import test from "node:test";
import assert from "node:assert/strict";
import { ApplicationLifecycle, awaitApplicationCompletion, BackgroundTaskRegistry } from "../src/lifecycle.js";

test("lifecycle stops polling and drains middleware, background work, and backups before closing SQLite once", async () => {
  const events: string[] = [];
  let releasePolling!: () => void;
  let releaseTask!: () => void;
  let releaseBackup!: () => void;
  let taskStarted!: () => void;
  const polling = new Promise<void>((resolve) => {
    releasePolling = resolve;
  });
  const task = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  const backup = new Promise<void>((resolve) => {
    releaseBackup = resolve;
  });
  const started = new Promise<void>((resolve) => {
    taskStarted = resolve;
  });
  const tasks = new BackgroundTaskRegistry();
  tasks.run(async () => {
    events.push("task-start");
    taskStarted();
    await task;
    events.push("task-end");
  });
  const lifecycle = new ApplicationLifecycle({
    stopPolling: () => {
      events.push("stop-polling");
      releasePolling();
    },
    pollingCompletion: () =>
      polling.then(() => {
        events.push("polling-drained");
      }),
    stopBackgroundWork: () => events.push("stop-background-work"),
    backgroundTasks: tasks,
    stopAndDrainBackups: async () => {
      events.push("backup-drain");
      await backup;
      events.push("backup-drained");
    },
    closeDatabase: () => events.push("db-close"),
  });

  await started;
  const shutdown = lifecycle.shutdown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["task-start", "stop-background-work", "backup-drain", "stop-polling", "polling-drained"]);
  releaseTask();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.slice(-1), ["task-end"]);
  releaseBackup();
  await shutdown;
  assert.deepEqual(events.slice(-2), ["backup-drained", "db-close"]);
  assert.equal(lifecycle.getState(), "STOPPED");
});

test("duplicate shutdown signals and startup failure close SQLite only once", async () => {
  let stops = 0;
  let closes = 0;
  const tasks = new BackgroundTaskRegistry();
  const lifecycle = new ApplicationLifecycle({
    stopPolling: () => {
      stops += 1;
    },
    pollingCompletion: () => null,
    backgroundTasks: tasks,
    closeDatabase: () => {
      closes += 1;
    },
  });
  await Promise.all([lifecycle.shutdown(), lifecycle.shutdown(), lifecycle.startupFailed()]);
  assert.equal(stops, 1);
  assert.equal(closes, 1);
  assert.equal(
    tasks.run(async () => undefined),
    false
  );
});

test("shutdown waits for in-flight startup work before closing SQLite", async () => {
  let releaseStartup!: () => void;
  let closes = 0;
  const startup = new Promise<void>((resolve) => {
    releaseStartup = resolve;
  });
  const lifecycle = new ApplicationLifecycle({
    stopPolling: () => undefined,
    startupCompletion: () => startup,
    pollingCompletion: () => null,
    backgroundTasks: new BackgroundTaskRegistry(),
    closeDatabase: () => {
      closes += 1;
    },
  });

  const shutdown = lifecycle.shutdown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 0);
  releaseStartup();
  await shutdown;
  assert.equal(closes, 1);
});

test("backup drain failure is logged and does not leave SQLite open", async () => {
  const failures: string[] = [];
  let closes = 0;
  const lifecycle = new ApplicationLifecycle({
    stopPolling: () => undefined,
    pollingCompletion: () => null,
    backgroundTasks: new BackgroundTaskRegistry(),
    stopAndDrainBackups: async () => {
      throw new Error("backup unavailable");
    },
    closeDatabase: () => {
      closes += 1;
    },
    onDrainFailure: (stage) => {
      failures.push(stage);
    },
  });
  await lifecycle.shutdown();
  assert.deepEqual(failures, ["backup"]);
  assert.equal(closes, 1);
});

test("a polling stop failure is isolated while remaining shutdown work still completes", async () => {
  const failures: string[] = [];
  let closes = 0;
  const lifecycle = new ApplicationLifecycle({
    stopPolling: () => {
      throw new Error("stop failed");
    },
    pollingCompletion: () => null,
    backgroundTasks: new BackgroundTaskRegistry(),
    closeDatabase: () => {
      closes += 1;
    },
    onDrainFailure: (stage) => {
      failures.push(stage);
    },
  });
  await lifecycle.shutdown();
  assert.deepEqual(failures, ["polling"]);
  assert.equal(closes, 1);
});

test("a database close failure is logged without reopening shutdown", async () => {
  const failures: string[] = [];
  let closes = 0;
  const lifecycle = new ApplicationLifecycle({
    stopPolling: () => undefined,
    pollingCompletion: () => null,
    backgroundTasks: new BackgroundTaskRegistry(),
    closeDatabase: () => {
      closes += 1;
      throw new Error("close failed");
    },
    onDrainFailure: (stage) => {
      failures.push(stage);
    },
  });
  await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]);
  assert.deepEqual(failures, ["database"]);
  assert.equal(closes, 1);
});

test("top-level runtime completion remains pending until shutdown drains background work", async () => {
  let releasePolling!: () => void;
  let releaseTask!: () => void;
  const polling = new Promise<void>((resolve) => {
    releasePolling = resolve;
  });
  const task = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  const tasks = new BackgroundTaskRegistry();
  tasks.run(async () => task);
  let closed = false;
  const lifecycle = new ApplicationLifecycle({
    stopPolling: releasePolling,
    pollingCompletion: () => polling,
    backgroundTasks: tasks,
    closeDatabase: () => {
      closed = true;
    },
  });
  let completed = false;
  const runtime = awaitApplicationCompletion(polling, lifecycle).then(() => {
    completed = true;
  });
  const shutdown = lifecycle.shutdown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(closed, false);
  releaseTask();
  await Promise.all([runtime, shutdown]);
  assert.equal(completed, true);
  assert.equal(closed, true);
});

test("normal polling completion drains resources without stopping an already-ended bot", async () => {
  let stops = 0;
  let closes = 0;
  const lifecycle = new ApplicationLifecycle({
    stopPolling: () => {
      stops += 1;
    },
    pollingCompletion: () => Promise.resolve(),
    backgroundTasks: new BackgroundTaskRegistry(),
    closeDatabase: () => {
      closes += 1;
    },
  });
  await awaitApplicationCompletion(Promise.resolve(), lifecycle);
  assert.equal(stops, 0);
  assert.equal(closes, 1);
});

test("lifecycle retires the operational listener before closing SQLite", async () => {
  const events: string[] = [];
  const lifecycle = new ApplicationLifecycle({
    stopPolling: () => undefined,
    pollingCompletion: () => null,
    backgroundTasks: new BackgroundTaskRegistry(),
    closeDatabase: () => events.push("db-close"),
    closeOperationalServer: async () => {
      events.push("server-close");
    },
  });
  const shutdown = lifecycle.shutdown();
  assert.equal(lifecycle.getState(), "SHUTTING_DOWN");
  await shutdown;
  assert.deepEqual(events, ["server-close", "db-close"]);
  assert.equal(lifecycle.getState(), "STOPPED");
});

test("shutdown deadline exits terminally without closing SQLite underneath a hung drain", async () => {
  let fireDeadline!: () => void;
  let closes = 0;
  const terminalExitCodes: number[] = [];
  const deadlineStages: string[] = [];
  const pending = new Promise<void>(() => undefined);
  const lifecycle = new ApplicationLifecycle({
    stopPolling: () => undefined,
    pollingCompletion: () => null,
    backgroundTasks: {
      run: () => true,
      stopAccepting: () => undefined,
      drain: () => pending,
    },
    closeDatabase: () => {
      closes += 1;
    },
    shutdownDeadlineMs: 30_000,
    createShutdownDeadlineTimer: (handler, delayMs) => {
      assert.equal(delayMs, 30_000);
      fireDeadline = handler;
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    },
    clearShutdownDeadlineTimer: () => undefined,
    terminalExit: (code) => {
      terminalExitCodes.push(code);
    },
    onShutdownDeadline: (stage) => {
      deadlineStages.push(stage);
    },
  });

  const shutdown = lifecycle.shutdown();
  await new Promise((resolve) => setImmediate(resolve));
  fireDeadline();
  await shutdown;

  assert.deepEqual(terminalExitCodes, [1]);
  assert.deepEqual(deadlineStages, ["background"]);
  assert.equal(closes, 0);
  assert.equal(lifecycle.getState(), "SHUTTING_DOWN");
});

test("background task telemetry preserves acceptance, completion, failure, and shutdown semantics", async () => {
  const tasks = new BackgroundTaskRegistry();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  assert.equal(
    tasks.run(async () => pending),
    true
  );
  assert.deepEqual(tasks.snapshot(), {
    accepting: true,
    inFlight: 1,
    acceptedTotal: 1,
    rejectedTotal: 0,
    completedTotal: 0,
    failedTotal: 0,
  });
  release();
  await tasks.drain();
  assert.equal(tasks.snapshot().completedTotal, 1);

  assert.equal(
    tasks.run(async () => {
      throw new Error("expected task failure");
    }),
    true
  );
  await tasks.drain();
  assert.equal(tasks.snapshot().completedTotal, 2);
  assert.equal(tasks.snapshot().failedTotal, 1);

  tasks.stopAccepting();
  assert.equal(
    tasks.run(async () => undefined),
    false
  );
  assert.equal(tasks.snapshot().rejectedTotal, 1);
  assert.equal(tasks.snapshot().accepting, false);
});
