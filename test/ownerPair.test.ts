import test from "node:test";
import assert from "node:assert/strict";
import { SupportDatabase } from "../src/db.js";
import { InstallationService } from "../src/installation.js";

process.env.BOT_TOKEN ??= "123456:TEST_OWNER_PAIR_TOKEN";
const { runOwnerPair } = await import("../src/ownerPair.js");

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
      write: (line) => output.push(line)
    });
    assert.equal(db.listUnconsumedTokens().filter((token) => token.kind === "OWNER_PAIRING").length, 1);
    assert.match(output.join("\n"), /https:\/\/t\.me\/fake_bot\?start=setup_/);
    assert.equal(db.listUnconsumedTokens().some((token) => output.join("\n").includes(token.token_hash)), false);
    const token = output.join("\n").match(/setup_([^\s]+)/)?.[1];
    assert.ok(token);
    new InstallationService(db).consumeOwnerPairingToken(token, { telegramId: 1 });
    await assert.rejects(() => runOwnerPair({ interactive: true, confirm: async () => "PAIR", openDatabase: () => db }), /OWNER already exists|owner:recover/i);
  } finally { db.close(); }
});
