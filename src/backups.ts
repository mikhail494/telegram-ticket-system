import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SupportDatabase } from "./db.js";

const BACKUP_NAME = /^support-\d{8}T\d{9}Z\.sqlite$/;

export interface BackupOptions {
  directory?: string | null;
  intervalMs: number;
  retentionCount: number;
  enabled: boolean;
}

export interface BackupResult {
  path: string;
  basename: string;
  size: number;
  sha256: string;
  retentionDeleted: number;
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

export function defaultBackupDirectory(databasePath: string): string | null {
  return databasePath === ":memory:" ? null : path.join(path.dirname(path.resolve(databasePath)), "backups");
}

export function backupDirectory(database: SupportDatabase, configured: string | null | undefined): string {
  const directory = configured?.trim() || defaultBackupDirectory(database.databasePath);
  if (!directory) throw new Error("Backups require a file-backed SQLite DATABASE_URL.");
  return path.resolve(directory);
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function verifySqlite(file: string): Promise<void> {
  let database: Database.Database | undefined;
  try {
    database = new Database(file, { readonly: true, fileMustExist: true });
    const result = database.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error(`SQLite integrity_check failed: ${String(result)}`);
  } finally { database?.close(); }
}

async function secure(file: string): Promise<void> {
  if (process.platform !== "win32") await chmod(file, 0o600);
}

export class BackupService {
  private active: Promise<BackupResult> | null = null;
  private readonly directory: string;

  constructor(private readonly database: SupportDatabase, private readonly options: BackupOptions, private readonly now = () => new Date()) {
    this.directory = backupDirectory(database, options.directory);
  }

  async createBackup(): Promise<BackupResult> {
    if (this.active) return this.active;
    this.active = this.createBackupInternal();
    try { return await this.active; } finally { this.active = null; }
  }

  private async createBackupInternal(): Promise<BackupResult> {
    await mkdir(this.directory, { recursive: true });
    const basename = `support-${timestamp(this.now())}.sqlite`;
    const finalPath = path.join(this.directory, basename);
    const temporary = path.join(this.directory, `.${basename}.${process.pid}.tmp`);
    const temporaryMetadata = `${temporary}.sha256`;
    try {
      await this.database.backupTo(temporary);
      await verifySqlite(temporary);
      const digest = await sha256(temporary);
      const size = (await stat(temporary)).size;
      await secure(temporary);
      await writeFile(temporaryMetadata, `${digest}  ${basename}\n`, { mode: 0o600 });
      await secure(temporaryMetadata);
      await rename(temporary, finalPath);
      await rename(temporaryMetadata, `${finalPath}.sha256`);
      const retentionDeleted = await this.applyRetention();
      return { path: finalPath, basename, size, sha256: digest, retentionDeleted };
    } catch (error) {
      await Promise.allSettled([rm(temporary, { force: true }), rm(temporaryMetadata, { force: true })]);
      throw error;
    }
  }

  private async applyRetention(): Promise<number> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const managed = entries.filter((entry) => entry.isFile() && BACKUP_NAME.test(entry.name)).map((entry) => entry.name).sort().reverse();
    const remove = managed.slice(Math.max(1, this.options.retentionCount));
    for (const name of remove) {
      await Promise.all([rm(path.join(this.directory, name), { force: true }), rm(path.join(this.directory, `${name}.sha256`), { force: true })]);
    }
    return remove.length;
  }

  async newestValidBackup(): Promise<string | null> {
    let entries: string[];
    try { entries = (await readdir(this.directory)).filter((name) => BACKUP_NAME.test(name)).sort().reverse(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    for (const name of entries) {
      const candidate = path.join(this.directory, name);
      try { await verifyBackupChecksum(candidate); await verifySqlite(candidate); return candidate; } catch { /* examine older backup */ }
    }
    return null;
  }
}

export async function verifyBackupChecksum(file: string): Promise<string> {
  const sidecar = `${file}.sha256`;
  let expected: string;
  try { expected = (await readFile(sidecar, "utf8")).trim().split(/\s+/)[0] ?? ""; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return sha256(file); throw error; }
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error("Backup checksum metadata is invalid.");
  const actual = await sha256(file);
  if (actual !== expected) throw new Error("Backup checksum does not match.");
  return actual;
}

export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly service: BackupService, private readonly options: BackupOptions, private readonly onFailure: (error: unknown) => void) {}
  async start(): Promise<void> {
    if (!this.options.enabled) return;
    const latest = await this.service.newestValidBackup();
    const age = latest ? Date.now() - (await stat(latest)).mtimeMs : Number.POSITIVE_INFINITY;
    if (age >= this.options.intervalMs) await this.run(); else this.schedule(this.options.intervalMs - age);
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private async run(): Promise<void> {
    try { await this.service.createBackup(); } catch (error) { this.onFailure(error); }
    this.schedule(this.options.intervalMs);
  }
  private schedule(delay: number): void {
    this.stop();
    this.timer = setTimeout(() => { void this.run(); }, Math.max(1, delay));
    this.timer.unref();
  }
}

export async function verifyRestoreCandidate(backupPath: string, liveDatabasePath: string): Promise<void> {
  const resolved = path.resolve(backupPath);
  if (resolved === path.resolve(liveDatabasePath)) throw new Error("Restore verification refuses the configured live database path.");
  await verifyBackupChecksum(resolved);
  const directory = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "ticket-restore-"));
  const copy = path.join(directory, path.basename(resolved));
  try {
    await (await import("node:fs/promises")).copyFile(resolved, copy);
    await verifySqlite(copy);
    const database = new SupportDatabase(`file:${copy}`);
    try { database.getInstallationState(); } finally { database.close(); }
    await verifySqlite(copy);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
