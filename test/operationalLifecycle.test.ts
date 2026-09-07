import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationLifecycle, BackgroundTaskRegistry } from "../src/lifecycle.js";
import { OperationalServer } from "../src/operationsHttp.js";
import {
  OperationalAlertCoordinator,
  RuntimeHealthEvaluator,
  RuntimeHealthRegistry,
  observePollingCompletion,
} from "../src/runtimeObservability.js";

test("shutdown makes readiness unavailable before closing SQLite and the operational listener", async () => {
  const health = new RuntimeHealthRegistry({ backupEnabled: false, backupIntervalMs: 86_400_000 });
  health.setRuntimeState("READY");
  health.markPollingStarted();
  let databaseClosed = false;
  let releaseTask!: () => void;
  let taskStarted!: () => void;
  const backgroundTasks = new BackgroundTaskRegistry();
  const task = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  const started = new Promise<void>((resolve) => {
    taskStarted = resolve;
  });
  backgroundTasks.run(async () => {
    taskStarted();
    await task;
  });
  const server = new OperationalServer({
    host: "127.0.0.1",
    port: 0,
    getSnapshot: () => health.snapshot(backgroundTasks.snapshot()),
    checkDatabase: () => !databaseClosed,
    recordDatabaseProbe: (ready) => health.recordDatabaseProbe(ready),
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
    closeDatabase: () => {
      databaseClosed = true;
    },
    closeOperationalServer: () => server.stop(),
  });
  health.setRuntimeState("SHUTTING_DOWN");
  const shutdown = lifecycle.shutdown();
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 503);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  releaseTask();
  await shutdown;
  assert.equal(databaseClosed, true);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
});

test("controlled shutdown stops health evaluation and polling without generating an incident alert", async () => {
  const health = new RuntimeHealthRegistry({ backupEnabled: true, backupIntervalMs: 3_600_000 });
  health.setRuntimeState("READY");
  health.markPollingStarted();
  const backgroundTasks = new BackgroundTaskRegistry();
  const alerts: string[] = [];
  const coordinator = new OperationalAlertCoordinator({
    health,
    backgroundTasks,
    getStaffChatId: () => -100900,
    sendMessage: async (_chatId, text) => void alerts.push(text),
  });
  let timerCallback: (() => void) | undefined;
  const evaluator = new RuntimeHealthEvaluator({
    health,
    checkDatabase: () => true,
    evaluateAlerts: () => coordinator.evaluate(health.snapshot(backgroundTasks.snapshot())),
    setTimer: (callback) => {
      timerCallback = callback;
      return { unref: () => undefined };
    },
    clearTimer: () => undefined,
  });
  evaluator.start();
  let finishPolling!: () => void;
  const rawPolling = new Promise<void>((resolve) => {
    finishPolling = resolve;
  });
  let unexpectedTerminations = 0;
  const lifecycleRef: { current?: ApplicationLifecycle } = {};
  const polling = observePollingCompletion(rawPolling, {
    health,
    isExpectedTermination: () => lifecycleRef.current?.getState() !== "RUNNING",
    onUnexpectedTermination: () => {
      unexpectedTerminations += 1;
      coordinator.evaluate(health.snapshot(backgroundTasks.snapshot()));
    },
  });
  const lifecycle = new ApplicationLifecycle({
    stopPolling: finishPolling,
    pollingCompletion: () => polling,
    stopBackgroundWork: () => {
      health.setRuntimeState("SHUTTING_DOWN");
      evaluator.stop();
    },
    backgroundTasks,
    closeDatabase: () => undefined,
  });
  lifecycleRef.current = lifecycle;

  await lifecycle.shutdown();
  timerCallback?.();
  await backgroundTasks.drain();
  assert.equal(unexpectedTerminations, 0);
  assert.equal(health.snapshot().pollingUnexpectedTerminationsTotal, 0);
  assert.deepEqual(alerts, []);
});
