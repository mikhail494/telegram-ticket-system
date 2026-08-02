import readline from "node:readline/promises";
import { Bot } from "grammy";
import { config } from "./config.js";
import { SupportDatabase } from "./db.js";
import { InstallationService } from "./installation.js";

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Owner recovery requires an interactive terminal confirmation.");
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question("Create a one-use owner recovery link? Existing ownership remains active until Telegram confirmation. Type RECOVER: ");
  prompt.close();
  if (answer.trim() !== "RECOVER") throw new Error("Owner recovery cancelled.");
  const db = new SupportDatabase(config.databaseUrl);
  try {
    const bot = new Bot(config.botToken);
    const identity = await bot.api.getMe();
    const token = new InstallationService(db).createOwnerRecoveryToken();
    console.log(`Open this one-use link within 30 minutes: https://t.me/${identity.username}?start=setup_${token}`);
    console.log("The current OWNER remains active until the transfer is confirmed privately in the bot.");
  } finally { db.close(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Owner recovery failed."); process.exitCode = 1; });
