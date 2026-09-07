import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, describe, it } from "node:test";
import { OperationalServer } from "../src/operationsHttp.js";
import { RuntimeHealthRegistry, type OperationalRuntimeState } from "../src/runtimeObservability.js";
import type { BackgroundTaskSnapshot } from "../src/lifecycle.js";

const servers: OperationalServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function request(
  port: number,
  path: string,
  method = "GET"
): Promise<{ status: number; body: string; contentType: string | undefined }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("content-type") ?? undefined,
  };
}

function createOperationalServer(
  state: OperationalRuntimeState,
  checkDatabase: () => boolean = () => true
): { server: OperationalServer; health: RuntimeHealthRegistry } {
  const health = new RuntimeHealthRegistry({ backupEnabled: true, backupIntervalMs: 86_400_000 });
  health.setRuntimeState(state);
  if (state === "READY") health.markPollingStarted();
  const background: BackgroundTaskSnapshot = {
    accepting: true,
    inFlight: 0,
    acceptedTotal: 0,
    rejectedTotal: 0,
    completedTotal: 0,
    failedTotal: 0,
  };
  const server = new OperationalServer({
    host: "127.0.0.1",
    port: 0,
    getSnapshot: () => health.snapshot(background),
    checkDatabase,
    recordDatabaseProbe: (ready) => health.recordDatabaseProbe(ready),
  });
  servers.push(server);
  return { server, health };
}

describe("OperationalServer", () => {
  it("keeps health live while startup and readiness follows runtime/database state", async () => {
    let databaseReady = true;
    const { server, health } = createOperationalServer("STARTING", () => databaseReady);
    await server.start();
    const port = server.port;
    assert.ok(port);

    assert.deepEqual(await request(port, "/healthz"), {
      status: 200,
      body: '{"status":"ok"}',
      contentType: "application/json; charset=utf-8",
    });
    assert.deepEqual(await request(port, "/readyz"), {
      status: 503,
      body: '{"status":"not_ready"}',
      contentType: "application/json; charset=utf-8",
    });

    health.setRuntimeState("READY");
    health.markPollingStarted();
    assert.equal((await request(port, "/readyz")).status, 200);
    databaseReady = false;
    assert.equal((await request(port, "/readyz")).status, 503);
    const { server: unavailable } = createOperationalServer("READY", () => {
      throw new Error("database unavailable");
    });
    await unavailable.start();
    assert.equal((await request(unavailable.port!, "/readyz")).status, 503);
    assert.match((await request(unavailable.port!, "/metrics")).body, /^telegram_support_database_ready 0$/m);
    health.setRuntimeState("SHUTTING_DOWN");
    assert.equal((await request(port, "/healthz")).status, 200);
    assert.equal((await request(port, "/readyz")).status, 503);
  });

  it("serves safe Prometheus metrics and conventional routing responses", async () => {
    const { server, health } = createOperationalServer("READY", () => true);
    await server.start();
    const port = server.port;
    assert.ok(port);

    const metrics = await request(port, "/metrics");
    assert.equal(metrics.status, 200);
    assert.match(metrics.contentType ?? "", /^text\/plain/);
    for (const name of [
      "telegram_support_up",
      "telegram_support_ready",
      "telegram_support_process_uptime_seconds",
      "telegram_support_process_start_unixtime",
      "telegram_support_process_resident_memory_bytes",
      "telegram_support_process_heap_used_bytes",
      "telegram_support_process_heap_total_bytes",
      "telegram_support_database_ready",
      "telegram_support_database_consecutive_failures",
      "telegram_support_polling_active",
      "telegram_support_updates_processed_total",
      "telegram_support_update_errors_total",
      "telegram_support_background_tasks_inflight",
      "telegram_support_backup_enabled",
      "telegram_support_backup_success_total",
      "telegram_support_backup_failure_total",
      "telegram_support_backup_retention_deleted_total",
      "telegram_support_backup_age_seconds",
      "telegram_support_alert_delivery_failures_total",
    ]) {
      assert.match(metrics.body, new RegExp(`^${name} \\d`, "m"));
    }
    assert.doesNotMatch(metrics.body, /test-secret|file:\/\/private|123456789/);
    assert.equal((await request(port, "/unknown")).status, 404);
    assert.equal((await request(port, "/healthz", "POST")).status, 405);
    assert.equal((await request(port, "/healthz", "HEAD")).body, "");

    health.setRuntimeState("STOPPED");
    assert.match((await request(port, "/metrics")).body, /^telegram_support_ready 0$/m);
  });

  it("requires active healthy polling but not backup health for readiness", async () => {
    const { server, health } = createOperationalServer("READY");
    health.markPollingStopped();
    await server.start();
    assert.equal((await request(server.port!, "/readyz")).status, 503);

    health.markPollingStarted();
    health.recordBackupFailure();
    assert.equal((await request(server.port!, "/readyz")).status, 200);

    health.recordUnexpectedPollingTermination();
    assert.equal((await request(server.port!, "/readyz")).status, 503);
  });

  it("never exposes operational secrets or identifiers through metrics", async () => {
    const { server, health } = createOperationalServer("READY", () => {
      throw new Error("BOT_TOKEN=secret file://private 123456789");
    });
    health.recordUpdateError("unknown");
    await server.start();
    const metrics = (await request(server.port!, "/metrics")).body;
    assert.doesNotMatch(metrics, /secret|private|123456789|BOT_TOKEN/);
    assert.equal(metrics.endsWith("\n"), true);
  });

  it("stops idempotently and rejects a bind conflict without retaining a listener", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    assert.ok(address && typeof address !== "string");
    const health = new RuntimeHealthRegistry({ backupEnabled: false, backupIntervalMs: 1 });
    const conflicting = new OperationalServer({
      host: "127.0.0.1",
      port: address.port,
      getSnapshot: () => health.snapshot(),
      checkDatabase: () => true,
      recordDatabaseProbe: (ready) => health.recordDatabaseProbe(ready),
    });
    await assert.rejects(conflicting.start(), /listen|EADDRINUSE/i);
    await conflicting.stop();
    await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())));

    const { server } = createOperationalServer("READY");
    await server.start();
    const port = server.port;
    await Promise.all([server.stop(), server.stop()]);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  });
});
