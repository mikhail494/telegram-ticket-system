import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { SupportDatabase } from "../src/db.js";
import { ADAPTIVE_RECOVERY_CONFIRMATION } from "../src/persistence/adaptivePrivacyRecovery.js";

process.env.BOT_TOKEN ??= "123456:SYNTHETIC_RECOVERY_TOKEN";
const { runAdaptiveRecovery } = await import("../src/adaptiveRecovery.js");

test("offline recovery CLI requires interactive confirmation, explains data loss and handles a mismatched key", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-recovery-cli-"));
  const file = path.join(directory, "support.db");
  const key = path.join(directory, "private", "adaptive.key");
  const output: string[] = [];
  const write = (line: string) => output.push(line);
  try {
    await assert.rejects(() => runAdaptiveRecovery({ interactive: false, write }), /interactive terminal/);
    await assert.rejects(
      () => runAdaptiveRecovery({ interactive: true, confirm: async () => "yes", write }),
      /cancelled/
    );
    assert.equal(fs.existsSync(file), false);
    assert.match(output.join("\n"), /STOP the application/);
    assert.match(output.join("\n"), /destroys only adaptive/);
    new SupportDatabase(file, { adaptiveKeyPath: key }).close();
    const old = fs.readFileSync(key);
    fs.writeFileSync(key, Buffer.alloc(32, 9), { mode: 0o600 });
    const result = await runAdaptiveRecovery({
      interactive: true,
      confirm: async () => ADAPTIVE_RECOVERY_CONFIRMATION,
      databaseUrl: file,
      adaptiveKeyPath: key,
      write,
    });
    assert.equal(result.resetPerformed, true);
    assert.match(output.join("\n"), /ADAPTIVE RECOVERY COMPLETE/);
    assert.match(output.join("\n"), /Back up the new key separately/);
    assert.notDeepEqual(fs.readFileSync(key), old);
    assert.ok(fs.readdirSync(path.dirname(key)).some((name) => /^replaced-.+\.key$/.test(name)));
    new SupportDatabase(file, { adaptiveKeyPath: key }).close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("db:backup prints key-exclusion and whole-database recovery requirements", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "backup-key-notice-"));
  const file = path.join(directory, "support.db");
  const key = path.join(directory, "private", "adaptive.key");
  const backups = path.join(directory, "backups");
  try {
    new SupportDatabase(file, { adaptiveKeyPath: key }).close();
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/dbBackup.ts"], {
      encoding: "utf8",
      env: {
        ...process.env,
        BOT_TOKEN: "123456:SYNTHETIC_BACKUP_TOKEN",
        DATABASE_URL: file,
        ADAPTIVE_KEY_PATH: key,
        BACKUP_DIR: backups,
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /BACKUP PASSED/);
    assert.match(result.stdout, /key is NOT included/);
    assert.match(result.stdout, /entire SupportDatabase from opening/);
    assert.equal(result.stdout.includes("SYNTHETIC_BACKUP_TOKEN"), false);
    const database = fs.readdirSync(backups).find((name) => name.endsWith(".sqlite"))!;
    assert.equal(fs.readFileSync(path.join(backups, database)).includes(fs.readFileSync(key)), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
