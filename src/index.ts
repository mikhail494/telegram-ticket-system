import { config, hostConfig, setRuntimeStaffChatId } from "./config.js";
import { SupportDatabase } from "./db.js";
import { createBot, sendStaffOnboardingIfNeeded, setBotCommands } from "./bot.js";
import { logger } from "./logger.js";
import { archiveClosedTicketsPendingUpload, initializeSupportLogsTopic } from "./archive.js";
import { loadQuickRepliesRegistry } from "./quickReplies.js";
import { processModerationRecovery } from "./languageModeration.js";
import type { EntityNotificationProviderRegistry } from "./entityNotifications.js";
import { InstallationService } from "./installation.js";
import { runWorkspaceStartup } from "./startup.js";

const quickRepliesRegistry = loadQuickRepliesRegistry();
const quickReplyCategories = quickRepliesRegistry.listCategories();

logger.info(
  {
    categoryCount: quickReplyCategories.length,
    templateCount: quickReplyCategories.reduce((count, category) => count + category.templates.length, 0)
  },
  "Quick Replies loaded successfully"
);

const db = new SupportDatabase(config.databaseUrl);
const installationService = new InstallationService(db);
if (hostConfig.staffChatId !== null) installationService.adoptLegacyInstallation(hostConfig.staffChatId);
setRuntimeStaffChatId(installationService.getStaffChatId());
const entityNotificationProviders: EntityNotificationProviderRegistry = new Map();
const bot = createBot(db, quickRepliesRegistry, { entityNotificationProviders, installationService });

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
    const pairingToken = installationService.createOwnerPairingToken();
    process.stdout.write(`Owner setup link (expires in 30 minutes): https://t.me/${botInfo.username}?start=setup_${pairingToken}\n`);
  }

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "Stopping bot");
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
