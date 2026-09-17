import test from "node:test";
import assert from "node:assert/strict";
import { SupportDatabase } from "../src/db.js";
import { InstallationService } from "../src/installation.js";
import { ApplicationLifecycle, installShutdownSignalHandlers } from "../src/lifecycle.js";
import { StartupRecoveryBudget, runBoundedRecoveryPass, runWorkspaceStartup } from "../src/startup.js";

test("setup mode skips every staff-workspace startup task", async () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    service.activateWorkspace({ chatId: -10041, title: "Pending setup workspace" });
    const calls: string[] = [];
    const task = (name: string) => async () => {
      calls.push(name);
    };
    assert.equal(
      await runWorkspaceStartup(service, {
        initializeSupportLogs: task("logs"),
        recoverArchives: task("archives"),
        recoverModeration: task("moderation"),
        sendLegacyStaffOnboarding: task("onboarding"),
      }),
      "SETUP_REQUIRED"
    );
    assert.deepEqual(calls, []);
  } finally {
    db.close();
  }
});

test("legacy workspace starts recoveries without creating onboarding noise", async () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    service.adoptLegacyInstallation(-10042);
    const calls: string[] = [];
    const task = (name: string) => async () => {
      calls.push(name);
    };
    assert.equal(
      await runWorkspaceStartup(service, {
        initializeSupportLogs: task("logs"),
        recoverArchives: task("archives"),
        recoverModeration: task("moderation"),
        sendLegacyStaffOnboarding: task("onboarding"),
      }),
      "READY"
    );
    assert.deepEqual(calls, ["logs", "archives", "moderation"]);
  } finally {
    db.close();
  }
});

test("ready startup automatically switches an adopted installation with an owner to role-based access", async () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 });
    service.adoptLegacyInstallation(-10042);
    const task = async () => undefined;

    await runWorkspaceStartup(service, {
      initializeSupportLogs: task,
      recoverArchives: task,
      recoverModeration: task,
      sendLegacyStaffOnboarding: task,
    });

    assert.equal(service.getState().authorizationMode, "RBAC_ACTIVE");
  } finally {
    db.close();
  }
});

test("startup signal handling stops later recovery stages at an item boundary", async () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    service.adoptLegacyInstallation(-10042);
    const lifecycle = new ApplicationLifecycle({
      stopPolling: () => undefined,
      pollingCompletion: () => null,
      backgroundTasks: { run: () => true, stopAccepting: () => undefined, drain: async () => undefined },
      closeDatabase: () => undefined,
    });
    const handlers = new Map<NodeJS.Signals, () => void>();
    installShutdownSignalHandlers(lifecycle, {
      once: (signal, handler) => {
        handlers.set(signal, handler);
      },
    });
    const calls: string[] = [];

    const result = await runWorkspaceStartup(
      service,
      {
        initializeSupportLogs: async () => {
          calls.push("logs");
        },
        recoverArchives: async () => {
          calls.push("archives");
          handlers.get("SIGTERM")!();
          handlers.get("SIGINT")!();
        },
        recoverModeration: async () => {
          calls.push("moderation");
        },
        sendLegacyStaffOnboarding: async () => {
          calls.push("onboarding");
        },
      },
      { shouldContinue: () => lifecycle.getState() === "RUNNING" }
    );

    assert.equal(result, "SHUTTING_DOWN");
    assert.deepEqual(calls, ["logs", "archives"]);
    await lifecycle.shutdown();
    assert.equal(lifecycle.getState(), "STOPPED");
  } finally {
    db.close();
  }
});

test("bounded startup recovery leaves durable candidates for a later pass", async () => {
  let now = 0;
  const budget = new StartupRecoveryBudget({ maxItems: 2, maxDurationMs: 10, now: () => now });
  const processed: number[] = [];

  const result = await runBoundedRecoveryPass([1, 2, 3], budget, async (item) => {
    processed.push(item);
    now += 1;
  });

  assert.deepEqual(processed, [1, 2]);
  assert.deepEqual(result, { processed: 2, hasMore: true });
});

test("startup recovery uses its ten-second limit only between durable items", async () => {
  let now = 0;
  const processed: number[] = [];
  const budget = new StartupRecoveryBudget({ maxItems: 50, maxDurationMs: 10_000, now: () => now });

  const result = await runBoundedRecoveryPass([1, 2], budget, async (item) => {
    processed.push(item);
    now = 10_000;
  });

  assert.deepEqual(processed, [1]);
  assert.deepEqual(result, { processed: 1, hasMore: true });
});

test("startup recovery finishes an in-flight item before honoring cancellation", async () => {
  let running = true;
  const processed: number[] = [];
  const budget = new StartupRecoveryBudget({ shouldContinue: () => running });

  const result = await runBoundedRecoveryPass([1, 2], budget, async (item) => {
    processed.push(item);
    running = false;
  });

  assert.deepEqual(processed, [1]);
  assert.deepEqual(result, { processed: 1, hasMore: true });
});
