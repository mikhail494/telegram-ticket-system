import { config } from "./config.js";
import { BackupService } from "./backups.js";
import { SupportDatabase } from "./db.js";

async function main(): Promise<void> {
  const db = new SupportDatabase(config.databaseUrl);
  try {
    const result = await new BackupService(db, { enabled: true, directory: config.backupDir, intervalMs: config.backupIntervalHours * 3_600_000, retentionCount: config.backupRetentionCount }).createBackup();
    console.log(`BACKUP PASSED\nFile: ${result.path}\nSize: ${result.size}\nSHA-256: ${result.sha256}`);
  } finally { db.close(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Backup failed."); process.exitCode = 1; });
