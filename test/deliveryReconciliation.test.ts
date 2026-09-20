import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { SupportDatabase } from "../src/db.js";

const STAFF_CHAT_ID = -100900;

function seedTicket(db: SupportDatabase): number {
  db.upsertUser({ telegramId: 7001, username: "customer" });
  return db.createTicket(7001, STAFF_CHAT_ID).id;
}

function seedUnknownBatch(
  db: SupportDatabase,
  id: string,
  options: {
    ticketId?: number;
    staffChatId?: number;
    outboundState?: "UNKNOWN_DELIVERY" | "FAILED" | "DELIVERED" | "NONE";
    followUpState?: "NONE" | "WAITING_USER";
    internalNote?: string | null;
  } = {}
) {
  const ticketId = options.ticketId ?? seedTicket(db);
  const staffChatId = options.staffChatId ?? STAFF_CHAT_ID;
  const operationKey = `ticket-batch:${id}:${ticketId}`;
  db.createTicketBatchExport({
    exportId: `export-${id}`,
    staffChatId,
    createdAt: "2026-09-19T00:00:00.000Z",
    selectionMode: "all_active",
    ticketCount: 1,
    items: [{ ticketId, snapshotToken: `sha256:${id}` }],
  });
  db.createTicketBatchAnswerPackage({
    answerPackageId: id,
    exportId: `export-${id}`,
    staffChatId,
    packageHash: `sha256:${id}`,
    sourceChatId: 1,
    sourceMessageId: 88,
    packageCreatedAt: "2026-09-19T00:00:00.000Z",
    items: [
      {
        ticket_id: ticketId,
        snapshot_token: `sha256:${id}`,
        action: "reply_keep_open",
        reply_text: "Batch reply",
        follow_up_state: options.followUpState ?? "NONE",
        internal_note: options.internalNote ?? null,
      },
    ],
  });
  const outboundState = options.outboundState ?? "UNKNOWN_DELIVERY";
  if (outboundState !== "NONE") {
    db.createTicketOutboundDeliveryIntent({
      operationKey,
      ticketId,
      direction: "STAFF_TO_USER",
      sourceChatId: 1,
      sourceMessageId: 88,
      deliveryChatId: 7001,
      senderType: "STAFF",
      senderDisplayName: "Support",
      text: "Batch reply",
    });
    if (outboundState === "UNKNOWN_DELIVERY") db.markTicketOutboundDeliveryUnknown(operationKey, "Ambiguous reply.");
    else if (outboundState === "FAILED")
      db.markTicketOutboundDeliveryFailed(operationKey, "TELEGRAM_BAD_REQUEST", "Rejected.");
    else db.markTicketOutboundDeliveryDelivered(operationKey, 901);
  }
  db.updateTicketBatchAnswerItem(id, ticketId, "UNKNOWN_DELIVERY", { lastError: "Manual review required." });
  return { ticketId, operationKey, record: db.listUnknownDeliveryReconciliations(staffChatId)[0] };
}

describe("unknown delivery reconciliation persistence", () => {
  it("lets one of two concurrent interactive reconciliations win without duplicate state", async () => {
    const db = new SupportDatabase(":memory:");
    try {
      const ticketId = seedTicket(db);
      const operationKey = `staff-message:${STAFF_CHAT_ID}:42`;
      db.createTicketOutboundDeliveryIntent({
        operationKey,
        ticketId,
        direction: "STAFF_TO_USER",
        sourceChatId: STAFF_CHAT_ID,
        sourceMessageId: 42,
        deliveryChatId: 7001,
        fromTelegramId: 91,
        senderType: "STAFF",
        senderDisplayName: "Agent",
        text: "Durable reply",
      });
      db.markTicketOutboundDeliveryUnknown(operationKey, "Ambiguous transport outcome.");

      const [record] = db.listUnknownDeliveryReconciliations(STAFF_CHAT_ID);
      assert.equal(record?.kind, "INTERACTIVE");
      assert.equal(record?.ticketId, ticketId);

      const reconcile = () =>
        db.reconcileUnknownDelivery({
          staffChatId: STAFF_CHAT_ID,
          caseToken: record!.caseToken,
          action: "CONFIRMED_DELIVERED",
          telegramMessageId: 501,
          reconciledBy: 1,
          note: "Verified in Telegram.",
        });
      const [first, duplicate] = await Promise.all([
        Promise.resolve().then(reconcile),
        Promise.resolve().then(reconcile),
      ]);
      const contradiction = db.reconcileUnknownDelivery({
        staffChatId: STAFF_CHAT_ID,
        caseToken: record!.caseToken,
        action: "CONFIRMED_FAILED",
        reconciledBy: 2,
        note: "Contradictory review.",
      });

      assert.equal(first.outcome, "APPLIED");
      assert.equal(duplicate.outcome, "IDEMPOTENT");
      assert.equal(contradiction.outcome, "CONFLICT");
      assert.equal(db.getTicketOutboundDelivery(operationKey)?.state, "DELIVERED");
      assert.equal(db.getTicketOutboundDelivery(operationKey)?.delivery_message_id, 501);
      const messages = db.listMessagesChronological(ticketId);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.delivery_message_id, 501);
      const audit = db.listDeliveryReconciliationAudit(STAFF_CHAT_ID);
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.reconciled_by, 1);
      assert.equal(audit[0]?.previous_state, "UNKNOWN_DELIVERY");
      assert.equal(audit[0]?.resulting_state, "DELIVERED");
    } finally {
      db.close();
    }
  });

  it("recovers file-backed orphan PENDING intents as UNKNOWN without replay", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-delivery-crash-"));
    const databasePath = path.join(directory, "support.db");
    const operationKey = `staff-message:${STAFF_CHAT_ID}:901`;
    try {
      const beforeCrash = new SupportDatabase(`file:${databasePath}`);
      const ticketId = seedTicket(beforeCrash);
      beforeCrash.createTicketOutboundDeliveryIntent({
        operationKey,
        ticketId,
        direction: "STAFF_TO_USER",
        sourceChatId: STAFF_CHAT_ID,
        sourceMessageId: 901,
        deliveryChatId: 7001,
        senderType: "STAFF",
        senderDisplayName: "Agent",
        text: "Possibly delivered reply",
      });
      beforeCrash.close();

      const afterRestart = new SupportDatabase(`file:${databasePath}`);
      assert.equal(afterRestart.getTicketOutboundDelivery(operationKey)?.state, "PENDING");
      assert.equal(afterRestart.markPendingTicketOutboundDeliveriesUnknown(), 1);
      assert.equal(afterRestart.getTicketOutboundDelivery(operationKey)?.state, "UNKNOWN_DELIVERY");
      assert.equal(afterRestart.listMessagesChronological(ticketId).length, 0);
      assert.equal(afterRestart.markPendingTicketOutboundDeliveriesUnknown(), 0);
      afterRestart.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("contains reconciliation to the active staff workspace and records confirmed failure once", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const ticketId = seedTicket(db);
      const operationKey = `staff-message:${STAFF_CHAT_ID}:902`;
      db.createTicketOutboundDeliveryIntent({
        operationKey,
        ticketId,
        direction: "STAFF_TO_USER",
        sourceChatId: STAFF_CHAT_ID,
        sourceMessageId: 902,
        deliveryChatId: 7001,
        senderType: "STAFF",
        senderDisplayName: "Agent",
        text: "Not delivered reply",
      });
      db.markTicketOutboundDeliveryUnknown(operationKey, "Ambiguous transport outcome.");
      const record = db.listUnknownDeliveryReconciliations(STAFF_CHAT_ID)[0]!;

      assert.equal(
        db.reconcileUnknownDelivery({
          staffChatId: STAFF_CHAT_ID - 1,
          caseToken: record.caseToken,
          action: "CONFIRMED_FAILED",
          reconciledBy: 2,
          note: "Wrong workspace attempt.",
        }).outcome,
        "NOT_FOUND"
      );
      assert.equal(
        db.reconcileUnknownDelivery({
          staffChatId: STAFF_CHAT_ID,
          caseToken: record.caseToken,
          action: "CONFIRMED_FAILED",
          reconciledBy: 1,
          note: "Verified absent in Telegram.",
        }).outcome,
        "APPLIED"
      );
      assert.equal(db.getTicketOutboundDelivery(operationKey)?.state, "FAILED");
      assert.equal(db.listMessagesChronological(ticketId).length, 0);
      assert.equal(db.listDeliveryReconciliationAudit(STAFF_CHAT_ID).length, 1);
    } finally {
      db.close();
    }
  });

  it("migrates a file-backed schema from 25 to 26 without changing durable delivery rows", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-delivery-reconciliation-"));
    const databasePath = path.join(directory, "support.db");
    try {
      const seeded = new SupportDatabase(`file:${databasePath}`);
      const ticketId = seedTicket(seeded);
      const operationKey = `staff-message:${STAFF_CHAT_ID}:77`;
      seeded.createTicketOutboundDeliveryIntent({
        operationKey,
        ticketId,
        direction: "STAFF_TO_USER",
        sourceChatId: STAFF_CHAT_ID,
        sourceMessageId: 77,
        deliveryChatId: 7001,
        senderType: "STAFF",
        senderDisplayName: "Agent",
        text: "Preserved reply",
      });
      seeded.markTicketOutboundDeliveryUnknown(operationKey, "Preserved diagnostic.");
      seeded.close();

      const fixture = new Database(databasePath);
      try {
        fixture.exec(`
          DROP TRIGGER IF EXISTS prevent_delivery_reconciliation_audit_update;
          DROP TRIGGER IF EXISTS prevent_delivery_reconciliation_audit_delete;
          DROP TABLE IF EXISTS delivery_reconciliation_audit;
          DELETE FROM schema_migrations WHERE id = 26;
        `);
      } finally {
        fixture.close();
      }

      const migrated = new SupportDatabase(`file:${databasePath}`);
      migrated.close();
      const inspected = new Database(databasePath, { readonly: true });
      try {
        assert.equal(
          (
            inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 26").get() as {
              count: number;
            }
          ).count,
          1
        );
        const preserved = inspected
          .prepare("SELECT state, text FROM ticket_outbound_deliveries WHERE operation_key = ?")
          .get(operationKey) as { state: string; text: string };
        assert.equal(preserved.state, "UNKNOWN_DELIVERY");
        assert.equal(preserved.text, "Preserved reply");
        assert.equal(
          (inspected.prepare("SELECT COUNT(*) AS count FROM delivery_reconciliation_audit").get() as { count: number })
            .count,
          0
        );
        assert.equal((inspected.pragma("foreign_key_check") as unknown[]).length, 0);
        assert.equal(
          (inspected.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]?.integrity_check,
          "ok"
        );
      } finally {
        inspected.close();
      }

      const auditStorage = new Database(databasePath);
      try {
        auditStorage
          .prepare(
            `INSERT INTO delivery_reconciliation_audit (
               case_token, delivery_kind, delivery_key, ticket_id, staff_chat_id, reconciled_by,
               action, previous_state, resulting_state, telegram_message_id, note, reconciled_at
             ) VALUES (?, 'INTERACTIVE', ?, ?, ?, 1, 'CONFIRMED_FAILED', 'UNKNOWN_DELIVERY',
                       'FAILED', NULL, 'verified', ?)`
          )
          .run("immutable-audit", operationKey, ticketId, STAFF_CHAT_ID, "2026-09-19T00:00:00.000Z");
        assert.throws(() => auditStorage.prepare("UPDATE delivery_reconciliation_audit SET note = 'changed'").run());
        assert.throws(() => auditStorage.prepare("DELETE FROM delivery_reconciliation_audit").run());
      } finally {
        auditStorage.close();
      }

      const reopened = new SupportDatabase(`file:${databasePath}`);
      reopened.close();
      const reopenedInspection = new Database(databasePath, { readonly: true });
      assert.equal(
        (
          reopenedInspection.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 26").get() as {
            count: number;
          }
        ).count,
        1
      );
      reopenedInspection.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconciles archive summary and document stages without duplicating local finalization", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const ticketId = seedTicket(db);
      db.addMessage({
        ticketId,
        direction: "USER_TO_STAFF",
        sourceChatId: 7001,
        sourceMessageId: 9,
        text: "Archive me",
      });
      db.closeTicketRecord(ticketId, { type: "STAFF", displayName: "Agent" });

      assert.equal(db.claimTicketArchiveSummary(ticketId, 810).claimed, true);
      db.markTicketArchiveUnknown(ticketId, "Summary outcome unknown.");
      const summary = db.listUnknownDeliveryReconciliations(STAFF_CHAT_ID)[0]!;
      assert.equal(summary.kind, "ARCHIVE_SUMMARY");
      const summaryResult = db.reconcileUnknownDelivery({
        staffChatId: STAFF_CHAT_ID,
        caseToken: summary.caseToken,
        action: "CONFIRMED_DELIVERED",
        telegramMessageId: 901,
        reconciledBy: 1,
      });
      assert.equal(summaryResult.resultingState, "SUMMARY_SENT");
      assert.equal(summaryResult.archiveContinuationRequired, true);

      assert.equal(db.claimTicketArchiveDocument(ticketId)?.claimed, true);
      db.markTicketArchiveUnknown(ticketId, "Document outcome unknown.");
      const document = db.listUnknownDeliveryReconciliations(STAFF_CHAT_ID)[0]!;
      assert.equal(document.kind, "ARCHIVE_DOCUMENT");
      const documentResult = db.reconcileUnknownDelivery({
        staffChatId: STAFF_CHAT_ID,
        caseToken: document.caseToken,
        action: "CONFIRMED_DELIVERED",
        telegramMessageId: 902,
        reconciledBy: 1,
      });
      assert.equal(documentResult.archiveContinuationRequired, true);
      assert.equal(db.getTicketArchiveDelivery(ticketId)?.state, "DELIVERED");
      assert.equal(db.finalizeTicketArchiveDelivery(ticketId), true);
      assert.equal(db.finalizeTicketArchiveDelivery(ticketId), false);
      assert.equal(db.getTicket(ticketId)?.logs_message_id, 901);
      assert.equal(db.getTicket(ticketId)?.transcript_message_id, 902);
      assert.equal(db.listMessagesChronological(ticketId).length, 0);
      assert.equal(db.listDeliveryReconciliationAudit(STAFF_CHAT_ID).length, 2);
    } finally {
      db.close();
    }
  });

  it("keeps an archive stage terminal and unsent after an operator confirms non-delivery", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const ticketId = seedTicket(db);
      db.closeTicketRecord(ticketId, { type: "STAFF", displayName: "Agent" });
      assert.equal(db.claimTicketArchiveSummary(ticketId, 810).claimed, true);
      db.markTicketArchiveUnknown(ticketId, "Summary outcome unknown.");
      const record = db.listUnknownDeliveryReconciliations(STAFF_CHAT_ID)[0]!;

      const result = db.reconcileUnknownDelivery({
        staffChatId: STAFF_CHAT_ID,
        caseToken: record.caseToken,
        action: "CONFIRMED_FAILED",
        reconciledBy: 1,
        note: "Verified absent from Support Logs.",
      });

      assert.equal(result.resultingState, "FAILED");
      assert.equal(db.getTicketArchiveDelivery(ticketId)?.state, "FAILED");
      assert.equal(db.getTicketArchiveDelivery(ticketId)?.failure_category, "OPERATOR_CONFIRMED_NOT_DELIVERED");
      assert.equal(db.listUnknownDeliveryReconciliations(STAFF_CHAT_ID).length, 0);
      assert.equal(db.listClosedTicketsPendingArchive(STAFF_CHAT_ID).length, 0);
      assert.equal(db.listDeliveryReconciliationAudit(STAFF_CHAT_ID).length, 1);
    } finally {
      db.close();
    }
  });

  it("reconciles a Batch UNKNOWN reply without replaying or duplicating its transcript", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const ticketId = seedTicket(db);
      db.createTicketBatchExport({
        exportId: "export-reconcile",
        staffChatId: STAFF_CHAT_ID,
        createdAt: "2026-09-19T00:00:00.000Z",
        selectionMode: "all_active",
        ticketCount: 1,
        items: [{ ticketId, snapshotToken: "sha256:ticket" }],
      });
      db.createTicketBatchAnswerPackage({
        answerPackageId: "batch-reconcile",
        exportId: "export-reconcile",
        staffChatId: STAFF_CHAT_ID,
        packageHash: "sha256:batch-reconcile",
        sourceChatId: 1,
        sourceMessageId: 88,
        packageCreatedAt: "2026-09-19T00:00:00.000Z",
        items: [
          {
            ticket_id: ticketId,
            snapshot_token: "sha256:ticket",
            action: "reply_keep_open",
            reply_text: "Batch reply",
            follow_up_state: "WAITING_USER",
            internal_note: "Awaiting customer confirmation.",
          },
        ],
      });
      const operationKey = `ticket-batch:batch-reconcile:${ticketId}`;
      db.createTicketOutboundDeliveryIntent({
        operationKey,
        ticketId,
        direction: "STAFF_TO_USER",
        sourceChatId: 1,
        sourceMessageId: 88,
        deliveryChatId: 7001,
        senderType: "STAFF",
        senderDisplayName: "Support",
        text: "Batch reply",
      });
      db.markTicketOutboundDeliveryUnknown(operationKey, "Ambiguous batch delivery.");
      db.updateTicketBatchAnswerItem("batch-reconcile", ticketId, "UNKNOWN_DELIVERY", {
        lastError: "Manual review required.",
      });

      const batch = db.listUnknownDeliveryReconciliations(STAFF_CHAT_ID)[0]!;
      assert.equal(batch.kind, "BATCH_REPLY");
      const first = db.reconcileUnknownDelivery({
        staffChatId: STAFF_CHAT_ID,
        caseToken: batch.caseToken,
        action: "CONFIRMED_DELIVERED",
        telegramMessageId: 903,
        reconciledBy: 1,
      });
      const duplicate = db.reconcileUnknownDelivery({
        staffChatId: STAFF_CHAT_ID,
        caseToken: batch.caseToken,
        action: "CONFIRMED_DELIVERED",
        telegramMessageId: 903,
        reconciledBy: 1,
      });

      assert.equal(first.resultingState, "STAFF_SYNC_PENDING");
      assert.equal(first.batchContinuationRequired, true);
      assert.equal(first.batchAnswerPackageId, "batch-reconcile");
      assert.equal(duplicate.outcome, "IDEMPOTENT");
      const item = db.listTicketBatchAnswerItems("batch-reconcile")[0]!;
      assert.equal(item.state, "STAFF_SYNC_PENDING");
      assert.equal(item.delivery_message_id, 903);
      assert.equal(item.topic_echo_state, "PENDING");
      assert.equal(db.getTicket(ticketId)?.status, "WAITING_USER");
      assert.equal(db.getTicket(ticketId)?.follow_up_state, "WAITING_USER");
      assert.equal(db.listTicketFollowUpHistory(ticketId).length, 1);
      assert.equal(db.listMessagesChronological(ticketId).length, 1);
      assert.equal(db.listMessagesChronological(ticketId)[0]?.delivery_message_id, 903);
    } finally {
      db.close();
    }
  });

  it("does not reconcile a Batch item contrary to its terminal outbound delivery", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const ticketId = seedTicket(db);
      db.createTicketBatchExport({
        exportId: "export-terminal",
        staffChatId: STAFF_CHAT_ID,
        createdAt: "2026-09-19T00:00:00.000Z",
        selectionMode: "all_active",
        ticketCount: 1,
        items: [{ ticketId, snapshotToken: "sha256:terminal" }],
      });
      db.createTicketBatchAnswerPackage({
        answerPackageId: "batch-terminal",
        exportId: "export-terminal",
        staffChatId: STAFF_CHAT_ID,
        packageHash: "sha256:batch-terminal",
        sourceChatId: 1,
        sourceMessageId: 89,
        packageCreatedAt: "2026-09-19T00:00:00.000Z",
        items: [
          {
            ticket_id: ticketId,
            snapshot_token: "sha256:terminal",
            action: "reply_keep_open",
            reply_text: "Terminal Batch reply",
          },
        ],
      });
      const operationKey = `ticket-batch:batch-terminal:${ticketId}`;
      db.createTicketOutboundDeliveryIntent({
        operationKey,
        ticketId,
        direction: "STAFF_TO_USER",
        sourceChatId: 1,
        sourceMessageId: 89,
        deliveryChatId: 7001,
        senderType: "STAFF",
        senderDisplayName: "Support",
        text: "Terminal Batch reply",
      });
      db.markTicketOutboundDeliveryDelivered(operationKey, 904);
      db.updateTicketBatchAnswerItem("batch-terminal", ticketId, "UNKNOWN_DELIVERY", {
        lastError: "Batch state was not finalized.",
      });
      const batch = db.listUnknownDeliveryReconciliations(STAFF_CHAT_ID)[0]!;

      const contradiction = db.reconcileUnknownDelivery({
        staffChatId: STAFF_CHAT_ID,
        caseToken: batch.caseToken,
        action: "CONFIRMED_FAILED",
        reconciledBy: 1,
        note: "Contradicts durable delivery proof.",
      });
      const completion = db.reconcileUnknownDelivery({
        staffChatId: STAFF_CHAT_ID,
        caseToken: batch.caseToken,
        action: "CONFIRMED_DELIVERED",
        telegramMessageId: 904,
        reconciledBy: 1,
      });

      assert.equal(contradiction.outcome, "CONFLICT");
      assert.equal(completion.outcome, "APPLIED");
      assert.equal(db.listTicketBatchAnswerItems("batch-terminal")[0]?.state, "STAFF_SYNC_PENDING");
      assert.equal(db.listMessagesChronological(ticketId).length, 1);
      assert.equal(db.listDeliveryReconciliationAudit(STAFF_CHAT_ID).length, 1);
    } finally {
      db.close();
    }
  });

  it("accepts a confirmed Batch failure when the outbound record is already durably FAILED", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const { ticketId, operationKey, record } = seedUnknownBatch(db, "batch-authoritative-failure", {
        outboundState: "FAILED",
      });
      assert.ok(record);
      db.recordTicketBatchFailureEvent("batch-authoritative-failure", ticketId, "FAILED", null, {
        nextRetryAt: "2026-09-20T01:00:00.000Z",
      });
      db.recordTicketBatchTopicEcho("batch-authoritative-failure", ticketId, "FAILED", {
        lastError: "Stale staff sync diagnostic.",
        nextRetryAt: "2026-09-20T01:00:00.000Z",
      });

      const result = db.reconcileUnknownDelivery({
        staffChatId: STAFF_CHAT_ID,
        caseToken: record.caseToken,
        action: "CONFIRMED_FAILED",
        reconciledBy: 1,
        note: "Verified as not delivered.",
      });

      assert.equal(result.outcome, "APPLIED");
      assert.equal(result.batchContinuationRequired, true);
      assert.equal(db.getTicketOutboundDelivery(operationKey)?.state, "FAILED");
      const item = db.listTicketBatchAnswerItems("batch-authoritative-failure")[0]!;
      assert.equal(item.state, "FAILED");
      assert.equal(item.delivery_error_category, "OPERATOR_CONFIRMED_NOT_DELIVERED");
      assert.equal(item.delivery_error_permanence, "PERMANENT");
      assert.equal(item.delivery_error_method, null);
      assert.equal(item.delivery_failure_event_state, "NOT_REQUIRED");
      assert.equal(item.delivery_failure_event_message_id, null);
      assert.equal(item.delivery_failure_event_next_retry_at, null);
      assert.equal(item.topic_echo_state, "NOT_REQUIRED");
      assert.equal(item.topic_echo_last_error, null);
      assert.equal(item.topic_echo_next_retry_at, null);
      assert.equal(db.listDeliveryReconciliationAudit(STAFF_CHAT_ID).length, 1);
      assert.equal(db.listMessagesChronological(ticketId).length, 0);
    } finally {
      db.close();
    }
  });

  it("does not duplicate a legacy Batch transcript that already proves the supplied Telegram message id", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const { ticketId, record } = seedUnknownBatch(db, "batch-legacy-evidence", { outboundState: "NONE" });
      assert.ok(record);
      db.addMessage({
        ticketId,
        direction: "STAFF_TO_USER",
        sourceChatId: 1,
        sourceMessageId: 88,
        deliveryChatId: 7001,
        deliveryMessageId: 903,
        senderType: "STAFF",
        senderDisplayName: "Support",
        text: "Batch reply",
      });

      assert.equal(
        db.reconcileUnknownDelivery({
          staffChatId: STAFF_CHAT_ID,
          caseToken: record.caseToken,
          action: "CONFIRMED_DELIVERED",
          telegramMessageId: 903,
          reconciledBy: 1,
        }).outcome,
        "APPLIED"
      );
      const messages = db.listMessagesChronological(ticketId);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.delivery_message_id, 903);
    } finally {
      db.close();
    }
  });

  it("does not restore Batch follow-up context onto a ticket closed before reconciliation", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const { ticketId, record } = seedUnknownBatch(db, "batch-closed-ticket", {
        followUpState: "WAITING_USER",
        internalNote: "Do not restore after close.",
      });
      assert.ok(record);
      db.closeTicketRecord(ticketId, { type: "STAFF", displayName: "Agent" });

      assert.equal(
        db.reconcileUnknownDelivery({
          staffChatId: STAFF_CHAT_ID,
          caseToken: record.caseToken,
          action: "CONFIRMED_DELIVERED",
          telegramMessageId: 904,
          reconciledBy: 1,
        }).outcome,
        "APPLIED"
      );
      const ticket = db.getTicket(ticketId)!;
      assert.equal(ticket.status, "CLOSED");
      assert.equal(ticket.follow_up_state, "NONE");
      assert.equal(ticket.internal_note, null);
      assert.equal(db.listTicketFollowUpHistory(ticketId).length, 0);
    } finally {
      db.close();
    }
  });

  it("does not let a stale Batch reconciliation mutate a ticket moved to another workspace", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-delivery-workspace-"));
    const databasePath = path.join(directory, "support.db");
    const otherStaffChatId = STAFF_CHAT_ID - 1;
    try {
      const beforeMove = new SupportDatabase(`file:${databasePath}`);
      const { ticketId, record } = seedUnknownBatch(beforeMove, "batch-moved-workspace");
      assert.ok(record);
      beforeMove.close();

      const moved = new Database(databasePath);
      moved.prepare("UPDATE tickets SET staff_chat_id = ? WHERE id = ?").run(otherStaffChatId, ticketId);
      moved.close();

      const afterMove = new SupportDatabase(`file:${databasePath}`);
      try {
        const result = afterMove.reconcileUnknownDelivery({
          staffChatId: STAFF_CHAT_ID,
          caseToken: record.caseToken,
          action: "CONFIRMED_DELIVERED",
          telegramMessageId: 905,
          reconciledBy: 1,
        });
        assert.equal(result.outcome, "NOT_FOUND");
        assert.equal(afterMove.getTicket(ticketId)?.staff_chat_id, otherStaffChatId);
        assert.equal(afterMove.listTicketBatchAnswerItems("batch-moved-workspace")[0]?.state, "UNKNOWN_DELIVERY");
        assert.equal(afterMove.listMessagesChronological(ticketId).length, 0);
        assert.equal(afterMove.listDeliveryReconciliationAudit(STAFF_CHAT_ID).length, 0);
      } finally {
        afterMove.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not continue an idempotent Batch reconciliation after its ticket moves workspace", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-delivery-idempotent-workspace-"));
    const databasePath = path.join(directory, "support.db");
    try {
      const otherStaffChatId = STAFF_CHAT_ID - 1;
      const db = new SupportDatabase(`file:${databasePath}`);
      const { ticketId, record } = seedUnknownBatch(db, "batch-idempotent-moved-workspace");
      assert.ok(record);
      const first = db.reconcileUnknownDelivery({
        staffChatId: STAFF_CHAT_ID,
        caseToken: record.caseToken,
        action: "CONFIRMED_DELIVERED",
        telegramMessageId: 906,
        reconciledBy: 1,
      });
      assert.equal(first.outcome, "APPLIED");
      db.close();
      const moved = new Database(databasePath);
      moved.prepare("UPDATE tickets SET staff_chat_id = ? WHERE id = ?").run(otherStaffChatId, ticketId);
      moved.close();

      const reopened = new SupportDatabase(`file:${databasePath}`);
      try {
        const staleRetry = reopened.reconcileUnknownDelivery({
          staffChatId: STAFF_CHAT_ID,
          caseToken: record.caseToken,
          action: "CONFIRMED_DELIVERED",
          telegramMessageId: 906,
          reconciledBy: 1,
        });

        assert.equal(staleRetry.outcome, "NOT_FOUND");
        assert.equal(reopened.getTicket(ticketId)?.staff_chat_id, otherStaffChatId);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects missing, blank, and oversized confirmed-failure notes at the persistence boundary", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const { operationKey, record } = seedUnknownBatch(db, "batch-note-invariant");
      assert.ok(record);
      for (const note of [null, "   ", "x".repeat(501)]) {
        assert.equal(
          db.reconcileUnknownDelivery({
            staffChatId: STAFF_CHAT_ID,
            caseToken: record.caseToken,
            action: "CONFIRMED_FAILED",
            reconciledBy: 1,
            note,
          }).outcome,
          "CONFLICT"
        );
      }
      assert.equal(db.getTicketOutboundDelivery(operationKey)?.state, "UNKNOWN_DELIVERY");
      assert.equal(db.listDeliveryReconciliationAudit(STAFF_CHAT_ID).length, 0);
    } finally {
      db.close();
    }
  });
});
