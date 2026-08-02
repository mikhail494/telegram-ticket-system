
import { normalizeTelegramDeliveryError } from "./deliveryDiagnostics.js";
import { logger } from "./logger.js";

export const DEFAULT_MODERATION_WARNING = "Please use English in the main chat. Further violations may be reviewed by an authorized moderator under the current community policy.";

export interface LanguageModerationConfig {
  enabled: boolean;
  targetChatId: number | null;
  warningText: string;
  lookbackMinutes: number;
  warningCooldownMinutes: number;
  warningMessageThreshold: number;
  allowlist: readonly string[];
}

export type LanguageClassification = "violation" | "ignored";

const scheduledCleanupJobs = new Set<number>();

export type ModerationCleanupScheduler = (
  api: import("grammy").Context["api"],
  db: import("./db.js").SupportDatabase,
  jobId: number,
  delayMs?: number
) => void;

export type ModerationTimerFactory = (callback: () => void, delayMs: number) => { unref?: () => void };

export function classifyEnglishOnlyMessage(text: string, allowlist: readonly string[] = []): LanguageClassification {
  const normalized = preprocessModerationText(text, allowlist);
  if (!normalized) return "ignored";

  const letters = normalized.match(/\p{L}/gu) ?? [];
  const cyrillic = normalized.match(/\p{Script=Cyrillic}/gu) ?? [];
  const nonLatin = normalized.match(/[\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? [];
  if (letters.length < 5 || isKeyboardMash(normalized)) return "ignored";
  if (cyrillic.length >= 5 && cyrillic.length / letters.length >= 0.55) return "violation";
  if (nonLatin.length >= 5 && nonLatin.length / letters.length >= 0.55) return "violation";
  return "ignored";
}

export function preprocessModerationText(text: string, allowlist: readonly string[] = []): string {
  let value = text
    .replace(/```[\s\S]*?```|`[^`]*`/g, " ")
    .replace(/^>.*$/gm, " ")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/@[\w_]+|#[\w_]+|\$[\w_]+|\/\w+(?:@\w+)?/g, " ")
    .replace(/\b(?:0x[a-f\d]{32,}|[1-9A-HJ-NP-Za-km-z]{26,}|[a-f\d]{32,})\b/gi, " ")
    .replace(/\b\d+(?:[.,]\d+)?\b/g, " ");
  for (const entry of allowlist) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    value = value.replace(new RegExp(escapeRegExp(trimmed), "gi"), " ");
  }
  return value.replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function parseModerationConfig(settings: Readonly<Record<string, string | undefined>>): LanguageModerationConfig {
  const targetChatId = parseInteger(settings.target);
  return {
    enabled: settings.enabled === "true",
    targetChatId,
    warningText: settings.warning_text?.trim() || DEFAULT_MODERATION_WARNING,
    lookbackMinutes: parsePositiveInteger(settings.lookback_minutes, 5),
    warningCooldownMinutes: parsePositiveInteger(settings.warning_cooldown_minutes, 10),
    warningMessageThreshold: parsePositiveInteger(settings.warning_message_threshold, 15),
    allowlist: parseAllowlist(settings.allowlist)
  };
}

export function parseAllowlist(value: string | undefined): readonly string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
  } catch {
    return [];
  }
}

export function scheduleModerationCleanup(
  api: import("grammy").Context["api"],
  db: import("./db.js").SupportDatabase,
  jobId: number,
  delayMs = 10_000,
  createTimer: ModerationTimerFactory = (callback, delay) => setTimeout(callback, delay)
): void {
  if (scheduledCleanupJobs.has(jobId)) return;
  scheduledCleanupJobs.add(jobId);
  const timer = createTimer(() => {
    void processModerationCleanupJob(api, db, jobId, new Date())
      .catch(async (error) => {
        const { logger } = await import("./logger.js");
        logger.warn({ jobId, err: error }, "Moderation cleanup timer failed");
      })
      .finally(() => scheduledCleanupJobs.delete(jobId));
  }, delayMs);
  timer.unref?.();
}

export async function processModerationRecovery(api: import("grammy").Context["api"], db: import("./db.js").SupportDatabase, currentTime = new Date()): Promise<void> {
  const { config } = await import("./config.js");
  for (const job of db.listLanguageModerationRecoveryJobs(config.staffChatId, currentTime.toISOString())) {
    await processModerationCleanupJob(api, db, job.id, currentTime);
  }
}

export async function processModerationCleanupJob(
  api: import("grammy").Context["api"],
  db: import("./db.js").SupportDatabase,
  jobId: number,
  currentTime = new Date()
): Promise<void> {
  const { config } = await import("./config.js");
  const job = db.getLanguageModerationCleanupJob(jobId);
  if (!job || job.staff_chat_id !== config.staffChatId || job.state === "COMPLETED" || Date.parse(job.cleanup_due_at) > currentTime.getTime()) return;

  if (!job.violation_cycle_id) {
    logger.warn({ jobId: job.id, chatId: job.chat_id }, "Moderation cleanup job has no immutable violation cycle reference");
    return;
  }

  let state = job.state;
  const cycleId = job.violation_cycle_id;

  try {
    if (state === "PENDING" || state === "CLEANING" || db.listPendingLanguageModerationCleanupCycleViolations(job.chat_id, job.user_telegram_id, cycleId).length > 0) {
      db.updateLanguageModerationCleanupJob(job.id, "CLEANING");
      const summary = { attempted: 0, deleted: 0, alreadyAbsent: 0, retryableFailures: 0, terminalFailures: 0 };
      for (const violation of db.listPendingLanguageModerationCleanupCycleViolations(job.chat_id, job.user_telegram_id, cycleId)) {
        summary.attempted += 1;
        try {
          await api.deleteMessage(job.chat_id, violation.message_id);
          db.recordLanguageModerationViolationCleanupResult({ chatId: job.chat_id, userId: job.user_telegram_id, messageId: violation.message_id, state: "DELETED" });
          summary.deleted += 1;
        } catch (error) {
          const diagnostic = normalizeTelegramDeliveryError(error);
          if (isAlreadyAbsentModerationMessage(diagnostic)) {
            db.recordLanguageModerationViolationCleanupResult({ chatId: job.chat_id, userId: job.user_telegram_id, messageId: violation.message_id, state: "ALREADY_ABSENT" });
            summary.alreadyAbsent += 1;
            continue;
          }

          const retryable = isRetryableModerationDeletionFailure(diagnostic);
          db.recordLanguageModerationViolationCleanupResult({
            chatId: job.chat_id,
            userId: job.user_telegram_id,
            messageId: violation.message_id,
            state: retryable ? "PENDING" : "TERMINAL_FAILED",
            errorCategory: diagnostic.category,
            errorCode: diagnostic.telegramErrorCode,
            errorDescription: diagnostic.description
          });
          if (retryable) summary.retryableFailures += 1;
          else summary.terminalFailures += 1;
          logger.warn({ jobId: job.id, chatId: job.chat_id, messageId: violation.message_id, telegramErrorCode: diagnostic.telegramErrorCode, description: diagnostic.description, retryable }, "Could not delete moderation violation message");
        }
      }
      logger.info({ jobId: job.id, chatId: job.chat_id, attemptedCount: summary.attempted, deletedCount: summary.deleted, alreadyAbsentCount: summary.alreadyAbsent, retryableFailureCount: summary.retryableFailures, terminalFailureCount: summary.terminalFailures }, "Moderation cleanup deletion summary");

      const unresolved = db.listLanguageModerationCleanupCycleViolations(job.chat_id, job.user_telegram_id, cycleId)
        .some((violation) => violation.cleanup_state === "PENDING" || violation.cleanup_state === "TERMINAL_FAILED");
      if (unresolved) return;
      db.updateLanguageModerationCleanupJob(job.id, "LOG_PENDING");
      state = "LOG_PENDING";
    }

    if (state !== "LOG_PENDING") return;
    const { logModerationSanction } = await import("./archive.js");
    await logModerationSanction(api, db, {
      userTelegramId: job.user_telegram_id,
      username: job.username,
      publicChatId: job.chat_id,
      publicChatTitle: job.chat_title,
      sanctionTier: job.sanction_tier,
      sanctionKind: job.sanction_kind,
      timestamp: job.updated_at
    });
    db.clearLanguageModerationCleanupCycleViolations(job.chat_id, job.user_telegram_id, cycleId);
    db.updateLanguageModerationCleanupJob(job.id, "COMPLETED");
  } catch (error) {
    db.updateLanguageModerationCleanupJob(jobId, state === "LOG_PENDING" ? "LOG_PENDING" : "CLEANING");
    const diagnostic = normalizeTelegramDeliveryError(error);
    logger.warn({ jobId, chatId: job.chat_id, category: diagnostic.category, telegramErrorCode: diagnostic.telegramErrorCode, description: diagnostic.description }, "Moderation cleanup/log recovery pending");
  }
}

function isAlreadyAbsentModerationMessage(diagnostic: ReturnType<typeof normalizeTelegramDeliveryError>): boolean {
  const description = diagnostic.description?.toLowerCase() ?? "";
  return diagnostic.telegramErrorCode === 400 && description.includes("message to delete not found");
}

function isRetryableModerationDeletionFailure(diagnostic: ReturnType<typeof normalizeTelegramDeliveryError>): boolean {
  return diagnostic.permanence !== "PERMANENT" || diagnostic.category === "FORBIDDEN";
}

function parseInteger(value: string | undefined): number | null {
  if (!value || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = parseInteger(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

function isKeyboardMash(value: string): boolean {
  const compact = value.replace(/\s/g, "").toLowerCase();
  if (compact.length < 8) return false;
  if (!/[a-zа-яё]/i.test(compact)) return false;
  const vowels = (compact.match(/[aeiouyаеёиоуыэюя]/g) ?? []).length;
  return vowels / compact.length < 0.08;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
