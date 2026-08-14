# Operations

## SQLite backups

The bot creates verified SQLite online backups by default every 24 hours and keeps the newest 14. `BACKUP_DIR` overrides the default directory; otherwise it is `backups` beside the configured SQLite database. Set `BACKUP_ENABLED=false` to disable scheduled backups. Use `npm run db:backup` for an on-demand verified backup and `npm run db:restore:verify -- <backup-path>` to validate a backup without touching the live database.

Backups are useful for bad deploys, accidental mutation, and logical corruption. A backup on the same disk does not protect against disk, VPS, or provider loss; copy verified backups to separately managed storage.

## Manual restore drill

1. Verify the chosen backup first with `npm run db:restore:verify -- <backup-path>`.
2. Stop `telegram-support` before touching the configured SQLite file.
3. Move the current database and its `-wal` and `-shm` sidecars to a dated quarantine directory; retain them until the restore is confirmed.
4. Copy the verified backup to the configured database path. Do not leave old WAL/SHM files beside the restored database.
5. Restore the service account ownership and restrictive permissions.
6. Restart PM2, inspect startup logs, then smoke-test ticket intake and staff access.

The repository deliberately provides no destructive restore command.

## Owner pairing and logs

For an installation without an OWNER, run `npm run owner:pair` in an interactive terminal and type `PAIR` before the one-use, 30-minute link is displayed. `npm run owner:recover` remains the explicit transfer flow for installations that already have an OWNER. Runtime logs never print pairing links; older PM2 logs may contain expired credentials from earlier versions and should be handled according to local retention policy after confirming they are expired or consumed.
