import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { now } from "./helpers.js";
import type {
  DeliveryReconciliationAuditRecord,
  DeliveryReconciliationKind,
  DeliveryReconciliationRecord,
  DeliveryReconciliationResult,
  ReconcileUnknownDeliveryInput,
} from "./types.js";

interface ReconciliationRow {
  kind: DeliveryReconciliationKind;
  delivery_key: string;
  ticket_id: number;
  staff_chat_id: number;
  source_chat_id: number | null;
  source_message_id: number | null;
  destination_chat_id: number | null;
  related_telegram_message_id: number | null;
  known_telegram_message_id: number | null;
  diagnostic_category: DeliveryReconciliationRecord["diagnosticCategory"];
  diagnostic_description: string | null;
  created_at: string;
  updated_at: string;
}

interface InteractiveDeliveryRow {
  operation_key: string;
  ticket_id: number;
  source_chat_id: number | null;
  source_message_id: number | null;
  delivery_chat_id: number | null;
  delivery_message_id: number | null;
  from_telegram_id: number | null;
  from_username: string | null;
  sender_type: string | null;
  sender_display_name: string | null;
  sender_username: string | null;
  text: string | null;
  media_type: string | null;
  filename: string | null;
  file_id: string | null;
}

interface BatchReconciliationRow {
  action: "reply_keep_open" | "reply_and_close";
  reply_text: string;
  follow_up_state: string;
  internal_note: string | null;
  escalation_target: string;
  source_chat_id: number | null;
  source_message_id: number | null;
  user_telegram_id: number;
}

const UNKNOWN_DELIVERY_ROWS_SQL = `
  SELECT 'INTERACTIVE' AS kind, d.operation_key AS delivery_key, d.ticket_id,
         t.staff_chat_id, d.source_chat_id, d.source_message_id,
         d.delivery_chat_id AS destination_chat_id, NULL AS related_telegram_message_id,
         d.delivery_message_id AS known_telegram_message_id,
         d.failure_category AS diagnostic_category, d.failure_description AS diagnostic_description,
         d.created_at, d.updated_at
  FROM ticket_outbound_deliveries d
  JOIN tickets t ON t.id = d.ticket_id
  WHERE t.staff_chat_id = ? AND d.state = 'UNKNOWN_DELIVERY'
    AND d.operation_key NOT LIKE 'ticket-batch:%'
  UNION ALL
  SELECT CASE WHEN a.summary_message_id IS NULL THEN 'ARCHIVE_SUMMARY' ELSE 'ARCHIVE_DOCUMENT' END,
         'ticket-archive:' || a.ticket_id || ':' ||
           CASE WHEN a.summary_message_id IS NULL THEN 'summary' ELSE 'document' END,
         a.ticket_id, t.staff_chat_id, NULL, NULL, t.staff_chat_id,
         a.summary_message_id, a.document_message_id,
         a.failure_category, a.failure_description, a.created_at, a.updated_at
  FROM ticket_archive_deliveries a
  JOIN tickets t ON t.id = a.ticket_id
  WHERE t.staff_chat_id = ? AND a.state = 'UNKNOWN_DELIVERY'
  UNION ALL
  SELECT 'BATCH_REPLY', 'ticket-batch:' || i.answer_package_id || ':' || i.ticket_id,
         i.ticket_id, p.staff_chat_id, p.source_chat_id, p.source_message_id,
         t.user_telegram_id, NULL, COALESCE(d.delivery_message_id, i.delivery_message_id),
         i.delivery_error_category, i.delivery_error_description, p.imported_at, i.updated_at
  FROM ticket_batch_answer_items i
  JOIN ticket_batch_answer_packages p ON p.answer_package_id = i.answer_package_id
  JOIN tickets t ON t.id = i.ticket_id
  LEFT JOIN ticket_outbound_deliveries d
    ON d.operation_key = 'ticket-batch:' || i.answer_package_id || ':' || i.ticket_id
  WHERE p.staff_chat_id = ? AND i.state = 'UNKNOWN_DELIVERY'
`;

function caseToken(kind: DeliveryReconciliationKind, deliveryKey: string): string {
  return createHash("sha256").update(`${kind}\0${deliveryKey}`).digest("base64url").slice(0, 32);
}

function toRecord(row: ReconciliationRow): DeliveryReconciliationRecord {
  return {
    caseToken: caseToken(row.kind, row.delivery_key),
    kind: row.kind,
    operationIdentity: row.delivery_key,
    ticketId: row.ticket_id,
    staffChatId: row.staff_chat_id,
    sourceChatId: row.source_chat_id,
    sourceMessageId: row.source_message_id,
    destinationChatId: row.destination_chat_id,
    relatedTelegramMessageId: row.related_telegram_message_id,
    knownTelegramMessageId: row.known_telegram_message_id,
    state: "UNKNOWN_DELIVERY",
    diagnosticCategory: row.diagnostic_category,
    diagnosticDescription: row.diagnostic_description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DeliveryReconciliationRepository {
  constructor(private readonly db: Database.Database) {}

  listUnknown(staffChatId: number, limit = 50): DeliveryReconciliationRecord[] {
    return this.listUnknownRows(staffChatId, limit).map(toRecord);
  }

  countUnknown(staffChatId: number): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM (${UNKNOWN_DELIVERY_ROWS_SQL}) AS unresolved
           WHERE NOT EXISTS (
             SELECT 1 FROM delivery_reconciliation_audit audit
             WHERE audit.staff_chat_id = unresolved.staff_chat_id
               AND audit.delivery_kind = unresolved.kind
               AND audit.delivery_key = unresolved.delivery_key
           )`
        )
        .get(staffChatId, staffChatId, staffChatId) as { count: number }
    ).count;
  }

  getUnknown(staffChatId: number, requestedCaseToken: string): DeliveryReconciliationRecord | undefined {
    return this.listUnknownRows(staffChatId, 50)
      .map(toRecord)
      .find((record) => record.caseToken === requestedCaseToken);
  }

  reconcile(input: ReconcileUnknownDeliveryInput): DeliveryReconciliationResult {
    const tx = this.db.transaction((): DeliveryReconciliationResult => {
      const existingAudit = this.getAuditByCaseToken(input.staffChatId, input.caseToken);
      if (existingAudit) return this.auditOutcome(existingAudit, input);

      const record = this.getUnknown(input.staffChatId, input.caseToken);
      if (!record) return { outcome: "NOT_FOUND" };
      if (input.action === "CONFIRMED_DELIVERED" && !isPositiveInteger(input.telegramMessageId)) {
        return { outcome: "CONFLICT", kind: record.kind, ticketId: record.ticketId };
      }

      const resultingState = this.applyReconciliation(record, input);
      if (resultingState === undefined) return { outcome: "CONFLICT", kind: record.kind, ticketId: record.ticketId };
      this.insertAudit(record, input, resultingState);
      return {
        outcome: "APPLIED",
        kind: record.kind,
        ticketId: record.ticketId,
        resultingState,
        archiveFinalizationRequired: record.kind === "ARCHIVE_DOCUMENT" && resultingState === "DELIVERED",
      };
    });
    return tx();
  }

  listAudit(staffChatId: number, limit = 100): DeliveryReconciliationAuditRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM delivery_reconciliation_audit
         WHERE staff_chat_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(staffChatId, limit) as DeliveryReconciliationAuditRecord[];
  }

  private listUnknownRows(staffChatId: number, limit: number): ReconciliationRow[] {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
    return this.db
      .prepare(
        `SELECT * FROM (${UNKNOWN_DELIVERY_ROWS_SQL}) AS unresolved
         WHERE NOT EXISTS (
           SELECT 1 FROM delivery_reconciliation_audit audit
           WHERE audit.staff_chat_id = unresolved.staff_chat_id
             AND audit.delivery_kind = unresolved.kind
             AND audit.delivery_key = unresolved.delivery_key
         )
         ORDER BY updated_at ASC, ticket_id ASC
         LIMIT ?`
      )
      .all(staffChatId, staffChatId, staffChatId, boundedLimit) as ReconciliationRow[];
  }

  private applyReconciliation(
    record: DeliveryReconciliationRecord,
    input: ReconcileUnknownDeliveryInput
  ): string | undefined {
    if (record.kind === "INTERACTIVE") return this.reconcileInteractive(record, input);
    if (record.kind === "ARCHIVE_SUMMARY" || record.kind === "ARCHIVE_DOCUMENT")
      return this.reconcileArchive(record, input);
    return this.reconcileBatch(record, input);
  }

  private reconcileInteractive(
    record: DeliveryReconciliationRecord,
    input: ReconcileUnknownDeliveryInput
  ): string | undefined {
    if (input.action === "CONFIRMED_FAILED") {
      const updated = this.db
        .prepare(
          `UPDATE ticket_outbound_deliveries
           SET state = 'FAILED', failure_category = 'OPERATOR_CONFIRMED_NOT_DELIVERED',
               failure_description = ?, updated_at = ?
           WHERE operation_key = ? AND state = 'UNKNOWN_DELIVERY'`
        )
        .run(
          input.note ?? "Operator confirmed that Telegram did not deliver this reply.",
          now(),
          record.operationIdentity
        );
      return updated.changes === 1 ? "FAILED" : undefined;
    }
    const delivery = this.db
      .prepare("SELECT * FROM ticket_outbound_deliveries WHERE operation_key = ? AND state = 'UNKNOWN_DELIVERY'")
      .get(record.operationIdentity) as InteractiveDeliveryRow | undefined;
    if (!delivery || !isPositiveInteger(input.telegramMessageId)) return undefined;
    const updated = this.db
      .prepare(
        `UPDATE ticket_outbound_deliveries
         SET state = 'DELIVERED', delivery_message_id = ?, failure_category = NULL,
             failure_description = NULL, updated_at = ?
         WHERE operation_key = ? AND state = 'UNKNOWN_DELIVERY'`
      )
      .run(input.telegramMessageId, now(), record.operationIdentity);
    if (updated.changes !== 1) return undefined;
    this.insertTranscriptMessage(delivery, input.telegramMessageId);
    return "DELIVERED";
  }

  private reconcileArchive(
    record: DeliveryReconciliationRecord,
    input: ReconcileUnknownDeliveryInput
  ): string | undefined {
    const isSummary = record.kind === "ARCHIVE_SUMMARY";
    if (input.action === "CONFIRMED_FAILED") {
      const updated = this.db
        .prepare(
          `UPDATE ticket_archive_deliveries
           SET state = 'FAILED', failure_category = 'OPERATOR_CONFIRMED_NOT_DELIVERED',
               failure_description = ?, updated_at = ?
           WHERE ticket_id = ? AND state = 'UNKNOWN_DELIVERY'
             AND ${isSummary ? "summary_message_id IS NULL" : "summary_message_id IS NOT NULL AND document_message_id IS NULL"}`
        )
        .run(
          input.note ?? "Operator confirmed that Telegram did not deliver this archive stage.",
          now(),
          record.ticketId
        );
      return updated.changes === 1 ? "FAILED" : undefined;
    }
    if (!isPositiveInteger(input.telegramMessageId)) return undefined;
    const resultingState = isSummary ? "SUMMARY_SENT" : "DELIVERED";
    const messageColumn = isSummary ? "summary_message_id" : "document_message_id";
    const updated = this.db
      .prepare(
        `UPDATE ticket_archive_deliveries
         SET state = ?, ${messageColumn} = ?, failure_category = NULL,
             failure_description = NULL, updated_at = ?
         WHERE ticket_id = ? AND state = 'UNKNOWN_DELIVERY'
           AND ${isSummary ? "summary_message_id IS NULL" : "summary_message_id IS NOT NULL AND document_message_id IS NULL"}`
      )
      .run(resultingState, input.telegramMessageId, now(), record.ticketId);
    return updated.changes === 1 ? resultingState : undefined;
  }

  private reconcileBatch(
    record: DeliveryReconciliationRecord,
    input: ReconcileUnknownDeliveryInput
  ): string | undefined {
    const identity = record.operationIdentity.slice("ticket-batch:".length);
    const separator = identity.lastIndexOf(":");
    const answerPackageId = separator < 0 ? "" : identity.slice(0, separator);
    const ticketIdText = separator < 0 ? "" : identity.slice(separator + 1);
    const ticketId = Number(ticketIdText);
    if (!answerPackageId || ticketId !== record.ticketId) return undefined;
    const item = this.db
      .prepare(
        `SELECT i.action, i.reply_text, i.follow_up_state, i.internal_note, i.escalation_target,
                p.source_chat_id, p.source_message_id, t.user_telegram_id
         FROM ticket_batch_answer_items i
         JOIN ticket_batch_answer_packages p ON p.answer_package_id = i.answer_package_id
         JOIN tickets t ON t.id = i.ticket_id
         WHERE i.answer_package_id = ? AND i.ticket_id = ? AND i.state = 'UNKNOWN_DELIVERY'
           AND i.action IN ('reply_keep_open', 'reply_and_close') AND i.reply_text IS NOT NULL`
      )
      .get(answerPackageId, ticketId) as BatchReconciliationRow | undefined;
    if (!item) return undefined;
    const outbound = this.db
      .prepare("SELECT * FROM ticket_outbound_deliveries WHERE operation_key = ?")
      .get(record.operationIdentity) as (InteractiveDeliveryRow & { state: string }) | undefined;
    if (input.action === "CONFIRMED_FAILED") {
      if (outbound && outbound.state !== "UNKNOWN_DELIVERY") return undefined;
      if (outbound?.state === "UNKNOWN_DELIVERY") {
        const updatedOutbound = this.db
          .prepare(
            `UPDATE ticket_outbound_deliveries
             SET state = 'FAILED', failure_category = 'OPERATOR_CONFIRMED_NOT_DELIVERED',
                 failure_description = ?, updated_at = ?
             WHERE operation_key = ? AND state = 'UNKNOWN_DELIVERY'`
          )
          .run(
            input.note ?? "Operator confirmed that Telegram did not deliver this batch reply.",
            now(),
            record.operationIdentity
          );
        if (updatedOutbound.changes !== 1) return undefined;
      }
      const updated = this.db
        .prepare(
          `UPDATE ticket_batch_answer_items
           SET state = 'FAILED', last_error = 'Operator confirmed reply was not delivered.', updated_at = ?
           WHERE answer_package_id = ? AND ticket_id = ? AND state = 'UNKNOWN_DELIVERY'`
        )
        .run(now(), answerPackageId, ticketId);
      return updated.changes === 1 ? "FAILED" : undefined;
    }
    if (!isPositiveInteger(input.telegramMessageId)) return undefined;
    if (
      outbound &&
      !(
        outbound.state === "UNKNOWN_DELIVERY" ||
        (outbound.state === "DELIVERED" && outbound.delivery_message_id === input.telegramMessageId)
      )
    )
      return undefined;
    if (outbound?.state === "UNKNOWN_DELIVERY") {
      const updated = this.db
        .prepare(
          `UPDATE ticket_outbound_deliveries
           SET state = 'DELIVERED', delivery_message_id = ?, failure_category = NULL,
               failure_description = NULL, updated_at = ?
           WHERE operation_key = ? AND state = 'UNKNOWN_DELIVERY'`
        )
        .run(input.telegramMessageId, now(), record.operationIdentity);
      if (updated.changes !== 1) return undefined;
      this.insertTranscriptMessage(outbound, input.telegramMessageId);
    } else if (!outbound) {
      this.insertTranscriptMessage(
        {
          operation_key: record.operationIdentity,
          ticket_id: ticketId,
          source_chat_id: item.source_chat_id,
          source_message_id: item.source_message_id,
          delivery_chat_id: item.user_telegram_id,
          delivery_message_id: null,
          from_telegram_id: null,
          from_username: null,
          sender_type: "STAFF",
          sender_display_name: "Support",
          sender_username: null,
          text: item.reply_text,
          media_type: null,
          filename: null,
          file_id: null,
        },
        input.telegramMessageId
      );
    }
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tickets
         SET follow_up_state = ?, internal_note = ?, escalation_target = ?,
             follow_up_updated_at = ?, follow_up_source_answer_package_id = ?,
             status = CASE
               WHEN status = 'CLOSED' THEN status
               WHEN ? = 'WAITING_USER' THEN 'WAITING_USER'
               WHEN ? != 'NONE' OR status = 'OPEN' THEN 'IN_PROGRESS'
               ELSE status
             END,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        item.follow_up_state,
        item.internal_note,
        item.escalation_target,
        timestamp,
        answerPackageId,
        item.follow_up_state,
        item.follow_up_state,
        timestamp,
        ticketId
      );
    this.db
      .prepare(
        `INSERT INTO ticket_follow_up_history (
           ticket_id, follow_up_state, internal_note, escalation_target,
           source_answer_package_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(ticketId, item.follow_up_state, item.internal_note, item.escalation_target, answerPackageId, timestamp);
    const updated = this.db
      .prepare(
        `UPDATE ticket_batch_answer_items
         SET state = 'STAFF_SYNC_PENDING', delivery_message_id = ?, applied_at = ?, last_error = NULL,
             delivery_error_category = NULL, delivery_error_permanence = NULL,
             delivery_error_code = NULL, delivery_http_status = NULL, delivery_error_method = NULL,
             delivery_retry_after_seconds = NULL, delivery_error_description = NULL,
             delivery_failure_event_state = 'NOT_REQUIRED', delivery_failure_event_next_retry_at = NULL,
             topic_echo_state = 'PENDING', topic_echo_next_retry_at = ?, updated_at = ?
         WHERE answer_package_id = ? AND ticket_id = ? AND state = 'UNKNOWN_DELIVERY'`
      )
      .run(input.telegramMessageId, timestamp, timestamp, timestamp, answerPackageId, ticketId);
    return updated.changes === 1 ? "STAFF_SYNC_PENDING" : undefined;
  }

  private insertTranscriptMessage(delivery: InteractiveDeliveryRow, deliveryMessageId: number): void {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO messages (
           ticket_id, direction, source_chat_id, source_message_id, delivery_chat_id, delivery_message_id,
           from_telegram_id, from_username, sender_type, sender_display_name, sender_username,
           text, media_type, filename, file_id, created_at
         ) VALUES (?, 'STAFF_TO_USER', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        delivery.ticket_id,
        delivery.source_chat_id,
        delivery.source_message_id,
        delivery.delivery_chat_id,
        deliveryMessageId,
        delivery.from_telegram_id,
        delivery.from_username,
        delivery.sender_type,
        delivery.sender_display_name,
        delivery.sender_username,
        delivery.text,
        delivery.media_type,
        delivery.filename,
        delivery.file_id,
        timestamp
      );
  }

  private insertAudit(
    record: DeliveryReconciliationRecord,
    input: ReconcileUnknownDeliveryInput,
    resultingState: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO delivery_reconciliation_audit (
           case_token, delivery_kind, delivery_key, ticket_id, staff_chat_id, reconciled_by,
           action, previous_state, resulting_state, telegram_message_id, note, reconciled_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'UNKNOWN_DELIVERY', ?, ?, ?, ?)`
      )
      .run(
        record.caseToken,
        record.kind,
        record.operationIdentity,
        record.ticketId,
        record.staffChatId,
        input.reconciledBy,
        input.action,
        resultingState,
        input.telegramMessageId ?? null,
        input.note ?? null,
        now()
      );
  }

  private getAuditByCaseToken(
    staffChatId: number,
    requestedCaseToken: string
  ): DeliveryReconciliationAuditRecord | undefined {
    return this.db
      .prepare("SELECT * FROM delivery_reconciliation_audit WHERE staff_chat_id = ? AND case_token = ?")
      .get(staffChatId, requestedCaseToken) as DeliveryReconciliationAuditRecord | undefined;
  }

  private auditOutcome(
    audit: DeliveryReconciliationAuditRecord,
    input: ReconcileUnknownDeliveryInput
  ): DeliveryReconciliationResult {
    const sameMessageId =
      audit.action !== "CONFIRMED_DELIVERED" || audit.telegram_message_id === (input.telegramMessageId ?? null);
    return {
      outcome: audit.action === input.action && sameMessageId ? "IDEMPOTENT" : "CONFLICT",
      kind: audit.delivery_kind,
      ticketId: audit.ticket_id,
      resultingState: audit.resulting_state,
      archiveFinalizationRequired: audit.delivery_kind === "ARCHIVE_DOCUMENT" && audit.resulting_state === "DELIVERED",
    };
  }
}

function isPositiveInteger(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
