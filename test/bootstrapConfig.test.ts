import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadHostConfig } from "../src/config.js";
import { runSetup } from "../src/setup.js";

test("host config allows an omitted STAFF_CHAT_ID", () => {
  const config = loadHostConfig({ env: { BOT_TOKEN: "123:test" }, envFile: false });
  assert.equal(config.staffChatId, null);
  assert.equal(config.databaseUrl, "file:./data/support.db");
  assert.equal(config.logLevel, "info");
});

test("explicit environment overrides local file values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ticket-config-"));
  const file = path.join(directory, ".env");
  try {
    await writeFile(file, "BOT_TOKEN=file-token\nDATABASE_URL=file:from-file.db\nLOG_LEVEL=warn\n");
    const config = loadHostConfig({ env: { BOT_TOKEN: "process-token", LOG_LEVEL: "debug" }, envFile: file });
    assert.equal(config.botToken, "process-token");
    assert.equal(config.databaseUrl, "file:from-file.db");
    assert.equal(config.logLevel, "debug");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("setup validates the token and writes an atomic env without printing it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ticket-setup-"));
  const envPath = path.join(directory, ".env");
  const output: string[] = [];
  const token = "123456:VERY_SECRET_TOKEN";
  try {
    const result = await runSetup({
      env: {}, envPath,
      promptToken: async () => ` ${token} `,
      confirmOverwrite: async () => true,
      verifyToken: async () => ({ id: 77, username: "safe_bot" }),
      writeOutput: (line) => output.push(line)
    });
    assert.equal(result.botUsername, "safe_bot");
    assert.equal(output.join("\n").includes(token), false);
    const saved = await readFile(envPath, "utf8");
    assert.match(saved, /^BOT_TOKEN=123456:VERY_SECRET_TOKEN$/m);
    assert.match(saved, /^DATABASE_URL=file:\.\/data\/support\.db$/m);
    assert.match(saved, /^LOG_LEVEL=info$/m);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("non-interactive setup without a token fails clearly", async () => {
  await assert.rejects(() => runSetup({ env: {}, envPath: false, interactive: false }), /BOT_TOKEN.*non-interactive/i);
});

test("explicit environment does not overwrite a different saved token without confirmation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ticket-setup-preserve-"));
  const envPath = path.join(directory, ".env");
  try {
    await writeFile(envPath, "BOT_TOKEN=123456:SAVED_TOKEN_VALUE\nDATABASE_URL=file:old.db\n");
    await runSetup({ env: { BOT_TOKEN: "654321:PROCESS_TOKEN_VALUE" }, envPath, verifyToken: async () => ({ id: 1, username: "bot" }), writeOutput: () => undefined });
    assert.match(await readFile(envPath, "utf8"), /^BOT_TOKEN=123456:SAVED_TOKEN_VALUE$/m);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
