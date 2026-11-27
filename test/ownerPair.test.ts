import test from "node:test";
import assert from "node:assert/strict";
import { SupportDatabase } from "../src/db.js";
import { InstallationService } from "../src/installation.js";
import readline from "node:readline/promises";
import { mock } from "node:test";
import { Api } from "grammy";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AdaptiveKeyError } from "../src/adaptiveKeyErrors.js";

process.env.BOT_TOKEN ??= "123456:TEST_OWNER_PAIR_TOKEN";
process.env.DATABASE_URL = ":memory:";
const { runOwnerPair, runOwnerPairCli } = await import("../src/ownerPair.js");

test("owner pairing prints predefined key/opening diagnostics without exposing underlying errors", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "owner-pair-diagnostics-"));
  const file = path.join(directory, "support.db");
  const key = path.join(directory, "private", "adaptive.key");
  const output: string[] = [];
  const printed = mock.method(console, "error", (line: string) => output.push(line));
  const secret = "private-link https://t.me/test?start=secret BOT_TOKEN=DO_NOT_PRINT";
  try {
    new SupportDatabase(file, { adaptiveKeyPath: key }).close();
    const bytes = fs.readFileSync(key);
    for (const mode of ["missing", "mismatch"] as const) {
      if (mode === "missing") fs.unlinkSync(key);
      else fs.writeFileSync(key, Buffer.alloc(32, 8), { mode: 0o600 });
      assert.equal(
        await runOwnerPairCli({
          interactive: true,
          confirm: async () => "PAIR",
          openDatabase: () => new SupportDatabase(file, { adaptiveKeyPath: key }),
        }),
        1
      );
      assert.match(output.at(-1)!, mode === "missing" ? /key is missing/ : /key mismatch/);
    }
    fs.writeFileSync(key, bytes, { mode: 0o600 });
    for (const code of ["DIRECTORY", "PERMISSIONS", "FILE", "LENGTH"] as const) {
      const error = new AdaptiveKeyError(code);
      error.message = secret;
      assert.equal(
        await runOwnerPairCli({
          interactive: true,
          confirm: async () => "PAIR",
          openDatabase: () => {
            throw error;
          },
        }),
        1
      );
      assert.equal(output.at(-1), new AdaptiveKeyError(code).message);
    }
    assert.equal(await runOwnerPairCli({ interactive: false }), 1);
    assert.equal(await runOwnerPairCli({ interactive: true, confirm: async () => "NO" }), 1);
    assert.equal(
      await runOwnerPairCli({
        interactive: true,
        confirm: async () => "PAIR",
        openDatabase: () => {
          throw new Error(secret);
        },
      }),
      1
    );
    assert.equal(output.at(-1), "Owner pairing database could not be opened.");
    const db = new SupportDatabase(":memory:");
    try {
      assert.equal(
        await runOwnerPairCli({
          interactive: true,
          confirm: async () => "PAIR",
          openDatabase: () => db,
          getUsername: async () => {
            throw new Error(secret);
          },
        }),
        1
      );
      assert.match(output.at(-1)!, /identity verification failed/);
      assert.equal(db.listUnconsumedTokens().length, 0);
      assert.equal(
        await runOwnerPairCli({
          interactive: true,
          confirm: async () => "PAIR",
          openDatabase: () => db,
          getUsername: async () => "synthetic_bot",
          write: () => {},
        }),
        0
      );
      db.upsertTeamMember({ userId: 1, role: "OWNER", addedBy: 1 });
      assert.equal(
        await runOwnerPairCli({ interactive: true, confirm: async () => "PAIR", openDatabase: () => db }),
        1
      );
      assert.match(output.at(-1)!, /OWNER already exists/);
    } finally {
      db.close();
    }
    assert.equal(
      await runOwnerPairCli({
        interactive: true,
        confirm: async () => {
          throw new Error(secret);
        },
      }),
      1
    );
    assert.equal(output.at(-1), "Owner pairing failed.");
    assert.equal(
      output.some((line) => line.includes("DO_NOT_PRINT") || line.includes("https://")),
      false
    );
  } finally {
    printed.mock.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("owner pairing cancels wrong confirmation before opening SQLite", async () => {
  let opened = false;
  await assert.rejects(
    () =>
      runOwnerPair({
        interactive: true,
        confirm: async () => "NO",
        openDatabase: () => {
          opened = true;
          throw new Error();
        },
      }),
    /cancelled/
  );
  assert.equal(opened, false);
});

test("owner pairing contains database and Telegram errors without disclosing credentials or issuing tokens", async () => {
  const secret = "123456:DO_NOT_DISCLOSE_THIS_TOKEN";
  await assert.rejects(
    () =>
      runOwnerPair({
        interactive: true,
        confirm: async () => "PAIR",
        openDatabase: () => {
          throw new Error(secret);
        },
      }),
    (error) => error instanceof Error && !error.message.includes(secret) && /database/.test(error.message)
  );
  const db = new SupportDatabase(":memory:");
  try {
    await assert.rejects(
      () =>
        runOwnerPair({
          interactive: true,
          confirm: async () => "PAIR",
          openDatabase: () => db,
          getUsername: async () => {
            throw new Error(secret);
          },
        }),
      (error) => error instanceof Error && !error.message.includes(secret) && /verification failed/.test(error.message)
    );
    assert.equal(db.listUnconsumedTokens().length, 0);
    assert.equal(db.ping(), true);
  } finally {
    db.close();
  }
});

test("owner pairing closes its prompt and owned database on a failed getMe", async () => {
  let closedPrompt = 0;
  const prompt = mock.method(readline, "createInterface", () => ({
    question: async () => "PAIR",
    close: () => {
      closedPrompt++;
    },
  }));
  const fetchMock = mock.method(Api.prototype, "getMe", async () => {
    throw new Error("synthetic getMe failure");
  });
  const close = mock.method(SupportDatabase.prototype, "close");
  try {
    await assert.rejects(() => runOwnerPair({ interactive: true }), /identity verification/);
    assert.equal(closedPrompt, 1);
    assert.equal(close.mock.callCount(), 1);
    assert.equal(fetchMock.mock.callCount(), 1);
  } finally {
    prompt.mock.restore();
    fetchMock.mock.restore();
    close.mock.restore();
  }
});

test("owner pairing refuses non-interactive invocation before creating a token", async () => {
  await assert.rejects(() => runOwnerPair({ interactive: false }), /interactive terminal/i);
});

test("owner pairing creates a one-use link only after interactive confirmation", async () => {
  const db = new SupportDatabase(":memory:");
  const output: string[] = [];
  try {
    await runOwnerPair({
      interactive: true,
      confirm: async () => "PAIR",
      getUsername: async () => "fake_bot",
      openDatabase: () => db,
      write: (line) => output.push(line),
    });
    assert.equal(db.listUnconsumedTokens().filter((token) => token.kind === "OWNER_PAIRING").length, 1);
    assert.match(output.join("\n"), /https:\/\/t\.me\/fake_bot\?start=setup_/);
    assert.equal(
      db.listUnconsumedTokens().some((token) => output.join("\n").includes(token.token_hash)),
      false
    );
    const token = output.join("\n").match(/setup_([^\s]+)/)?.[1];
    assert.ok(token);
    new InstallationService(db).consumeOwnerPairingToken(token, { telegramId: 1 });
    await assert.rejects(
      () => runOwnerPair({ interactive: true, confirm: async () => "PAIR", openDatabase: () => db }),
      /OWNER already exists|owner:recover/i
    );
  } finally {
    db.close();
  }
});
