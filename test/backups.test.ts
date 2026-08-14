import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackupScheduler, BackupService, createAutomaticBackupScheduler, verifyBackupChecksum, verifyRestoreCandidate, verifySqlite } from "../src/backups.js";
import { SupportDatabase } from "../src/db.js";

async function fixture(): Promise<{ directory: string; db: SupportDatabase; backupDirectory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ticket-backup-"));
  const db = new SupportDatabase(`file:${path.join(directory, "support.sqlite")}`);
  db.setSetting("representative", "preserved");
  return { directory, db, backupDirectory: path.join(directory, "backups") };
}

test("online backup is finalized with immutable checksum metadata and passes a restore drill", async () => {
  const { directory, db, backupDirectory } = await fixture();
  try {
    const result = await new BackupService(db, { enabled: true, directory: backupDirectory, intervalMs: 1, retentionCount: 14 }).createBackup();
    assert.match(result.basename, /^support-\d{8}T\d{9}Z\.sqlite$/);
    const original = await readFile(result.path);
    const originalChecksum = await readFile(`${result.path}.sha256`, "utf8");
    assert.equal((await verifyRestoreCandidate(result.path, db.databasePath)).checksum, "verified");
    const restoreTarget = path.join(directory, "restore-target.sqlite");
    await copyFile(result.path, restoreTarget);
    const restored = new SupportDatabase(`file:${restoreTarget}`);
    try { assert.equal(restored.getSetting("representative"), "preserved"); } finally { restored.close(); }
    await verifySqlite(restoreTarget);
    assert.deepEqual(await readFile(result.path), original);
    assert.equal(await readFile(`${result.path}.sha256`, "utf8"), originalChecksum);
    assert.equal((await readdir(backupDirectory)).some((name) => name.endsWith(".tmp")), false);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("managed backup publication removes its own partial final file when checksum publication fails", async () => {
  const { directory, db, backupDirectory } = await fixture();
  try {
    let moves = 0;
    const service = new BackupService(db, {
      enabled: true, directory: backupDirectory, intervalMs: 1, retentionCount: 14,
      rename: async (from, to) => {
        moves += 1;
        if (moves === 2) throw new Error("checksum publish failed");
        await rename(from, to);
      }
    });
    await assert.rejects(() => service.createBackup(), /checksum publish failed/);
    assert.deepEqual(await readdir(backupDirectory), []);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("managed backup discovery ignores a half-published backup without checksum metadata", async () => {
  const { directory, db, backupDirectory } = await fixture();
  try {
    const result = await new BackupService(db, { enabled: true, directory: backupDirectory, intervalMs: 1, retentionCount: 14 }).createBackup();
    await rm(`${result.path}.sha256`);
    const service = new BackupService(db, { enabled: true, directory: backupDirectory, intervalMs: 1, retentionCount: 14 });
    assert.equal(await service.newestValidBackup(), null);
    assert.equal((await verifyRestoreCandidate(result.path, db.databasePath)).checksum, "metadata absent");
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("retention failure does not invalidate the newly finalized backup", async () => {
  const { directory, db, backupDirectory } = await fixture();
  try {
    let tick = 0;
    const failOldRemoval = async (target: Parameters<typeof rm>[0], options?: Parameters<typeof rm>[1]) => {
      if (String(target).includes("support-20231114T221320000Z.sqlite")) throw new Error("old backup locked");
      return rm(target, options);
    };
    const service = new BackupService(db, { enabled: true, directory: backupDirectory, intervalMs: 1, retentionCount: 1, remove: failOldRemoval }, () => new Date(1_700_000_000_000 + tick++));
    await service.createBackup();
    const second = await service.createBackup();
    assert.equal(second.retentionDeleted, 0);
    assert.equal(second.retentionFailed, 1);
    await verifyBackupChecksum(second.path, { requireMetadata: true });
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("restore verification rejects missing, corrupt, truncated, mismatched, and live candidates without mutating the original", async () => {
  const { directory, db, backupDirectory } = await fixture();
  try {
    const result = await new BackupService(db, { enabled: true, directory: backupDirectory, intervalMs: 1, retentionCount: 14 }).createBackup();
    const bytes = await readFile(result.path);
    const checksum = await readFile(`${result.path}.sha256`, "utf8");
    await assert.rejects(() => verifyRestoreCandidate(path.join(directory, "missing.sqlite"), db.databasePath));
    await assert.rejects(() => verifyRestoreCandidate(result.path, result.path), /live database/i);
    const random = path.join(directory, "not-a-database.sqlite"); await writeFile(random, "not sqlite");
    await assert.rejects(() => verifyRestoreCandidate(random, db.databasePath));
    const truncated = path.join(directory, "truncated.sqlite"); await writeFile(truncated, bytes.subarray(0, 64));
    await assert.rejects(() => verifyRestoreCandidate(truncated, db.databasePath));
    await writeFile(`${result.path}.sha256`, "0".repeat(64));
    await assert.rejects(() => verifyRestoreCandidate(result.path, db.databasePath), /checksum/i);
    await writeFile(`${result.path}.sha256`, checksum);
    assert.deepEqual(await readFile(result.path), bytes);
    assert.equal(await readFile(`${result.path}.sha256`, "utf8"), checksum);
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

test("disabled or unsupported automatic backups never prevent normal database startup", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const disabled = createAutomaticBackupScheduler(db, { enabled: false, intervalMs: 1, retentionCount: 1 }, () => assert.fail("disabled backups should not report a failure"));
    assert.equal(disabled, null);
    const failures: unknown[] = [];
    const unsupported = createAutomaticBackupScheduler(db, { enabled: true, intervalMs: 1, retentionCount: 1 }, (error) => failures.push(error));
    assert.equal(unsupported, null);
    assert.match(String(failures[0]), /file-backed SQLite/i);
    assert.equal(db.getSetting("representative") ?? null, null);
  } finally { db.close(); }
});
