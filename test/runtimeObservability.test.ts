import assert from "node:assert/strict";
import test from "node:test";
import {
  OperationalAlertCoordinator,
  RuntimeHealthEvaluator,
  RuntimeHealthRegistry,
  observePollingCompletion,
} from "../src/runtimeObservability.js";
import { BackgroundTaskRegistry } from "../src/lifecycle.js";
import type { Update } from "grammy/types";
import { createBotHarness } from "./helpers/botHarness.js";

const HOUR = 3_600_000;

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: unknown): void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("runtime health records bounded deterministic operational telemetry", () => {
  let now = new Date("2026-09-05T10:00:00.000Z");
  const health = new RuntimeHealthRegistry({
    backupEnabled: true,
    backupIntervalMs: 24 * HOUR,
    now: () => now,
    processStartedAt: now,
  });

  health.setRuntimeState("READY");
  health.recordDatabaseProbe(true);
  health.markPollingStarted();
  health.recordUpdateSuccess();
  health.recordUpdateError("telegram");
  health.recordBackupFailure();
  now = new Date("2026-09-05T11:00:00.000Z");
  health.recordBackupSuccess({ size: 4096, retentionDeleted: 3, retentionFailed: 2, tempCleanupFailed: 1 });

  const snapshot = health.snapshot({
    accepting: true,
    inFlight: 2,
    acceptedTotal: 4,
    rejectedTotal: 1,
    completedTotal: 2,
    failedTotal: 1,
  });
  assert.equal(snapshot.runtimeState, "READY");
  assert.equal(snapshot.processStartedAt.toISOString(), "2026-09-05T10:00:00.000Z");
  assert.equal(snapshot.processUptimeSeconds, 3600);
  assert.equal(snapshot.databaseReady, true);
  assert.equal(snapshot.pollingActive, true);
  assert.equal(snapshot.updatesProcessedTotal, 1);
  assert.equal(snapshot.updateErrorsTotal, 1);
  assert.deepEqual(snapshot.updateErrorsByCategory, { telegram: 1, http: 0, unknown: 0 });
  assert.equal(snapshot.backupSuccessTotal, 1);
  assert.equal(snapshot.backupFailureTotal, 1);
  assert.equal(snapshot.backupConsecutiveFailures, 0);
  assert.equal(snapshot.backupLastSizeBytes, 4096);
  assert.equal(snapshot.backupRetentionDeletedTotal, 3);
  assert.equal(snapshot.backupRetentionFailuresTotal, 2);
  assert.equal(snapshot.backupTempCleanupFailuresTotal, 1);
  assert.equal(snapshot.backgroundTasksInFlight, 2);
  assert.equal(snapshot.lastUpdateSuccessAt?.toISOString(), "2026-09-05T10:00:00.000Z");
  assert.equal(snapshot.lastUpdateErrorAt?.toISOString(), "2026-09-05T10:00:00.000Z");
});

test("bot middleware counts successful and failed updates without swallowing failures", async () => {
  const health = new RuntimeHealthRegistry({ backupEnabled: false, backupIntervalMs: HOUR });
  const harness = createBotHarness({ runtimeHealth: health });
  const update = (updateId: number, text: string): Update => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      from: { id: 500, is_bot: false, first_name: "Customer" },
      chat: { id: 500, type: "private", first_name: "Customer" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    },
  });
  try {
    await harness.bot.handleUpdate(update(1, "/help"));
    harness.failNextApiCall("sendMessage", "private token 123456789");
    await assert.rejects(harness.bot.handleUpdate(update(2, "/help")), /private token/);
    const snapshot = health.snapshot();
    assert.equal(snapshot.updatesProcessedTotal, 1);
    assert.equal(snapshot.updateErrorsTotal, 1);
    assert.equal(snapshot.updateErrorsByCategory.telegram, 1);
  } finally {
    harness.cleanup();
  }
});

test("backup freshness is interval-derived and disabled backups never become stale", () => {
  let now = new Date("2026-09-01T00:00:00.000Z");
  const enabled = new RuntimeHealthRegistry({
    backupEnabled: true,
    backupIntervalMs: 4 * HOUR,
    now: () => now,
    processStartedAt: now,
  });
  const disabled = new RuntimeHealthRegistry({
    backupEnabled: false,
    backupIntervalMs: 4 * HOUR,
    now: () => now,
    processStartedAt: now,
  });
  enabled.recordBackupSuccess({ size: 10, retentionDeleted: 0, retentionFailed: 0, tempCleanupFailed: 0 });
  now = new Date("2026-09-01T07:59:59.000Z");
  assert.equal(enabled.snapshot().backupStale, false);
  now = new Date("2026-09-01T08:00:00.000Z");
  assert.equal(enabled.snapshot().backupStale, true);
  assert.equal(enabled.snapshot().backupAgeSeconds, 8 * 3600);
  assert.equal(disabled.snapshot().backupStale, false);
  assert.equal(disabled.snapshot().backupAgeSeconds, 0);
});

test("a discovered existing backup restores freshness without inflating process success counters", () => {
  const now = new Date("2026-09-05T12:00:00.000Z");
  const health = new RuntimeHealthRegistry({
    backupEnabled: true,
    backupIntervalMs: 24 * HOUR,
    now: () => now,
    processStartedAt: now,
  });
  health.recordExistingBackup({ size: 2048, modifiedAt: new Date("2026-09-05T06:00:00.000Z") });
  const snapshot = health.snapshot();
  assert.equal(snapshot.backupSuccessTotal, 0);
  assert.equal(snapshot.backupLastSizeBytes, 2048);
  assert.equal(snapshot.backupLastSuccessAt?.toISOString(), "2026-09-05T06:00:00.000Z");
  assert.equal(snapshot.backupAgeSeconds, 6 * 3600);
  assert.equal(snapshot.backupStale, false);
});

test("polling observation distinguishes controlled shutdown from unexpected settlement", async () => {
  const health = new RuntimeHealthRegistry({ backupEnabled: false, backupIntervalMs: HOUR });
  health.setRuntimeState("READY");
  health.markPollingStarted();
  let expected = false;
  let incidents = 0;

  const first = deferred();
  const observedUnexpected = observePollingCompletion(first.promise, {
    health,
    isExpectedTermination: () => expected,
    onUnexpectedTermination: () => {
      incidents += 1;
    },
  });
  first.resolve();
  await observedUnexpected;
  assert.equal(health.snapshot().pollingUnexpectedTerminationsTotal, 1);
  assert.equal(health.snapshot().pollingActive, false);
  assert.equal(incidents, 1);

  health.markPollingStarted();
  expected = true;
  const second = deferred();
  const observedExpected = observePollingCompletion(second.promise, {
    health,
    isExpectedTermination: () => expected,
    onUnexpectedTermination: () => assert.fail("controlled shutdown is not an incident"),
  });
  second.resolve();
  await observedExpected;
  assert.equal(health.snapshot().pollingUnexpectedTerminationsTotal, 1);

  health.markPollingStarted();
  expected = false;
  const third = deferred();
  const observedRejection = observePollingCompletion(third.promise, {
    health,
    isExpectedTermination: () => expected,
    onUnexpectedTermination: () => {
      incidents += 1;
    },
  });
  third.reject(new Error("private token: 123456789"));
  await assert.rejects(observedRejection, /private token/);
  assert.equal(health.snapshot().pollingUnexpectedTerminationsTotal, 2);
  assert.equal(incidents, 2);
});

test("alert coordinator deduplicates incidents, recovers once, routes dynamically, and contains private errors", async () => {
  const now = new Date("2026-09-05T12:00:00.000Z");
  let workspace = 100;
  const sent: Array<{ chatId: number; text: string }> = [];
  const tasks = new BackgroundTaskRegistry();
  const health = new RuntimeHealthRegistry({
    backupEnabled: true,
    backupIntervalMs: HOUR,
    now: () => now,
    processStartedAt: now,
  });
  health.setRuntimeState("READY");
  health.markPollingStarted();
  const alerts = new OperationalAlertCoordinator({
    health,
    backgroundTasks: tasks,
    getStaffChatId: () => workspace,
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    now: () => now,
  });

  health.recordDatabaseProbe(false);
  alerts.evaluate();
  health.recordDatabaseProbe(false);
  alerts.evaluate();
  assert.equal(sent.length, 0);
  health.recordDatabaseProbe(false);
  alerts.evaluate();
  alerts.evaluate();
  await tasks.drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.chatId, 100);
  assert.match(sent[0]?.text ?? "", /DATABASE_UNHEALTHY[\s\S]*FIRING/);

  workspace = 200;
  health.recordDatabaseProbe(true);
  alerts.evaluate();
  alerts.evaluate();
  await tasks.drain();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.chatId, 200);
  assert.match(sent[1]?.text ?? "", /DATABASE_UNHEALTHY[\s\S]*RECOVERED/);
  health.recordBackupFailure();
  alerts.evaluate();
  await tasks.drain();
  assert.equal(sent[2]?.chatId, 200);
  assert.match(sent[2]?.text ?? "", /BACKUP_FAILURE[\s\S]*FIRING/);
  assert.doesNotMatch(sent.map((entry) => entry.text).join("\n"), /123456789|private token/);
});

test("failed alert delivery is contained without recursion or repeated firing", async () => {
  const tasks = new BackgroundTaskRegistry();
  const health = new RuntimeHealthRegistry({ backupEnabled: true, backupIntervalMs: HOUR });
  health.setRuntimeState("READY");
  health.markPollingStarted();
  let attempts = 0;
  const alerts = new OperationalAlertCoordinator({
    health,
    backgroundTasks: tasks,
    getStaffChatId: () => 123456789,
    sendMessage: async () => {
      attempts += 1;
      throw new Error("BOT_TOKEN=secret-value");
    },
  });

  health.recordBackupFailure();
  alerts.evaluate();
  alerts.evaluate();
  await tasks.drain();
  assert.equal(attempts, 1);
  assert.equal(health.snapshot().alertDeliveryFailuresTotal, 1);
});

test("alert delivery preserves transition order when recovery follows before the firing send completes", async () => {
  const tasks = new BackgroundTaskRegistry();
  const health = new RuntimeHealthRegistry({ backupEnabled: true, backupIntervalMs: HOUR });
  const firstDelivery = deferred();
  const statuses: string[] = [];
  const alerts = new OperationalAlertCoordinator({
    health,
    backgroundTasks: tasks,
    getStaffChatId: () => 100,
    sendMessage: async (_chatId, text) => {
      statuses.push(text.match(/Status: (\w+)/)?.[1] ?? "missing");
      if (statuses.length === 1) await firstDelivery.promise;
    },
  });

  health.recordBackupFailure();
  alerts.evaluate();
  health.recordBackupSuccess({ size: 1, retentionDeleted: 0, retentionFailed: 0, tempCleanupFailed: 0 });
  alerts.evaluate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(statuses, ["FIRING"]);
  firstDelivery.resolve();
  await tasks.drain();
  assert.deepEqual(statuses, ["FIRING", "RECOVERED"]);
});

test("polling, backup failure, and stale backup alerts each fire and recover exactly once", async () => {
  let now = new Date("2026-09-05T00:00:00.000Z");
  const tasks = new BackgroundTaskRegistry();
  const health = new RuntimeHealthRegistry({
    backupEnabled: true,
    backupIntervalMs: HOUR,
    now: () => now,
    processStartedAt: now,
  });
  health.setRuntimeState("READY");
  health.markPollingStarted();
  const messages: string[] = [];
  const alerts = new OperationalAlertCoordinator({
    health,
    backgroundTasks: tasks,
    getStaffChatId: () => 100,
    sendMessage: async (_chatId, text) => void messages.push(text),
    now: () => now,
  });

  health.recordUnexpectedPollingTermination();
  health.recordBackupFailure();
  now = new Date("2026-09-05T02:00:00.000Z");
  alerts.evaluate();
  alerts.evaluate();
  await tasks.drain();
  assert.deepEqual(messages.map((message) => message.match(/Condition: (\w+)/)?.[1]).sort(), [
    "BACKUP_FAILURE",
    "BACKUP_STALE",
    "POLLING_TERMINATED",
  ]);

  health.markPollingStarted();
  health.recordBackupSuccess({ size: 12, retentionDeleted: 0, retentionFailed: 0, tempCleanupFailed: 0 });
  alerts.evaluate();
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 6);
  assert.equal(messages.filter((message) => /Status: RECOVERED/.test(message)).length, 3);
});

test("periodic evaluator owns an unref timer, performs one cheap probe, and stops cleanly", () => {
  const health = new RuntimeHealthRegistry({ backupEnabled: false, backupIntervalMs: HOUR });
  health.setRuntimeState("READY");
  health.markPollingStarted();
  let callback: (() => void) | undefined;
  let unrefCount = 0;
  let clearCount = 0;
  let probes = 0;
  let evaluations = 0;
  const evaluator = new RuntimeHealthEvaluator({
    health,
    checkDatabase: () => {
      probes += 1;
      return true;
    },
    evaluateAlerts: () => {
      evaluations += 1;
    },
    setTimer: (handler) => {
      callback = handler;
      return { unref: () => void (unrefCount += 1) };
    },
    clearTimer: () => {
      clearCount += 1;
    },
  });

  evaluator.start();
  assert.equal(unrefCount, 1);
  callback?.();
  assert.equal(probes, 1);
  assert.equal(evaluations, 1);
  assert.equal(unrefCount, 2);
  evaluator.stop();
  assert.equal(clearCount, 1);
  callback?.();
  assert.equal(probes, 1);
});
