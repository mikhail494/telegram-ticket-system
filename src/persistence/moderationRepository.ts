import Database from "better-sqlite3";
import { now } from "./helpers.js";
import type { LanguageModerationCleanupJob, LanguageModerationUserState, LanguageModerationViolation, LanguageModerationViolationCleanupState, LanguageModerationWarningState } from "./types.js";
export class ModerationRepository {
  constructor(private readonly db: Database.Database) {}
  getLanguageModerationUserState(chatId: number, userId: number): LanguageModerationUserState | undefined {
    return this.db.prepare("SELECT * FROM language_moderation_user_state WHERE chat_id = ? AND user_telegram_id = ?").get(chatId, userId) as LanguageModerationUserState | undefined;
  }

  upsertLanguageModerationUserState(input: Omit<LanguageModerationUserState, "updated_at">): void {
    this.db.prepare(`INSERT INTO language_moderation_user_state (chat_id, user_telegram_id, username, current_strikes, sanction_tier, first_strike_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, user_telegram_id) DO UPDATE SET username = excluded.username, current_strikes = excluded.current_strikes, sanction_tier = excluded.sanction_tier, first_strike_at = excluded.first_strike_at, updated_at = excluded.updated_at`)
      .run(input.chat_id, input.user_telegram_id, input.username, input.current_strikes, input.sanction_tier, input.first_strike_at, now());
  }

  addLanguageModerationViolation(input: Pick<LanguageModerationViolation, "chat_id" | "user_telegram_id" | "message_id" | "username" | "cycle_tier"> & { message_thread_id?: number | null }): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO language_moderation_violations (chat_id, user_telegram_id, message_id, username, detected_at, cycle_tier, message_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.chat_id, input.user_telegram_id, input.message_id, input.username, now(), input.cycle_tier, input.message_thread_id ?? null);
    return result.changes === 1;
  }

  listLanguageModerationViolations(chatId: number, since: string): LanguageModerationViolation[] {
    return this.db.prepare("SELECT * FROM language_moderation_violations WHERE chat_id = ? AND detected_at >= ? ORDER BY detected_at ASC, message_id ASC").all(chatId, since) as LanguageModerationViolation[];
  }

  claimLanguageModerationFirstStrikes(chatId: number, since: string, messageThreadId: number | null = null): Array<{ userId: number; username: string | null; messageId: number }> {
    const transaction = this.db.transaction(() => {
      const candidates = this.db.prepare(`
        SELECT v.user_telegram_id AS userId, MAX(v.message_id) AS messageId, MAX(v.username) AS username
        FROM language_moderation_violations v
        LEFT JOIN language_moderation_user_state s ON s.chat_id = v.chat_id AND s.user_telegram_id = v.user_telegram_id
        WHERE v.chat_id = ? AND v.detected_at >= ? AND COALESCE(v.message_thread_id, 0) = ? AND COALESCE(s.current_strikes, 0) = 0
        GROUP BY v.user_telegram_id ORDER BY v.user_telegram_id ASC
      `).all(chatId, since, messageThreadId ?? 0) as Array<{ userId: number; username: string | null; messageId: number }>;
      const timestamp = now();
      const update = this.db.prepare(`INSERT INTO language_moderation_user_state (chat_id, user_telegram_id, username, current_strikes, sanction_tier, first_strike_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?) ON CONFLICT(chat_id, user_telegram_id) DO UPDATE SET current_strikes = 1, username = excluded.username, first_strike_at = excluded.first_strike_at, updated_at = excluded.updated_at WHERE language_moderation_user_state.current_strikes = 0`);
      return candidates.filter((candidate) => update.run(chatId, candidate.userId, candidate.username, timestamp, timestamp).changes === 1);
    });
    return transaction();
  }

  clearLanguageModerationViolations(chatId: number, userId: number): void {
    this.db.prepare("DELETE FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ?").run(chatId, userId);
  }

  listLanguageModerationCycleViolations(chatId: number, userId: number, cycleTier: number): LanguageModerationViolation[] {
    return this.db.prepare("SELECT * FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ? AND cycle_tier = ? ORDER BY message_id ASC").all(chatId, userId, cycleTier) as LanguageModerationViolation[];
  }

  listPendingLanguageModerationCycleViolations(chatId: number, userId: number, cycleTier: number): LanguageModerationViolation[] {
    return this.db.prepare("SELECT * FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ? AND cycle_tier = ? AND cleanup_state = 'PENDING' ORDER BY message_id ASC").all(chatId, userId, cycleTier) as LanguageModerationViolation[];
  }

  assignLanguageModerationViolationCycle(chatId: number, userId: number, cycleTier: number, cycleId: string): number {
    const result = this.db.prepare("UPDATE language_moderation_violations SET moderation_cycle_id = ? WHERE chat_id = ? AND user_telegram_id = ? AND cycle_tier = ? AND moderation_cycle_id IS NULL")
      .run(cycleId, chatId, userId, cycleTier);
    return result.changes;
  }

  listLanguageModerationCleanupCycleViolations(chatId: number, userId: number, cycleId: string): LanguageModerationViolation[] {
    return this.db.prepare("SELECT * FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ? AND moderation_cycle_id = ? ORDER BY message_id ASC").all(chatId, userId, cycleId) as LanguageModerationViolation[];
  }

  listPendingLanguageModerationCleanupCycleViolations(chatId: number, userId: number, cycleId: string): LanguageModerationViolation[] {
    return this.db.prepare("SELECT * FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ? AND moderation_cycle_id = ? AND cleanup_state = 'PENDING' ORDER BY message_id ASC").all(chatId, userId, cycleId) as LanguageModerationViolation[];
  }

  recordLanguageModerationViolationCleanupResult(input: {
    chatId: number;
    userId: number;
    messageId: number;
    state: LanguageModerationViolationCleanupState;
    errorCategory?: string | null;
    errorCode?: number | null;
    errorDescription?: string | null;
  }): void {
    const completedAt = input.state === "DELETED" || input.state === "ALREADY_ABSENT" ? now() : null;
    this.db.prepare(`UPDATE language_moderation_violations
      SET cleanup_state = ?, cleanup_attempt_count = cleanup_attempt_count + 1,
          cleanup_last_error_category = ?, cleanup_last_error_code = ?, cleanup_last_error_description = ?,
          cleanup_completed_at = ?
      WHERE chat_id = ? AND user_telegram_id = ? AND message_id = ? AND cleanup_state = 'PENDING'`)
      .run(
        input.state,
        input.errorCategory ?? null,
        input.errorCode ?? null,
        input.errorDescription ?? null,
        completedAt,
        input.chatId,
        input.userId,
        input.messageId
      );
  }

  clearLanguageModerationCycleViolations(chatId: number, userId: number, cycleTier: number): void {
    this.db.prepare("DELETE FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ? AND cycle_tier = ?").run(chatId, userId, cycleTier);
  }

  clearLanguageModerationCleanupCycleViolations(chatId: number, userId: number, cycleId: string): void {
    this.db.prepare("DELETE FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ? AND moderation_cycle_id = ?").run(chatId, userId, cycleId);
  }

  getLanguageModerationChatState(chatId: number): LanguageModerationWarningState | undefined {
    return this.getLanguageModerationWarningState(chatId, null);
  }

  upsertLanguageModerationChatState(chatId: number, values: { lastWarningMessageId?: number | null; lastWarningAt?: string | null; ordinaryMessagesSinceWarning: number; pendingWarningDueAt?: string | null; pendingWarningStartedAt?: string | null }): void {
    this.upsertLanguageModerationWarningState(chatId, null, values);
  }

  getLanguageModerationWarningState(chatId: number, messageThreadId: number | null): LanguageModerationWarningState | undefined {
    return this.db.prepare("SELECT * FROM language_moderation_warning_state WHERE chat_id = ? AND message_thread_id = ?")
      .get(chatId, messageThreadId ?? 0) as LanguageModerationWarningState | undefined;
  }

  upsertLanguageModerationWarningState(
    chatId: number,
    messageThreadId: number | null,
    values: { lastWarningMessageId?: number | null; lastWarningAt?: string | null; ordinaryMessagesSinceWarning: number; pendingWarningDueAt?: string | null; pendingWarningStartedAt?: string | null }
  ): void {
    this.db.prepare(`INSERT INTO language_moderation_warning_state (chat_id, message_thread_id, last_warning_message_id, last_warning_at, ordinary_messages_since_warning, pending_warning_due_at, pending_warning_started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, message_thread_id) DO UPDATE SET last_warning_message_id = excluded.last_warning_message_id,
        last_warning_at = excluded.last_warning_at, ordinary_messages_since_warning = excluded.ordinary_messages_since_warning,
        pending_warning_due_at = excluded.pending_warning_due_at, pending_warning_started_at = excluded.pending_warning_started_at,
        updated_at = excluded.updated_at`)
      .run(chatId, messageThreadId ?? 0, values.lastWarningMessageId ?? null, values.lastWarningAt ?? null,
        values.ordinaryMessagesSinceWarning, values.pendingWarningDueAt ?? null, values.pendingWarningStartedAt ?? null, now());
  }

  createLanguageModerationCleanupJob(input: Omit<LanguageModerationCleanupJob, "id" | "state" | "created_at" | "updated_at">): number {
    const result = this.db.prepare("INSERT INTO language_moderation_cleanup_jobs (staff_chat_id, chat_id, user_telegram_id, username, chat_title, sanction_tier, sanction_kind, violation_cycle_id, cleanup_due_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)")
      .run(input.staff_chat_id, input.chat_id, input.user_telegram_id, input.username, input.chat_title, input.sanction_tier, input.sanction_kind, input.violation_cycle_id, input.cleanup_due_at, now(), now());
    return Number(result.lastInsertRowid);
  }

  getLanguageModerationCleanupJob(jobId: number): LanguageModerationCleanupJob | undefined {
    return this.db.prepare("SELECT * FROM language_moderation_cleanup_jobs WHERE id = ?").get(jobId) as LanguageModerationCleanupJob | undefined;
  }

  listLanguageModerationRecoveryJobs(staffChatId: number, nowIso: string): LanguageModerationCleanupJob[] {
    return this.db.prepare("SELECT * FROM language_moderation_cleanup_jobs WHERE staff_chat_id = ? AND state IN ('PENDING', 'CLEANING', 'LOG_PENDING') AND cleanup_due_at <= ? ORDER BY id ASC").all(staffChatId, nowIso) as LanguageModerationCleanupJob[];
  }

  updateLanguageModerationCleanupJob(id: number, state: LanguageModerationCleanupJob["state"]): void {
    this.db.prepare("UPDATE language_moderation_cleanup_jobs SET state = ?, updated_at = ? WHERE id = ?").run(state, now(), id);
  }


}