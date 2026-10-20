# Operations

## Operational HTTP endpoints

Native and PM2 deployments leave the operational listener disabled by default. Enable it explicitly when a local reverse proxy or monitoring agent needs probes:

```env
OPS_HTTP_ENABLED=true
OPS_HTTP_HOST=127.0.0.1
OPS_HTTP_PORT=3000
```

`GET /healthz` returns `200` while the process and listener are alive. `GET /readyz` returns `200` only while the runtime is READY, Telegram polling is active and has not terminated unexpectedly, and a lightweight SQLite `SELECT 1` succeeds. Setup-required installations can still be ready. During graceful shutdown readiness becomes `503` before SQLite closes. Update failures and backup degradation remain observable without taking an otherwise working support runtime offline.

`GET /metrics` exposes process-lifetime counters and gauges for polling, aggregate update outcomes, tracked background work, database probes, automatic backup success/failure/freshness, and operational alert delivery. Metrics use only a fixed category set and never include chat, user, message, ticket, filesystem path, exception text, or secret labels. Backup freshness becomes stale after the greater of twice the configured interval or the configured interval plus one hour. Disabled backups report disabled and never become stale.

## Delivery reconciliation

Interactive staff replies, Ticket Batch user replies, and Support Logs archive delivery persist a durable intent before Telegram is called. A process interruption while an intent is `PENDING`, or any ambiguous transport outcome, becomes `UNKNOWN_DELIVERY` during startup recovery. The application deliberately does not resend those operations because Telegram has no application idempotency key. Ambiguous entity-notification sends are likewise retained without replay.

Customer-to-staff routing records the source chat/message before `CREATE_TOPIC`, `SEND_SUMMARY`, `SEND_INITIAL_POST` / `SEND_UPDATE`, and required `COPY_ORIGINAL` calls. Media and long text require that final copy; a formatted post alone does not complete routing. Each attempt has identity `inbound:<source-chat>:<source-message>:<stage>:<attempt>`. Interrupted claims become `UNKNOWN_DELIVERY` at startup without a Telegram call.

A confirmed missing-topic rejection may rebind the unsent stage to an already-created replacement, or elect one replacement owner, with a new attempt identity. Required copies retain the proven formatted-message/transcript record and do not repeat it. An ambiguous old-topic result never takes this path. A historical active ticket with no topic and no nonterminal provisioning owner elects the next source operation as owner; other sources wait for that owner, including while its outcome requires reconciliation.

OWNER and ADMIN operators can open **Delivery review** from the private dashboard. For each unresolved operation, verify the destination directly in Telegram before choosing an action:

1. **Mark delivered** requires the numeric Telegram message ID, or the actual `message_thread_id` for inbound topic creation. Verify the correct ticket and bound workspace. It records local proof and continues the existing state machine at the next stage, never resending the reconciled side effect. A later stage can independently become unknown.
2. **Mark not delivered** requires an operator note of 1 to 500 characters. It does not retry the operation. Inbound routing waits in `RETRY_REQUIRED`; **Start NEW attempt** is a separate deliberate action which increments the attempt identity and records who requested it before any new Telegram call. A duplicate request cannot repeat the attempt.
3. **Continue safe routing** resumes inbound `READY` / confirmed-rejection `FAILED` work if a previous continuation was interrupted. It cannot claim an unknown or in-flight attempt. No retry timer or new recovery worker is introduced.

Archive permits only terminal `DELIVERED` / `CANCELLED` inbound operations. `READY`, `FAILED`, `RETRY_REQUIRED`, `PENDING`, and `UNKNOWN_DELIVERY` remain unresolved. Closing a ticket atomically cancels unsent provisioning/formatted-post work and retains its full received text/media metadata in the transcript without claiming staff delivery. A required original copy in `READY` may finish on a closed ticket without reopening it. If Telegram positively rejects that copy, or an operator confirms non-delivery, the closed ticket's copy becomes `CANCELLED`, not delivered: received content and file metadata are retained for the archive, and the copy is not resent automatically. Confirmed copy failures on open tickets remain eligible for controlled safe continuation. `PENDING` and `UNKNOWN_DELIVERY` copies still block archive. A real in-flight send is never cancelled by closure alone: its result must first be proven or reconciled. When routing reaches a terminal result after closure and no unresolved inbound work remains, the existing bound-workspace archive path resumes automatically. A pre-claim workspace mismatch cancels unsent routing without writing into the moved ticket.

Ready inbound updates and required copies drain in ordered chunks until the ticket's ready queue is empty. Draining stops if the active workspace changes or an operation makes no durable state/stage/attempt progress; the latter logs a warning instead of spinning. It never claims `PENDING`, `UNKNOWN_DELIVERY`, or `RETRY_REQUIRED` work and introduces no retry worker.

If a ticket changes while a Batch user reply is in flight, proven delivery is retained but stale follow-up changes are rejected. `FOLLOW_UP_NOT_APPLIED_CONCURRENT_CHANGE` in the item's existing `last_error` records that local conflict, not a Telegram failure. The staff event and final summary report that follow-up, internal note, and escalation were not applied; the original requested context remains on the Batch item. Staff-only recovery completes `reply_keep_open` (or marks it inactive if already closed) without a second user send. `reply_and_close` retains its existing close/archive continuation.

If follow-up persistence itself fails, matching durable history distinguishes an already-committed transition from unapplied context. The latter is retained as `FOLLOW_UP_NOT_APPLIED_PERSISTENCE_FAILURE` and reported separately; recovery never claims it was applied. Full staff-recovery chunks yield through the existing tracked recovery timer so remaining confirmed deliveries can finish without replaying user replies.

The first valid reconciliation wins. Repeating the same reconciliation is idempotent; a contradictory later action is rejected. Every applied action records the operator, time, prior and resulting state, note, and supplied Telegram message ID in an append-only audit trail. A demoted operator or an operator no longer present in the active staff workspace cannot act through a stale screen. There is intentionally no "retry unknown delivery" action; any later deliberate delivery must use a new audited operation identity.

```bash
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/readyz
curl http://127.0.0.1:3000/metrics
```

These endpoints have no authentication. Keep the native listener on loopback by default and do not expose `/metrics` directly to the public internet without network controls or an appropriate reverse-proxy policy.

The runtime evaluates health once per minute with one SQLite ping. After a successful ping it samples durable backlogs through five fixed read-only aggregate queries in one SQLite read transaction. `/metrics` serves the cached observation; it does not execute backlog queries. A cheap active-workspace lookup prevents a cached observation from another workspace appearing as current. Database, polling, and backup alerts retain their existing ordering and behavior: database alerts require three consecutive failed probes; polling termination and hard scheduled-backup failure alert immediately; persistent conditions are deduplicated. Alert state and counters reset on process restart.

### Durable backlog observations

All backlog counts belong to the active configured staff workspace. They contain no per-ticket, per-user, operation-key, or chat labels. An observed empty queue reports count and age zero. Before the first sample, during installation without a workspace, or after a workspace change before its first sample, queue measurements are `NaN`, not a claimed zero. A failed observation retains the last good measurements for the same workspace, sets `telegram_support_backlog_sample_success` to zero, and increments `telegram_support_backlog_observation_failures_total`. A failed readiness probe skips observation and clears sample success without incrementing this query-attempt counter or changing the last-attempt timestamp. Telemetry failure does not make an otherwise healthy `/readyz` fail.

| Metric suffix (all start with `telegram_support_`)                                                  | Meaning                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backlog_workspace_configured`, `backlog_sample_available`, `backlog_sample_success`                | Scope and observation availability/success gauges. Unknown workspace lookup reports `NaN` for configured.                                                                                                                                        |
| `backlog_last_attempt_unixtime`, `backlog_last_success_unixtime`, `backlog_observation_age_seconds` | Attempt/success UTC timestamps and sample age; absent success has timestamp zero and age `NaN`.                                                                                                                                                  |
| `delivery_review_cases`, `delivery_review_oldest_update_age_seconds`                                | The existing unresolved Delivery Review queue, including inbound `READY`, `FAILED`, and `RETRY_REQUIRED`; age is since its oldest last-state `updated_at`. Reconciled cases are excluded by the shared queue predicate.                          |
| `unknown_delivery_count`                                                                            | Actual `UNKNOWN_DELIVERY` operations in review, Batch outbound intents (including an orphan before its item becomes reviewable), and Batch final summaries. Batch intent/item representations count once. This is not the complete review count. |
| `batch_recovery_due_count`, `batch_recovery_oldest_overdue_seconds`                                 | Runnable staff topic echoes, failure events, final summaries, reply-and-close/silent-close continuations, and local invalid/closed-echo normalization. Each answer item counts once.                                                             |
| `moderation_cleanup_due_count`, `moderation_cleanup_oldest_overdue_seconds`                         | `PENDING`, `CLEANING`, or `LOG_PENDING` jobs whose `cleanup_due_at` has arrived.                                                                                                                                                                 |
| `archive_recovery_eligible_count`, `archive_recovery_oldest_closed_age_seconds`                     | Closed, unarchived tickets with history and no unresolved inbound/outbound delivery, live/unknown archive claim, or operator-confirmed archive rejection. Age is since `closed_at`, not time since eligibility began.                            |
| `batch_export_unknown_delivery_count`                                                               | Independent unknown Batch export deliveries; these are not Delivery Review UI cases.                                                                                                                                                             |

Queue ages and overdue durations are measured at sample time and clamp future timestamps to zero. Batch null retry dates are immediately eligible where the recovery selector permits them, but have no proven due timestamp: they contribute zero overdue age. Local invalid/closed-echo normalization likewise has no overdue clock. Invalid echoes and due silent-close items with a missing ticket still count where recovery can resolve them locally; a present ticket in another workspace is excluded. Future retry dates, the no-retry sentinel, terminal staff failures, wrong-workspace tickets, and closed continuations blocked by unresolved archive delivery are excluded from automatic overdue work. Eligible archive work remains bounded startup/manual recovery; these metrics add no archive worker.

Two additional alert conditions use only fresh successful observations (at most 120 seconds old) while the runtime is READY with active polling:

- `DELIVERY_REVIEW_STALE`: at least one open review case has had no state update for 60 minutes.
- `AUTOMATED_RECOVERY_OVERDUE`: runnable Batch work or a due moderation cleanup job has an explicit due/retry timestamp overdue by 30 minutes.

Each condition emits one FIRING transition and one RECOVERED transition through the existing tracked alert coordinator, using only aggregate counts/ages. A failed or stale sample cannot recover an alert. Temporary workspace lookup failure also preserves alert deduplication. Backlog alerts stay bound to their observed workspace and are discarded if that destination changes before delivery. No alert replays an unknown Telegram operation.

The query plans use the existing workspace/package, ticket/state, moderation-due, message/ticket, and audit/workspace indexes. Review cases are materialized once per observation; SQL deduplication uses temporary sets, not JavaScript case loading. Counts still scale with the active workspace's ticket/package history and unresolved rows: this is a fixed query workload, not a constant-time row count or an enforced wall-clock deadline. No indexes or migrations were added. Revalidate eligibility and query plans when recovery predicates, delivery states, or their indexes change. Handler-duration and Telegram arrival-lag histograms are deferred from this workstream.

## Docker runtime

The Docker image uses the digest-pinned Node.js 24 LTS Bookworm Slim base, enables the operational listener on `0.0.0.0:3000`, runs as the non-root `node` user, and defaults `DATABASE_URL` to `file:/data/support.db`. Docker declares `/data` as a volume, so durable deployments must mount or otherwise persist `/data`; otherwise the database and its local backups disappear with an ephemeral container. The image healthcheck uses `/readyz`. `EXPOSE 3000` and binding to `0.0.0.0` inside the container do not publish a host port by themselves. This repository contains no host-port publication configuration; if a deployment publishes port 3000, bind it to loopback or a private network and enforce firewall or reverse-proxy ACLs. These unauthenticated aggregate operational endpoints remain internal data.

## SQLite backups

The bot creates verified SQLite online backups by default every 24 hours and keeps the newest 14. `BACKUP_DIR` overrides the default directory; otherwise it is `backups` beside the configured SQLite database. Set `BACKUP_ENABLED=false` to disable scheduled backups. `BACKUP_DIR=` intentionally selects the default directory. Use `npm run db:backup` for an on-demand verified backup and `npm run db:restore:verify -- <backup-path>` to validate a backup without touching the live database.

Backups are useful for bad deploys, accidental mutation, and logical corruption. A backup on the same disk does not protect against disk, VPS, or provider loss; copy verified backups to separately managed storage. Restrict an operator-provided `BACKUP_DIR` to the service account.

## Graceful shutdown

Signal handlers are installed before asynchronous startup recovery begins. Startup handles at most 50 durable archive or moderation recovery items, or 10 seconds of recovery work, whichever comes first. The time budget is checked only between durable item boundaries: an already-started Telegram or SQLite operation is allowed to finish. Unfinished archive or moderation work remains durable and resumes on a later recovery/startup; automatic post-polling continuation is intentionally deferred until those delivery paths have stronger idempotency and crash-consistency guarantees. Ticket Batch recovery begins after polling as tracked background work because its runtime already owns durable recovery, workspace validation, retry scheduling, and UNKNOWN_DELIVERY semantics.

On `SIGINT` or `SIGTERM`, the process becomes non-ready, stops accepting new detached recovery work and future backup scheduling, stops polling, drains active middleware, tracked database-dependent background work, and an active backup, then closes the operational listener and SQLite last. The total graceful-shutdown deadline is 30 seconds. If it expires, the process logs the stage still pending and exits non-zero without closing SQLite underneath unfinished work so the supervisor can restart it safely. `SIGKILL` cannot be drained by the application, so use it only after ordinary shutdown has failed.

This repository does not contain a PM2 ecosystem configuration. Production PM2 must set `kill_timeout` to at least `35000`; `40000` milliseconds is the recommended value so PM2 does not send `SIGKILL` before the application's 30-second graceful window has elapsed. This is a deployment requirement and does not change an existing supervisor configuration automatically.

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
