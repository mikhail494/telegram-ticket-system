import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { DeliveryErrorCategory, DeliveryErrorPermanence, NormalizedDeliveryError } from "./deliveryDiagnostics.js";

export type TicketStatus = "OPEN" | "WAITING_USER" | "IN_PROGRESS" | "CLOSED";
export type MessageDirection = "USER_TO_STAFF" | "STAFF_TO_USER" | "SYSTEM";
export type MessageSenderType = "USER" | "STAFF" | "SYSTEM";

export interface UserRecord {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketRecord {
  id: number;
  user_telegram_id: number;
  status: TicketStatus;
  staff_chat_id: number | null;
  message_thread_id: number | null;
  staff_message_id: number | null;
  logs_message_id: number | null;
  transcript_message_id: number | null;
  archived_at: string | null;
  closed_by_type: MessageSenderType | null;
  closed_by_display_name: string | null;
  closed_by_username: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  follow_up_state: TicketFollowUpState;
  internal_note: string | null;
  escalation_target: TicketEscalationTarget;
  follow_up_updated_at: string | null;
  follow_up_source_answer_package_id: string | null;
}

export type TicketFollowUpState = "NONE" | "WAITING_USER" | "WAITING_DEVS" | "WAITING_QUEST_OWNER" | "MONITORING";
export type TicketEscalationTarget = "NONE" | "DEVS" | "PAYMENTS" | "SECURITY" | "QUEST_OWNER" | "SUPPORT";

export interface TicketFollowUpHistoryRecord {
  id: number;
  ticket_id: number;
  follow_up_state: TicketFollowUpState;
  internal_note: string | null;
  escalation_target: TicketEscalationTarget;
  source_answer_package_id: string | null;
  created_at: string;
}

export interface TicketWithUser extends TicketRecord {
  username: string | null;
  first_name: string | null;
  last_name: string | null;
}

export interface TicketMessageRecord {
  id: number;
  ticket_id: number;
  direction: MessageDirection;
  source_chat_id: number | null;
  source_message_id: number | null;
  delivery_chat_id: number | null;
  delivery_message_id: number | null;
  from_telegram_id: number | null;
  from_username: string | null;
  sender_type: MessageSenderType | null;
  sender_display_name: string | null;
  sender_username: string | null;
  text: string | null;
  media_type: string | null;
  filename: string | null;
  file_id: string | null;
  created_at: string;
}

export interface BannedUserRecord {
  user_telegram_id: number;
  username: string | null;
  reason: string;
  banned_by: number | null;
  created_at: string;
}

export interface UserInput {
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface AddMessageInput {
  ticketId: number;
  direction: MessageDirection;
  sourceChatId?: number | null;
  sourceMessageId?: number | null;
  deliveryChatId?: number | null;
  deliveryMessageId?: number | null;
  fromTelegramId?: number | null;
  fromUsername?: string | null;
  senderType?: MessageSenderType | null;
  senderDisplayName?: string | null;
  senderUsername?: string | null;
  text?: string | null;
  mediaType?: string | null;
  filename?: string | null;
  fileId?: string | null;
}

export interface BanUserInput {
  userTelegramId: number;
  username?: string | null;
  reason: string;
  bannedBy?: number | null;
}

export interface CloseTicketInput {
  type: MessageSenderType;
  displayName: string;
  username?: string | null;
}

export interface TicketBatchExportRecord {
  export_id: string;
  staff_chat_id: number;
  created_at: string;
  selection_mode: string;
  ticket_count: number;
  delivery_state: TicketBatchExportDeliveryState;
  delivery_message_id: number | null;
  delivered_at: string | null;
  last_error: string | null;
}

export type TicketBatchExportDeliveryState = "PREPARING" | "DELIVERED" | "FAILED" | "UNKNOWN_DELIVERY";

export interface TicketBatchExportItemRecord {
  export_id: string;
  ticket_id: number;
  snapshot_token: string;
}

export interface TicketBatchDeliveryFailureContext {
  category: DeliveryErrorCategory;
  permanence: DeliveryErrorPermanence;
  occurred_at: string;
  retry_after_seconds: number | null;
  staff_failure_event_posted: boolean;
}

export interface TicketBatchStaffSyncContext {
  state: TicketBatchTopicEchoState;
  delivered: boolean;
  terminal_failure_category: DeliveryErrorCategory | null;
  intended_follow_up_state: TicketFollowUpState;
  intended_escalation_target: TicketEscalationTarget;
  internal_context_available: boolean;
}

export interface CreateTicketBatchExportInput {
  exportId: string;
  staffChatId: number;
  createdAt: string;
  selectionMode: "all_active";
  ticketCount: number;
  items: Array<{ ticketId: number; snapshotToken: string }>;
  deliveryState?: TicketBatchExportDeliveryState;
}

export type TicketBatchAnswerPackageStatus = "PENDING" | "APPLYING" | "COMPLETED" | "PARTIAL" | "CANCELLED";
export type TicketBatchAnswerItemState = "PENDING" | "APPLYING" | "REPLY_SENT" | "STAFF_SYNC_PENDING" | "COMPLETED" | "NO_ACTION" | "STALE" | "INACTIVE" | "FAILED" | "UNKNOWN_DELIVERY";
export type TicketBatchTopicEchoState = "NOT_REQUIRED" | "PENDING" | "SENT" | "FAILED" | "TERMINAL_FAILED";
export type TicketBatchFailureEventState = "NOT_REQUIRED" | "PENDING" | "SENT" | "FAILED";
export type TicketBatchSummaryDeliveryState = "NOT_ATTEMPTED" | "SENT" | "FAILED";
export type TicketBatchFinalSummaryState = "NOT_PENDING" | "PENDING" | "SENT" | "FAILED" | "UNKNOWN_DELIVERY";

export interface TicketBatchAnswerPackageRecord {
  answer_package_id: string; export_id: string; staff_chat_id: number; package_hash: string;
  source_chat_id: number | null; source_message_id: number | null; package_created_at: string;
  imported_at: string; status: TicketBatchAnswerPackageStatus; started_at: string | null;
  completed_at: string | null; updated_at: string;
  preview_token: string | null; preview_chat_id: number | null; preview_message_id: number | null; preview_page: number | null;
  summary_delivery_state: TicketBatchSummaryDeliveryState; summary_delivery_error: string | null; summary_delivery_attempted_at: string | null;
  final_summary_state: TicketBatchFinalSummaryState; final_summary_text: string | null;
  final_summary_chat_id: number | null; final_summary_origin_chat_id: number | null; final_summary_origin_message_id: number | null;
  final_summary_message_id: number | null; final_summary_attempt_count: number; final_summary_next_retry_at: string | null;
  final_summary_last_error: string | null; final_summary_delivered_at: string | null;
}

export interface TicketBatchAnswerItemRecord {
  answer_package_id: string; ticket_id: number; snapshot_token: string; action: "reply_keep_open" | "reply_and_close" | "no_action";
  reply_text: string | null; state: TicketBatchAnswerItemState; delivery_message_id: number | null;
  applied_at: string | null; last_error: string | null; updated_at: string;
  follow_up_state: TicketFollowUpState; internal_note: string | null; escalation_target: TicketEscalationTarget;
  topic_echo_chat_id: number | null; topic_echo_thread_id: number | null; topic_echo_message_id: number | null;
  topic_echo_state: TicketBatchTopicEchoState; topic_echo_last_error: string | null;
  topic_echo_attempt_count: number; topic_echo_next_retry_at: string | null;
  topic_echo_error_category: DeliveryErrorCategory | null; topic_echo_error_code: number | null;
  topic_echo_http_status: number | null; topic_echo_error_method: string | null;
  topic_echo_error_description: string | null; topic_echo_terminal_at: string | null;
  delivery_error_category: DeliveryErrorCategory | null; delivery_error_permanence: DeliveryErrorPermanence | null;
  delivery_error_code: number | null; delivery_http_status: number | null; delivery_error_method: string | null;
  delivery_retry_after_seconds: number | null; delivery_error_description: string | null; delivery_failed_at: string | null;
  delivery_attempt_count: number; delivery_failure_event_state: TicketBatchFailureEventState;
  delivery_failure_event_message_id: number | null; delivery_failure_event_attempt_count: number;
  delivery_failure_event_next_retry_at: string | null;
}

export interface TicketBatchRecoveryAudit {
  successTopicEchoes: number;
  failureEvents: number;
  noActionFollowUpEvents: number;
  finalSummaries: number;
  invalidSuccessEchoes: number;
  terminalStaffFailures: number;
  userFacingCandidates: number;
}

export interface CreateTicketBatchAnswerPackageInput {
  answerPackageId: string; exportId: string; staffChatId: number; packageHash: string;
  sourceChatId?: number | null; sourceMessageId?: number | null; packageCreatedAt: string;
  items: Array<Pick<TicketBatchAnswerItemRecord, "ticket_id" | "snapshot_token" | "action" | "reply_text"> & Partial<Pick<TicketBatchAnswerItemRecord, "follow_up_state" | "internal_note" | "escalation_target">>>;
}

export interface LanguageModerationUserState {
  chat_id: number; user_telegram_id: number; username: string | null; current_strikes: number;
  sanction_tier: number; first_strike_at: string | null; updated_at: string;
}

export interface LanguageModerationViolation {
  chat_id: number; user_telegram_id: number; message_id: number; username: string | null;
  detected_at: string; cycle_tier: number; moderation_cycle_id: string | null; cleanup_state: LanguageModerationViolationCleanupState;
  cleanup_attempt_count: number; cleanup_last_error_category: string | null; cleanup_last_error_code: number | null;
  cleanup_last_error_description: string | null; cleanup_completed_at: string | null;
}

export type LanguageModerationViolationCleanupState = "PENDING" | "DELETED" | "ALREADY_ABSENT" | "TERMINAL_FAILED";

export interface LanguageModerationCleanupJob {
  id: number; staff_chat_id: number | null; chat_id: number; user_telegram_id: number; username: string | null; chat_title: string | null;
  sanction_tier: number; sanction_kind: string; violation_cycle_id: string | null; cleanup_due_at: string; state: "PENDING" | "CLEANING" | "LOG_PENDING" | "COMPLETED";
  created_at: string; updated_at: string;
}

export type EntityNotificationPublicationState = "CLAIMED" | "PUBLISHED" | "FAILED" | "UNKNOWN_DELIVERY";

export interface EntityNotificationPublication {
  provider: string;
  entity_type: string;
  entity_id: string;
  event_type: "created";
  observed_at: string;
  target_chat_id: number | null;
  state: EntityNotificationPublicationState;
  telegram_message_id: number | null;
  first_seen_at: string;
  published_at: string | null;
  updated_at: string;
  last_error: string | null;
}

interface TableColumnInfo {
  name: string;
}

interface Migration {
  id: number;
  name: string;
  up: () => void;
}

const TICKET_STATUSES: TicketStatus[] = ["OPEN", "WAITING_USER", "IN_PROGRESS", "CLOSED"];

function now(): string {
  return new Date().toISOString();
}

function senderTypeForDirection(direction: MessageDirection): MessageSenderType {
  if (direction === "USER_TO_STAFF") {
    return "USER";
  }

  if (direction === "STAFF_TO_USER") {
    return "STAFF";
  }

  return "SYSTEM";
}

function normalizeDatabasePath(databaseUrl: string): string {
  const value = databaseUrl.trim();

  if (value === ":memory:") {
    return value;
  }

  if (value.startsWith("file://")) {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    return process.platform === "win32" && /^\/[A-Za-z]:/.test(pathname)
      ? pathname.slice(1)
      : pathname;
  }

  if (value.startsWith("file:")) {
    return value.slice("file:".length);
  }

  if (value.startsWith("sqlite://")) {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    return process.platform === "win32" && /^\/[A-Za-z]:/.test(pathname)
      ? pathname.slice(1)
      : pathname;
  }

  return value;
}

function ensureDirectoryForDatabase(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  const directory = path.dirname(databasePath);
  if (directory && directory !== ".") {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export class SupportDatabase {
  private readonly db: Database.Database;

  constructor(databaseUrl: string) {
    const databasePath = normalizeDatabasePath(databaseUrl);
    ensureDirectoryForDatabase(databasePath);

    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  upsertUser(user: UserInput): void {
    const timestamp = now();
    this.db
      .prepare(
        `
        INSERT INTO users (telegram_id, username, first_name, last_name, created_at, updated_at)
        VALUES (@telegramId, @username, @firstName, @lastName, @createdAt, @updatedAt)
        ON CONFLICT(telegram_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          updated_at = excluded.updated_at
      `
      )
      .run({
        telegramId: user.telegramId,
        username: user.username ?? null,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        createdAt: timestamp,
        updatedAt: timestamp
      });
  }

  getUser(telegramId: number): UserRecord | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE telegram_id = ?")
      .get(telegramId) as UserRecord | undefined;
  }

  createTicket(userTelegramId: number, staffChatId: number): TicketRecord {
    const timestamp = now();
    const result = this.db
      .prepare(
        `
        INSERT INTO tickets (user_telegram_id, status, staff_chat_id, created_at, updated_at)
        VALUES (?, 'OPEN', ?, ?, ?)
      `
      )
      .run(userTelegramId, staffChatId, timestamp, timestamp);

    return this.getTicket(Number(result.lastInsertRowid))!;
  }

  getTicket(ticketId: number): TicketRecord | undefined {
    return this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId) as
      | TicketRecord
      | undefined;
  }

  getTicketWithUser(ticketId: number): TicketWithUser | undefined {
    return this.db
      .prepare(
        `
        SELECT
          tickets.*,
          users.username,
          users.first_name,
          users.last_name
        FROM tickets
        JOIN users ON users.telegram_id = tickets.user_telegram_id
        WHERE tickets.id = ?
      `
      )
      .get(ticketId) as TicketWithUser | undefined;
  }

  findActiveTicketForUser(userTelegramId: number, staffChatId: number): TicketRecord | undefined {
    return this.db
      .prepare(
        `
        SELECT * FROM tickets
        WHERE user_telegram_id = ?
          AND staff_chat_id = ?
          AND status != 'CLOSED'
        ORDER BY id DESC
        LIMIT 1
      `
      )
      .get(userTelegramId, staffChatId) as TicketRecord | undefined;
  }

  getLatestTicketForUser(userTelegramId: number, staffChatId: number): TicketRecord | undefined {
    return this.db
      .prepare(
        `
        SELECT * FROM tickets
        WHERE user_telegram_id = ? AND staff_chat_id = ?
        ORDER BY id DESC
        LIMIT 1
      `
      )
      .get(userTelegramId, staffChatId) as TicketRecord | undefined;
  }

  listTicketsForUser(userTelegramId: number, staffChatId: number, limit = 10): TicketRecord[] {
    return this.db
      .prepare(
        `
        SELECT * FROM tickets
        WHERE user_telegram_id = ? AND staff_chat_id = ?
        ORDER BY id DESC
        LIMIT ?
      `
      )
      .all(userTelegramId, staffChatId, limit) as TicketRecord[];
  }

  findTicketByStaffThread(staffChatId: number, messageThreadId: number): TicketWithUser | undefined {
    return this.db
      .prepare(
        `
        SELECT
          tickets.*,
          users.username,
          users.first_name,
          users.last_name
        FROM tickets
        JOIN users ON users.telegram_id = tickets.user_telegram_id
        WHERE tickets.staff_chat_id = ? AND tickets.message_thread_id = ?
        ORDER BY tickets.id DESC
        LIMIT 1
      `
      )
      .get(staffChatId, messageThreadId) as TicketWithUser | undefined;
  }

  closeOtherActiveTicketsForUserInStaffChat(
    userTelegramId: number,
    staffChatId: number,
    keepTicketId: number
  ): number {
    const timestamp = now();
    const result = this.db
      .prepare(
        `
        UPDATE tickets
        SET status = 'CLOSED',
            updated_at = ?,
            closed_at = COALESCE(closed_at, ?),
            follow_up_state = 'NONE',
            internal_note = NULL,
            escalation_target = 'NONE',
            follow_up_updated_at = ?,
            follow_up_source_answer_package_id = NULL
        WHERE user_telegram_id = ?
          AND staff_chat_id = ?
          AND id != ?
          AND status != 'CLOSED'
      `
      )
      .run(timestamp, timestamp, timestamp, userTelegramId, staffChatId, keepTicketId);

    return result.changes;
  }

  updateTicketStaffMessage(ticketId: number, staffChatId: number, staffMessageId: number): void {
    this.db
      .prepare(
        `
        UPDATE tickets
        SET staff_chat_id = ?, staff_message_id = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(staffChatId, staffMessageId, now(), ticketId);
  }

  updateTicketForumTopic(ticketId: number, staffChatId: number, messageThreadId: number): void {
    this.db
      .prepare(
        `
        UPDATE tickets
        SET staff_chat_id = ?, message_thread_id = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(staffChatId, messageThreadId, now(), ticketId);
  }

  updateTicketStatus(ticketId: number, status: TicketStatus): TicketRecord | undefined {
    if (!TICKET_STATUSES.includes(status)) {
      throw new Error(`Unsupported ticket status: ${status}`);
    }

    const timestamp = now();
    this.db
      .prepare(
        `
        UPDATE tickets
        SET status = ?,
            updated_at = ?,
            closed_at = CASE WHEN ? = 'CLOSED' THEN COALESCE(closed_at, ?) ELSE NULL END,
            closed_by_type = CASE WHEN ? = 'CLOSED' THEN closed_by_type ELSE NULL END,
            closed_by_display_name = CASE WHEN ? = 'CLOSED' THEN closed_by_display_name ELSE NULL END,
            closed_by_username = CASE WHEN ? = 'CLOSED' THEN closed_by_username ELSE NULL END,
            follow_up_state = CASE WHEN ? = 'CLOSED' THEN 'NONE' ELSE follow_up_state END,
            internal_note = CASE WHEN ? = 'CLOSED' THEN NULL ELSE internal_note END,
            escalation_target = CASE WHEN ? = 'CLOSED' THEN 'NONE' ELSE escalation_target END,
            follow_up_updated_at = CASE WHEN ? = 'CLOSED' THEN ? ELSE follow_up_updated_at END,
            follow_up_source_answer_package_id = CASE WHEN ? = 'CLOSED' THEN NULL ELSE follow_up_source_answer_package_id END
        WHERE id = ?
      `
      )
      .run(
        status,
        timestamp,
        status,
        status === "CLOSED" ? timestamp : null,
        status,
        status,
        status,
        status,
        status,
        status,
        status,
        status === "CLOSED" ? timestamp : null,
        status,
        ticketId
      );

    return this.getTicket(ticketId);
  }

  listActiveTicketsForStaffChat(staffChatId: number): TicketWithUser[] {
    return this.db
      .prepare(
        `
        SELECT tickets.*, users.username, users.first_name, users.last_name
        FROM tickets
        JOIN users ON users.telegram_id = tickets.user_telegram_id
        WHERE tickets.staff_chat_id = ?
          AND tickets.status IN ('OPEN', 'IN_PROGRESS', 'WAITING_USER')
        ORDER BY tickets.id ASC
      `
      )
      .all(staffChatId) as TicketWithUser[];
  }

  closeTicketRecord(ticketId: number, input: CloseTicketInput): TicketRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(
        `
        UPDATE tickets
        SET status = 'CLOSED',
            updated_at = ?,
            closed_at = COALESCE(closed_at, ?),
            closed_by_type = ?,
            closed_by_display_name = ?,
            closed_by_username = ?,
            follow_up_state = 'NONE',
            internal_note = NULL,
            escalation_target = 'NONE',
            follow_up_updated_at = ?,
            follow_up_source_answer_package_id = NULL
        WHERE id = ?
      `
      )
      .run(
        timestamp,
        timestamp,
        input.type,
        input.displayName,
        input.username ?? null,
        timestamp,
        ticketId
      );

    return this.getTicket(ticketId);
  }

  markTicketArchivedAndDeleteMessages(
    ticketId: number,
    logsMessageId: number,
    transcriptMessageId: number
  ): void {
    const tx = this.db.transaction(() => {
      const timestamp = now();
      this.db
        .prepare(
          `
          UPDATE tickets
          SET logs_message_id = ?,
              transcript_message_id = ?,
              archived_at = ?,
              updated_at = ?
          WHERE id = ?
        `
        )
        .run(logsMessageId, transcriptMessageId, timestamp, timestamp, ticketId);

      this.db.prepare("DELETE FROM messages WHERE ticket_id = ?").run(ticketId);
    });

    tx();
  }

  addMessage(input: AddMessageInput): number {
    const tx = this.db.transaction((message: AddMessageInput) => {
      const result = this.db
        .prepare(
          `
          INSERT INTO messages (
            ticket_id,
            direction,
            source_chat_id,
            source_message_id,
            delivery_chat_id,
            delivery_message_id,
            from_telegram_id,
            from_username,
            sender_type,
            sender_display_name,
            sender_username,
            text,
            media_type,
            filename,
            file_id,
            created_at
          )
          VALUES (
            @ticketId,
            @direction,
            @sourceChatId,
            @sourceMessageId,
            @deliveryChatId,
            @deliveryMessageId,
            @fromTelegramId,
            @fromUsername,
            @senderType,
            @senderDisplayName,
            @senderUsername,
            @text,
            @mediaType,
            @filename,
            @fileId,
            @createdAt
          )
        `
        )
        .run({
          ticketId: message.ticketId,
          direction: message.direction,
          sourceChatId: message.sourceChatId ?? null,
          sourceMessageId: message.sourceMessageId ?? null,
          deliveryChatId: message.deliveryChatId ?? null,
          deliveryMessageId: message.deliveryMessageId ?? null,
          fromTelegramId: message.fromTelegramId ?? null,
          fromUsername: message.fromUsername ?? null,
          senderType: message.senderType ?? senderTypeForDirection(message.direction),
          senderDisplayName: message.senderDisplayName ?? null,
          senderUsername: message.senderUsername ?? message.fromUsername ?? null,
          text: message.text ?? null,
          mediaType: message.mediaType ?? null,
          filename: message.filename ?? null,
          fileId: message.fileId ?? null,
          createdAt: now()
        });

      this.db
        .prepare("UPDATE tickets SET updated_at = ? WHERE id = ?")
        .run(now(), message.ticketId);

      return Number(result.lastInsertRowid);
    });

    return tx(input);
  }

  listMessages(ticketId: number, limit = 10): TicketMessageRecord[] {
    return this.db
      .prepare(
        `
        SELECT * FROM messages
        WHERE ticket_id = ?
        ORDER BY id DESC
        LIMIT ?
      `
      )
      .all(ticketId, limit) as TicketMessageRecord[];
  }

  listMessagesChronological(ticketId: number): TicketMessageRecord[] {
    return this.db
      .prepare(
        `
        SELECT * FROM messages
        WHERE ticket_id = ?
        ORDER BY created_at ASC, id ASC
      `
      )
      .all(ticketId) as TicketMessageRecord[];
  }

  deleteMessagesForTicket(ticketId: number): number {
    const result = this.db.prepare("DELETE FROM messages WHERE ticket_id = ?").run(ticketId);
    return result.changes;
  }

  listClosedTicketsPendingArchive(staffChatId: number, limit = 1000): TicketWithUser[] {
    return this.db
      .prepare(
        `
        SELECT
          tickets.*,
          users.username,
          users.first_name,
          users.last_name
        FROM tickets
        JOIN users ON users.telegram_id = tickets.user_telegram_id
        WHERE tickets.staff_chat_id = ?
          AND tickets.status = 'CLOSED'
          AND tickets.archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM messages WHERE messages.ticket_id = tickets.id
          )
        ORDER BY tickets.closed_at ASC, tickets.id ASC
        LIMIT ?
      `
      )
      .all(staffChatId, limit) as TicketWithUser[];
  }

  createTicketBatchExport(input: CreateTicketBatchExportInput): void {
    const tx = this.db.transaction((value: CreateTicketBatchExportInput) => {
      this.db
        .prepare(
          `
          INSERT INTO ticket_batch_exports (
            export_id, staff_chat_id, created_at, selection_mode, ticket_count, delivery_state
          ) VALUES (?, ?, ?, ?, ?, ?)
        `
        )
        .run(value.exportId, value.staffChatId, value.createdAt, value.selectionMode, value.ticketCount, value.deliveryState ?? "DELIVERED");

      const insertItem = this.db.prepare(
        `
        INSERT INTO ticket_batch_export_items (export_id, ticket_id, snapshot_token)
        VALUES (?, ?, ?)
      `
      );
      for (const item of value.items) {
        insertItem.run(value.exportId, item.ticketId, item.snapshotToken);
      }
    });

    tx(input);
  }

  getTicketBatchExport(exportId: string, staffChatId: number): TicketBatchExportRecord | undefined {
    return this.db
      .prepare(
        `
        SELECT * FROM ticket_batch_exports
        WHERE export_id = ? AND staff_chat_id = ?
      `
      )
      .get(exportId, staffChatId) as TicketBatchExportRecord | undefined;
  }

  listTicketBatchExportItems(exportId: string): TicketBatchExportItemRecord[] {
    return this.db
      .prepare(
        `
        SELECT * FROM ticket_batch_export_items
        WHERE export_id = ?
        ORDER BY ticket_id ASC
      `
      )
      .all(exportId) as TicketBatchExportItemRecord[];
  }

  markTicketBatchExportDelivered(exportId: string, staffChatId: number, deliveryMessageId: number): void {
    const result = this.db.prepare(`UPDATE ticket_batch_exports
      SET delivery_state = 'DELIVERED', delivery_message_id = ?, delivered_at = ?, last_error = NULL
      WHERE export_id = ? AND staff_chat_id = ? AND delivery_state = 'PREPARING'`)
      .run(deliveryMessageId, now(), exportId, staffChatId);
    if (result.changes !== 1) {
      throw new Error("Ticket batch export delivery state could not be confirmed.");
    }
  }

  markTicketBatchExportFailed(exportId: string, staffChatId: number, error: string): void {
    this.db.prepare(`UPDATE ticket_batch_exports
      SET delivery_state = 'FAILED', last_error = ?
      WHERE export_id = ? AND staff_chat_id = ? AND delivery_state = 'PREPARING'`)
      .run(error.slice(0, 160), exportId, staffChatId);
  }

  markTicketBatchExportUnknownDelivery(exportId: string, staffChatId: number, error: string): void {
    this.db.prepare(`UPDATE ticket_batch_exports
      SET delivery_state = 'UNKNOWN_DELIVERY', last_error = ?
      WHERE export_id = ? AND staff_chat_id = ? AND delivery_state = 'PREPARING'`)
      .run(error.slice(0, 160), exportId, staffChatId);
  }

  getTicketBatchAnswerPackage(answerPackageId: string, staffChatId: number): TicketBatchAnswerPackageRecord | undefined {
    return this.db.prepare("SELECT * FROM ticket_batch_answer_packages WHERE answer_package_id = ? AND staff_chat_id = ?")
      .get(answerPackageId, staffChatId) as TicketBatchAnswerPackageRecord | undefined;
  }

  getTicketBatchAnswerPackageByHash(packageHash: string, staffChatId: number): TicketBatchAnswerPackageRecord | undefined {
    return this.db.prepare("SELECT * FROM ticket_batch_answer_packages WHERE package_hash = ? AND staff_chat_id = ?")
      .get(packageHash, staffChatId) as TicketBatchAnswerPackageRecord | undefined;
  }

  getTicketBatchAnswerPackageByPreviewToken(previewToken: string, staffChatId: number): TicketBatchAnswerPackageRecord | undefined {
    return this.db.prepare("SELECT * FROM ticket_batch_answer_packages WHERE preview_token = ? AND staff_chat_id = ?")
      .get(previewToken, staffChatId) as TicketBatchAnswerPackageRecord | undefined;
  }

  createTicketBatchAnswerPackage(input: CreateTicketBatchAnswerPackageInput): TicketBatchAnswerPackageRecord {
    const tx = this.db.transaction((value: CreateTicketBatchAnswerPackageInput) => {
      const timestamp = now();
      this.db.prepare(`INSERT INTO ticket_batch_answer_packages (answer_package_id, export_id, staff_chat_id, package_hash, source_chat_id, source_message_id, package_created_at, imported_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`)
        .run(value.answerPackageId, value.exportId, value.staffChatId, value.packageHash, value.sourceChatId ?? null, value.sourceMessageId ?? null, value.packageCreatedAt, timestamp, timestamp);
      const insert = this.db.prepare(`INSERT INTO ticket_batch_answer_items (answer_package_id, ticket_id, snapshot_token, action, reply_text, state, updated_at, follow_up_state, internal_note, escalation_target, topic_echo_state) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, 'PENDING')`);
      for (const item of value.items) insert.run(value.answerPackageId, item.ticket_id, item.snapshot_token, item.action, item.reply_text, timestamp, item.follow_up_state ?? "NONE", item.internal_note ?? null, item.escalation_target ?? "NONE");
    });
    tx(input);
    return this.getTicketBatchAnswerPackage(input.answerPackageId, input.staffChatId)!;
  }

  listTicketBatchAnswerItems(answerPackageId: string): TicketBatchAnswerItemRecord[] {
    return this.db.prepare("SELECT * FROM ticket_batch_answer_items WHERE answer_package_id = ? ORDER BY ticket_id ASC")
      .all(answerPackageId) as TicketBatchAnswerItemRecord[];
  }

  getLatestTicketBatchDeliveryFailure(ticketId: number, staffChatId: number): TicketBatchDeliveryFailureContext | undefined {
    const row = this.db.prepare(`SELECT i.delivery_error_category AS category, i.delivery_error_permanence AS permanence,
      i.delivery_failed_at AS occurred_at, i.delivery_retry_after_seconds AS retry_after_seconds,
      i.delivery_failure_event_state = 'SENT' AS staff_failure_event_posted
      FROM ticket_batch_answer_items i
      JOIN ticket_batch_answer_packages p ON p.answer_package_id = i.answer_package_id
      WHERE i.ticket_id = ? AND p.staff_chat_id = ? AND i.delivery_error_category IS NOT NULL
      ORDER BY i.delivery_failed_at DESC, i.updated_at DESC LIMIT 1`)
      .get(ticketId, staffChatId) as (Omit<TicketBatchDeliveryFailureContext, "staff_failure_event_posted"> & { staff_failure_event_posted: number }) | undefined;
    return row ? { ...row, staff_failure_event_posted: row.staff_failure_event_posted === 1 } : undefined;
  }

  getLatestTicketBatchStaffSyncContext(ticketId: number, staffChatId: number): TicketBatchStaffSyncContext | undefined {
    const row = this.db.prepare(`SELECT i.topic_echo_state AS state, i.topic_echo_message_id IS NOT NULL AS delivered,
      i.topic_echo_error_category AS terminal_failure_category, i.follow_up_state AS intended_follow_up_state,
      i.escalation_target AS intended_escalation_target, (i.internal_note IS NOT NULL OR i.follow_up_state != 'NONE' OR i.escalation_target != 'NONE') AS internal_context_available
      FROM ticket_batch_answer_items i
      JOIN ticket_batch_answer_packages p ON p.answer_package_id = i.answer_package_id
      WHERE i.ticket_id = ? AND p.staff_chat_id = ? AND (i.topic_echo_state = 'TERMINAL_FAILED' OR i.topic_echo_state = 'SENT')
      ORDER BY i.updated_at DESC LIMIT 1`)
      .get(ticketId, staffChatId) as (Omit<TicketBatchStaffSyncContext, "delivered" | "internal_context_available"> & { delivered: number; internal_context_available: number }) | undefined;
    return row ? {
      ...row,
      delivered: row.delivered === 1,
      internal_context_available: row.internal_context_available === 1
    } : undefined;
  }

  setTicketBatchAnswerPackagePreview(answerPackageId: string, staffChatId: number, preview: { token: string; chatId: number; messageId: number; page: number }): boolean {
    const result = this.db.prepare(`UPDATE ticket_batch_answer_packages
      SET preview_token = ?, preview_chat_id = ?, preview_message_id = ?, preview_page = ?, updated_at = ?
      WHERE answer_package_id = ? AND staff_chat_id = ? AND status = 'PENDING' AND preview_message_id IS NULL`)
      .run(preview.token, preview.chatId, preview.messageId, preview.page, now(), answerPackageId, staffChatId);
    return result.changes === 1;
  }

  updateTicketBatchAnswerPackagePreviewPage(answerPackageId: string, staffChatId: number, page: number): void {
    this.db.prepare("UPDATE ticket_batch_answer_packages SET preview_page = ?, updated_at = ? WHERE answer_package_id = ? AND staff_chat_id = ? AND status = 'PENDING'")
      .run(page, now(), answerPackageId, staffChatId);
  }

  clearTicketBatchAnswerPackagePreview(answerPackageId: string, staffChatId: number): void {
    this.db.prepare("UPDATE ticket_batch_answer_packages SET preview_token = NULL, preview_chat_id = NULL, preview_message_id = NULL, preview_page = NULL, updated_at = ? WHERE answer_package_id = ? AND staff_chat_id = ?")
      .run(now(), answerPackageId, staffChatId);
  }

  claimTicketBatchAnswerPackage(answerPackageId: string, staffChatId: number): TicketBatchAnswerPackageRecord | undefined {
    const tx = this.db.transaction(() => {
      const item = this.getTicketBatchAnswerPackage(answerPackageId, staffChatId);
      if (!item || item.status !== "PENDING") return item;
      const timestamp = now();
      this.db.prepare("UPDATE ticket_batch_answer_packages SET status = 'APPLYING', started_at = COALESCE(started_at, ?), updated_at = ? WHERE answer_package_id = ? AND status = 'PENDING'")
        .run(timestamp, timestamp, answerPackageId);
      return this.getTicketBatchAnswerPackage(answerPackageId, staffChatId);
    });
    return tx();
  }

  cancelTicketBatchAnswerPackage(answerPackageId: string, staffChatId: number): boolean {
    const result = this.db.prepare("UPDATE ticket_batch_answer_packages SET status = 'CANCELLED', updated_at = ? WHERE answer_package_id = ? AND staff_chat_id = ? AND status = 'PENDING'")
      .run(now(), answerPackageId, staffChatId);
    return result.changes === 1;
  }

  claimTicketBatchAnswerItem(answerPackageId: string, ticketId: number): boolean {
    const result = this.db.prepare("UPDATE ticket_batch_answer_items SET state = 'APPLYING', updated_at = ? WHERE answer_package_id = ? AND ticket_id = ? AND state = 'PENDING'")
      .run(now(), answerPackageId, ticketId);
    return result.changes === 1;
  }

  updateTicketBatchAnswerItem(answerPackageId: string, ticketId: number, state: TicketBatchAnswerItemState, options: { deliveryMessageId?: number | null; lastError?: string | null; applied?: boolean } = {}): void {
    this.db.prepare("UPDATE ticket_batch_answer_items SET state = ?, delivery_message_id = COALESCE(?, delivery_message_id), last_error = ?, applied_at = CASE WHEN ? THEN ? ELSE applied_at END, updated_at = ? WHERE answer_package_id = ? AND ticket_id = ?")
      .run(state, options.deliveryMessageId ?? null, options.lastError ?? null, options.applied ? 1 : 0, options.applied ? now() : null, now(), answerPackageId, ticketId);
  }

  recordTicketBatchDeliveryFailure(
    answerPackageId: string,
    ticketId: number,
    state: "FAILED" | "UNKNOWN_DELIVERY",
    diagnostic: NormalizedDeliveryError
  ): void {
    this.db.prepare(`UPDATE ticket_batch_answer_items
      SET state = ?, last_error = ?, delivery_error_category = ?, delivery_error_permanence = ?,
          delivery_error_code = ?, delivery_http_status = ?, delivery_error_method = ?,
          delivery_retry_after_seconds = ?, delivery_error_description = ?, delivery_failed_at = ?,
          delivery_attempt_count = delivery_attempt_count + 1, updated_at = ?
      WHERE answer_package_id = ? AND ticket_id = ?`)
      .run(
        state,
        diagnostic.category,
        diagnostic.category,
        diagnostic.permanence,
        diagnostic.telegramErrorCode,
        diagnostic.httpStatus,
        diagnostic.method,
        diagnostic.retryAfterSeconds,
        diagnostic.description,
        diagnostic.occurredAt,
        now(),
        answerPackageId,
        ticketId
      );
  }

  recordTicketBatchFailureEvent(
    answerPackageId: string,
    ticketId: number,
    state: TicketBatchFailureEventState,
    messageId?: number | null,
    options: { nextRetryAt?: string | null; incrementAttempt?: boolean } = {}
  ): void {
    this.db.prepare(`UPDATE ticket_batch_answer_items
      SET delivery_failure_event_state = ?, delivery_failure_event_message_id = COALESCE(?, delivery_failure_event_message_id), delivery_failure_event_next_retry_at = COALESCE(?, delivery_failure_event_next_retry_at), delivery_failure_event_attempt_count = delivery_failure_event_attempt_count + ?, updated_at = ?
      WHERE answer_package_id = ? AND ticket_id = ?`)
      .run(state, messageId ?? null, options.nextRetryAt ?? null, options.incrementAttempt ? 1 : 0, now(), answerPackageId, ticketId);
  }

  listPendingTicketBatchFailureEvents(staffChatId: number, at: string, limit = 20): TicketBatchAnswerItemRecord[] {
    return this.db.prepare(`SELECT i.* FROM ticket_batch_answer_items i
      JOIN ticket_batch_answer_packages p ON p.answer_package_id = i.answer_package_id
      JOIN tickets t ON t.id = i.ticket_id
      WHERE p.staff_chat_id = ? AND i.delivery_failure_event_state IN ('PENDING', 'FAILED')
        AND t.status != 'CLOSED'
        AND i.action IN ('reply_keep_open', 'reply_and_close')
        AND i.delivery_error_category IS NOT NULL
        AND i.delivery_message_id IS NULL
        AND (i.delivery_failure_event_next_retry_at IS NULL OR i.delivery_failure_event_next_retry_at <= ?)
      ORDER BY i.updated_at ASC, i.ticket_id ASC LIMIT ?`).all(staffChatId, at, limit) as TicketBatchAnswerItemRecord[];
  }

  recordTicketBatchSummaryDelivery(answerPackageId: string, staffChatId: number, state: TicketBatchSummaryDeliveryState, error: string | null = null): void {
    this.db.prepare(`UPDATE ticket_batch_answer_packages
      SET summary_delivery_state = ?, summary_delivery_error = ?, summary_delivery_attempted_at = ?, updated_at = ?
      WHERE answer_package_id = ? AND staff_chat_id = ?`)
      .run(state, error, now(), now(), answerPackageId, staffChatId);
  }

  queueTicketBatchFinalSummary(
    answerPackageId: string,
    staffChatId: number,
    input: { text: string; chatId: number; originChatId?: number | null; originMessageId?: number | null }
  ): void {
    this.db.prepare(`UPDATE ticket_batch_answer_packages
      SET final_summary_state = 'PENDING', final_summary_text = ?, final_summary_chat_id = ?,
          final_summary_origin_chat_id = ?, final_summary_origin_message_id = ?,
          final_summary_next_retry_at = ?, final_summary_last_error = NULL, updated_at = ?
      WHERE answer_package_id = ? AND staff_chat_id = ? AND final_summary_state != 'SENT'`)
      .run(input.text, input.chatId, input.originChatId ?? null, input.originMessageId ?? null, now(), now(), answerPackageId, staffChatId);
  }

  queueTicketBatchFinalSummaryRefresh(answerPackageId: string, staffChatId: number, text: string): boolean {
    const timestamp = now();
    const result = this.db.prepare(`UPDATE ticket_batch_answer_packages
      SET final_summary_state = 'PENDING', final_summary_text = ?,
          final_summary_origin_chat_id = final_summary_chat_id,
          final_summary_origin_message_id = final_summary_message_id,
          final_summary_next_retry_at = ?, final_summary_last_error = NULL, updated_at = ?
      WHERE answer_package_id = ? AND staff_chat_id = ? AND final_summary_state = 'SENT'
        AND final_summary_chat_id IS NOT NULL AND final_summary_message_id IS NOT NULL`)
      .run(text, timestamp, timestamp, answerPackageId, staffChatId);
    return result.changes === 1;
  }

  listPendingTicketBatchFinalSummaries(staffChatId: number, at: string, limit = 20): TicketBatchAnswerPackageRecord[] {
    return this.db.prepare(`SELECT * FROM ticket_batch_answer_packages
      WHERE staff_chat_id = ? AND final_summary_state IN ('PENDING', 'FAILED')
        AND (final_summary_next_retry_at IS NULL OR final_summary_next_retry_at <= ?)
      ORDER BY updated_at ASC, answer_package_id ASC LIMIT ?`).all(staffChatId, at, limit) as TicketBatchAnswerPackageRecord[];
  }

  recordTicketBatchFinalSummaryAttempt(answerPackageId: string, staffChatId: number): void {
    this.db.prepare(`UPDATE ticket_batch_answer_packages SET final_summary_attempt_count = final_summary_attempt_count + 1, updated_at = ?
      WHERE answer_package_id = ? AND staff_chat_id = ?`).run(now(), answerPackageId, staffChatId);
  }

  recordTicketBatchFinalSummarySent(answerPackageId: string, staffChatId: number, messageId: number): void {
    this.db.prepare(`UPDATE ticket_batch_answer_packages
      SET final_summary_state = 'SENT', final_summary_message_id = ?, final_summary_delivered_at = ?,
          final_summary_next_retry_at = NULL, final_summary_last_error = NULL,
          summary_delivery_state = 'SENT', summary_delivery_error = NULL, summary_delivery_attempted_at = ?, updated_at = ?
      WHERE answer_package_id = ? AND staff_chat_id = ?`).run(messageId, now(), now(), now(), answerPackageId, staffChatId);
  }

  recordTicketBatchFinalSummaryFailure(answerPackageId: string, staffChatId: number, state: "FAILED" | "UNKNOWN_DELIVERY", error: string, nextRetryAt: string | null): void {
    this.db.prepare(`UPDATE ticket_batch_answer_packages
      SET final_summary_state = ?, final_summary_last_error = ?, final_summary_next_retry_at = ?,
          summary_delivery_state = 'FAILED', summary_delivery_error = ?, summary_delivery_attempted_at = ?, updated_at = ?
      WHERE answer_package_id = ? AND staff_chat_id = ?`).run(state, error, nextRetryAt, error, now(), now(), answerPackageId, staffChatId);
  }

  recordTicketBatchTopicEcho(answerPackageId: string, ticketId: number, state: TicketBatchTopicEchoState, options: { chatId?: number | null; threadId?: number | null; messageId?: number | null; lastError?: string | null; nextRetryAt?: string | null; incrementAttempt?: boolean; diagnostic?: NormalizedDeliveryError } = {}): void {
    this.db.prepare(`UPDATE ticket_batch_answer_items
      SET topic_echo_state = ?, topic_echo_chat_id = COALESCE(?, topic_echo_chat_id), topic_echo_thread_id = COALESCE(?, topic_echo_thread_id), topic_echo_message_id = COALESCE(?, topic_echo_message_id), topic_echo_last_error = ?, topic_echo_next_retry_at = ?, topic_echo_attempt_count = topic_echo_attempt_count + ?, topic_echo_error_category = COALESCE(?, topic_echo_error_category), topic_echo_error_code = COALESCE(?, topic_echo_error_code), topic_echo_http_status = COALESCE(?, topic_echo_http_status), topic_echo_error_method = COALESCE(?, topic_echo_error_method), topic_echo_error_description = COALESCE(?, topic_echo_error_description), topic_echo_terminal_at = CASE WHEN ? THEN COALESCE(topic_echo_terminal_at, ?) ELSE topic_echo_terminal_at END, updated_at = ?
      WHERE answer_package_id = ? AND ticket_id = ?`)
      .run(state, options.chatId ?? null, options.threadId ?? null, options.messageId ?? null, options.lastError ?? null, options.nextRetryAt ?? null, options.incrementAttempt ? 1 : 0, options.diagnostic?.category ?? null, options.diagnostic?.telegramErrorCode ?? null, options.diagnostic?.httpStatus ?? null, options.diagnostic?.method ?? null, options.diagnostic?.description ?? null, state === "TERMINAL_FAILED" ? 1 : 0, now(), now(), answerPackageId, ticketId);
  }

  listPendingTicketBatchTopicEchoes(staffChatId: number, at: string, limit = 20): TicketBatchAnswerItemRecord[] {
    return this.db.prepare(`SELECT i.* FROM ticket_batch_answer_items i
      JOIN ticket_batch_answer_packages p ON p.answer_package_id = i.answer_package_id
      JOIN tickets t ON t.id = i.ticket_id
      WHERE p.staff_chat_id = ? AND i.topic_echo_state IN ('PENDING', 'FAILED')
        AND t.status != 'CLOSED'
        AND (i.topic_echo_next_retry_at IS NULL OR i.topic_echo_next_retry_at <= ?)
        AND (
          (i.action = 'no_action' AND (i.follow_up_state != 'NONE' OR i.internal_note IS NOT NULL OR i.escalation_target != 'NONE'))
          OR
          (i.action IN ('reply_keep_open', 'reply_and_close') AND i.delivery_message_id IS NOT NULL
            AND i.delivery_error_category IS NULL AND i.delivery_error_permanence IS NULL
            AND i.delivery_failure_event_state != 'SENT'
            AND i.state IN ('REPLY_SENT', 'STAFF_SYNC_PENDING', 'COMPLETED'))
        )
      ORDER BY i.updated_at ASC, i.ticket_id ASC LIMIT ?`).all(staffChatId, at, limit) as TicketBatchAnswerItemRecord[];
  }

  listClosedTicketBatchReplyAndClosePendingEchoes(staffChatId: number, limit = 20): TicketBatchAnswerItemRecord[] {
    return this.db.prepare(`SELECT i.* FROM ticket_batch_answer_items i
      JOIN ticket_batch_answer_packages p ON p.answer_package_id = i.answer_package_id
      JOIN tickets t ON t.id = i.ticket_id
      WHERE p.staff_chat_id = ? AND p.status IN ('APPLYING', 'PARTIAL')
        AND t.status = 'CLOSED'
        AND i.action = 'reply_and_close'
        AND i.state IN ('REPLY_SENT', 'STAFF_SYNC_PENDING')
        AND i.delivery_message_id IS NOT NULL
        AND i.delivery_error_category IS NULL
        AND i.delivery_error_permanence IS NULL
        AND i.delivery_failure_event_state != 'SENT'
        AND i.topic_echo_state IN ('PENDING', 'FAILED')
      ORDER BY i.updated_at ASC, i.ticket_id ASC LIMIT ?`).all(staffChatId, limit) as TicketBatchAnswerItemRecord[];
  }

  setTicketBatchPostDeliveryRetry(answerPackageId: string, ticketId: number, nextRetryAt: string | null, lastError: string | null): void {
    this.db.prepare(`UPDATE ticket_batch_answer_items
      SET topic_echo_next_retry_at = ?, last_error = ?, updated_at = ?
      WHERE answer_package_id = ? AND ticket_id = ?`)
      .run(nextRetryAt, lastError, now(), answerPackageId, ticketId);
  }

  listPendingTicketBatchReplyAndCloseContinuations(staffChatId: number, at: string, limit = 20): TicketBatchAnswerItemRecord[] {
    return this.db.prepare(`SELECT i.* FROM ticket_batch_answer_items i
      JOIN ticket_batch_answer_packages p ON p.answer_package_id = i.answer_package_id
      JOIN tickets t ON t.id = i.ticket_id
      WHERE p.staff_chat_id = ? AND p.status IN ('APPLYING', 'PARTIAL')
        AND i.action = 'reply_and_close'
        AND i.state IN ('REPLY_SENT', 'STAFF_SYNC_PENDING')
        AND i.delivery_message_id IS NOT NULL
        AND i.delivery_error_category IS NULL
        AND i.delivery_error_permanence IS NULL
        AND i.delivery_failure_event_state != 'SENT'
        AND (i.topic_echo_state = 'SENT' OR (i.topic_echo_state = 'NOT_REQUIRED' AND t.status = 'CLOSED'))
        AND (i.topic_echo_next_retry_at IS NULL OR i.topic_echo_next_retry_at <= ?)
      ORDER BY i.updated_at ASC, i.ticket_id ASC LIMIT ?`).all(staffChatId, at, limit) as TicketBatchAnswerItemRecord[];
  }

  getNextTicketBatchStaffRetryAt(staffChatId: number): string | undefined {
    const row = this.db.prepare(`SELECT MIN(retry_at) AS retry_at FROM (
      SELECT i.topic_echo_next_retry_at AS retry_at
      FROM ticket_batch_answer_items i
      JOIN ticket_batch_answer_packages p ON p.answer_package_id = i.answer_package_id
      WHERE p.staff_chat_id = ? AND i.topic_echo_next_retry_at IS NOT NULL
        AND (i.topic_echo_state IN ('PENDING', 'FAILED')
          OR (i.action = 'reply_and_close' AND i.state IN ('REPLY_SENT', 'STAFF_SYNC_PENDING')
            AND i.topic_echo_state IN ('SENT', 'NOT_REQUIRED')))
      UNION ALL
      SELECT i.delivery_failure_event_next_retry_at
      FROM ticket_batch_answer_items i
      JOIN ticket_batch_answer_packages p ON p.answer_package_id = i.answer_package_id
      WHERE p.staff_chat_id = ? AND i.delivery_failure_event_state IN ('PENDING', 'FAILED')
        AND i.delivery_failure_event_next_retry_at IS NOT NULL
      UNION ALL
      SELECT final_summary_next_retry_at
      FROM ticket_batch_answer_packages
      WHERE staff_chat_id = ? AND final_summary_state IN ('PENDING', 'FAILED')
        AND final_summary_next_retry_at IS NOT NULL
    )`).get(staffChatId, staffChatId, staffChatId) as { retry_at: string | null };
    return row.retry_at ?? undefined;
  }

  listInvalidTicketBatchSuccessEchoes(staffChatId: number, limit = 20): TicketBatchAnswerItemRecord[] {
    return this.db.prepare(`SELECT i.* FROM ticket_batch_answer_items i
      JOIN ticket_batch_answer_packages p ON p.answer_package_id = i.answer_package_id
      WHERE p.staff_chat_id = ? AND i.topic_echo_state IN ('PENDING', 'FAILED')
        AND i.action IN ('reply_keep_open', 'reply_and_close')
        AND (i.delivery_message_id IS NULL OR i.delivery_error_category IS NOT NULL OR i.delivery_error_permanence IS NOT NULL OR i.delivery_failure_event_state = 'SENT')
      ORDER BY i.updated_at ASC, i.ticket_id ASC LIMIT ?`).all(staffChatId, limit) as TicketBatchAnswerItemRecord[];
  }

  getTicketBatchRecoveryAudit(staffChatId: number, at: string): TicketBatchRecoveryAudit {
    const due = "(i.topic_echo_next_retry_at IS NULL OR i.topic_echo_next_retry_at <= @at)";
    const base = "p.staff_chat_id = @staffChatId";
    const count = (where: string): number => (this.db.prepare(`SELECT COUNT(*) AS count FROM ticket_batch_answer_items i JOIN ticket_batch_answer_packages p ON p.answer_package_id = i.answer_package_id WHERE ${base} AND ${where}`).get({ staffChatId, at }) as { count: number }).count;
    const finalSummaries = (this.db.prepare(`SELECT COUNT(*) AS count FROM ticket_batch_answer_packages WHERE staff_chat_id = ? AND final_summary_state IN ('PENDING', 'FAILED') AND (final_summary_next_retry_at IS NULL OR final_summary_next_retry_at <= ?)`)
      .get(staffChatId, at) as { count: number }).count;
    return {
      successTopicEchoes: count(`i.topic_echo_state IN ('PENDING','FAILED') AND ${due} AND i.action IN ('reply_keep_open','reply_and_close') AND i.delivery_message_id IS NOT NULL AND i.delivery_error_category IS NULL AND i.delivery_error_permanence IS NULL AND i.delivery_failure_event_state != 'SENT'`),
      failureEvents: count("i.delivery_failure_event_state IN ('PENDING','FAILED') AND i.action IN ('reply_keep_open','reply_and_close') AND i.delivery_error_category IS NOT NULL AND i.delivery_message_id IS NULL AND (i.delivery_failure_event_next_retry_at IS NULL OR i.delivery_failure_event_next_retry_at <= @at)"),
      noActionFollowUpEvents: count(`i.topic_echo_state IN ('PENDING','FAILED') AND ${due} AND i.action = 'no_action' AND (i.follow_up_state != 'NONE' OR i.internal_note IS NOT NULL OR i.escalation_target != 'NONE')`),
      finalSummaries,
      invalidSuccessEchoes: count(`i.topic_echo_state IN ('PENDING','FAILED') AND i.action IN ('reply_keep_open','reply_and_close') AND (i.delivery_message_id IS NULL OR i.delivery_error_category IS NOT NULL OR i.delivery_error_permanence IS NOT NULL OR i.delivery_failure_event_state = 'SENT')`),
      terminalStaffFailures: count("i.topic_echo_state = 'TERMINAL_FAILED'"),
      userFacingCandidates: 0
    };
  }

  setTicketFollowUpContext(ticketId: number, input: { followUpState: TicketFollowUpState; internalNote: string | null; escalationTarget: TicketEscalationTarget; sourceAnswerPackageId?: string | null }): TicketRecord | undefined {
    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE tickets SET follow_up_state = ?, internal_note = ?, escalation_target = ?, follow_up_updated_at = ?, follow_up_source_answer_package_id = ?, updated_at = ? WHERE id = ?`)
        .run(input.followUpState, input.internalNote, input.escalationTarget, timestamp, input.sourceAnswerPackageId ?? null, timestamp, ticketId);
      this.db.prepare(`INSERT INTO ticket_follow_up_history (ticket_id, follow_up_state, internal_note, escalation_target, source_answer_package_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(ticketId, input.followUpState, input.internalNote, input.escalationTarget, input.sourceAnswerPackageId ?? null, timestamp);
    });
    tx();
    return this.getTicket(ticketId);
  }

  clearWaitingUserFollowUp(ticketId: number): TicketRecord | undefined {
    const ticket = this.getTicket(ticketId);
    if (!ticket || ticket.follow_up_state !== "WAITING_USER") return ticket;
    return this.setTicketFollowUpContext(ticketId, { followUpState: "NONE", internalNote: null, escalationTarget: "NONE", sourceAnswerPackageId: ticket.follow_up_source_answer_package_id });
  }

  listTicketFollowUpHistory(ticketId: number): TicketFollowUpHistoryRecord[] {
    return this.db.prepare("SELECT * FROM ticket_follow_up_history WHERE ticket_id = ? ORDER BY id ASC").all(ticketId) as TicketFollowUpHistoryRecord[];
  }

  finalizeTicketBatchAnswerPackage(answerPackageId: string, staffChatId: number): TicketBatchAnswerPackageRecord | undefined {
    const items = this.listTicketBatchAnswerItems(answerPackageId);
    const complete = items.every((item) => ["COMPLETED", "NO_ACTION", "STALE", "INACTIVE"].includes(item.state));
    const timestamp = now();
    this.db.prepare("UPDATE ticket_batch_answer_packages SET status = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END, updated_at = ? WHERE answer_package_id = ? AND staff_chat_id = ?")
      .run(complete ? "COMPLETED" : "PARTIAL", complete ? 1 : 0, complete ? timestamp : null, timestamp, answerPackageId, staffChatId);
    return this.getTicketBatchAnswerPackage(answerPackageId, staffChatId);
  }

  getLanguageModerationUserState(chatId: number, userId: number): LanguageModerationUserState | undefined {
    return this.db.prepare("SELECT * FROM language_moderation_user_state WHERE chat_id = ? AND user_telegram_id = ?").get(chatId, userId) as LanguageModerationUserState | undefined;
  }

  upsertLanguageModerationUserState(input: Omit<LanguageModerationUserState, "updated_at">): void {
    this.db.prepare(`INSERT INTO language_moderation_user_state (chat_id, user_telegram_id, username, current_strikes, sanction_tier, first_strike_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, user_telegram_id) DO UPDATE SET username = excluded.username, current_strikes = excluded.current_strikes, sanction_tier = excluded.sanction_tier, first_strike_at = excluded.first_strike_at, updated_at = excluded.updated_at`)
      .run(input.chat_id, input.user_telegram_id, input.username, input.current_strikes, input.sanction_tier, input.first_strike_at, now());
  }

  addLanguageModerationViolation(input: Pick<LanguageModerationViolation, "chat_id" | "user_telegram_id" | "message_id" | "username" | "cycle_tier">): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO language_moderation_violations (chat_id, user_telegram_id, message_id, username, detected_at, cycle_tier) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.chat_id, input.user_telegram_id, input.message_id, input.username, now(), input.cycle_tier);
    return result.changes === 1;
  }

  listLanguageModerationViolations(chatId: number, since: string): LanguageModerationViolation[] {
    return this.db.prepare("SELECT * FROM language_moderation_violations WHERE chat_id = ? AND detected_at >= ? ORDER BY detected_at ASC, message_id ASC").all(chatId, since) as LanguageModerationViolation[];
  }

  claimLanguageModerationFirstStrikes(chatId: number, since: string): Array<{ userId: number; username: string | null; messageId: number }> {
    const transaction = this.db.transaction(() => {
      const candidates = this.db.prepare(`
        SELECT v.user_telegram_id AS userId, MAX(v.message_id) AS messageId, MAX(v.username) AS username
        FROM language_moderation_violations v
        LEFT JOIN language_moderation_user_state s ON s.chat_id = v.chat_id AND s.user_telegram_id = v.user_telegram_id
        WHERE v.chat_id = ? AND v.detected_at >= ? AND COALESCE(s.current_strikes, 0) = 0
        GROUP BY v.user_telegram_id ORDER BY v.user_telegram_id ASC
      `).all(chatId, since) as Array<{ userId: number; username: string | null; messageId: number }>;
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

  getLanguageModerationChatState(chatId: number): { chat_id: number; last_warning_message_id: number | null; last_warning_at: string | null; ordinary_messages_since_warning: number; pending_warning_due_at: string | null; pending_warning_started_at: string | null; updated_at: string } | undefined {
    return this.db.prepare("SELECT * FROM language_moderation_chat_state WHERE chat_id = ?").get(chatId) as { chat_id: number; last_warning_message_id: number | null; last_warning_at: string | null; ordinary_messages_since_warning: number; pending_warning_due_at: string | null; pending_warning_started_at: string | null; updated_at: string } | undefined;
  }

  upsertLanguageModerationChatState(chatId: number, values: { lastWarningMessageId?: number | null; lastWarningAt?: string | null; ordinaryMessagesSinceWarning: number; pendingWarningDueAt?: string | null; pendingWarningStartedAt?: string | null }): void {
    this.db.prepare(`INSERT INTO language_moderation_chat_state (chat_id, last_warning_message_id, last_warning_at, ordinary_messages_since_warning, pending_warning_due_at, pending_warning_started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET last_warning_message_id = excluded.last_warning_message_id, last_warning_at = excluded.last_warning_at, ordinary_messages_since_warning = excluded.ordinary_messages_since_warning, pending_warning_due_at = excluded.pending_warning_due_at, pending_warning_started_at = excluded.pending_warning_started_at, updated_at = excluded.updated_at`)
      .run(chatId, values.lastWarningMessageId ?? null, values.lastWarningAt ?? null, values.ordinaryMessagesSinceWarning, values.pendingWarningDueAt ?? null, values.pendingWarningStartedAt ?? null, now());
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

  claimEntityNotificationPublication(input: { provider: string; entityType: string; entityId: string; eventType: "created"; observedAt: string; targetChatId: number }): EntityNotificationPublicationState {
    const timestamp = now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO entity_notification_publications (provider, entity_type, entity_id, event_type, observed_at, target_chat_id, state, first_seen_at, updated_at)
      VALUES (?, ?, ?, 'created', ?, ?, 'CLAIMED', ?, ?)`).run(input.provider, input.entityType, input.entityId, input.observedAt, input.targetChatId, timestamp, timestamp);
    if (result.changes === 1) return "CLAIMED";

    const existing = this.db.prepare("SELECT state FROM entity_notification_publications WHERE provider = ? AND entity_type = ? AND entity_id = ? AND event_type = 'created'")
      .get(input.provider, input.entityType, input.entityId) as { state: EntityNotificationPublicationState } | undefined;
    if (existing?.state === "FAILED") {
      const retry = this.db.prepare("UPDATE entity_notification_publications SET state = 'CLAIMED', observed_at = ?, target_chat_id = ?, updated_at = ?, last_error = NULL WHERE provider = ? AND entity_type = ? AND entity_id = ? AND event_type = 'created' AND state = 'FAILED'")
        .run(input.observedAt, input.targetChatId, timestamp, input.provider, input.entityType, input.entityId);
      if (retry.changes === 1) return "CLAIMED";
    }
    if (existing?.state === "CLAIMED") return "UNKNOWN_DELIVERY";
    return existing?.state ?? "UNKNOWN_DELIVERY";
  }

  recordEntityNotificationPublished(provider: string, entityType: string, entityId: string, eventType: "created", telegramMessageId: number): void {
    this.db.prepare("UPDATE entity_notification_publications SET state = 'PUBLISHED', telegram_message_id = ?, published_at = ?, updated_at = ?, last_error = NULL WHERE provider = ? AND entity_type = ? AND entity_id = ? AND event_type = 'created' AND state = 'CLAIMED'")
      .run(telegramMessageId, now(), now(), provider, entityType, entityId);
  }

  recordEntityNotificationFailure(provider: string, entityType: string, entityId: string, eventType: "created", error: string): void {
    this.db.prepare("UPDATE entity_notification_publications SET state = 'FAILED', last_error = ?, updated_at = ? WHERE provider = ? AND entity_type = ? AND entity_id = ? AND event_type = 'created' AND state = 'CLAIMED'")
      .run(error.slice(0, 160), now(), provider, entityType, entityId);
  }

  countEntityNotificationPublications(state?: EntityNotificationPublicationState): number {
    const row = state
      ? this.db.prepare("SELECT COUNT(*) AS count FROM entity_notification_publications WHERE state = ?").get(state) as { count: number }
      : this.db.prepare("SELECT COUNT(*) AS count FROM entity_notification_publications").get() as { count: number };
    return row.count;
  }

  getSetting(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;

    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `
      )
      .run(key, value, now());
  }

  getBannedUser(userTelegramId: number): BannedUserRecord | undefined {
    return this.db
      .prepare("SELECT * FROM banned_users WHERE user_telegram_id = ?")
      .get(userTelegramId) as BannedUserRecord | undefined;
  }

  banUser(input: BanUserInput): void {
    this.db
      .prepare(
        `
        INSERT INTO banned_users (user_telegram_id, username, reason, banned_by, created_at)
        VALUES (@userTelegramId, @username, @reason, @bannedBy, @createdAt)
        ON CONFLICT(user_telegram_id) DO UPDATE SET
          username = excluded.username,
          reason = excluded.reason,
          banned_by = excluded.banned_by,
          created_at = excluded.created_at
      `
      )
      .run({
        userTelegramId: input.userTelegramId,
        username: input.username ?? null,
        reason: input.reason,
        bannedBy: input.bannedBy ?? null,
        createdAt: now()
      });
  }

  unbanUser(userTelegramId: number): boolean {
    const result = this.db
      .prepare("DELETE FROM banned_users WHERE user_telegram_id = ?")
      .run(userTelegramId);

    return result.changes > 0;
  }

  listBannedUsers(limit = 50): BannedUserRecord[] {
    return this.db
      .prepare(
        `
        SELECT * FROM banned_users
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(limit) as BannedUserRecord[];
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const migrations: Migration[] = [
      {
        id: 1,
        name: "create_core_tables",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
              telegram_id INTEGER PRIMARY KEY,
              username TEXT,
              first_name TEXT,
              last_name TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tickets (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_telegram_id INTEGER NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('OPEN', 'WAITING_USER', 'IN_PROGRESS', 'CLOSED')),
              staff_chat_id INTEGER,
              message_thread_id INTEGER,
              staff_message_id INTEGER,
              logs_message_id INTEGER,
              transcript_message_id INTEGER,
              archived_at TEXT,
              closed_by_type TEXT CHECK(closed_by_type IN ('USER', 'STAFF', 'SYSTEM')),
              closed_by_display_name TEXT,
              closed_by_username TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              closed_at TEXT,
              FOREIGN KEY(user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ticket_id INTEGER NOT NULL,
              direction TEXT NOT NULL CHECK(direction IN ('USER_TO_STAFF', 'STAFF_TO_USER', 'SYSTEM')),
              source_chat_id INTEGER,
              source_message_id INTEGER,
              delivery_chat_id INTEGER,
              delivery_message_id INTEGER,
              from_telegram_id INTEGER,
              from_username TEXT,
              sender_type TEXT CHECK(sender_type IN ('USER', 'STAFF', 'SYSTEM')),
              sender_display_name TEXT,
              sender_username TEXT,
              text TEXT,
              media_type TEXT,
              filename TEXT,
              file_id TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
          `);
        }
      },
      {
        id: 2,
        name: "ensure_ticket_topic_columns",
        up: () => {
          this.addColumnIfMissing("tickets", "staff_chat_id", "INTEGER");
          this.addColumnIfMissing("tickets", "message_thread_id", "INTEGER");
          this.addColumnIfMissing("tickets", "staff_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "closed_at", "TEXT");
          this.addColumnIfMissing("tickets", "logs_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "transcript_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "archived_at", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_type", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_display_name", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_username", "TEXT");
        }
      },
      {
        id: 3,
        name: "create_banned_users",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS banned_users (
              user_telegram_id INTEGER PRIMARY KEY,
              username TEXT,
              reason TEXT NOT NULL,
              banned_by INTEGER,
              created_at TEXT NOT NULL
            );
          `);
        }
      },
      {
        id: 4,
        name: "create_indexes",
        up: () => {
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_tickets_user_status
              ON tickets(user_telegram_id, status);

            CREATE INDEX IF NOT EXISTS idx_tickets_user_staff_status
              ON tickets(user_telegram_id, staff_chat_id, status);

            CREATE INDEX IF NOT EXISTS idx_tickets_staff_thread
              ON tickets(staff_chat_id, message_thread_id);

            CREATE INDEX IF NOT EXISTS idx_tickets_staff_message
              ON tickets(staff_chat_id, staff_message_id);

            CREATE INDEX IF NOT EXISTS idx_messages_ticket_created
              ON messages(ticket_id, created_at);
          `);
        }
      },
      {
        id: 5,
        name: "enforce_single_active_ticket_per_staff_chat",
        up: () => {
          const timestamp = now();
          this.db
            .prepare(
              `
              UPDATE tickets
              SET status = 'CLOSED',
                  updated_at = ?,
                  closed_at = COALESCE(closed_at, ?)
              WHERE status != 'CLOSED'
                AND id NOT IN (
                  SELECT MAX(id)
                  FROM tickets
                  WHERE status != 'CLOSED'
                  GROUP BY user_telegram_id, staff_chat_id
                )
            `
            )
            .run(timestamp, timestamp);

          this.db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_ticket_user_staff
              ON tickets(user_telegram_id, staff_chat_id)
              WHERE status != 'CLOSED';
          `);
        }
      },
      {
        id: 6,
        name: "harden_existing_forum_topic_schema",
        up: () => {
          const timestamp = now();
          this.db
            .prepare(
              `
              UPDATE tickets
              SET status = 'CLOSED',
                  updated_at = ?,
                  closed_at = COALESCE(closed_at, ?)
              WHERE status != 'CLOSED'
                AND (staff_chat_id IS NULL OR message_thread_id IS NULL)
            `
            )
            .run(timestamp, timestamp);

          if (this.hasTable("staff_message_links")) {
            this.db.exec(`
              DELETE FROM staff_message_links
              WHERE id NOT IN (
                SELECT MIN(id)
                FROM staff_message_links
                GROUP BY staff_chat_id, staff_message_id
              );

              CREATE UNIQUE INDEX IF NOT EXISTS uniq_staff_message_links_staff_message
                ON staff_message_links(staff_chat_id, staff_message_id);
            `);
          }
        }
      },
      {
        id: 7,
        name: "add_archive_settings_and_transcript_columns",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
          `);

          this.addColumnIfMissing("tickets", "logs_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "transcript_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "archived_at", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_type", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_display_name", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_username", "TEXT");

          this.addColumnIfMissing("messages", "sender_type", "TEXT");
          this.addColumnIfMissing("messages", "sender_display_name", "TEXT");
          this.addColumnIfMissing("messages", "sender_username", "TEXT");
          this.addColumnIfMissing("messages", "filename", "TEXT");

          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_tickets_archive_pending
              ON tickets(staff_chat_id, status, archived_at);
          `);
        }
      },
      {
        id: 8,
        name: "create_ticket_batch_exports",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS ticket_batch_exports (
              export_id TEXT PRIMARY KEY,
              staff_chat_id INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              selection_mode TEXT NOT NULL,
              ticket_count INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ticket_batch_export_items (
              export_id TEXT NOT NULL,
              ticket_id INTEGER NOT NULL,
              snapshot_token TEXT NOT NULL,
              PRIMARY KEY (export_id, ticket_id),
              FOREIGN KEY (export_id) REFERENCES ticket_batch_exports(export_id) ON DELETE CASCADE
            );
          `);
        }
      },
      {
        id: 9,
        name: "create_ticket_batch_answer_packages",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS ticket_batch_answer_packages (
              answer_package_id TEXT PRIMARY KEY, export_id TEXT NOT NULL, staff_chat_id INTEGER NOT NULL,
              package_hash TEXT NOT NULL, source_chat_id INTEGER, source_message_id INTEGER,
              package_created_at TEXT NOT NULL, imported_at TEXT NOT NULL, status TEXT NOT NULL,
              started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
              FOREIGN KEY (export_id) REFERENCES ticket_batch_exports(export_id) ON DELETE CASCADE,
              UNIQUE (staff_chat_id, package_hash)
            );
            CREATE TABLE IF NOT EXISTS ticket_batch_answer_items (
              answer_package_id TEXT NOT NULL, ticket_id INTEGER NOT NULL, snapshot_token TEXT NOT NULL,
              action TEXT NOT NULL, reply_text TEXT, state TEXT NOT NULL, delivery_message_id INTEGER,
              applied_at TEXT, last_error TEXT, updated_at TEXT NOT NULL,
              PRIMARY KEY (answer_package_id, ticket_id),
              FOREIGN KEY (answer_package_id) REFERENCES ticket_batch_answer_packages(answer_package_id) ON DELETE CASCADE
            );
          `);
        }
      },
      {
        id: 10,
        name: "create_language_moderation_state",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS language_moderation_user_state (
              chat_id INTEGER NOT NULL, user_telegram_id INTEGER NOT NULL, username TEXT,
              current_strikes INTEGER NOT NULL DEFAULT 0 CHECK(current_strikes BETWEEN 0 AND 2),
              sanction_tier INTEGER NOT NULL DEFAULT 0 CHECK(sanction_tier BETWEEN 0 AND 3),
              first_strike_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(chat_id, user_telegram_id)
            );
            CREATE TABLE IF NOT EXISTS language_moderation_chat_state (
              chat_id INTEGER PRIMARY KEY, last_warning_message_id INTEGER, last_warning_at TEXT,
              ordinary_messages_since_warning INTEGER NOT NULL DEFAULT 0, pending_warning_due_at TEXT, pending_warning_started_at TEXT, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS language_moderation_violations (
              chat_id INTEGER NOT NULL, user_telegram_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
              username TEXT, detected_at TEXT NOT NULL, cycle_tier INTEGER NOT NULL,
              moderation_cycle_id TEXT,
              cleanup_state TEXT NOT NULL DEFAULT 'PENDING' CHECK(cleanup_state IN ('PENDING','DELETED','ALREADY_ABSENT','TERMINAL_FAILED')),
              cleanup_attempt_count INTEGER NOT NULL DEFAULT 0, cleanup_last_error_category TEXT, cleanup_last_error_code INTEGER,
              cleanup_last_error_description TEXT, cleanup_completed_at TEXT,
              PRIMARY KEY(chat_id, message_id)
            );
            CREATE INDEX IF NOT EXISTS idx_language_moderation_violations_lookup
              ON language_moderation_violations(chat_id, detected_at, user_telegram_id);
            CREATE TABLE IF NOT EXISTS language_moderation_cleanup_jobs (
              id INTEGER PRIMARY KEY AUTOINCREMENT, staff_chat_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, user_telegram_id INTEGER NOT NULL,
              username TEXT, chat_title TEXT, sanction_tier INTEGER NOT NULL, sanction_kind TEXT NOT NULL,
              violation_cycle_id TEXT,
              cleanup_due_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','CLEANING','LOG_PENDING','COMPLETED')),
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_language_moderation_cleanup_due
              ON language_moderation_cleanup_jobs(staff_chat_id, state, cleanup_due_at);
          `);
        }
      },
      {
        id: 11,
        name: "scope_language_moderation_cleanup_jobs_to_staff_chat",
        up: () => {
          this.addColumnIfMissing("language_moderation_cleanup_jobs", "staff_chat_id", "INTEGER");
          this.db.exec(`
            DROP INDEX IF EXISTS idx_language_moderation_cleanup_due;
            CREATE INDEX idx_language_moderation_cleanup_due
              ON language_moderation_cleanup_jobs(staff_chat_id, state, cleanup_due_at);
          `);
        }
      },
      {
        id: 12,
        name: "create_entity_notification_publications",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS entity_notification_publications (
              provider TEXT NOT NULL,
              entity_type TEXT NOT NULL,
              entity_id TEXT NOT NULL,
              event_type TEXT NOT NULL CHECK(event_type = 'created'),
              observed_at TEXT NOT NULL,
              target_chat_id INTEGER,
              state TEXT NOT NULL CHECK(state IN ('CLAIMED', 'PUBLISHED', 'FAILED', 'UNKNOWN_DELIVERY')),
              telegram_message_id INTEGER,
              first_seen_at TEXT NOT NULL,
              published_at TEXT,
              updated_at TEXT NOT NULL,
              last_error TEXT,
              PRIMARY KEY(provider, entity_type, entity_id, event_type)
            );
            CREATE INDEX IF NOT EXISTS idx_entity_notification_publications_state
              ON entity_notification_publications(state, updated_at);
          `);
        }
      },
      {
        id: 13,
        name: "track_ticket_batch_delivery_and_preview",
        up: () => {
          this.addColumnIfMissing("ticket_batch_exports", "delivery_state", "TEXT NOT NULL DEFAULT 'DELIVERED'");
          this.addColumnIfMissing("ticket_batch_exports", "delivery_message_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_exports", "delivered_at", "TEXT");
          this.addColumnIfMissing("ticket_batch_exports", "last_error", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_packages", "preview_token", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_packages", "preview_chat_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "preview_message_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "preview_page", "INTEGER");
          this.db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_ticket_batch_preview_token
              ON ticket_batch_answer_packages(preview_token)
              WHERE preview_token IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_ticket_batch_exports_delivery
              ON ticket_batch_exports(staff_chat_id, delivery_state, created_at);
          `);
        }
      },
      {
        id: 14,
        name: "add_ticket_follow_up_history_and_batch_topic_echoes",
        up: () => {
          this.addColumnIfMissing("tickets", "follow_up_state", "TEXT NOT NULL DEFAULT 'NONE' CHECK(follow_up_state IN ('NONE','WAITING_USER','WAITING_DEVS','WAITING_QUEST_OWNER','MONITORING'))");
          this.addColumnIfMissing("tickets", "internal_note", "TEXT");
          this.addColumnIfMissing("tickets", "escalation_target", "TEXT NOT NULL DEFAULT 'NONE' CHECK(escalation_target IN ('NONE','DEVS','PAYMENTS','SECURITY','QUEST_OWNER','SUPPORT'))");
          this.addColumnIfMissing("tickets", "follow_up_updated_at", "TEXT");
          this.addColumnIfMissing("tickets", "follow_up_source_answer_package_id", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "follow_up_state", "TEXT NOT NULL DEFAULT 'NONE'");
          this.addColumnIfMissing("ticket_batch_answer_items", "internal_note", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "escalation_target", "TEXT NOT NULL DEFAULT 'NONE'");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_chat_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_thread_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_message_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_state", "TEXT NOT NULL DEFAULT 'PENDING'");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_last_error", "TEXT");
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS ticket_follow_up_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ticket_id INTEGER NOT NULL,
              follow_up_state TEXT NOT NULL CHECK(follow_up_state IN ('NONE','WAITING_USER','WAITING_DEVS','WAITING_QUEST_OWNER','MONITORING')),
              internal_note TEXT,
              escalation_target TEXT NOT NULL CHECK(escalation_target IN ('NONE','DEVS','PAYMENTS','SECURITY','QUEST_OWNER','SUPPORT')),
              source_answer_package_id TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_ticket_follow_up_history_ticket
              ON ticket_follow_up_history(ticket_id, id);
            CREATE INDEX IF NOT EXISTS idx_ticket_batch_answer_item_echo
              ON ticket_batch_answer_items(answer_package_id, topic_echo_state, ticket_id);
          `);
        }
      },
      {
        id: 15,
        name: "add_batch_delivery_diagnostics",
        up: () => {
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_error_category", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_error_permanence", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_error_code", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_http_status", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_error_method", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_retry_after_seconds", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_error_description", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_failed_at", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_attempt_count", "INTEGER NOT NULL DEFAULT 0");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_failure_event_state", "TEXT NOT NULL DEFAULT 'NOT_REQUIRED'");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_failure_event_message_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "summary_delivery_state", "TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED'");
          this.addColumnIfMissing("ticket_batch_answer_packages", "summary_delivery_error", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_packages", "summary_delivery_attempted_at", "TEXT");
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_ticket_batch_answer_items_delivery_failure
              ON ticket_batch_answer_items(answer_package_id, delivery_error_permanence, ticket_id);
          `);
        }
      },
      {
        id: 16,
        name: "make_ticket_batch_staff_finalization_retryable",
        up: () => {
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_state", "TEXT NOT NULL DEFAULT 'NOT_PENDING'");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_text", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_chat_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_origin_chat_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_origin_message_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_message_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_attempt_count", "INTEGER NOT NULL DEFAULT 0");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_next_retry_at", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_last_error", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_delivered_at", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_attempt_count", "INTEGER NOT NULL DEFAULT 0");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_next_retry_at", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_failure_event_attempt_count", "INTEGER NOT NULL DEFAULT 0");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_failure_event_next_retry_at", "TEXT");
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_ticket_batch_final_summary_recovery
              ON ticket_batch_answer_packages(staff_chat_id, final_summary_state, final_summary_next_retry_at);
            CREATE INDEX IF NOT EXISTS idx_ticket_batch_topic_echo_recovery
              ON ticket_batch_answer_items(topic_echo_state, topic_echo_next_retry_at, answer_package_id);
            UPDATE ticket_batch_answer_packages
            SET final_summary_state = 'PENDING',
                final_summary_chat_id = staff_chat_id,
                final_summary_next_retry_at = COALESCE(final_summary_next_retry_at, updated_at)
            WHERE final_summary_state = 'NOT_PENDING'
              AND status IN ('COMPLETED', 'PARTIAL')
              AND summary_delivery_state = 'FAILED';
            UPDATE ticket_batch_answer_items
            SET topic_echo_state = 'NOT_REQUIRED',
                topic_echo_last_error = 'Success echo is not applicable after an unconfirmed user delivery.',
                topic_echo_next_retry_at = NULL
            WHERE action IN ('reply_keep_open', 'reply_and_close')
              AND delivery_message_id IS NULL
              AND delivery_error_category IS NOT NULL
              AND topic_echo_state IN ('PENDING', 'FAILED');
            UPDATE ticket_batch_answer_items
            SET topic_echo_next_retry_at = COALESCE(topic_echo_next_retry_at, updated_at)
            WHERE topic_echo_state IN ('PENDING', 'FAILED');
            UPDATE ticket_batch_answer_items
            SET delivery_failure_event_next_retry_at = COALESCE(delivery_failure_event_next_retry_at, updated_at)
            WHERE delivery_failure_event_state IN ('PENDING', 'FAILED')
              AND delivery_error_category IS NOT NULL;
          `);
        }
      },
      {
        id: 17,
        name: "classify_terminal_ticket_batch_staff_events",
        up: () => {
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_error_category", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_error_code", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_http_status", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_error_method", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_error_description", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_terminal_at", "TEXT");
          this.db.exec(`
            UPDATE ticket_batch_answer_items
            SET topic_echo_state = 'TERMINAL_FAILED',
                topic_echo_error_category = CASE
                  WHEN topic_echo_error_category IS NOT NULL THEN topic_echo_error_category
                  WHEN topic_echo_last_error IN ('USER_BLOCKED_BOT', 'USER_DEACTIVATED', 'CHAT_UNAVAILABLE', 'FORBIDDEN', 'RATE_LIMITED', 'TELEGRAM_BAD_REQUEST', 'TELEGRAM_SERVER_ERROR', 'NETWORK_TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN_TELEGRAM_ERROR') THEN topic_echo_last_error
                  ELSE NULL
                END,
                topic_echo_terminal_at = COALESCE(topic_echo_terminal_at, updated_at), topic_echo_next_retry_at = NULL
            WHERE topic_echo_state = 'FAILED' AND topic_echo_next_retry_at = '9999-12-31T23:59:59.999Z';
            UPDATE ticket_batch_answer_items
            SET topic_echo_state = 'NOT_REQUIRED', topic_echo_next_retry_at = NULL,
                topic_echo_last_error = 'Staff topic event is no longer needed for a closed ticket.'
            WHERE topic_echo_state IN ('PENDING', 'FAILED')
              AND ticket_id IN (SELECT id FROM tickets WHERE status = 'CLOSED');
            UPDATE ticket_batch_answer_items
            SET topic_echo_state = 'NOT_REQUIRED', topic_echo_next_retry_at = NULL,
                topic_echo_last_error = 'No staff topic event was requested.'
            WHERE topic_echo_state IN ('PENDING', 'FAILED') AND action = 'no_action'
              AND follow_up_state = 'NONE' AND internal_note IS NULL AND escalation_target = 'NONE';
            UPDATE ticket_batch_answer_items
            SET delivery_failure_event_state = 'NOT_REQUIRED', delivery_failure_event_next_retry_at = NULL
            WHERE delivery_failure_event_state IN ('PENDING', 'FAILED')
              AND ticket_id IN (SELECT id FROM tickets WHERE status = 'CLOSED');
          `);
        }
      },
      {
        id: 18,
        name: "persist_language_moderation_violation_cleanup_progress",
        up: () => {
          if (!this.hasTable("language_moderation_violations")) {
            return;
          }
          this.addColumnIfMissing("language_moderation_violations", "cleanup_state", "TEXT NOT NULL DEFAULT 'PENDING'");
          this.addColumnIfMissing("language_moderation_violations", "cleanup_attempt_count", "INTEGER NOT NULL DEFAULT 0");
          this.addColumnIfMissing("language_moderation_violations", "cleanup_last_error_category", "TEXT");
          this.addColumnIfMissing("language_moderation_violations", "cleanup_last_error_code", "INTEGER");
          this.addColumnIfMissing("language_moderation_violations", "cleanup_last_error_description", "TEXT");
          this.addColumnIfMissing("language_moderation_violations", "cleanup_completed_at", "TEXT");
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_language_moderation_violations_cleanup
              ON language_moderation_violations(chat_id, user_telegram_id, cycle_tier, cleanup_state, message_id);
          `);
        }
      },
      {
        id: 19,
        name: "bind_language_moderation_cleanup_jobs_to_violation_cycles",
        up: () => {
          if (!this.hasTable("language_moderation_violations") || !this.hasTable("language_moderation_cleanup_jobs")) {
            return;
          }
          this.addColumnIfMissing("language_moderation_violations", "moderation_cycle_id", "TEXT");
          this.addColumnIfMissing("language_moderation_cleanup_jobs", "violation_cycle_id", "TEXT");
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_language_moderation_violations_cycle
              ON language_moderation_violations(chat_id, user_telegram_id, moderation_cycle_id, cleanup_state, message_id);
          `);
        }
      }
    ];

    for (const migration of migrations) {
      if (this.hasMigration(migration.id)) {
        continue;
      }

      const applyMigration = this.db.transaction(() => {
        migration.up();
        this.db
          .prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.id, migration.name, now());
      });

      applyMigration();
    }
  }

  private hasMigration(id: number): boolean {
    const row = this.db
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(id) as { id: number } | undefined;

    return Boolean(row);
  }

  private hasColumn(tableName: "tickets" | "messages" | "language_moderation_cleanup_jobs" | "language_moderation_violations" | "ticket_batch_exports" | "ticket_batch_answer_packages" | "ticket_batch_answer_items", columnName: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as TableColumnInfo[];
    return rows.some((row) => row.name === columnName);
  }

  private hasTable(tableName: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { name: string } | undefined;

    return Boolean(row);
  }

  private addColumnIfMissing(
    tableName: "tickets" | "messages" | "language_moderation_cleanup_jobs" | "language_moderation_violations" | "ticket_batch_exports" | "ticket_batch_answer_packages" | "ticket_batch_answer_items",
    columnName: string,
    columnDefinition: string
  ): void {
    if (this.hasColumn(tableName, columnName)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
  }
}
