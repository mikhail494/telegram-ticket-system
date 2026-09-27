import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SupportDatabase } from "../src/db.js";

const STAFF_CHAT_ID = -100901;

function createTicket(db: SupportDatabase, userId = 7001) {
  db.upsertUser({ telegramId: userId, username: `user_${userId}` });
  return db.createTicket(userId, STAFF_CHAT_ID);
}

describe("ticket status conditional transitions", () => {
  it("never reopens CLOSED through the ordinary status CAS API", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const ticket = createTicket(db);
      db.closeTicketRecordIfOpen(ticket.id, STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
      assert.equal(db.transitionTicketStatusIfCurrent(ticket.id, STAFF_CHAT_ID, "CLOSED", "OPEN").outcome, "CONFLICT");
      assert.equal(db.getTicket(ticket.id)?.status, "CLOSED");
    } finally {
      db.close();
    }
  });

  it("lets one matching transition win while a stale incompatible transition reports conflict", async () => {
    const db = new SupportDatabase(":memory:");
    try {
      const ticket = createTicket(db);
      const [first, stale] = await Promise.all([
        Promise.resolve().then(() =>
          db.transitionTicketStatusIfCurrent(ticket.id, STAFF_CHAT_ID, "OPEN", "WAITING_USER")
        ),
        Promise.resolve().then(() =>
          db.transitionTicketStatusIfCurrent(ticket.id, STAFF_CHAT_ID, "OPEN", "IN_PROGRESS")
        ),
      ]);

      assert.equal(first.outcome, "APPLIED");
      assert.equal(stale.outcome, "CONFLICT");
      assert.equal(db.getTicket(ticket.id)?.status, "WAITING_USER");
    } finally {
      db.close();
    }
  });

  it("makes repeated closes idempotent and prevents a stale workspace from mutating the ticket", async () => {
    const db = new SupportDatabase(":memory:");
    try {
      const ticket = createTicket(db);
      const close = () =>
        db.closeTicketRecordIfOpen(ticket.id, STAFF_CHAT_ID, {
          type: "STAFF",
          displayName: "Agent",
        });
      const [first, repeated] = await Promise.all([Promise.resolve().then(close), Promise.resolve().then(close)]);

      assert.equal(first.outcome, "APPLIED");
      assert.equal(repeated.outcome, "IDEMPOTENT");
      assert.equal(db.getTicket(ticket.id)?.status, "CLOSED");
      assert.equal(
        db.transitionTicketStatusIfCurrent(ticket.id, STAFF_CHAT_ID - 1, "CLOSED", "IN_PROGRESS").outcome,
        "NOT_FOUND"
      );
      assert.equal(db.getTicket(ticket.id)?.status, "CLOSED");
    } finally {
      db.close();
    }
  });

  it("applies Batch follow-up context once and rejects a stale workspace or status", async () => {
    const db = new SupportDatabase(":memory:");
    try {
      const ticket = createTicket(db);
      const apply = () =>
        db.applyTicketBatchFollowUpIfCurrent(ticket.id, STAFF_CHAT_ID, "OPEN", {
          followUpState: "WAITING_USER",
          internalNote: "Await the transaction hash.",
          escalationTarget: "SUPPORT",
          sourceAnswerPackageId: "answers_cas",
          nextStatus: "WAITING_USER",
        });
      const [first, repeated] = await Promise.all([Promise.resolve().then(apply), Promise.resolve().then(apply)]);

      assert.equal(first.outcome, "APPLIED");
      assert.equal(repeated.outcome, "IDEMPOTENT");
      assert.equal(db.getTicket(ticket.id)?.status, "WAITING_USER");
      assert.equal(db.listTicketFollowUpHistory(ticket.id).length, 1);
      assert.equal(
        db.applyTicketBatchFollowUpIfCurrent(ticket.id, STAFF_CHAT_ID - 1, "WAITING_USER", {
          followUpState: "NONE",
          internalNote: null,
          escalationTarget: "NONE",
          sourceAnswerPackageId: "answers_other_workspace",
          nextStatus: "IN_PROGRESS",
        }).outcome,
        "NOT_FOUND"
      );
      assert.equal(
        db.applyTicketBatchFollowUpIfCurrent(ticket.id, STAFF_CHAT_ID, "OPEN", {
          followUpState: "NONE",
          internalNote: null,
          escalationTarget: "NONE",
          sourceAnswerPackageId: "answers_stale",
          nextStatus: "IN_PROGRESS",
        }).outcome,
        "CONFLICT"
      );
    } finally {
      db.close();
    }
  });
});
