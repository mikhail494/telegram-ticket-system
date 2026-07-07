import { config } from "./config.js";
import { SupportDatabase } from "./db.js";
import { createBot, setBotCommands } from "./bot.js";
import { logger } from "./logger.js";
import { archiveClosedTicketsPendingUpload, initializeSupportLogsTopic } from "./archive.js";

const db = new SupportDatabase(config.databaseUrl);
const bot = createBot(db);

async function main(): Promise<void> {
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  await initializeSupportLogsTopic(bot.api, db);
  await archiveClosedTicketsPendingUpload(bot.api, db);
  await setBotCommands(bot);

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "Stopping bot");
    bot.stop();
    db.close();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await bot.start({
    allowed_updates: ["message", "callback_query"],
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
