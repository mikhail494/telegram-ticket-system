import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SupportDatabase, type TicketInboundRoutingStage } from "../src/db.js";

const workspace = -100900;
const user = 123;
const stages = ["CREATE_TOPIC", "SEND_SUMMARY", "SEND_INITIAL_POST", "SEND_UPDATE", "COPY_ORIGINAL"] as const;

function prepareStage(db: SupportDatabase, stage: TicketInboundRoutingStage, sourceMessageId = 1) {
  db.upsertUser({ telegramId: user });
  if (stage === "SEND_UPDATE") {
    const ticket = db.createTicket(user, workspace);
    db.updateTicketForumTopic(ticket.id, workspace, 500);
  }
  const started = db.beginTicketInboundRouting({
    sourceChatId: user,
    sourceMessageId,
    staffChatId: workspace,
    userTelegramId: user,
    senderDisplayName: "Customer",
    text: "Full customer content",
    shouldCopyOriginal: stage === "COPY_ORIGINAL",
  });
  const claim = (expected: TicketInboundRoutingStage) =>
    assert.equal(db.claimTicketInboundRoutingOperation(user, sourceMessageId, workspace, expected)?.claimed, true);
  if (stage !== "CREATE_TOPIC" && stage !== "SEND_UPDATE") {
    claim("CREATE_TOPIC");
    assert.equal(db.markTicketInboundRoutingTopicCreated(user, sourceMessageId, workspace, 500), true);
    if (stage !== "SEND_SUMMARY") {
      claim("SEND_SUMMARY");
      assert.equal(db.markTicketInboundRoutingSummaryDelivered(user, sourceMessageId, workspace, 501), true);
      if (stage === "COPY_ORIGINAL") {
        claim("SEND_INITIAL_POST");
        assert.equal(db.markTicketInboundRoutingInitialPostDelivered(user, sourceMessageId, workspace, 502), true);
      }
    }
  }
  return { ticketId: started.ticket.id, claim: () => claim(stage) };
}

describe("inbound delivery review persistence", () => {
  it("cannot bind a reconciled topic to another ticket or partially commit conflicting proof", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const { ticketId, claim } = prepareStage(db, "CREATE_TOPIC");
      claim();
      db.markTicketInboundRoutingUnknown(user, 1, workspace, "Uncertain creation");
      db.upsertUser({ telegramId: user + 1 });
      const other = db.createTicket(user + 1, workspace);
      db.updateTicketForumTopic(other.id, workspace, 999);
      const record = db.listUnknownDeliveryReconciliations(workspace)[0]!;
      assert.equal(
        db.reconcileUnknownDelivery({
          staffChatId: workspace,
          caseToken: record.caseToken,
          action: "CONFIRMED_DELIVERED",
          telegramMessageId: 999,
          reconciledBy: 1,
        }).outcome,
        "CONFLICT"
      );
      assert.equal(db.getTicket(ticketId)?.message_thread_id, null);
      assert.equal(db.getTicketInboundRoutingOperation(user, 1)?.state, "UNKNOWN_DELIVERY");
      assert.equal(db.listDeliveryReconciliationAudit(workspace).length, 0);
    } finally {
      db.close();
    }
  });

  it("a closed ticket can terminate a copy only after external non-delivery proof", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const { ticketId, claim } = prepareStage(db, "COPY_ORIGINAL");
      claim();
      db.markTicketInboundRoutingUnknown(user, 1, workspace, "Uncertain copy");
      db.closeTicketRecordIfOpen(ticketId, workspace, { type: "STAFF", displayName: "Agent" });
      assert.equal(db.hasUnresolvedTicketInboundRoutingOperations(ticketId), true);
      const record = db.listUnknownDeliveryReconciliations(workspace)[0]!;
      const result = db.reconcileUnknownDelivery({
        staffChatId: workspace,
        caseToken: record.caseToken,
        action: "CONFIRMED_FAILED",
        reconciledBy: 1,
        note: "Original copy confirmed absent; ticket now closed",
      });
      assert.equal(result.resultingState, "CANCELLED");
      assert.equal(result.archiveContinuationRequired, true);
      assert.equal(db.hasUnresolvedTicketInboundRoutingOperations(ticketId), false);
      assert.equal(db.listMessagesChronological(ticketId)[0]?.text, "Full customer content");
      assert.equal(db.requestInboundRoutingRetry(workspace, record.caseToken, 1).outcome, "NOT_FOUND");
    } finally {
      db.close();
    }
  });

  for (const stage of stages) {
    it(`${stage}: first proof wins, identical proof is idempotent, contradiction conflicts`, async () => {
      const db = new SupportDatabase(":memory:");
      try {
        const { ticketId, claim } = prepareStage(db, stage);
        claim();
        db.markTicketInboundRoutingUnknown(user, 1, workspace, "Uncertain transport.");
        const record = db.listUnknownDeliveryReconciliations(workspace)[0]!;
        assert.equal(record.kind, "INBOUND_ROUTING");
        assert.equal(record.inboundStage, stage);
        const input = {
          staffChatId: workspace,
          caseToken: record.caseToken,
          action: "CONFIRMED_DELIVERED" as const,
          telegramMessageId: 777,
          reconciledBy: 1,
        };
        const results = await Promise.all([
          Promise.resolve().then(() => db.reconcileUnknownDelivery(input)),
          Promise.resolve().then(() => db.reconcileUnknownDelivery(input)),
        ]);
        assert.deepEqual(
          results.map((r) => r.outcome),
          ["APPLIED", "IDEMPOTENT"]
        );
        assert.equal(results[0]!.staffChatId, workspace);
        assert.equal(
          db.reconcileUnknownDelivery({ ...input, action: "CONFIRMED_FAILED", note: "Contradictory proof" }).outcome,
          "CONFLICT"
        );
        assert.equal(db.reconcileUnknownDelivery({ ...input, telegramMessageId: 778 }).outcome, "CONFLICT");
        assert.equal(db.listDeliveryReconciliationAudit(workspace).length, 1);
        assert.equal(db.listDeliveryReconciliationAudit(workspace)[0]!.delivery_key, record.operationIdentity);
        if (stage === "SEND_INITIAL_POST" || stage === "SEND_UPDATE") {
          assert.equal(db.listMessagesChronological(ticketId).length, 1);
          assert.equal(db.listMessagesChronological(ticketId)[0]!.delivery_message_id, 777);
        }
        if (stage === "COPY_ORIGINAL")
          assert.equal(db.getTicketInboundRoutingOperation(user, 1)?.copied_message_id, 777);
      } finally {
        db.close();
      }
    });

    it(`${stage}: confirmed non-delivery requires a separately audited new attempt`, () => {
      const db = new SupportDatabase(":memory:");
      try {
        const { claim } = prepareStage(db, stage);
        claim();
        db.markTicketInboundRoutingUnknown(user, 1, workspace, "Uncertain transport.");
        const record = db.listUnknownDeliveryReconciliations(workspace)[0]!;
        const failed = {
          staffChatId: workspace,
          caseToken: record.caseToken,
          action: "CONFIRMED_FAILED" as const,
          reconciledBy: 2,
          note: "Verified absent in Telegram",
        };
        assert.equal(db.reconcileUnknownDelivery(failed).outcome, "APPLIED");
        assert.equal(db.getTicketInboundRoutingOperation(user, 1)?.state, "RETRY_REQUIRED");
        assert.equal(db.claimTicketInboundRoutingOperation(user, 1, workspace, stage)?.claimed, false);
        assert.equal(db.getTicketInboundRoutingOperation(user, 1)?.attempt, 1);
        assert.equal(db.requestInboundRoutingRetry(workspace, record.caseToken, 2).outcome, "APPLIED");
        assert.equal(db.getTicketInboundRoutingOperation(user, 1)?.attempt, 2);
        assert.equal(db.getTicketInboundRoutingOperation(user, 1)?.state, "READY");
        assert.notEqual(db.listUnknownDeliveryReconciliations(workspace)[0]!.caseToken, record.caseToken);
        assert.equal(db.reconcileUnknownDelivery(failed).outcome, "IDEMPOTENT");
        assert.equal(db.requestInboundRoutingRetry(workspace, record.caseToken, 2).outcome, "NOT_FOUND");
        assert.equal(db.listDeliveryReconciliationAudit(workspace).length, 2);
        claim();
        db.markTicketInboundRoutingUnknown(user, 1, workspace, "New attempt uncertain.");
        const second = db.listUnknownDeliveryReconciliations(workspace)[0]!;
        assert.equal(db.reconcileUnknownDelivery({ ...failed, caseToken: second.caseToken }).outcome, "APPLIED");
        assert.equal(db.listDeliveryReconciliationAudit(workspace).length, 3);
      } finally {
        db.close();
      }
    });
  }

  it("rejects reconciliation and new attempts after the ticket moves workspace", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const { ticketId, claim } = prepareStage(db, "SEND_UPDATE");
      claim();
      db.markTicketInboundRoutingUnknown(user, 1, workspace, "Uncertain transport.");
      const record = db.listUnknownDeliveryReconciliations(workspace)[0]!;
      db.updateTicketForumTopic(ticketId, workspace - 1, 900);
      for (const staffChatId of [workspace, workspace - 1]) {
        assert.equal(
          db.reconcileUnknownDelivery({
            staffChatId,
            caseToken: record.caseToken,
            action: "CONFIRMED_DELIVERED",
            telegramMessageId: 777,
            reconciledBy: 1,
          }).outcome,
          "NOT_FOUND"
        );
        assert.equal(db.requestInboundRoutingRetry(staffChatId, record.caseToken, 1).outcome, "NOT_FOUND");
      }
      assert.equal(db.getTicketInboundRoutingOperation(user, 1)?.state, "UNKNOWN_DELIVERY");
      assert.equal(db.listDeliveryReconciliationAudit(workspace).length, 0);
    } finally {
      db.close();
    }
  });

  it("requires real proof and keeps inbound audit append-only after file-backed reopen", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "inbound-review-audit-"));
    const filename = path.join(directory, "support.db");
    try {
      const db = new SupportDatabase(`file:${filename}`);
      try {
        const { claim } = prepareStage(db, "SEND_UPDATE");
        claim();
      } finally {
        db.close();
      }
      const reopened = new SupportDatabase(`file:${filename}`);
      try {
        assert.equal(reopened.markPendingTicketInboundRoutingOperationsUnknown(), 1);
        const record = reopened.listUnknownDeliveryReconciliations(workspace)[0]!;
        const input = {
          staffChatId: workspace,
          caseToken: record.caseToken,
          action: "CONFIRMED_FAILED" as const,
          reconciledBy: 1,
        };
        for (const note of [null, " ", "x".repeat(501)])
          assert.equal(reopened.reconcileUnknownDelivery({ ...input, note }).outcome, "CONFLICT");
        assert.equal(
          reopened.reconcileUnknownDelivery({ ...input, action: "CONFIRMED_DELIVERED", telegramMessageId: 0 }).outcome,
          "CONFLICT"
        );
        assert.equal(reopened.reconcileUnknownDelivery({ ...input, note: "Confirmed absent" }).outcome, "APPLIED");
      } finally {
        reopened.close();
      }
      const inspect = new Database(filename);
      try {
        assert.throws(
          () => inspect.exec("UPDATE ticket_inbound_reconciliation_audit SET note = 'changed'"),
          /append-only/
        );
        assert.throws(() => inspect.exec("DELETE FROM ticket_inbound_reconciliation_audit"), /append-only/);
        assert.equal(inspect.pragma("integrity_check", { simple: true }), "ok");
        assert.deepEqual(inspect.pragma("foreign_key_check"), []);
      } finally {
        inspect.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
