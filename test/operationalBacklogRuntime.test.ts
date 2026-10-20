import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RuntimeHealthRegistry,
  RuntimeHealthEvaluator,
  OperationalAlertCoordinator,
} from "../src/runtimeObservability.js";
import { BackgroundTaskRegistry } from "../src/lifecycle.js";
import type { OperationalBacklogObservation } from "../src/operationalBacklog.js";

const AT = "2026-10-20T12:00:00.000Z";
function sample(overrides: Partial<OperationalBacklogObservation> = {}): OperationalBacklogObservation {
  return {
    staffChatId: -100900,
    observedAt: AT,
    deliveryReview: { count: 0, oldestAgeSeconds: 0 },
    unknownDeliveryCount: 0,
    batchRecovery: { count: 0, oldestOverdueSeconds: 0 },
    moderationCleanup: { count: 0, oldestOverdueSeconds: 0 },
    archiveRecovery: { count: 0, oldestAgeSeconds: 0 },
    batchExportUnknownDeliveryCount: 0,
    ...overrides,
  };
}

test("backlog telemetry retains the last good sample on query failure and invalidates another workspace", () => {
  let workspace: number | null = -100900;
  let now = new Date(AT);
  const health = new RuntimeHealthRegistry({
    backupEnabled: false,
    backupIntervalMs: 3600000,
    now: () => now,
    getBacklogWorkspace: () => workspace,
  });
  assert.equal(health.snapshot().backlog.sampleAvailable, false);
  health.recordBacklogObservation(sample({ deliveryReview: { count: 2, oldestAgeSeconds: 3600 } }));
  now = new Date(now.getTime() + 60000);
  health.recordBacklogObservationFailure();
  const failed = health.snapshot().backlog;
  assert.equal(failed.observation?.deliveryReview.count, 2);
  assert.equal(failed.sampleAvailable, true);
  assert.equal(failed.observationSuccess, false);
  assert.equal(failed.observationAgeSeconds, 60);
  assert.equal(failed.observationFailuresTotal, 1);
  assert.equal(failed.lastSuccessAt?.toISOString(), AT);
  workspace = -100901;
  assert.equal(health.snapshot().backlog.sampleAvailable, false);
  assert.equal(health.snapshot().backlog.observation, null);
  workspace = null;
  assert.equal(health.snapshot().backlog.workspaceConfigured, false);
});

test("the evaluator samples only after a healthy probe and stops sampling before shutdown closes SQLite", () => {
  let now = new Date(AT);
  let ready = true;
  let failQuery = false;
  let noWorkspace = false;
  const calls: string[] = [];
  const health = new RuntimeHealthRegistry({ backupEnabled: false, backupIntervalMs: 3600000, now: () => now });
  health.setRuntimeState("READY");
  health.markPollingStarted();
  const evaluator = new RuntimeHealthEvaluator({
    health,
    checkDatabase: () => {
      calls.push("ping");
      return ready;
    },
    observeBacklog: () => {
      calls.push("backlog");
      if (failQuery) throw new Error("secret");
      return noWorkspace ? null : sample();
    },
    evaluateAlerts: () => {
      calls.push("alerts");
    },
    setTimer: () => ({ unref() {} }),
    clearTimer: () => undefined,
  });
  evaluator.evaluateNow();
  assert.deepEqual(calls, []);
  evaluator.start();
  evaluator.evaluateNow();
  assert.deepEqual(calls, ["ping", "backlog", "alerts"]);
  now = new Date(now.getTime() + 60000);
  failQuery = true;
  evaluator.evaluateNow();
  assert.equal(health.snapshot().databaseReady, true);
  assert.equal(health.snapshot().backlog.observation?.deliveryReview.count, 0);
  assert.equal(health.snapshot().backlog.observationSuccess, false);
  ready = false;
  calls.length = 0;
  evaluator.evaluateNow();
  assert.deepEqual(calls, ["ping", "alerts"]);
  assert.equal(health.snapshot().backlog.observationFailuresTotal, 1);
  ready = true;
  failQuery = false;
  noWorkspace = true;
  evaluator.evaluateNow();
  assert.equal(health.snapshot().backlog.workspaceConfigured, false);
  assert.equal(health.snapshot().backlog.sampleAvailable, false);
  assert.equal(health.snapshot().backlog.observationFailuresTotal, 1);
  evaluator.stop();
  calls.length = 0;
  evaluator.evaluateNow();
  assert.deepEqual(calls, []);
});

test("backlog snapshots cannot mutate cached counts and an unavailable scope is never a known empty queue", () => {
  let failScope = false;
  const health = new RuntimeHealthRegistry({
    backupEnabled: false,
    backupIntervalMs: 1,
    now: () => new Date(AT),
    getBacklogWorkspace: () => {
      if (failScope) throw new Error("private diagnostic");
      return -100900;
    },
  });
  health.recordBacklogObservation(sample());
  health.snapshot().backlog.observation!.deliveryReview.count = 999;
  assert.equal(health.snapshot().backlog.observation!.deliveryReview.count, 0);
  failScope = true;
  assert.equal(health.snapshot().backlog.workspaceConfigured, null);
  assert.equal(health.snapshot().backlog.sampleAvailable, false);
  assert.equal(health.snapshot().backlog.observation, null);
  failScope = false;
  assert.equal(health.snapshot().backlog.observation!.deliveryReview.count, 0);
});

test("queued backlog alerts stay bound to their observed workspace and do not produce cross-workspace recovery", async () => {
  let workspace = -100900;
  const tasks = new BackgroundTaskRegistry();
  const health = new RuntimeHealthRegistry({
    backupEnabled: false,
    backupIntervalMs: 1,
    now: () => new Date(AT),
    getBacklogWorkspace: () => workspace,
  });
  health.setRuntimeState("READY");
  health.markPollingStarted();
  const messages: Array<{ chat: number; text: string }> = [];
  const alerts = new OperationalAlertCoordinator({
    health,
    backgroundTasks: tasks,
    getStaffChatId: () => workspace,
    sendMessage: async (chat, text) => {
      messages.push({ chat, text });
    },
  });
  health.recordBacklogObservation(sample({ deliveryReview: { count: 1, oldestAgeSeconds: 3600 } }));
  alerts.evaluate();
  workspace = -100901;
  await tasks.drain();
  assert.equal(messages.length, 0);
  health.recordBacklogObservation(sample({ staffChatId: workspace }));
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 0);
  health.recordBacklogObservation(
    sample({ staffChatId: workspace, batchRecovery: { count: 1, oldestOverdueSeconds: 1800 } })
  );
  alerts.evaluate();
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.chat, workspace);
  assert.match(messages[0]!.text, /AUTOMATED_RECOVERY_OVERDUE/);
  tasks.stopAccepting();
  health.recordBacklogObservation(sample({ staffChatId: workspace }));
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 1);
});

test("backlog alerts fire once, retain incidents through telemetry errors and recover only from a fresh READY sample", async () => {
  let now = new Date(AT);
  const tasks = new BackgroundTaskRegistry();
  const health = new RuntimeHealthRegistry({ backupEnabled: false, backupIntervalMs: 3600000, now: () => now });
  const messages: string[] = [];
  const alerts = new OperationalAlertCoordinator({
    health,
    backgroundTasks: tasks,
    getStaffChatId: () => -100900,
    sendMessage: async (_id, text) => {
      messages.push(text);
    },
    now: () => now,
  });
  health.recordBacklogObservation(
    sample({
      deliveryReview: { count: 2, oldestAgeSeconds: 3600 },
      moderationCleanup: { count: 1, oldestOverdueSeconds: 1800 },
    })
  );
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 0);
  health.setRuntimeState("READY");
  health.markPollingStarted();
  alerts.evaluate();
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 2);
  assert.match(messages[0]!, /DELIVERY_REVIEW_STALE[\s\S]*FIRING/);
  assert.match(messages[1]!, /AUTOMATED_RECOVERY_OVERDUE[\s\S]*FIRING/);
  assert.doesNotMatch(messages.join("\n"), /-100900|ticket|Customer content/);
  health.recordBacklogObservationFailure();
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 2);
  health.recordBacklogObservation(sample());
  now = new Date(now.getTime() + 121000);
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 2);
  health.recordBacklogObservation(sample({ observedAt: now.toISOString() }));
  alerts.evaluate();
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 4);
  assert.equal(messages.filter((text) => text.includes("Status: RECOVERED")).length, 2);
  health.setRuntimeState("SHUTTING_DOWN");
  health.recordBacklogObservation(
    sample({ observedAt: now.toISOString(), batchRecovery: { count: 1, oldestOverdueSeconds: 1800 } })
  );
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 4);
});

test("temporary workspace lookup failure preserves a firing backlog incident without a duplicate transition", async () => {
  let lookupFails = false;
  const tasks = new BackgroundTaskRegistry();
  const health = new RuntimeHealthRegistry({
    backupEnabled: false,
    backupIntervalMs: 1,
    now: () => new Date(AT),
    getBacklogWorkspace: () => {
      if (lookupFails) throw new Error("scope unavailable");
      return -100900;
    },
  });
  health.setRuntimeState("READY");
  health.markPollingStarted();
  const messages: string[] = [];
  const alerts = new OperationalAlertCoordinator({
    health,
    backgroundTasks: tasks,
    getStaffChatId: () => -100900,
    sendMessage: async (_chat, text) => {
      messages.push(text);
    },
  });
  health.recordBacklogObservation(sample({ deliveryReview: { count: 1, oldestAgeSeconds: 3600 } }));
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 1);
  lookupFails = true;
  alerts.evaluate();
  await tasks.drain();
  lookupFails = false;
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 1);
  health.recordBacklogObservation(sample());
  alerts.evaluate();
  await tasks.drain();
  assert.equal(messages.length, 2);
  assert.match(messages[1]!, /RECOVERED/);
});

test("an unhealthy readiness probe invalidates freshness without recording a query attempt", () => {
  let now = new Date(AT);
  const health = new RuntimeHealthRegistry({ backupEnabled: false, backupIntervalMs: 1, now: () => now });
  health.recordBacklogObservation(sample());
  now = new Date(now.getTime() + 60000);
  const evaluator = new RuntimeHealthEvaluator({
    health,
    checkDatabase: () => false,
    observeBacklog: () => assert.fail("No backlog SQL after a failed readiness probe"),
    evaluateAlerts: () => undefined,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => undefined,
  });
  evaluator.start();
  evaluator.evaluateNow();
  evaluator.stop();
  const backlog = health.snapshot().backlog;
  assert.equal(backlog.observationFailuresTotal, 0);
  assert.equal(backlog.lastAttemptAt?.toISOString(), AT);
  assert.equal(backlog.lastSuccessAt?.toISOString(), AT);
  assert.equal(backlog.observationSuccess, false);
  assert.equal(backlog.fresh, false);
  assert.equal(backlog.observation?.deliveryReview.count, 0);
});
