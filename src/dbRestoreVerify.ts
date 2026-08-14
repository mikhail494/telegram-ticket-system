import { config } from "./config.js";
import { resolveDatabasePath } from "./db.js";
import { verifyRestoreCandidate } from "./backups.js";

async function main(): Promise<void> {
  const backup = process.argv[2];
  if (!backup) throw new Error("Usage: npm run db:restore:verify -- <backup-path>");
  const result = await verifyRestoreCandidate(backup, resolveDatabasePath(config.databaseUrl));
  console.log(`RESTORE VERIFICATION PASSED\nFile: ${result.path}\nChecksum: ${result.checksum}\nSQLite integrity: ${result.sqliteIntegrity}\nApplication compatibility: ${result.applicationCompatibility}`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Restore verification failed."); process.exitCode = 1; });
