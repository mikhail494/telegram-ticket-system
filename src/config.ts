import { readFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

const hostSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BOT_TOKEN: z.string().trim().min(1, "BOT_TOKEN is required"),
  STAFF_CHAT_ID: z.union([z.coerce.number().int(), z.literal("")]).optional(),
  DATABASE_URL: z.string().trim().min(1).default("file:./data/support.db"),
  LOG_LEVEL: z.string().trim().min(1).default("info"),
  BACKUP_ENABLED: z.enum(["true", "false", "1", "0"]).default("true"),
  BACKUP_DIR: z.string().trim().min(1).optional(),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).max(8760).default(24),
  BACKUP_RETENTION_COUNT: z.coerce.number().int().min(1).max(365).default(14)
});

export interface HostConfig {
  nodeEnv: "development" | "test" | "production";
  botToken: string;
  staffChatId: number | null;
  databaseUrl: string;
  logLevel: string;
  backupEnabled: boolean;
  backupDir: string | null;
  backupIntervalHours: number;
  backupRetentionCount: number;
}

export function loadHostConfig(options: { env?: NodeJS.ProcessEnv; envFile?: string | false } = {}): HostConfig {
  const explicit = options.env ?? process.env;
  const envPath = options.envFile === undefined ? path.resolve(process.cwd(), ".env") : options.envFile;
  let local: Record<string, string> = {};
  if (envPath) {
    try { local = dotenv.parse(readFileSync(envPath)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const merged = { ...local, ...Object.fromEntries(Object.entries(explicit).filter(([, value]) => value !== undefined)) };
  const parsed = hostSchema.safeParse(merged);
  if (!parsed.success) throw new Error(`Invalid host configuration: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}. Run npm run setup.`);
  return {
    nodeEnv: parsed.data.NODE_ENV,
    botToken: parsed.data.BOT_TOKEN,
    staffChatId: typeof parsed.data.STAFF_CHAT_ID === "number" ? parsed.data.STAFF_CHAT_ID : null,
    databaseUrl: parsed.data.DATABASE_URL,
    logLevel: parsed.data.LOG_LEVEL,
    backupEnabled: parsed.data.BACKUP_ENABLED === "true" || parsed.data.BACKUP_ENABLED === "1",
    backupDir: parsed.data.BACKUP_DIR ?? null,
    backupIntervalHours: parsed.data.BACKUP_INTERVAL_HOURS,
    backupRetentionCount: parsed.data.BACKUP_RETENTION_COUNT
  };
}

export const hostConfig = loadHostConfig();
let runtimeStaffChatId = hostConfig.staffChatId;
export function setRuntimeStaffChatId(chatId: number | null): void { runtimeStaffChatId = chatId; }
export const config = {
  nodeEnv: hostConfig.nodeEnv,
  botToken: hostConfig.botToken,
  databaseUrl: hostConfig.databaseUrl,
  logLevel: hostConfig.logLevel,
  backupEnabled: hostConfig.backupEnabled,
  backupDir: hostConfig.backupDir,
  backupIntervalHours: hostConfig.backupIntervalHours,
  backupRetentionCount: hostConfig.backupRetentionCount,
  get staffChatId(): number {
    if (runtimeStaffChatId === null) throw new Error("Staff workspace is not configured yet.");
    return runtimeStaffChatId;
  }
} as const;
