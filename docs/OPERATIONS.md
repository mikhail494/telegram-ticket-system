# Operations

## SQLite backups

The bot creates verified SQLite online backups by default every 24 hours and keeps the newest 14. `BACKUP_DIR` overrides the default directory; otherwise it is `backups` beside the configured SQLite database. Set `BACKUP_ENABLED=false` to disable scheduled backups. `BACKUP_DIR=` intentionally selects the default directory. Use `npm run db:backup` for an on-demand verified backup and `npm run db:restore:verify -- <backup-path>` to validate a backup without touching the live database.

Backups are useful for bad deploys, accidental mutation, and logical corruption. A backup on the same disk does not protect against disk, VPS, or provider loss; copy verified backups to separately managed storage. Restrict an operator-provided `BACKUP_DIR` to the service account.

## Graceful shutdown

On `SIGINT` or `SIGTERM`, the process stops accepting new detached recovery work, stops polling, waits for active middleware and tracked database-dependent background work, then waits for any active automatic backup before closing SQLite. The scheduler stops creating future backups as soon as shutdown begins. A failed backup drain is logged safely and does not leave the database open indefinitely. `SIGKILL` cannot be drained by the application, so use it only after ordinary shutdown has failed.

Finalized managed backups are checksum-validated and SQLite-checked through isolated temporary copies, so normal discovery never opens or creates SQLite sidecars beside the finalized source. After final publication, a successful backup attempts to remove only the temporary database, checksum, WAL, and SHM sidecars created for that attempt. A cleanup failure is reported but does not remove the finalized backup or cause automatic backup draining to fail. It does not sweep or delete unrelated older temporary files in an operator-managed backup directory.

Pre-fix managed backup WAL/SHM/journal sidecars may be removed manually only after confirming they match an old managed backup filename. Retention removes those exact companions only when it has successfully removed that managed backup. Never remove live database `-wal` or `-shm` files while the service is running.

## Manual restore drill

1. Verify the chosen backup first with `npm run db:restore:verify -- <backup-path>`.
2. Stop `telegram-support` before touching the configured SQLite file.
3. Move the current database and its `-wal` and `-shm` sidecars to a dated quarantine directory; retain them until the restore is confirmed.
4. Copy the verified backup to the configured database path. Do not leave old WAL/SHM files beside the restored database.
5. Restore the service account ownership and restrictive permissions.
6. Restart PM2, inspect startup logs, then smoke-test ticket intake and staff access.

The repository deliberately provides no destructive restore command.

## Owner pairing and logs

For an installation without an OWNER, run `npm run owner:pair` in an interactive terminal and type `PAIR` before the one-use, 30-minute link is displayed. `npm run owner:recover` remains the explicit transfer flow for installations that already have an OWNER. Once an OWNER is paired for a READY installation with a staff workspace, role-based access activates automatically. Runtime logs never print pairing links; older PM2 logs may contain expired credentials from earlier versions and should be handled according to local retention policy after confirming they are expired or consumed.
