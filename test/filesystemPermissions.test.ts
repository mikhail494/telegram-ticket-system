import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackupService } from "../src/backups.js";
import { SupportDatabase } from "../src/db.js";

async function mode(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

test(
  "creates SQLite and managed backup artifacts with restrictive POSIX permissions",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ticket-filesystem-permissions-"));
    const databasePath = path.join(directory, "data", "support.db");
    const database = new SupportDatabase(`file:${databasePath}`);
    try {
      const backupDirectory = path.join(directory, "backups");
      const result = await new BackupService(database, {
        enabled: true,
        directory: backupDirectory,
        intervalMs: 86_400_000,
        retentionCount: 14,
      }).createBackup();

      assert.equal(await mode(path.dirname(databasePath)), 0o700);
      assert.equal(await mode(databasePath), 0o600);
      assert.equal(await mode(`${databasePath}-wal`), 0o600);
      assert.equal(await mode(`${databasePath}-shm`), 0o600);
      assert.equal(await mode(backupDirectory), 0o700);
      assert.equal(await mode(result.path), 0o600);
      assert.equal(await mode(`${result.path}.sha256`), 0o600);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
