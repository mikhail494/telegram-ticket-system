import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationLifecycle, BackgroundTaskRegistry } from "../src/lifecycle.js";
import { OperationalServer, type OperationalRuntimeState } from "../src/operationsHttp.js";

test("shutdown makes readiness unavailable before closing SQLite and the operational listener", async () => {
  let state: OperationalRuntimeState = "READY";
  let databaseClosed = false;
  let releaseTask!: () => void;
  let taskStarted!: () => void;
  const backgroundTasks = new BackgroundTaskRegistry();
  const task = new Promise<void>((resolve) => { releaseTask = resolve; });
  const started = new Promise<void>((resolve) => { taskStarted = resolve; });
  backgroundTasks.run(async () => { taskStarted(); await task; });
  const server = new OperationalServer({
    host: "127.0.0.1",
    port: 0,
    getState: () => state,
    checkDatabase: () => !databaseClosed
  });
  await server.start();
  await started;
  const port = server.port;
  assert.ok(port);
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200);

  const lifecycle = new ApplicationLifecycle({
    stopPolling: () => undefined,
    pollingCompletion: () => null,
    backgroundTasks,
    closeDatabase: () => { databaseClosed = true; },
    closeOperationalServer: () => server.stop()
  });
  state = "SHUTTING_DOWN";
  const shutdown = lifecycle.shutdown();
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 503);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  releaseTask();
  await shutdown;
  assert.equal(databaseClosed, true);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
});
