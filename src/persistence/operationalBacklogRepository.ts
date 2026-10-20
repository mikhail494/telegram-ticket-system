import type Database from "better-sqlite3";
import { backlogAgeSeconds, type OperationalBacklogObservation } from "../operationalBacklog.js";
import { DELIVERY_REVIEW_CASES_SQL } from "./deliveryReconciliationRepository.js";
import {
  BATCH_FAILURE_EVENT_PENDING,
  BATCH_FINAL_SUMMARY_PENDING,
  BATCH_TOPIC_ECHO_PENDING,
  BATCH_CLOSED_REPLY_PENDING,
  BATCH_REPLY_AND_CLOSE_PENDING,
  BATCH_SILENT_CLOSE_PENDING,
  BATCH_INVALID_SUCCESS_ECHO,
} from "./batchRecoveryQueries.js";

interface Aggregate {
  count: number;
  oldest: string | null;
}

// Mirrors archiveTicketIfPossible's pre-send guards, not just the broader startup list.
// In-flight/ambiguous claims and operator-confirmed non-delivery are not retryable archives.
const ARCHIVE_UNBLOCKED = `NOT EXISTS (
  SELECT 1 FROM ticket_outbound_deliveries d WHERE d.ticket_id = t.id AND d.state IN ('PENDING', 'UNKNOWN_DELIVERY'))
  AND NOT EXISTS (SELECT 1 FROM ticket_inbound_routing_operations r
    WHERE r.ticket_id = t.id AND r.state NOT IN ('DELIVERED', 'CANCELLED'))
  AND NOT EXISTS (SELECT 1 FROM ticket_archive_deliveries a WHERE a.ticket_id = t.id
    AND (a.state IN ('SUMMARY_PENDING', 'DOCUMENT_PENDING', 'UNKNOWN_DELIVERY')
      OR (a.state = 'FAILED' AND a.failure_category = 'OPERATOR_CONFIRMED_NOT_DELIVERED')))
  AND t.id NOT IN (SELECT audit.ticket_id FROM delivery_reconciliation_audit audit
    WHERE audit.staff_chat_id = @staffChatId
      AND audit.delivery_kind IN ('ARCHIVE_SUMMARY', 'ARCHIVE_DOCUMENT') AND audit.action = 'CONFIRMED_FAILED')
  AND EXISTS (SELECT 1 FROM messages m WHERE m.ticket_id = t.id)`;

// Keep the outer loop workspace-scoped rather than walking the global topic-echo state index.
const ITEM_PACKAGE_FROM = `FROM ticket_batch_answer_packages p
  CROSS JOIN ticket_batch_answer_items i ON i.answer_package_id = p.answer_package_id`;
const ITEM_FROM = `${ITEM_PACKAGE_FROM} CROSS JOIN tickets t ON t.id = i.ticket_id`;
const CLOSED_CONTINUATION_CAN_PROGRESS = `(t.status != 'CLOSED' OR t.archived_at IS NOT NULL OR (${ARCHIVE_UNBLOCKED}))`;

const BATCH_CANDIDATE_RULES: ReadonlyArray<{
  predicate: string;
  due: string;
  guard: string;
  allowMissingTicket?: boolean;
}> = [
  {
    predicate: BATCH_FAILURE_EVENT_PENDING,
    due: "i.delivery_failure_event_next_retry_at",
    guard: "t.message_thread_id IS NOT NULL",
  },
  {
    predicate: BATCH_TOPIC_ECHO_PENDING,
    due: "i.topic_echo_next_retry_at",
    guard: "(i.topic_echo_state = 'SENT' OR t.message_thread_id IS NOT NULL)",
  },
  { predicate: BATCH_CLOSED_REPLY_PENDING, due: "NULL", guard: "1" },
  { predicate: BATCH_INVALID_SUCCESS_ECHO, due: "NULL", guard: "1", allowMissingTicket: true },
  {
    predicate: BATCH_REPLY_AND_CLOSE_PENDING,
    due: "i.topic_echo_next_retry_at",
    guard: CLOSED_CONTINUATION_CAN_PROGRESS,
  },
  {
    predicate: BATCH_SILENT_CLOSE_PENDING,
    due: "i.topic_echo_next_retry_at",
    guard: `(t.id IS NULL OR ${CLOSED_CONTINUATION_CAN_PROGRESS})`,
    allowMissingTicket: true,
  },
];
const BATCH_CANDIDATES = BATCH_CANDIDATE_RULES.map(
  ({
    predicate,
    due,
    guard,
    allowMissingTicket,
  }) => `SELECT 'item:' || i.answer_package_id || ':' || i.ticket_id AS work_key,
    ${due} AS due_at ${allowMissingTicket ? `${ITEM_PACKAGE_FROM} LEFT JOIN tickets t ON t.id = i.ticket_id` : ITEM_FROM}
    WHERE ${predicate} AND ${allowMissingTicket ? "(t.id IS NULL OR t.staff_chat_id = p.staff_chat_id)" : "t.staff_chat_id = p.staff_chat_id"} AND ${guard}`
).join(" UNION ALL ");

export const BATCH_BACKLOG_SQL = `SELECT COUNT(*) AS count, MIN(due_at) AS oldest FROM (
  SELECT work_key, MIN(due_at) AS due_at FROM (${BATCH_CANDIDATES}) GROUP BY work_key
  UNION ALL SELECT 'summary:' || p.answer_package_id, p.final_summary_next_retry_at
    FROM ticket_batch_answer_packages p WHERE ${BATCH_FINAL_SUMMARY_PENDING})`;

export const ARCHIVE_BACKLOG_SQL = `SELECT COUNT(*) AS count, MIN(t.closed_at) AS oldest FROM tickets t
  WHERE t.staff_chat_id = @staffChatId AND t.status = 'CLOSED' AND t.archived_at IS NULL AND ${ARCHIVE_UNBLOCKED}`;

export const MODERATION_BACKLOG_SQL = `SELECT COUNT(*) AS count, MIN(cleanup_due_at) AS oldest
  FROM language_moderation_cleanup_jobs WHERE staff_chat_id = @staffChatId
    AND state IN ('PENDING', 'CLEANING', 'LOG_PENDING') AND cleanup_due_at <= @at`;

const REVIEW_BACKLOG_SQL = `WITH review AS MATERIALIZED (
  SELECT delivery_key, state, updated_at FROM (${DELIVERY_REVIEW_CASES_SQL})), unknown_operations AS (
  SELECT delivery_key FROM review WHERE state = 'UNKNOWN_DELIVERY'
  UNION SELECT d.operation_key ${ITEM_FROM}
    JOIN ticket_outbound_deliveries d ON d.operation_key = 'ticket-batch:' || i.answer_package_id || ':' || i.ticket_id
    WHERE p.staff_chat_id = @staffChatId AND t.staff_chat_id = p.staff_chat_id AND d.state = 'UNKNOWN_DELIVERY'
      AND d.operation_key NOT IN (SELECT audit.delivery_key FROM delivery_reconciliation_audit audit
        WHERE audit.staff_chat_id = @staffChatId AND audit.delivery_kind = 'BATCH_REPLY')
  UNION SELECT 'batch-final-summary:' || p.answer_package_id FROM ticket_batch_answer_packages p
    WHERE p.staff_chat_id = @staffChatId AND p.final_summary_state = 'UNKNOWN_DELIVERY')
  SELECT COUNT(*) AS count, MIN(updated_at) AS oldest,
    (SELECT COUNT(*) FROM unknown_operations) AS unknown_count FROM review`;

export const OPERATIONAL_BACKLOG_SQL = {
  review: REVIEW_BACKLOG_SQL,
  batch: BATCH_BACKLOG_SQL,
  moderation: MODERATION_BACKLOG_SQL,
  archive: ARCHIVE_BACKLOG_SQL,
  exports: `SELECT COUNT(*) AS count FROM ticket_batch_exports
    WHERE staff_chat_id = @staffChatId AND delivery_state = 'UNKNOWN_DELIVERY'`,
};

export class OperationalBacklogRepository {
  private statements?: Record<keyof typeof OPERATIONAL_BACKLOG_SQL, Database.Statement>;

  constructor(private readonly db: Database.Database) {}

  observe(staffChatId: number, at: string): OperationalBacklogObservation {
    // Preparation is also observation work: failures must not prevent SQLite startup.
    const statements = (this.statements ??= {
      review: this.db.prepare(OPERATIONAL_BACKLOG_SQL.review),
      batch: this.db.prepare(OPERATIONAL_BACKLOG_SQL.batch),
      moderation: this.db.prepare(OPERATIONAL_BACKLOG_SQL.moderation),
      archive: this.db.prepare(OPERATIONAL_BACKLOG_SQL.archive),
      exports: this.db.prepare(OPERATIONAL_BACKLOG_SQL.exports),
    });
    const parameters = { staffChatId, at };
    const review = statements.review.get(parameters) as Aggregate & { unknown_count: number };
    const batch = statements.batch.get(parameters) as Aggregate;
    const moderation = statements.moderation.get(parameters) as Aggregate;
    const archive = statements.archive.get(parameters) as Aggregate;
    const exports = statements.exports.get(parameters) as { count: number };
    return {
      staffChatId,
      observedAt: at,
      deliveryReview: { count: review.count, oldestAgeSeconds: backlogAgeSeconds(at, review.oldest) },
      unknownDeliveryCount: review.unknown_count,
      batchRecovery: { count: batch.count, oldestOverdueSeconds: backlogAgeSeconds(at, batch.oldest) },
      moderationCleanup: { count: moderation.count, oldestOverdueSeconds: backlogAgeSeconds(at, moderation.oldest) },
      archiveRecovery: { count: archive.count, oldestAgeSeconds: backlogAgeSeconds(at, archive.oldest) },
      batchExportUnknownDeliveryCount: exports.count,
    };
  }
}
