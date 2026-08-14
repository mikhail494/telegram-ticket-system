import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  rename?: typeof rename;
  remove?: typeof rm;
}

export interface BackupResult {
  path: string;
  basename: string;
  size: number;
  sha256: string;
  retentionDeleted: number;
  retentionFailed: number;
}

export interface RestoreVerificationResult {
  path: string;
  checksum: "verified" | "metadata absent";
  sqliteIntegrity: "ok";
  applicationCompatibility: "ok";
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
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => { hash.update(chunk); });
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
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
  private readonly move: typeof rename;
  private readonly remove: typeof rm;

  constructor(private readonly database: SupportDatabase, private readonly options: BackupOptions, private readonly now = () => new Date()) {
    this.directory = backupDirectory(database, options.directory);
    this.move = options.rename ?? rename;
    this.remove = options.remove ?? rm;
  }

  async createBackup(): Promise<BackupResult> {
    if (this.active) return this.active;
    this.active = this.createBackupInternal();
    try { return await this.active; } finally { this.active = null; }
  }

  private async createBackupInternal(): Promise<BackupResult> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const basename = `support-${timestamp(this.now())}.sqlite`;
    const finalPath = path.join(this.directory, basename);
    const temporary = path.join(this.directory, `.${basename}.${process.pid}.tmp`);
    const temporaryMetadata = `${temporary}.sha256`;
    const finalMetadata = `${finalPath}.sha256`;
    let publishedDatabase = false;
    let publishedMetadata = false;
    try {
      try {
        await stat(finalPath);
        throw new Error(`Refusing to overwrite an existing managed backup: ${basename}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.database.backupTo(temporary);
      await verifySqlite(temporary);
      const digest = await sha256(temporary);
      const size = (await stat(temporary)).size;
      await secure(temporary);
      await writeFile(temporaryMetadata, `${digest}  ${basename}\n`, { mode: 0o600 });
      await secure(temporaryMetadata);
      await this.move(temporary, finalPath);
      publishedDatabase = true;
      await this.move(temporaryMetadata, finalMetadata);
      publishedMetadata = true;
      let retention: Pick<BackupResult, "retentionDeleted" | "retentionFailed">;
      try { retention = await this.applyRetention(); }
      catch { retention = { retentionDeleted: 0, retentionFailed: 1 }; }
      return { path: finalPath, basename, size, sha256: digest, ...retention };
    } catch (error) {
      await Promise.allSettled([
        this.remove(temporary, { force: true }),
        this.remove(temporaryMetadata, { force: true }),
        this.remove(`${temporary}-wal`, { force: true }),
        this.remove(`${temporary}-shm`, { force: true }),
        ...(publishedDatabase ? [this.remove(finalPath, { force: true })] : []),
        ...(publishedMetadata ? [this.remove(finalMetadata, { force: true })] : [])
      ]);
      throw error;
    }
  }

  private async applyRetention(): Promise<Pick<BackupResult, "retentionDeleted" | "retentionFailed">> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const managed = entries.filter((entry) => entry.isFile() && BACKUP_NAME.test(entry.name)).map((entry) => entry.name).sort().reverse();
    const remove = managed.slice(Math.max(1, this.options.retentionCount));
    let retentionDeleted = 0;
    let retentionFailed = 0;
    for (const name of remove) {
      try {
        await this.remove(path.join(this.directory, name), { force: true });
        retentionDeleted += 1;
      } catch {
        retentionFailed += 1;
        continue;
      }
      try { await this.remove(path.join(this.directory, `${name}.sha256`), { force: true }); } catch { retentionFailed += 1; }
    }
    return { retentionDeleted, retentionFailed };
  }

  async newestValidBackup(): Promise<string | null> {
    let entries: string[];
    try { entries = (await readdir(this.directory)).filter((name) => BACKUP_NAME.test(name)).sort().reverse(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    for (const name of entries) {
      const candidate = path.join(this.directory, name);
      try { await verifyBackupChecksum(candidate, { requireMetadata: true }); await verifySqlite(candidate); return candidate; } catch { /* examine older backup */ }
    }
    return null;
  }
}

export async function verifyBackupChecksum(file: string, options: { requireMetadata?: boolean } = {}): Promise<{ sha256: string; metadata: "verified" | "absent" }> {
  const sidecar = `${file}.sha256`;
  let expected: string;
  try { expected = (await readFile(sidecar, "utf8")).trim().split(/\s+/)[0] ?? ""; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (options.requireMetadata) throw new Error("Managed backup checksum metadata is missing.");
    return { sha256: await sha256(file), metadata: "absent" };
  }
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error("Backup checksum metadata is invalid.");
  const actual = await sha256(file);
  if (actual !== expected) throw new Error("Backup checksum does not match.");
  return { sha256: actual, metadata: "verified" };
}

export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly service: BackupService, private readonly options: BackupOptions, private readonly onFailure: (error: unknown) => void, private readonly onSuccess: (result: BackupResult) => void = () => undefined) {}
  async start(): Promise<void> {
    if (!this.options.enabled) return;
    const latest = await this.service.newestValidBackup();
    const age = latest ? Date.now() - (await stat(latest)).mtimeMs : Number.POSITIVE_INFINITY;
    if (age >= this.options.intervalMs) await this.run(); else this.schedule(this.options.intervalMs - age);
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private async run(): Promise<void> {
    try { this.onSuccess(await this.service.createBackup()); } catch (error) { this.onFailure(error); }
    this.schedule(this.options.intervalMs);
  }
  private schedule(delay: number): void {
    this.stop();
    this.timer = setTimeout(() => { void this.run(); }, Math.max(1, delay));
    this.timer.unref();
  }
}

export function createAutomaticBackupScheduler(
  database: SupportDatabase,
  options: BackupOptions,
  onFailure: (error: unknown) => void,
  onSuccess: (result: BackupResult) => void = () => undefined
): BackupScheduler | null {
  if (!options.enabled) return null;
  try { return new BackupScheduler(new BackupService(database, options), options, onFailure, onSuccess); }
  catch (error) { onFailure(error); return null; }
}

export async function verifyRestoreCandidate(backupPath: string, liveDatabasePath: string): Promise<RestoreVerificationResult> {
  const resolved = path.resolve(backupPath);
  if (resolved === path.resolve(liveDatabasePath)) throw new Error("Restore verification refuses the configured live database path.");
  const checksum = await verifyBackupChecksum(resolved);
  const directory = await mkdtemp(path.join(os.tmpdir(), "ticket-restore-"));
  const copy = path.join(directory, path.basename(resolved));
  try {
    await copyFile(resolved, copy);
    await verifySqlite(copy);
    const database = new SupportDatabase(`file:${copy}`);
    try { database.getInstallationState(); } finally { database.close(); }
    await verifySqlite(copy);
    return { path: resolved, checksum: checksum.metadata === "verified" ? "verified" : "metadata absent", sqliteIntegrity: "ok", applicationCompatibility: "ok" };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
