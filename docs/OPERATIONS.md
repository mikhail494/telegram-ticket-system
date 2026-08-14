# Operations

## Operational HTTP endpoints

Native and PM2 deployments leave the operational listener disabled by default. Enable it explicitly when a local reverse proxy or monitoring agent needs probes:

```env
OPS_HTTP_ENABLED=true
OPS_HTTP_HOST=127.0.0.1
OPS_HTTP_PORT=3000
```

`GET /healthz` returns `200` while the process is alive. `GET /readyz` returns `200` only after Telegram polling has started and a lightweight SQLite `SELECT 1` succeeds; setup-required installations can still be ready. During graceful shutdown readiness becomes `503` before SQLite closes. `GET /metrics` provides only low-cardinality process and SQLite readiness gauges.

```bash
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/readyz
curl http://127.0.0.1:3000/metrics
```

These endpoints have no authentication. Keep the native listener on loopback by default and do not expose `/metrics` directly to the public internet without network controls or an appropriate reverse-proxy policy.

## Docker runtime

The Docker image enables the operational listener on `0.0.0.0:3000`, runs as the non-root `node` user, and defaults `DATABASE_URL` to `file:/data/support.db`. Docker declares `/data` as a volume, so durable deployments must mount or otherwise persist `/data`; otherwise the database and its local backups disappear with an ephemeral container. The image healthcheck uses `/readyz`. `EXPOSE 3000` does not publish a host port by itself.

## SQLite backups

The bot creates verified SQLite online backups by default every 24 hours and keeps the newest 14. `BACKUP_DIR` overrides the default directory; otherwise it is `backups` beside the configured SQLite database. Set `BACKUP_ENABLED=false` to disable scheduled backups. `BACKUP_DIR=` intentionally selects the default directory. Use `npm run db:backup` for an on-demand verified backup and `npm run db:restore:verify -- <backup-path>` to validate a backup without touching the live database.

Backups are useful for bad deploys, accidental mutation, and logical corruption. A backup on the same disk does not protect against disk, VPS, or provider loss; copy verified backups to separately managed storage. Restrict an operator-provided `BACKUP_DIR` to the service account.

## Graceful shutdown

On `SIGINT` or `SIGTERM`, the process stops accepting new detached recovery work, stops polling, waits for active middleware and tracked database-dependent background work, then waits for any active automatic backup before closing SQLite. The scheduler stops creating future backups as soon as shutdown begins. A failed backup drain is logged safely and does not leave the database open indefinitely. `SIGKILL` cannot be drained by the application, so use it only after ordinary shutdown has failed.

Finalized managed backups are checksum-validated and SQLite-checked through isolated temporary copies, so normal discovery never opens or creates SQLite sidecars beside the finalized source. After final publication, a successful backup attempts to remove only the temporary database, checksum, WAL, and SHM sidecars created for that attempt. A cleanup failure is reported but does not remove the finalized backup or cause automatic backup draining to fail. It does not sweep or delete unrelated older temporary files in an operator-managed backup directory.

Pre-fix managed backup WAL/SHM/journal sidecars may be removed manually only after confirming they match an old managed backup filename. Retention removes those exact companions only when it has successfully removed that managed backup. Never remove live database `-wal` or `-shm` files while the service is running.

## Customer private-message anti-flood protection

Private customer ingress uses a permissive, in-memory per-user limiter to bound sustained abusive traffic while allowing ordinary bursts of screenshots, documents, and clarifications. A throttled message is not stored or forwarded; the customer is asked to wait briefly and resend it. The limiter does not ban, mute, or close tickets, and its process-local state resets on restart. Operator flows, staff test tickets, public moderation, Batch operations, and configuration input are not limited by this protection.

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
