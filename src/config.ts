import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  STAFF_CHAT_ID: z.coerce.number().int("STAFF_CHAT_ID must be a Telegram chat id"),
  DATABASE_URL: z.string().min(1).default("file:./data/support.db"),
  LOG_LEVEL: z.string().default("info")
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  nodeEnv: parsed.data.NODE_ENV,
  botToken: parsed.data.BOT_TOKEN,
  staffChatId: parsed.data.STAFF_CHAT_ID,
  databaseUrl: parsed.data.DATABASE_URL,
  logLevel: parsed.data.LOG_LEVEL
} as const;
