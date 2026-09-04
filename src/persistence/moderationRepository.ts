import Database from "better-sqlite3";
import {
  ADAPTIVE_LEARNING_HORIZON_MS,
  ADAPTIVE_STORAGE_MAINTENANCE_INTERVAL,
  MAX_ADAPTIVE_MESSAGE_FEATURES_PER_CHAT,
  MAX_ADAPTIVE_SIGNAL_OBSERVATIONS_PER_CHAT,
  MAX_ADAPTIVE_TOKEN_FEATURES,
  MAX_ADAPTIVE_TRIGRAM_FEATURES,
} from "../adaptiveModerationPolicy.js";
import { now } from "./helpers.js";
import type {
  LanguageModerationCleanupJob,
  LanguageModerationLearningSignal,
  LanguageModerationMessageAuthor,
  LanguageModerationMessageFeatures,
  LanguageModerationSignalKind,
  LanguageModerationUserState,
  LanguageModerationViolation,
  LanguageModerationViolationCleanupState,
  LanguageModerationWarningState,
} from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SIGNAL_CHUNK_SIZE = 50;
const PRUNE_BATCH_SIZE = 100;
const STORAGE_CAP_PRUNE_BATCH_SIZE = 8_192;
const MAX_OWNER_FEEDBACK_PER_CHAT = 500;

export class ModerationRepository {
  constructor(private readonly db: Database.Database) {}
  addLanguageModerationMessageAuthor(input: {
    chatId: number;
    messageId: number;
    userTelegramId: number;
    username?: string | null;
    messageThreadId?: number | null;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO language_moderation_message_authors
      (chat_id, message_id, user_telegram_id, username, message_thread_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.chatId,
        input.messageId,
        input.userTelegramId,
        input.username ?? null,
        input.messageThreadId ?? null,
        now()
      );
    return result.changes === 1;
  }

  getLanguageModerationMessageAuthor(chatId: number, messageId: number): LanguageModerationMessageAuthor | undefined {
    return this.db
      .prepare("SELECT * FROM language_moderation_message_authors WHERE chat_id = ? AND message_id = ?")
      .get(chatId, messageId) as LanguageModerationMessageAuthor | undefined;
  }

  recordLanguageModerationObservation(input: {
    chatId: number;
    messageId: number;
    userTelegramId: number;
    features: { fingerprintHash: string; tokenHashes: readonly string[]; trigramHashes: readonly string[] };
    observedAt: string;
    expiresAt: string;
  }): boolean {
    const fingerprintHash = normalizeHash(input.features.fingerprintHash);
    if (!fingerprintHash) return false;
    const tokenHashes = normalizeHashes(input.features.tokenHashes, MAX_ADAPTIVE_TOKEN_FEATURES);
    const trigramHashes = normalizeHashes(input.features.trigramHashes, MAX_ADAPTIVE_TRIGRAM_FEATURES);
    const learningActiveSince = new Date(Date.parse(input.observedAt) - ADAPTIVE_LEARNING_HORIZON_MS).toISOString();
    const transaction = this.db.transaction(() => {
      this.pruneExpiredAdaptiveData(input.chatId, input.observedAt, learningActiveSince);
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO language_moderation_message_features
          (chat_id, message_id, user_telegram_id, fingerprint_hash, token_hashes_json, trigram_hashes_json, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.chatId,
          input.messageId,
          input.userTelegramId,
          fingerprintHash,
          JSON.stringify(tokenHashes),
          JSON.stringify(trigramHashes),
          input.observedAt,
          input.expiresAt
        ).changes;
      if (inserted !== 1) return false;
      this.insertSignalObservations(input.chatId, input.messageId, "TOKEN", tokenHashes, input.observedAt);
      this.insertSignalObservations(input.chatId, input.messageId, "TRIGRAM", trigramHashes, input.observedAt);
      if (this.advanceAdaptiveMaintenanceCounter(input.chatId)) this.enforceAdaptiveStorageCaps(input.chatId);
      return true;
    });
    return transaction();
  }

  getLanguageModerationMessageFeatures(
    chatId: number,
    messageId: number
  ): LanguageModerationMessageFeatures | undefined {
    return this.db
      .prepare("SELECT * FROM language_moderation_message_features WHERE chat_id = ? AND message_id = ?")
      .get(chatId, messageId) as LanguageModerationMessageFeatures | undefined;
  }

  getLanguageModerationAdaptiveEvidence(input: {
    chatId: number;
    features: {
      fingerprintHash: string;
      tokenHashes: readonly string[];
      trigramHashes: readonly string[];
      families: ReadonlyArray<{ tokenHash: string; trigramHashes: readonly string[] }>;
    };
    activeSince: string;
    currentTime: string;
  }): {
    exactOwnerConfirmed: boolean;
    families: Array<{
      token?: {
        kind: LanguageModerationSignalKind;
        seenCount: number;
        positiveCount: number;
        lastPositiveAt: string | null;
      };
      trigrams: Array<{
        kind: LanguageModerationSignalKind;
        seenCount: number;
        positiveCount: number;
        lastPositiveAt: string | null;
      }>;
      totalTrigramCount: number;
    }>;
  } {
    const fingerprintHash = normalizeHash(input.features.fingerprintHash);
    const exactOwnerConfirmed = Boolean(
      fingerprintHash &&
      this.db
        .prepare(
          `SELECT 1 FROM language_moderation_owner_feedback feedback
          JOIN language_moderation_message_features features
            ON features.chat_id = feedback.chat_id AND features.message_id = feedback.message_id
          WHERE feedback.chat_id = ? AND features.fingerprint_hash = ?
            AND feedback.created_at >= ? AND features.expires_at > ? LIMIT 1`
        )
        .get(input.chatId, fingerprintHash, input.activeSince, input.currentTime)
    );
    const tokenRows = this.selectLearningSignals(
      input.chatId,
      "TOKEN",
      normalizeHashes(input.features.tokenHashes, MAX_ADAPTIVE_TOKEN_FEATURES),
      input.activeSince
    );
    const trigramRows = this.selectLearningSignals(
      input.chatId,
      "TRIGRAM",
      normalizeHashes(input.features.trigramHashes, MAX_ADAPTIVE_TRIGRAM_FEATURES),
      input.activeSince
    );
    const tokenEvidence = new Map(tokenRows.map((row) => [row.signal_hash, learningSignalEvidence(row)]));
    const trigramEvidence = new Map(trigramRows.map((row) => [row.signal_hash, learningSignalEvidence(row)]));
    return {
      exactOwnerConfirmed,
      families: input.features.families
        .map((family) => {
          const tokenHash = normalizeHash(family.tokenHash);
          const trigramHashes = normalizeHashes(family.trigramHashes, MAX_ADAPTIVE_TRIGRAM_FEATURES);
          return {
            token: tokenHash ? tokenEvidence.get(tokenHash) : undefined,
            trigrams: trigramHashes
              .map((hash) => trigramEvidence.get(hash))
              .filter((signal): signal is NonNullable<typeof signal> => signal !== undefined),
            totalTrigramCount: trigramHashes.length,
          };
        })
        .filter((family) => family.token !== undefined || family.totalTrigramCount > 0),
    };
  }

  recordLanguageModerationOwnerFeedback(input: {
    chatId: number;
    messageId: number;
    userTelegramId: number;
    recordedAt: string;
    retainUntil: string;
  }): { feedbackRecorded: boolean; featuresAvailable: boolean } {
    const transaction = this.db.transaction(() => {
      const features = this.getLanguageModerationMessageFeatures(input.chatId, input.messageId);
      const featuresAvailable =
        features?.user_telegram_id === input.userTelegramId && features.expires_at > input.recordedAt;
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO language_moderation_owner_feedback
          (chat_id, message_id, user_telegram_id, created_at) VALUES (?, ?, ?, ?)`
        )
        .run(input.chatId, input.messageId, input.userTelegramId, input.recordedAt).changes;
      if (inserted !== 1) return { feedbackRecorded: false, featuresAvailable };
      if (featuresAvailable && features) {
        this.db
          .prepare(
            `UPDATE language_moderation_message_features
            SET expires_at = CASE WHEN expires_at < ? THEN ? ELSE expires_at END
            WHERE chat_id = ? AND message_id = ?`
          )
          .run(input.retainUntil, input.retainUntil, input.chatId, input.messageId);
        this.markSignalObservationsPositive(input.chatId, input.messageId, input.recordedAt);
      }
      this.enforceOwnerFeedbackCap(input.chatId);
      return { feedbackRecorded: true, featuresAvailable };
    });
    return transaction();
  }

  countLanguageModerationOwnerFeedback(chatId: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS count FROM language_moderation_owner_feedback WHERE chat_id = ?")
        .get(chatId) as {
        count: number;
      }
    ).count;
  }

  listLanguageModerationLearningSignals(chatId: number): LanguageModerationLearningSignal[] {
    return this.db
      .prepare(
        `SELECT chat_id, signal_kind, signal_hash,
                COUNT(*) AS seen_count,
                SUM(positive) AS positive_count,
                MIN(observed_at) AS first_observed_at,
                MAX(observed_at) AS last_seen_at,
                MAX(positive_at) AS last_positive_at
         FROM language_moderation_learning_signal_observations
         WHERE chat_id = ?
         GROUP BY chat_id, signal_kind, signal_hash
         ORDER BY signal_kind, signal_hash`
      )
      .all(chatId) as LanguageModerationLearningSignal[];
  }

  getLanguageModerationUserState(chatId: number, userId: number): LanguageModerationUserState | undefined {
    return this.db
      .prepare("SELECT * FROM language_moderation_user_state WHERE chat_id = ? AND user_telegram_id = ?")
      .get(chatId, userId) as LanguageModerationUserState | undefined;
  }

  upsertLanguageModerationUserState(input: Omit<LanguageModerationUserState, "updated_at">): void {
    this.db
      .prepare(
        `INSERT INTO language_moderation_user_state (chat_id, user_telegram_id, username, current_strikes, sanction_tier, first_strike_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, user_telegram_id) DO UPDATE SET username = excluded.username, current_strikes = excluded.current_strikes, sanction_tier = excluded.sanction_tier, first_strike_at = excluded.first_strike_at, updated_at = excluded.updated_at`
      )
      .run(
        input.chat_id,
        input.user_telegram_id,
        input.username,
        input.current_strikes,
        input.sanction_tier,
        input.first_strike_at,
        now()
      );
  }

  addLanguageModerationViolation(
    input: Pick<
      LanguageModerationViolation,
      "chat_id" | "user_telegram_id" | "message_id" | "username" | "cycle_tier"
    > & { message_thread_id?: number | null }
  ): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO language_moderation_violations (chat_id, user_telegram_id, message_id, username, detected_at, cycle_tier, message_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.chat_id,
        input.user_telegram_id,
        input.message_id,
        input.username,
        now(),
        input.cycle_tier,
        input.message_thread_id ?? null
      );
    return result.changes === 1;
  }

  getLanguageModerationViolation(chatId: number, messageId: number): LanguageModerationViolation | undefined {
    return this.db
      .prepare("SELECT * FROM language_moderation_violations WHERE chat_id = ? AND message_id = ?")
      .get(chatId, messageId) as LanguageModerationViolation | undefined;
  }

  listLanguageModerationViolations(chatId: number, since: string): LanguageModerationViolation[] {
    return this.db
      .prepare(
        "SELECT * FROM language_moderation_violations WHERE chat_id = ? AND detected_at >= ? ORDER BY detected_at ASC, message_id ASC"
      )
      .all(chatId, since) as LanguageModerationViolation[];
  }

  claimLanguageModerationFirstStrikes(
    chatId: number,
    since: string,
    messageThreadId: number | null = null
  ): Array<{ userId: number; username: string | null; messageId: number }> {
    const transaction = this.db.transaction(() => {
      const candidates = this.db
        .prepare(
          `
        SELECT v.user_telegram_id AS userId, MAX(v.message_id) AS messageId, MAX(v.username) AS username
        FROM language_moderation_violations v
        LEFT JOIN language_moderation_user_state s ON s.chat_id = v.chat_id AND s.user_telegram_id = v.user_telegram_id
        WHERE v.chat_id = ? AND v.detected_at >= ? AND COALESCE(v.message_thread_id, 0) = ? AND COALESCE(s.current_strikes, 0) = 0
        GROUP BY v.user_telegram_id ORDER BY v.user_telegram_id ASC
      `
        )
        .all(chatId, since, messageThreadId ?? 0) as Array<{
        userId: number;
        username: string | null;
        messageId: number;
      }>;
      const timestamp = now();
      const update = this.db.prepare(
        `INSERT INTO language_moderation_user_state (chat_id, user_telegram_id, username, current_strikes, sanction_tier, first_strike_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?) ON CONFLICT(chat_id, user_telegram_id) DO UPDATE SET current_strikes = 1, username = excluded.username, first_strike_at = excluded.first_strike_at, updated_at = excluded.updated_at WHERE language_moderation_user_state.current_strikes = 0`
      );
      return candidates.filter(
        (candidate) => update.run(chatId, candidate.userId, candidate.username, timestamp, timestamp).changes === 1
      );
    });
    return transaction();
  }

  clearLanguageModerationViolations(chatId: number, userId: number): void {
    this.db
      .prepare("DELETE FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ?")
      .run(chatId, userId);
  }

  listLanguageModerationCycleViolations(
    chatId: number,
    userId: number,
    cycleTier: number
  ): LanguageModerationViolation[] {
    return this.db
      .prepare(
        "SELECT * FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ? AND cycle_tier = ? ORDER BY message_id ASC"
      )
      .all(chatId, userId, cycleTier) as LanguageModerationViolation[];
  }

  listPendingLanguageModerationCycleViolations(
    chatId: number,
    userId: number,
    cycleTier: number
  ): LanguageModerationViolation[] {
    return this.db
      .prepare(
        "SELECT * FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ? AND cycle_tier = ? AND cleanup_state = 'PENDING' ORDER BY message_id ASC"
      )
      .all(chatId, userId, cycleTier) as LanguageModerationViolation[];
  }

  assignLanguageModerationViolationCycle(chatId: number, userId: number, cycleTier: number, cycleId: string): number {
    const result = this.db
      .prepare(
        "UPDATE language_moderation_violations SET moderation_cycle_id = ? WHERE chat_id = ? AND user_telegram_id = ? AND cycle_tier = ? AND moderation_cycle_id IS NULL"
      )
      .run(cycleId, chatId, userId, cycleTier);
    return result.changes;
  }

  listLanguageModerationCleanupCycleViolations(
    chatId: number,
    userId: number,
    cycleId: string
  ): LanguageModerationViolation[] {
    return this.db
      .prepare(
        "SELECT * FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ? AND moderation_cycle_id = ? ORDER BY message_id ASC"
      )
      .all(chatId, userId, cycleId) as LanguageModerationViolation[];
  }

  listPendingLanguageModerationCleanupCycleViolations(
    chatId: number,
    userId: number,
    cycleId: string
  ): LanguageModerationViolation[] {
    return this.db
      .prepare(
        "SELECT * FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ? AND moderation_cycle_id = ? AND cleanup_state = 'PENDING' ORDER BY message_id ASC"
      )
      .all(chatId, userId, cycleId) as LanguageModerationViolation[];
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
    this.db
      .prepare(
        `UPDATE language_moderation_violations
      SET cleanup_state = ?, cleanup_attempt_count = cleanup_attempt_count + 1,
          cleanup_last_error_category = ?, cleanup_last_error_code = ?, cleanup_last_error_description = ?,
          cleanup_completed_at = ?
      WHERE chat_id = ? AND user_telegram_id = ? AND message_id = ? AND cleanup_state = 'PENDING'`
      )
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
    this.db
      .prepare(
        "DELETE FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ? AND cycle_tier = ?"
      )
      .run(chatId, userId, cycleTier);
  }

  clearLanguageModerationCleanupCycleViolations(chatId: number, userId: number, cycleId: string): void {
    this.db
      .prepare(
        "DELETE FROM language_moderation_violations WHERE chat_id = ? AND user_telegram_id = ? AND moderation_cycle_id = ?"
      )
      .run(chatId, userId, cycleId);
  }

  getLanguageModerationChatState(chatId: number): LanguageModerationWarningState | undefined {
    return this.getLanguageModerationWarningState(chatId, null);
  }

  upsertLanguageModerationChatState(
    chatId: number,
    values: {
      lastWarningMessageId?: number | null;
      lastWarningAt?: string | null;
      ordinaryMessagesSinceWarning: number;
      pendingWarningDueAt?: string | null;
      pendingWarningStartedAt?: string | null;
    }
  ): void {
    this.upsertLanguageModerationWarningState(chatId, null, values);
  }

  getLanguageModerationWarningState(
    chatId: number,
    messageThreadId: number | null
  ): LanguageModerationWarningState | undefined {
    return this.db
      .prepare("SELECT * FROM language_moderation_warning_state WHERE chat_id = ? AND message_thread_id = ?")
      .get(chatId, messageThreadId ?? 0) as LanguageModerationWarningState | undefined;
  }

  upsertLanguageModerationWarningState(
    chatId: number,
    messageThreadId: number | null,
    values: {
      lastWarningMessageId?: number | null;
      lastWarningAt?: string | null;
      ordinaryMessagesSinceWarning: number;
      pendingWarningDueAt?: string | null;
      pendingWarningStartedAt?: string | null;
    }
  ): void {
    this.db
      .prepare(
        `INSERT INTO language_moderation_warning_state (chat_id, message_thread_id, last_warning_message_id, last_warning_at, ordinary_messages_since_warning, pending_warning_due_at, pending_warning_started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, message_thread_id) DO UPDATE SET last_warning_message_id = excluded.last_warning_message_id,
        last_warning_at = excluded.last_warning_at, ordinary_messages_since_warning = excluded.ordinary_messages_since_warning,
        pending_warning_due_at = excluded.pending_warning_due_at, pending_warning_started_at = excluded.pending_warning_started_at,
        updated_at = excluded.updated_at`
      )
      .run(
        chatId,
        messageThreadId ?? 0,
        values.lastWarningMessageId ?? null,
        values.lastWarningAt ?? null,
        values.ordinaryMessagesSinceWarning,
        values.pendingWarningDueAt ?? null,
        values.pendingWarningStartedAt ?? null,
        now()
      );
  }

  createLanguageModerationCleanupJob(
    input: Omit<LanguageModerationCleanupJob, "id" | "state" | "created_at" | "updated_at">
  ): number {
    const result = this.db
      .prepare(
        "INSERT INTO language_moderation_cleanup_jobs (staff_chat_id, chat_id, user_telegram_id, username, chat_title, sanction_tier, sanction_kind, violation_cycle_id, cleanup_due_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)"
      )
      .run(
        input.staff_chat_id,
        input.chat_id,
        input.user_telegram_id,
        input.username,
        input.chat_title,
        input.sanction_tier,
        input.sanction_kind,
        input.violation_cycle_id,
        input.cleanup_due_at,
        now(),
        now()
      );
    return Number(result.lastInsertRowid);
  }

  getLanguageModerationCleanupJob(jobId: number): LanguageModerationCleanupJob | undefined {
    return this.db.prepare("SELECT * FROM language_moderation_cleanup_jobs WHERE id = ?").get(jobId) as
      LanguageModerationCleanupJob | undefined;
  }

  listLanguageModerationRecoveryJobs(staffChatId: number, nowIso: string): LanguageModerationCleanupJob[] {
    return this.db
      .prepare(
        "SELECT * FROM language_moderation_cleanup_jobs WHERE staff_chat_id = ? AND state IN ('PENDING', 'CLEANING', 'LOG_PENDING') AND cleanup_due_at <= ? ORDER BY id ASC"
      )
      .all(staffChatId, nowIso) as LanguageModerationCleanupJob[];
  }

  updateLanguageModerationCleanupJob(id: number, state: LanguageModerationCleanupJob["state"]): void {
    this.db
      .prepare("UPDATE language_moderation_cleanup_jobs SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, now(), id);
  }

  private insertSignalObservations(
    chatId: number,
    messageId: number,
    kind: LanguageModerationSignalKind,
    hashes: readonly string[],
    observedAt: string
  ): void {
    for (const hashChunk of chunks(hashes, SIGNAL_CHUNK_SIZE)) {
      const values = hashChunk.map(() => "(?, ?, ?, ?, ?, 0, NULL, ?)").join(", ");
      const parameters = hashChunk.flatMap((hash) => [chatId, messageId, kind, hash, observedAt, observedAt]);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO language_moderation_learning_signal_observations
          (chat_id, message_id, signal_kind, signal_hash, observed_at, positive, positive_at, retained_at)
          VALUES ${values}`
        )
        .run(...parameters);
    }
  }

  private markSignalObservationsPositive(chatId: number, messageId: number, recordedAt: string): void {
    this.db
      .prepare(
        `UPDATE language_moderation_learning_signal_observations
         SET positive = 1, positive_at = ?, retained_at = ?
         WHERE chat_id = ? AND message_id = ? AND positive = 0`
      )
      .run(recordedAt, recordedAt, chatId, messageId);
  }

  private selectLearningSignals(
    chatId: number,
    kind: LanguageModerationSignalKind,
    hashes: readonly string[],
    activeSince: string
  ): LanguageModerationLearningSignal[] {
    const rows: LanguageModerationLearningSignal[] = [];
    for (const hashChunk of chunks(hashes, SIGNAL_CHUNK_SIZE)) {
      const placeholders = hashChunk.map(() => "?").join(", ");
      rows.push(
        ...(this.db
          .prepare(
            `SELECT chat_id, signal_kind, signal_hash,
                    COUNT(*) AS seen_count,
                    SUM(positive) AS positive_count,
                    MIN(observed_at) AS first_observed_at,
                    MAX(observed_at) AS last_seen_at,
                    MAX(positive_at) AS last_positive_at
             FROM language_moderation_learning_signal_observations
             WHERE chat_id = ? AND signal_kind = ? AND retained_at >= ?
               AND signal_hash IN (${placeholders})
             GROUP BY chat_id, signal_kind, signal_hash`
          )
          .all(chatId, kind, activeSince, ...hashChunk) as LanguageModerationLearningSignal[])
      );
    }
    return rows;
  }

  private pruneExpiredAdaptiveData(chatId: number, currentTime: string, learningActiveSince: string): void {
    this.db
      .prepare(
        `DELETE FROM language_moderation_message_features WHERE rowid IN (
          SELECT rowid FROM language_moderation_message_features
          WHERE expires_at <= ? ORDER BY expires_at, chat_id, message_id LIMIT ?
        )`
      )
      .run(currentTime, PRUNE_BATCH_SIZE);
    this.db
      .prepare(
        `DELETE FROM language_moderation_learning_signal_observations WHERE rowid IN (
          SELECT rowid FROM language_moderation_learning_signal_observations
          WHERE chat_id = ? AND retained_at < ?
          ORDER BY retained_at, message_id, signal_kind, signal_hash LIMIT ?
        )`
      )
      .run(chatId, learningActiveSince, PRUNE_BATCH_SIZE);
    this.pruneOwnerFeedback(chatId, learningActiveSince);
  }

  private pruneOwnerFeedback(chatId: number, activeSince: string): void {
    this.db
      .prepare(
        `DELETE FROM language_moderation_owner_feedback WHERE rowid IN (
          SELECT rowid FROM language_moderation_owner_feedback
          WHERE chat_id = ? AND created_at < ? LIMIT ?
        )`
      )
      .run(chatId, activeSince, PRUNE_BATCH_SIZE);
  }

  private enforceAdaptiveStorageCaps(chatId: number): void {
    const featureExcess = Math.min(
      STORAGE_CAP_PRUNE_BATCH_SIZE,
      Math.max(
        0,
        this.countRowsForChat("language_moderation_message_features", chatId) - MAX_ADAPTIVE_MESSAGE_FEATURES_PER_CHAT
      )
    );
    if (featureExcess > 0)
      this.db
        .prepare(
          `DELETE FROM language_moderation_message_features WHERE rowid IN (
            SELECT rowid FROM language_moderation_message_features WHERE chat_id = ?
            ORDER BY created_at, message_id LIMIT ?
          )`
        )
        .run(chatId, featureExcess);

    const observationExcess = Math.min(
      STORAGE_CAP_PRUNE_BATCH_SIZE,
      Math.max(
        0,
        this.countRowsForChat("language_moderation_learning_signal_observations", chatId) -
          MAX_ADAPTIVE_SIGNAL_OBSERVATIONS_PER_CHAT
      )
    );
    if (observationExcess > 0)
      this.db
        .prepare(
          `DELETE FROM language_moderation_learning_signal_observations WHERE rowid IN (
            SELECT rowid FROM language_moderation_learning_signal_observations WHERE chat_id = ?
            ORDER BY retained_at, message_id, signal_kind, signal_hash LIMIT ?
          )`
        )
        .run(chatId, observationExcess);
  }

  private advanceAdaptiveMaintenanceCounter(chatId: number): boolean {
    this.db
      .prepare(
        `INSERT INTO language_moderation_adaptive_maintenance (chat_id, observations_since_maintenance)
         VALUES (?, 1)
         ON CONFLICT(chat_id) DO UPDATE SET
           observations_since_maintenance = observations_since_maintenance + 1`
      )
      .run(chatId);
    const count = (
      this.db
        .prepare(
          "SELECT observations_since_maintenance AS count FROM language_moderation_adaptive_maintenance WHERE chat_id = ?"
        )
        .get(chatId) as { count: number }
    ).count;
    if (count < ADAPTIVE_STORAGE_MAINTENANCE_INTERVAL) return false;
    this.db
      .prepare(
        "UPDATE language_moderation_adaptive_maintenance SET observations_since_maintenance = 0 WHERE chat_id = ?"
      )
      .run(chatId);
    return true;
  }

  private countRowsForChat(table: string, chatId: number): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE chat_id = ?`).get(chatId) as { count: number }
    ).count;
  }

  private enforceOwnerFeedbackCap(chatId: number): void {
    this.db
      .prepare(
        `DELETE FROM language_moderation_owner_feedback WHERE rowid IN (
          SELECT rowid FROM language_moderation_owner_feedback WHERE chat_id = ?
          ORDER BY created_at DESC, message_id DESC LIMIT ? OFFSET ?
        )`
      )
      .run(chatId, PRUNE_BATCH_SIZE, MAX_OWNER_FEEDBACK_PER_CHAT);
  }
}

function normalizeHash(value: string): string | undefined {
  const normalized = value.toLowerCase();
  return SHA256_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeHashes(values: readonly string[], limit: number): string[] {
  return [...new Set(values.map(normalizeHash).filter((value): value is string => value !== undefined))].slice(
    0,
    limit
  );
}

function learningSignalEvidence(signal: LanguageModerationLearningSignal): {
  kind: LanguageModerationSignalKind;
  seenCount: number;
  positiveCount: number;
  lastPositiveAt: string | null;
} {
  return {
    kind: signal.signal_kind,
    seenCount: signal.seen_count,
    positiveCount: signal.positive_count,
    lastPositiveAt: signal.last_positive_at,
  };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
