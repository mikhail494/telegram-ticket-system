import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RuntimeHealthSnapshot } from "./runtimeObservability.js";

export type { OperationalRuntimeState } from "./runtimeObservability.js";

export interface OperationalServerOptions {
  host: string;
  port: number;
  getSnapshot(): RuntimeHealthSnapshot;
  checkDatabase(): boolean;
  recordDatabaseProbe(ready: boolean): void;
}

export class OperationalServer {
  private server: Server | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: OperationalServerOptions) {}

  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address.port : null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => this.handleRequest(request, response));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.options.port, this.options.host);
      });
    } catch (error) {
      this.server = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.stopPromise = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    }).finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    request.resume();
    if (request.method !== "GET" && request.method !== "HEAD") {
      this.respond(response, request.method, 405, "text/plain; charset=utf-8", "Method Not Allowed");
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/healthz") {
      this.respond(response, request.method, 200, "application/json; charset=utf-8", '{"status":"ok"}');
      return;
    }
    if (pathname === "/readyz") {
      const ready = this.isReady();
      this.respond(
        response,
        request.method,
        ready ? 200 : 503,
        "application/json; charset=utf-8",
        ready ? '{"status":"ready"}' : '{"status":"not_ready"}'
      );
      return;
    }
    if (pathname === "/metrics") {
      this.respond(response, request.method, 200, "text/plain; version=0.0.4; charset=utf-8", this.metrics());
      return;
    }

    this.respond(response, request.method, 404, "text/plain; charset=utf-8", "Not Found");
  }

  private isReady(): boolean {
    const databaseReady = this.databaseReady();
    return this.snapshotReady(this.options.getSnapshot(), databaseReady);
  }

  private databaseReady(): boolean {
    let ready = false;
    try {
      ready = this.options.checkDatabase();
    } catch {
      ready = false;
    }
    this.options.recordDatabaseProbe(ready);
    return ready;
  }

  private metrics(): string {
    const databaseReady = this.databaseReady();
    const snapshot = this.options.getSnapshot();
    const ready = this.snapshotReady(snapshot, databaseReady);
    const memory = process.memoryUsage();
    return [
      "# HELP telegram_support_up Whether the operational HTTP server is running.",
      "# TYPE telegram_support_up gauge",
      "telegram_support_up 1",
      "# HELP telegram_support_ready Whether Telegram support runtime is ready to serve work.",
      "# TYPE telegram_support_ready gauge",
      `telegram_support_ready ${ready ? 1 : 0}`,
      "# HELP telegram_support_runtime_ready Whether runtime, polling, and SQLite are ready for support work.",
      "# TYPE telegram_support_runtime_ready gauge",
      `telegram_support_runtime_ready ${ready ? 1 : 0}`,
      "# HELP telegram_support_process_uptime_seconds Process uptime in seconds.",
      "# TYPE telegram_support_process_uptime_seconds gauge",
      `telegram_support_process_uptime_seconds ${process.uptime()}`,
      "# HELP telegram_support_process_start_unixtime Unix time when this runtime health registry started.",
      "# TYPE telegram_support_process_start_unixtime gauge",
      `telegram_support_process_start_unixtime ${unixTime(snapshot.processStartedAt)}`,
      "# HELP telegram_support_process_resident_memory_bytes Process resident memory in bytes.",
      "# TYPE telegram_support_process_resident_memory_bytes gauge",
      `telegram_support_process_resident_memory_bytes ${memory.rss}`,
      "# HELP telegram_support_process_heap_used_bytes Process heap used in bytes.",
      "# TYPE telegram_support_process_heap_used_bytes gauge",
      `telegram_support_process_heap_used_bytes ${memory.heapUsed}`,
      "# HELP telegram_support_process_heap_total_bytes Process heap total in bytes.",
      "# TYPE telegram_support_process_heap_total_bytes gauge",
      `telegram_support_process_heap_total_bytes ${memory.heapTotal}`,
      "# HELP telegram_support_database_ready Whether the local SQLite probe succeeds.",
      "# TYPE telegram_support_database_ready gauge",
      `telegram_support_database_ready ${databaseReady ? 1 : 0}`,
      "# HELP telegram_support_database_consecutive_failures Consecutive failed SQLite readiness probes.",
      "# TYPE telegram_support_database_consecutive_failures gauge",
      `telegram_support_database_consecutive_failures ${snapshot.databaseConsecutiveFailures}`,
      "# HELP telegram_support_database_last_success_unixtime Unix time of the last successful SQLite probe.",
      "# TYPE telegram_support_database_last_success_unixtime gauge",
      `telegram_support_database_last_success_unixtime ${unixTime(snapshot.lastDatabaseSuccessAt)}`,
      "# HELP telegram_support_database_last_failure_unixtime Unix time of the last failed SQLite probe.",
      "# TYPE telegram_support_database_last_failure_unixtime gauge",
      `telegram_support_database_last_failure_unixtime ${unixTime(snapshot.lastDatabaseFailureAt)}`,
      "# HELP telegram_support_polling_active Whether Telegram polling is active.",
      "# TYPE telegram_support_polling_active gauge",
      `telegram_support_polling_active ${snapshot.pollingActive ? 1 : 0}`,
      "# HELP telegram_support_polling_unexpected_terminations_total Unexpected Telegram polling terminations.",
      "# TYPE telegram_support_polling_unexpected_terminations_total counter",
      `telegram_support_polling_unexpected_terminations_total ${snapshot.pollingUnexpectedTerminationsTotal}`,
      "# HELP telegram_support_updates_processed_total Telegram updates completed successfully.",
      "# TYPE telegram_support_updates_processed_total counter",
      `telegram_support_updates_processed_total ${snapshot.updatesProcessedTotal}`,
      "# HELP telegram_support_update_errors_total Telegram update handler failures.",
      "# TYPE telegram_support_update_errors_total counter",
      `telegram_support_update_errors_total ${snapshot.updateErrorsTotal}`,
      "# HELP telegram_support_update_errors_by_category_total Telegram update failures by fixed safe category.",
      "# TYPE telegram_support_update_errors_by_category_total counter",
      `telegram_support_update_errors_by_category_total{category="telegram"} ${snapshot.updateErrorsByCategory.telegram}`,
      `telegram_support_update_errors_by_category_total{category="http"} ${snapshot.updateErrorsByCategory.http}`,
      `telegram_support_update_errors_by_category_total{category="unknown"} ${snapshot.updateErrorsByCategory.unknown}`,
      "# HELP telegram_support_last_update_success_unixtime Unix time of the last successful update.",
      "# TYPE telegram_support_last_update_success_unixtime gauge",
      `telegram_support_last_update_success_unixtime ${unixTime(snapshot.lastUpdateSuccessAt)}`,
      "# HELP telegram_support_last_update_error_unixtime Unix time of the last failed update.",
      "# TYPE telegram_support_last_update_error_unixtime gauge",
      `telegram_support_last_update_error_unixtime ${unixTime(snapshot.lastUpdateErrorAt)}`,
      "# HELP telegram_support_background_tasks_accepting Whether detached background work is accepted.",
      "# TYPE telegram_support_background_tasks_accepting gauge",
      `telegram_support_background_tasks_accepting ${snapshot.backgroundTasksAccepting ? 1 : 0}`,
      "# HELP telegram_support_background_tasks_inflight Currently tracked background tasks.",
      "# TYPE telegram_support_background_tasks_inflight gauge",
      `telegram_support_background_tasks_inflight ${snapshot.backgroundTasksInFlight}`,
      "# HELP telegram_support_background_tasks_accepted_total Accepted background tasks.",
      "# TYPE telegram_support_background_tasks_accepted_total counter",
      `telegram_support_background_tasks_accepted_total ${snapshot.backgroundTasksAcceptedTotal}`,
      "# HELP telegram_support_background_tasks_rejected_total Background tasks rejected after shutdown began.",
      "# TYPE telegram_support_background_tasks_rejected_total counter",
      `telegram_support_background_tasks_rejected_total ${snapshot.backgroundTasksRejectedTotal}`,
      "# HELP telegram_support_background_tasks_completed_total Completed background tasks including failures.",
      "# TYPE telegram_support_background_tasks_completed_total counter",
      `telegram_support_background_tasks_completed_total ${snapshot.backgroundTasksCompletedTotal}`,
      "# HELP telegram_support_background_tasks_failed_total Failed background tasks.",
      "# TYPE telegram_support_background_tasks_failed_total counter",
      `telegram_support_background_tasks_failed_total ${snapshot.backgroundTasksFailedTotal}`,
      "# HELP telegram_support_backup_enabled Whether automatic SQLite backups are enabled.",
      "# TYPE telegram_support_backup_enabled gauge",
      `telegram_support_backup_enabled ${snapshot.backupEnabled ? 1 : 0}`,
      "# HELP telegram_support_backup_success_total Successful finalized SQLite backups.",
      "# TYPE telegram_support_backup_success_total counter",
      `telegram_support_backup_success_total ${snapshot.backupSuccessTotal}`,
      "# HELP telegram_support_backup_failure_total Hard SQLite backup failures.",
      "# TYPE telegram_support_backup_failure_total counter",
      `telegram_support_backup_failure_total ${snapshot.backupFailureTotal}`,
      "# HELP telegram_support_backup_consecutive_failures Consecutive hard SQLite backup failures.",
      "# TYPE telegram_support_backup_consecutive_failures gauge",
      `telegram_support_backup_consecutive_failures ${snapshot.backupConsecutiveFailures}`,
      "# HELP telegram_support_backup_last_success_unixtime Unix time of the last successful backup.",
      "# TYPE telegram_support_backup_last_success_unixtime gauge",
      `telegram_support_backup_last_success_unixtime ${unixTime(snapshot.backupLastSuccessAt)}`,
      "# HELP telegram_support_backup_last_failure_unixtime Unix time of the last hard backup failure.",
      "# TYPE telegram_support_backup_last_failure_unixtime gauge",
      `telegram_support_backup_last_failure_unixtime ${unixTime(snapshot.backupLastFailureAt)}`,
      "# HELP telegram_support_backup_last_size_bytes Size of the last successful backup.",
      "# TYPE telegram_support_backup_last_size_bytes gauge",
      `telegram_support_backup_last_size_bytes ${snapshot.backupLastSizeBytes}`,
      "# HELP telegram_support_backup_retention_deleted_total Backups removed by successful retention cleanup.",
      "# TYPE telegram_support_backup_retention_deleted_total counter",
      `telegram_support_backup_retention_deleted_total ${snapshot.backupRetentionDeletedTotal}`,
      "# HELP telegram_support_backup_retention_failures_total Backup retention cleanup failures.",
      "# TYPE telegram_support_backup_retention_failures_total counter",
      `telegram_support_backup_retention_failures_total ${snapshot.backupRetentionFailuresTotal}`,
      "# HELP telegram_support_backup_temp_cleanup_failures_total Backup temporary artifact cleanup failures.",
      "# TYPE telegram_support_backup_temp_cleanup_failures_total counter",
      `telegram_support_backup_temp_cleanup_failures_total ${snapshot.backupTempCleanupFailuresTotal}`,
      "# HELP telegram_support_backup_age_seconds Age of the last successful backup, or zero before one succeeds.",
      "# TYPE telegram_support_backup_age_seconds gauge",
      `telegram_support_backup_age_seconds ${snapshot.backupAgeSeconds}`,
      "# HELP telegram_support_backup_stale Whether enabled backups exceeded the freshness window.",
      "# TYPE telegram_support_backup_stale gauge",
      `telegram_support_backup_stale ${snapshot.backupStale ? 1 : 0}`,
      "# HELP telegram_support_alert_delivery_failures_total Operational alert delivery failures.",
      "# TYPE telegram_support_alert_delivery_failures_total counter",
      `telegram_support_alert_delivery_failures_total ${snapshot.alertDeliveryFailuresTotal}`,
      "",
    ].join("\n");
  }

  private snapshotReady(snapshot: RuntimeHealthSnapshot, databaseReady: boolean): boolean {
    return (
      snapshot.runtimeState === "READY" &&
      databaseReady &&
      snapshot.pollingActive &&
      !snapshot.pollingUnexpectedlyTerminated
    );
  }

  private respond(
    response: ServerResponse,
    method: string | undefined,
    status: number,
    contentType: string,
    body: string
  ): void {
    response.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
    response.end(method === "HEAD" ? undefined : body);
  }
}

function unixTime(value: Date | null): number {
  return value ? Math.floor(value.getTime() / 1000) : 0;
}
