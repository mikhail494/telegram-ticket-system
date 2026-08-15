import Database from "better-sqlite3";
import type { NormalizedDeliveryError } from "../deliveryDiagnostics.js";
import { now } from "./helpers.js";
import type { CreateTicketBatchAnswerPackageInput, CreateTicketBatchExportInput, TicketBatchAnswerItemRecord, TicketBatchAnswerItemState, TicketBatchAnswerPackageRecord, TicketBatchDeliveryFailureContext, TicketBatchExportItemRecord, TicketBatchExportRecord, TicketBatchFailureEventState, TicketBatchRecoveryAudit, TicketBatchStaffSyncContext, TicketBatchSummaryDeliveryState, TicketBatchTopicEchoState } from "./types.js";
export class TicketBatchRepository {
  constructor(private readonly db: Database.Database) {}
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

  finalizeTicketBatchAnswerPackage(answerPackageId: string, staffChatId: number): TicketBatchAnswerPackageRecord | undefined {
    const items = this.listTicketBatchAnswerItems(answerPackageId);
    const complete = items.every((item) => ["COMPLETED", "NO_ACTION", "STALE", "INACTIVE"].includes(item.state));
    const timestamp = now();
    this.db.prepare("UPDATE ticket_batch_answer_packages SET status = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END, updated_at = ? WHERE answer_package_id = ? AND staff_chat_id = ?")
      .run(complete ? "COMPLETED" : "PARTIAL", complete ? 1 : 0, complete ? timestamp : null, timestamp, answerPackageId, staffChatId);
    return this.getTicketBatchAnswerPackage(answerPackageId, staffChatId);
  }


}
