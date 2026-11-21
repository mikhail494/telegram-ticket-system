import fs from "node:fs";
import path from "node:path";

export function resolveDatabasePath(databaseUrl: string): string {
  const value = databaseUrl.trim();
  if (value === ":memory:") return value;
  if (value.startsWith("file://")) {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    return process.platform === "win32" && /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname;
  }
  if (value.startsWith("file:")) return value.slice("file:".length);
  if (value.startsWith("sqlite://")) {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    return process.platform === "win32" && /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname;
  }
  return value;
}
export function ensureDirectoryForDatabase(databasePath: string): void {
  if (databasePath === ":memory:") return;
  const directory = path.dirname(databasePath);
  if (directory && directory !== ".") fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
export function createDatabaseFileWithRestrictedPermissions(databasePath: string): void {
  if (databasePath === ":memory:" || process.platform === "win32") return;
  try {
    const descriptor = fs.openSync(databasePath, "wx", 0o600);
    fs.closeSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
export function secureDatabaseArtifacts(databasePath: string): void {
  if (databasePath === ":memory:" || process.platform === "win32") return;
  for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
