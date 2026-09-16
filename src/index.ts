import { config, hostConfig } from "./config.js";
import { SupportDatabase } from "./db.js";
import { TELEGRAM_ALLOWED_UPDATES, createBot, sendStaffOnboardingIfNeeded, setBotCommands } from "./bot.js";
import { logger } from "./logger.js";
import { archiveClosedTicketsPendingUpload, initializeSupportLogsTopic } from "./archive.js";
import { createPersistentQuickRepliesRegistry, loadQuickRepliesRegistry } from "./quickReplies.js";
import { processModerationRecovery } from "./languageModeration.js";
import type { EntityNotificationProviderRegistry } from "./entityNotifications.js";
import { InstallationService } from "./installation.js";
import { StartupRecoveryBudget, StartupRecoveryContinuation, runWorkspaceStartup } from "./startup.js";
import { createAutomaticBackupScheduler } from "./backups.js";
import {
  ApplicationLifecycle,
  awaitApplicationCompletion,
  BackgroundTaskRegistry,
  installShutdownSignalHandlers,
} from "./lifecycle.js";
import { OperationalServer, type OperationalRuntimeState } from "./operationsHttp.js";
import {
  OperationalAlertCoordinator,
  RuntimeHealthEvaluator,
  RuntimeHealthRegistry,
  observePollingCompletion,
} from "./runtimeObservability.js";

const db = new SupportDatabase(config.databaseUrl);
const quickRepliesRegistry = createPersistentQuickRepliesRegistry(db, loadQuickRepliesRegistry());
const quickReplyCategories = quickRepliesRegistry.listCategories();

logger.info(
  {
    categoryCount: quickReplyCategories.length,
    templateCount: quickReplyCategories.reduce((count, category) => count + category.templates.length, 0),
  },
  "Quick Replies loaded successfully"
);

const installationService = new InstallationService(db);
if (hostConfig.staffChatId !== null) installationService.adoptLegacyInstallation(hostConfig.staffChatId);
const entityNotificationProviders: EntityNotificationProviderRegistry = new Map();
const backgroundTasks = new BackgroundTaskRegistry();
const backupOptions = {
  enabled: config.backupEnabled,
  directory: config.backupDir,
  intervalMs: config.backupIntervalHours * 3_600_000,
  retentionCount: config.backupRetentionCount,
};
const runtimeHealth = new RuntimeHealthRegistry({
  backupEnabled: backupOptions.enabled,
  backupIntervalMs: backupOptions.intervalMs,
});
const bot = createBot(db, quickRepliesRegistry, {
  entityNotificationProviders,
  installationService,
  backgroundTasks,
  runtimeHealth,
});
const operationalAlerts = new OperationalAlertCoordinator({
  health: runtimeHealth,
  backgroundTasks,
  getStaffChatId: () => installationService.getStaffChatId(),
  sendMessage: (chatId, text) => bot.api.sendMessage(chatId, text),
});
const telemetrySnapshot = () => runtimeHealth.snapshot(backgroundTasks.snapshot());
const evaluateAlerts = () => operationalAlerts.evaluate(telemetrySnapshot());
const evaluateAlertsWhileRunning = () => {
  if (runtimeHealth.getRuntimeState() === "READY") evaluateAlerts();
};
const healthEvaluator = new RuntimeHealthEvaluator({
  health: runtimeHealth,
  checkDatabase: () => db.ping(),
  evaluateAlerts,
});
const recordAutomaticBackupFailure = (error: unknown) => {
  runtimeHealth.recordBackupFailure();
  evaluateAlertsWhileRunning();
  logger.warn({ err: error }, "Automatic SQLite backups are unavailable; support bot startup will continue");
};
const backupScheduler = createAutomaticBackupScheduler(
  db,
  backupOptions,
  recordAutomaticBackupFailure,
  (result) => {
    runtimeHealth.recordBackupSuccess(result);
    evaluateAlertsWhileRunning();
    const details = {
      backup: result.basename,
      size: result.size,
      sha256: result.sha256,
      retentionDeleted: result.retentionDeleted,
      retentionFailed: result.retentionFailed,
      tempCleanupFailed: result.tempCleanupFailed,
    };
    if (result.tempCleanupFailed)
      logger.warn(details, "Automatic SQLite backup completed with temporary cleanup failures");
    else logger.info(details, "Automatic SQLite backup completed");
  },
  (backup) => runtimeHealth.recordExistingBackup(backup)
);
let polling: Promise<void> | null = null;
let operationalServer: OperationalServer | null = null;
let startupRecoveryContinuation: StartupRecoveryContinuation | null = null;
let startupCompletion: Promise<void> | null = null;
const lifecycle = new ApplicationLifecycle({
  stopPolling: () => bot.stop(),
  startupCompletion: () => startupCompletion,
  pollingCompletion: () => polling,
  stopBackgroundWork: () => {
    runtimeHealth.setRuntimeState("SHUTTING_DOWN");
    healthEvaluator.stop();
    startupRecoveryContinuation?.stop();
    bot.stopBackgroundWork();
  },
  backgroundTasks,
  stopAndDrainBackups: () => backupScheduler?.stopAndDrain() ?? Promise.resolve(),
  closeDatabase: () => db.close(),
  closeOperationalServer: () => operationalServer?.stop() ?? Promise.resolve(),
  onShutdownDeadline: (stage, deadlineMs) =>
    logger.fatal(
      { deadlineMs, stage },
      "Graceful shutdown deadline expired; forcing terminal exit without closing SQLite"
    ),
  terminalExit: (code) => process.exit(code),
  onDrainFailure: (stage, error) => logger.warn({ err: error, stage }, "Graceful shutdown drain failed"),
});
startupRecoveryContinuation = new StartupRecoveryContinuation({
  backgroundTasks,
  shouldContinue: () => lifecycle.isRunning(),
  onFailure: (name, error) => logger.warn({ err: error, name }, "Startup recovery continuation failed"),
});
installShutdownSignalHandlers(lifecycle, {
  once: (signal, handler) =>
    process.once(signal, () => {
      logger.info({ signal }, "Stopping bot");
      handler();
    }),
});

function getOperationalRuntimeState(): OperationalRuntimeState {
  const lifecycleState = lifecycle.getState();
  if (lifecycleState === "SHUTTING_DOWN") return "SHUTTING_DOWN";
  if (lifecycleState === "STOPPED") return "STOPPED";
  return runtimeHealth.getRuntimeState();
}

function getOperationalSnapshot() {
  runtimeHealth.setRuntimeState(getOperationalRuntimeState());
  return telemetrySnapshot();
}

async function startApplication(): Promise<void> {
  if (config.opsHttpEnabled) {
    operationalServer = new OperationalServer({
      host: config.opsHttpHost,
      port: config.opsHttpPort,
      getSnapshot: getOperationalSnapshot,
      checkDatabase: () => db.ping(),
      recordDatabaseProbe: (ready) => runtimeHealth.recordDatabaseProbe(ready),
    });
    await operationalServer.start();
    logger.info({ host: config.opsHttpHost, port: config.opsHttpPort }, "Operational HTTP server started");
  }
  if (!lifecycle.isRunning()) return;
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  if (!lifecycle.isRunning()) return;
  const botInfo = await bot.api.getMe();
  if (!lifecycle.isRunning()) return;
  bot.botInfo = botInfo;
  const startupRecoveryBudget = new StartupRecoveryBudget({ shouldContinue: () => lifecycle.isRunning() });
  const recoverArchives = (budget: StartupRecoveryBudget) =>
    archiveClosedTicketsPendingUpload(bot.api, db, installationService.requireStaffChatId(), { budget });
  const recoverModeration = (budget: StartupRecoveryBudget) =>
    processModerationRecovery(bot.api, db, installationService.requireStaffChatId(), new Date(), { budget });
  const startupState = await runWorkspaceStartup(
    installationService,
    {
      discoverStaffWorkspaceMembers: async () => {
        const workspace = installationService.getActiveWorkspace();
        if (!workspace) return;
        try {
          const administrators = await bot.api.getChatAdministrators(workspace.telegram_chat_id);
          for (const administrator of administrators) {
            if (administrator.user.is_bot) continue;
            installationService.ensureBaselineAgent({
              telegramId: administrator.user.id,
              username: administrator.user.username,
              firstName: administrator.user.first_name,
              lastName: administrator.user.last_name,
            });
          }
        } catch (error) {
          logger.warn({ err: error }, "Could not discover staff workspace administrators");
        }
      },
      initializeSupportLogs: () =>
        initializeSupportLogsTopic(bot.api, db, installationService.requireStaffChatId()).then(() => undefined),
      recoverArchives: async () => {
        const result = await recoverArchives(startupRecoveryBudget);
        if (result.hasMore)
          startupRecoveryContinuation?.enqueue("archives", () =>
            recoverArchives(new StartupRecoveryBudget({ shouldContinue: () => lifecycle.isRunning() }))
          );
      },
      recoverModeration: async () => {
        const result = await recoverModeration(startupRecoveryBudget);
        if (result.hasMore)
          startupRecoveryContinuation?.enqueue("moderation", () =>
            recoverModeration(new StartupRecoveryBudget({ shouldContinue: () => lifecycle.isRunning() }))
          );
      },
      recoverBatch: async () => {
        startupRecoveryContinuation?.enqueue("ticket_batch", async () => {
          await bot.recoverPendingTicketBatchStaffOperations();
          return { hasMore: false, madeProgress: true };
        });
      },
      sendLegacyStaffOnboarding: () => sendStaffOnboardingIfNeeded(bot.api, db, installationService),
    },
    { shouldContinue: () => lifecycle.isRunning() }
  );
  if (startupState === "SHUTTING_DOWN" || !lifecycle.isRunning()) return;
  await setBotCommands(bot, installationService);
  if (!lifecycle.isRunning()) return;
  if (!installationService.getOwner()) {
    logger.warn(
      "No OWNER is paired. Run npm run owner:pair in an interactive terminal to create a one-use pairing link."
    );
  }
  if (backupScheduler) void backupScheduler.start().catch(recordAutomaticBackupFailure);
  if (!lifecycle.isRunning()) return;

  const pollingRun = bot.start({
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    onStart: (botInfo) => {
      runtimeHealth.markPollingStarted();
      runtimeHealth.setRuntimeState("READY");
      healthEvaluator.start();
      startupRecoveryContinuation?.start();
      evaluateAlerts();
      logger.info({ username: botInfo.username }, "Telegram support bot started");
    },
  });
  polling = observePollingCompletion(pollingRun, {
    health: runtimeHealth,
    isExpectedTermination: () => lifecycle.getState() !== "RUNNING" || runtimeHealth.getRuntimeState() !== "READY",
    onUnexpectedTermination: (outcome) => {
      logger.error({ outcome }, "Telegram polling terminated unexpectedly");
      evaluateAlerts();
    },
  });
}

const startup = startApplication();
startupCompletion = startup.then(
  () => undefined,
  () => undefined
);
void startup
  .then(async () => {
    if (polling) await awaitApplicationCompletion(polling, lifecycle);
  })
  .catch(async (error) => {
    if (!lifecycle.isRunning()) return;
    logger.fatal({ err: error }, "Bot failed to start");
    await lifecycle.startupFailed();
    process.exitCode = 1;
  });
