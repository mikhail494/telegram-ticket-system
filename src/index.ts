import { config, hostConfig, setRuntimeStaffChatId } from "./config.js";
import { SupportDatabase } from "./db.js";
import { createBot, sendStaffOnboardingIfNeeded, setBotCommands } from "./bot.js";
import { logger } from "./logger.js";
import { archiveClosedTicketsPendingUpload, initializeSupportLogsTopic } from "./archive.js";
import { createPersistentQuickRepliesRegistry, loadQuickRepliesRegistry } from "./quickReplies.js";
import { processModerationRecovery } from "./languageModeration.js";
import type { EntityNotificationProviderRegistry } from "./entityNotifications.js";
import { InstallationService } from "./installation.js";
import { runWorkspaceStartup } from "./startup.js";
import { createAutomaticBackupScheduler } from "./backups.js";
import { ApplicationLifecycle, awaitApplicationCompletion, BackgroundTaskRegistry } from "./lifecycle.js";
import { OperationalServer, type OperationalRuntimeState } from "./operationsHttp.js";

const db = new SupportDatabase(config.databaseUrl);
const quickRepliesRegistry = createPersistentQuickRepliesRegistry(db, loadQuickRepliesRegistry());
const quickReplyCategories = quickRepliesRegistry.listCategories();

logger.info(
  {
    categoryCount: quickReplyCategories.length,
    templateCount: quickReplyCategories.reduce((count, category) => count + category.templates.length, 0)
  },
  "Quick Replies loaded successfully"
);

const installationService = new InstallationService(db);
if (hostConfig.staffChatId !== null) installationService.adoptLegacyInstallation(hostConfig.staffChatId);
setRuntimeStaffChatId(installationService.getStaffChatId());
const entityNotificationProviders: EntityNotificationProviderRegistry = new Map();
const backgroundTasks = new BackgroundTaskRegistry();
const bot = createBot(db, quickRepliesRegistry, { entityNotificationProviders, installationService, backgroundTasks });
const backupOptions = { enabled: config.backupEnabled, directory: config.backupDir, intervalMs: config.backupIntervalHours * 3_600_000, retentionCount: config.backupRetentionCount };
const backupScheduler = createAutomaticBackupScheduler(
  db,
  backupOptions,
  (error) => logger.warn({ err: error }, "Automatic SQLite backups are unavailable; support bot startup will continue"),
  (result) => {
    const details = { backup: result.basename, size: result.size, sha256: result.sha256, retentionDeleted: result.retentionDeleted, retentionFailed: result.retentionFailed, tempCleanupFailed: result.tempCleanupFailed };
    if (result.tempCleanupFailed) logger.warn(details, "Automatic SQLite backup completed with temporary cleanup failures");
    else logger.info(details, "Automatic SQLite backup completed");
  }
);
let polling: Promise<void> | null = null;
let operationalState: OperationalRuntimeState = "STARTING";
let operationalServer: OperationalServer | null = null;
const lifecycle = new ApplicationLifecycle({
  stopPolling: () => bot.stop(),
  pollingCompletion: () => polling,
  stopBackgroundWork: () => bot.stopBackgroundWork(),
  backgroundTasks,
  stopAndDrainBackups: () => backupScheduler?.stopAndDrain() ?? Promise.resolve(),
  closeDatabase: () => db.close(),
  closeOperationalServer: () => operationalServer?.stop() ?? Promise.resolve(),
  onDrainFailure: (stage, error) => logger.warn({ err: error, stage }, "Graceful shutdown drain failed")
});

function getOperationalRuntimeState(): OperationalRuntimeState {
  const lifecycleState = lifecycle.getState();
  if (lifecycleState === "SHUTTING_DOWN") return "SHUTTING_DOWN";
  if (lifecycleState === "STOPPED") return "STOPPED";
  return operationalState;
}

async function main(): Promise<void> {
  if (config.opsHttpEnabled) {
    operationalServer = new OperationalServer({
      host: config.opsHttpHost,
      port: config.opsHttpPort,
      getState: getOperationalRuntimeState,
      checkDatabase: () => db.ping()
    });
    await operationalServer.start();
    logger.info({ host: config.opsHttpHost, port: config.opsHttpPort }, "Operational HTTP server started");
  }
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  const botInfo = await bot.api.getMe();
  bot.botInfo = botInfo;
  await runWorkspaceStartup(installationService, {
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
            lastName: administrator.user.last_name
          });
        }
      } catch (error) {
        logger.warn({ err: error }, "Could not discover staff workspace administrators");
      }
    },
    initializeSupportLogs: () => initializeSupportLogsTopic(bot.api, db).then(() => undefined),
    recoverArchives: () => archiveClosedTicketsPendingUpload(bot.api, db).then(() => undefined),
    recoverModeration: () => processModerationRecovery(bot.api, db),
    recoverBatch: () => bot.recoverPendingTicketBatchStaffOperations(),
    sendLegacyStaffOnboarding: () => sendStaffOnboardingIfNeeded(bot.api, db, installationService)
  });
  await setBotCommands(bot, installationService);
  if (!installationService.getOwner()) {
    logger.warn("No OWNER is paired. Run npm run owner:pair in an interactive terminal to create a one-use pairing link.");
  }
  if (backupScheduler) void backupScheduler.start().catch((error) => logger.warn({ err: error }, "Automatic SQLite backup scheduler failed to start"));

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "Stopping bot");
    return lifecycle.shutdown();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  polling = bot.start({
    allowed_updates: ["message", "callback_query", "chat_member"],
    onStart: (botInfo) => {
      operationalState = "READY";
      logger.info({ username: botInfo.username }, "Telegram support bot started");
    }
  });
  await awaitApplicationCompletion(polling, lifecycle);
}

main().catch(async (error) => {
  logger.fatal({ err: error }, "Bot failed to start");
  await lifecycle.startupFailed();
  process.exitCode = 1;
});
