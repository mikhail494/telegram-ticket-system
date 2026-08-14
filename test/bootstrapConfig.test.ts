import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSetup } from "../src/setup.js";

process.env.BOT_TOKEN ??= "123456:TEST_BOT_TOKEN";
const { loadHostConfig } = await import("../src/config.js");

test("host config allows an omitted STAFF_CHAT_ID", () => {
  const config = loadHostConfig({ env: { BOT_TOKEN: "123:test" }, envFile: false });
  assert.equal(config.staffChatId, null);
  assert.equal(config.databaseUrl, "file:./data/support.db");
  assert.equal(config.logLevel, "info");
  assert.equal(config.backupEnabled, true);
  assert.equal(config.backupIntervalHours, 24);
  assert.equal(config.backupRetentionCount, 14);
  assert.equal(config.opsHttpEnabled, false);
  assert.equal(config.opsHttpHost, "127.0.0.1");
  assert.equal(config.opsHttpPort, 3000);
});

test("host config validates backup settings", () => {
  assert.throws(() => loadHostConfig({ env: { BOT_TOKEN: "123:test", BACKUP_INTERVAL_HOURS: "0" }, envFile: false }), /BACKUP_INTERVAL_HOURS/);
  assert.throws(() => loadHostConfig({ env: { BOT_TOKEN: "123:test", BACKUP_RETENTION_COUNT: "0" }, envFile: false }), /BACKUP_RETENTION_COUNT/);
  assert.equal(loadHostConfig({ env: { BOT_TOKEN: "123:test", BACKUP_ENABLED: "0" }, envFile: false }).backupEnabled, false);
  assert.equal(loadHostConfig({ env: { BOT_TOKEN: "123:test", BACKUP_DIR: "" }, envFile: false }).backupDir, null);
});

test("host config validates operational HTTP settings", () => {
  for (const [value, expected] of [["true", true], ["1", true], ["false", false], ["0", false]] as const) {
    assert.equal(loadHostConfig({ env: { BOT_TOKEN: "123:test", OPS_HTTP_ENABLED: value }, envFile: false }).opsHttpEnabled, expected);
  }
  const configured = loadHostConfig({ env: { BOT_TOKEN: "123:test", OPS_HTTP_HOST: "0.0.0.0", OPS_HTTP_PORT: "3210" }, envFile: false });
  assert.equal(configured.opsHttpHost, "0.0.0.0");
  assert.equal(configured.opsHttpPort, 3210);
  for (const port of ["0", "65536", "not-a-port"]) {
    assert.throws(() => loadHostConfig({ env: { BOT_TOKEN: "123:test", OPS_HTTP_PORT: port }, envFile: false }), /OPS_HTTP_PORT/);
  }
  assert.throws(() => loadHostConfig({ env: { BOT_TOKEN: "123:test", OPS_HTTP_HOST: "   " }, envFile: false }), /OPS_HTTP_HOST/);
});

test("example environment remains parse-compatible when a token is supplied", () => {
  const config = loadHostConfig({ env: { BOT_TOKEN: "123:test" }, envFile: path.resolve(".env.example") });
  assert.equal(config.opsHttpEnabled, false);
  assert.equal(config.opsHttpHost, "127.0.0.1");
  assert.equal(config.opsHttpPort, 3000);
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

test("confirmed token replacement removes the superseded secret", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ticket-setup-replace-"));
  const envPath = path.join(directory, ".env");
  try {
    await writeFile(envPath, "# keep this comment\nBOT_TOKEN=123456:OLD_TOKEN_VALUE\nCUSTOM_VALUE=preserved\n");
    await runSetup({
      env: { BOT_TOKEN: "654321:NEW_TOKEN_VALUE" },
      envPath,
      confirmOverwrite: async () => true,
      verifyToken: async () => ({ id: 1, username: "bot" }),
      writeOutput: () => undefined
    });
    const saved = await readFile(envPath, "utf8");
    assert.doesNotMatch(saved, /OLD_TOKEN_VALUE/);
    assert.equal(saved.match(/^BOT_TOKEN=/gm)?.length, 1);
    assert.match(saved, /^BOT_TOKEN=654321:NEW_TOKEN_VALUE$/m);
    assert.match(saved, /^# keep this comment$/m);
    assert.match(saved, /^CUSTOM_VALUE=preserved$/m);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("setup removes superseded duplicate assignments even when the effective token is unchanged", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ticket-setup-deduplicate-"));
  const envPath = path.join(directory, ".env");
  try {
    await writeFile(envPath, "BOT_TOKEN=123456:OLD_TOKEN_VALUE\nBOT_TOKEN=654321:CURRENT_TOKEN_VALUE\n");
    await runSetup({
      env: {},
      envPath,
      verifyToken: async () => ({ id: 1, username: "bot" }),
      writeOutput: () => undefined
    });
    const saved = await readFile(envPath, "utf8");
    assert.doesNotMatch(saved, /OLD_TOKEN_VALUE/);
    assert.equal(saved.match(/^BOT_TOKEN=/gm)?.length, 1);
    assert.match(saved, /^BOT_TOKEN=654321:CURRENT_TOKEN_VALUE$/m);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("setup preserves existing env comments, quoting, and unrelated values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ticket-setup-compatible-"));
  const envPath = path.join(directory, ".env");
  const original = [
    "# deployment note",
    'BOT_TOKEN="123456:SAVED_TOKEN_VALUE"',
    'CUSTOM_VALUE="contains # and spaces"',
    "A.B=one",
    "AXB=two",
    "DATABASE_URL=file:old.db",
    ""
  ].join("\n");
  try {
    await writeFile(envPath, original);
    await runSetup({
      env: {},
      envPath,
      verifyToken: async () => ({ id: 1, username: "bot" }),
      writeOutput: () => undefined
    });
    const saved = await readFile(envPath, "utf8");
    assert.match(saved, /^# deployment note$/m);
    assert.match(saved, /^BOT_TOKEN="123456:SAVED_TOKEN_VALUE"$/m);
    assert.match(saved, /^CUSTOM_VALUE="contains # and spaces"$/m);
    assert.match(saved, /^A\.B=one$/m);
    assert.match(saved, /^AXB=two$/m);
    assert.match(saved, /^DATABASE_URL=file:old\.db$/m);
    assert.match(saved, /^LOG_LEVEL=info$/m);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
