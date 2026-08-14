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
import { BackupScheduler, BackupService } from "./backups.js";

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
const bot = createBot(db, quickRepliesRegistry, { entityNotificationProviders, installationService });
const backupScheduler = new BackupScheduler(
  new BackupService(db, { enabled: config.backupEnabled, directory: config.backupDir, intervalMs: config.backupIntervalHours * 3_600_000, retentionCount: config.backupRetentionCount }),
  { enabled: config.backupEnabled, directory: config.backupDir, intervalMs: config.backupIntervalHours * 3_600_000, retentionCount: config.backupRetentionCount },
  (error) => logger.warn({ err: error }, "Automatic SQLite backup failed")
);

async function main(): Promise<void> {
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
  void backupScheduler.start().catch((error) => logger.warn({ err: error }, "Automatic SQLite backup scheduler failed to start"));

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "Stopping bot");
    backupScheduler.stop();
    bot.stop();
    db.close();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await bot.start({
    allowed_updates: ["message", "callback_query", "chat_member"],
    onStart: (botInfo) => {
      logger.info({ username: botInfo.username }, "Telegram support bot started");
    }
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, "Bot failed to start");
  db.close();
  process.exit(1);
});
