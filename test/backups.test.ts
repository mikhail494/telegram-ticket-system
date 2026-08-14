import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackupScheduler, BackupService, verifyRestoreCandidate, verifySqlite } from "../src/backups.js";
import { SupportDatabase } from "../src/db.js";

async function fixture(): Promise<{ directory: string; db: SupportDatabase; backupDirectory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ticket-backup-"));
  const db = new SupportDatabase(`file:${path.join(directory, "support.sqlite")}`);
  db.setSetting("representative", "preserved");
  return { directory, db, backupDirectory: path.join(directory, "backups") };
}

test("online backup is verified, checksummed, and preserves application data", async () => {
  const { directory, db, backupDirectory } = await fixture();
  try {
    const result = await new BackupService(db, { enabled: true, directory: backupDirectory, intervalMs: 1, retentionCount: 14 }).createBackup();
    assert.match(result.basename, /^support-\d{8}T\d{9}Z\.sqlite$/);
    await verifySqlite(result.path);
    assert.match(await (await import("node:fs/promises")).readFile(`${result.path}.sha256`, "utf8"), new RegExp(result.sha256));
    const restored = new SupportDatabase(`file:${result.path}`);
    try { assert.equal(restored.getSetting("representative"), "preserved"); } finally { restored.close(); }
    assert.equal((await readdir(backupDirectory)).some((name) => name.endsWith(".tmp")), false);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("failed restore verification rejects corruption and never accepts the live database", async () => {
  const { directory, db, backupDirectory } = await fixture();
  try {
    const result = await new BackupService(db, { enabled: true, directory: backupDirectory, intervalMs: 1, retentionCount: 14 }).createBackup();
    await verifyRestoreCandidate(result.path, db.databasePath);
    await assert.rejects(() => verifyRestoreCandidate(result.path, result.path), /live database/i);
    await writeFile(`${result.path}.sha256`, "0".repeat(64));
    await assert.rejects(() => verifyRestoreCandidate(result.path, db.databasePath), /checksum/i);
    const random = path.join(directory, "not-a-database.sqlite"); await writeFile(random, "not sqlite");
    await assert.rejects(() => verifyRestoreCandidate(random, db.databasePath));
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("retention only removes managed finalized backups and overlapping triggers share one backup", async () => {
  const { directory, db, backupDirectory } = await fixture();
  try {
    await (await import("node:fs/promises")).mkdir(backupDirectory); await writeFile(path.join(backupDirectory, "operator-notes.txt"), "keep");
    let tick = 0;
    const service = new BackupService(db, { enabled: true, directory: backupDirectory, intervalMs: 1, retentionCount: 1 }, () => new Date(1_700_000_000_000 + tick++));
    const [first, duplicate] = await Promise.all([service.createBackup(), service.createBackup()]);
    assert.equal(first.path, duplicate.path);
    await service.createBackup();
    assert.equal((await readdir(backupDirectory)).filter((name) => /^support-.*\.sqlite$/.test(name)).length, 1);
    assert.equal((await readdir(backupDirectory)).includes("operator-notes.txt"), true);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("scheduler does not duplicate a recent valid backup", async () => {
  const { directory, db, backupDirectory } = await fixture();
  try {
    const service = new BackupService(db, { enabled: true, directory: backupDirectory, intervalMs: 86_400_000, retentionCount: 14 });
    await service.createBackup();
    const scheduler = new BackupScheduler(service, { enabled: true, directory: backupDirectory, intervalMs: 86_400_000, retentionCount: 14 }, () => assert.fail("unexpected failure"));
    await scheduler.start(); scheduler.stop();
    assert.equal((await readdir(backupDirectory)).filter((name) => /^support-.*\.sqlite$/.test(name)).length, 1);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
