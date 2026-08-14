import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, describe, it } from "node:test";
import { OperationalServer, type OperationalRuntimeState } from "../src/operationsHttp.js";

const servers: OperationalServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function request(port: number, path: string, method = "GET"): Promise<{ status: number; body: string; contentType: string | undefined }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: response.status, body: await response.text(), contentType: response.headers.get("content-type") ?? undefined };
}

function createOperationalServer(getState: () => OperationalRuntimeState, checkDatabase: () => boolean = () => true): OperationalServer {
  const server = new OperationalServer({ host: "127.0.0.1", port: 0, getState, checkDatabase });
  servers.push(server);
  return server;
}

describe("OperationalServer", () => {
  it("keeps health live while startup and readiness follows runtime/database state", async () => {
    let state: OperationalRuntimeState = "STARTING";
    let databaseReady = true;
    const server = createOperationalServer(() => state, () => databaseReady);
    await server.start();
    const port = server.port;
    assert.ok(port);

    assert.deepEqual(await request(port, "/healthz"), { status: 200, body: '{"status":"ok"}', contentType: "application/json; charset=utf-8" });
    assert.deepEqual(await request(port, "/readyz"), { status: 503, body: '{"status":"not_ready"}', contentType: "application/json; charset=utf-8" });

    state = "READY";
    assert.equal((await request(port, "/readyz")).status, 200);
    databaseReady = false;
    assert.equal((await request(port, "/readyz")).status, 503);
    const unavailable = createOperationalServer(() => "READY", () => { throw new Error("database unavailable"); });
    await unavailable.start();
    assert.equal((await request(unavailable.port!, "/readyz")).status, 503);
    assert.match((await request(unavailable.port!, "/metrics")).body, /^telegram_support_database_ready 0$/m);
    state = "SHUTTING_DOWN";
    assert.equal((await request(port, "/healthz")).status, 200);
    assert.equal((await request(port, "/readyz")).status, 503);
  });

  it("serves safe Prometheus metrics and conventional routing responses", async () => {
    let state: OperationalRuntimeState = "READY";
    const server = createOperationalServer(() => state, () => true);
    await server.start();
    const port = server.port;
    assert.ok(port);

    const metrics = await request(port, "/metrics");
    assert.equal(metrics.status, 200);
    assert.match(metrics.contentType ?? "", /^text\/plain/);
    for (const name of ["telegram_support_up", "telegram_support_ready", "telegram_support_process_uptime_seconds", "telegram_support_process_resident_memory_bytes", "telegram_support_process_heap_used_bytes", "telegram_support_process_heap_total_bytes", "telegram_support_database_ready"]) {
      assert.match(metrics.body, new RegExp(`^${name} \\d`, "m"));
    }
    assert.doesNotMatch(metrics.body, /test-secret|file:\/\/private|123456789/);
    assert.equal((await request(port, "/unknown")).status, 404);
    assert.equal((await request(port, "/healthz", "POST")).status, 405);
    assert.equal((await request(port, "/healthz", "HEAD")).body, "");

    state = "STOPPED";
    assert.match((await request(port, "/metrics")).body, /^telegram_support_ready 0$/m);
  });

  it("stops idempotently and rejects a bind conflict without retaining a listener", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    assert.ok(address && typeof address !== "string");
    const conflicting = new OperationalServer({ host: "127.0.0.1", port: address.port, getState: () => "STARTING", checkDatabase: () => true });
    await assert.rejects(conflicting.start(), /listen|EADDRINUSE/i);
    await conflicting.stop();
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));

    const server = createOperationalServer(() => "READY");
    await server.start();
    const port = server.port;
    await Promise.all([server.stop(), server.stop()]);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  });
});
