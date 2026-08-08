import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { SupportDatabase, TicketWithUser } from "../src/db.js";
import { TEST_STAFF_CHAT_ID, createBotHarness, type BotHarness } from "./helpers/botHarness.js";

const harnesses: BotHarness[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function harness(options: Parameters<typeof createBotHarness>[0] = {}): BotHarness {
  const created = createBotHarness(options);
  harnesses.push(created);
  return created;
}

function createReplyAndClosePackage(
  db: SupportDatabase,
  answerPackageId: string,
  tickets: readonly TicketWithUser[]
): void {
  const exportId = `export_${answerPackageId}`;
  const createdAt = "2026-08-07T00:00:00.000Z";
  db.createTicketBatchExport({
    exportId,
    staffChatId: TEST_STAFF_CHAT_ID,
    createdAt,
    selectionMode: "all_active",
    ticketCount: tickets.length,
    items: tickets.map((ticket) => ({ ticketId: ticket.id, snapshotToken: `snapshot_${ticket.id}` }))
  });
  db.createTicketBatchAnswerPackage({
    answerPackageId,
    exportId,
    staffChatId: TEST_STAFF_CHAT_ID,
    packageHash: `hash_${answerPackageId}`,
    packageCreatedAt: createdAt,
    items: tickets.map((ticket) => ({
      ticket_id: ticket.id,
      snapshot_token: `snapshot_${ticket.id}`,
      action: "reply_and_close" as const,
      reply_text: `Synthetic reply ${ticket.id}`
    }))
  });
}

function recordConfirmedReply(db: SupportDatabase, answerPackageId: string, ticket: TicketWithUser, messageId: number): void {
  db.addMessage({
    ticketId: ticket.id,
    direction: "STAFF_TO_USER",
    deliveryChatId: ticket.user_telegram_id,
    deliveryMessageId: messageId,
    senderType: "STAFF",
    senderDisplayName: "Synthetic Staff",
    text: `Synthetic reply ${ticket.id}`
  });
  db.updateTicketBatchAnswerItem(answerPackageId, ticket.id, "STAFF_SYNC_PENDING", {
    deliveryMessageId: messageId,
    applied: true
  });
}

describe("reply_and_close post-delivery recovery", () => {
  it("resumes after a process restart without resending the confirmed reply", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-reply-close-recovery-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "support.db");
    const first = harness({ databasePath });
    const ticket = first.seedTicket({ user: { id: 4101 }, messageThreadId: 74101 });
    createReplyAndClosePackage(first.db, "restart_recovery", [ticket]);
    recordConfirmedReply(first.db, "restart_recovery", ticket, 8801);
    first.db.recordTicketBatchTopicEcho("restart_recovery", ticket.id, "FAILED");
    first.db.finalizeTicketBatchAnswerPackage("restart_recovery", TEST_STAFF_CHAT_ID);
    first.cleanup();
    harnesses.splice(harnesses.indexOf(first), 1);

    const restarted = harness({ databasePath });
    await restarted.bot.recoverPendingTicketBatchStaffOperations();

    assert.equal(restarted.findApiCalls("sendMessage").some((call) =>
      call.payload.chat_id === ticket.user_telegram_id && call.payload.text === `Synthetic reply ${ticket.id}`
    ), false);
    assert.equal(restarted.findApiCalls("sendMessage").filter((call) =>
      call.payload.chat_id === TEST_STAFF_CHAT_ID
        && call.payload.message_thread_id === ticket.message_thread_id
        && String(call.payload.text).includes("Batch reply sent to user")
    ).length, 1);
    assert.equal(restarted.db.getTicket(ticket.id)?.status, "CLOSED");
    assert.ok(restarted.db.getTicket(ticket.id)?.archived_at);
    assert.equal(restarted.db.listTicketBatchAnswerItems("restart_recovery")[0]?.state, "COMPLETED");
    assert.equal(restarted.db.getTicketBatchAnswerPackage("restart_recovery", TEST_STAFF_CHAT_ID)?.status, "COMPLETED");
    assert.equal(restarted.countApiCalls("sendDocument"), 1);
    assert.equal(restarted.countApiCalls("deleteForumTopic"), 1);

    restarted.clearApiCalls();
    await restarted.bot.recoverPendingTicketBatchStaffOperations();
    assert.equal(restarted.countApiCalls("sendDocument"), 0);
    assert.equal(restarted.countApiCalls("deleteForumTopic"), 0);
    assert.equal(restarted.findApiCalls("sendMessage").some((call) =>
      call.payload.chat_id === ticket.user_telegram_id && call.payload.text === `Synthetic reply ${ticket.id}`
    ), false);
  });

  it("normalizes sixteen already closed and archived items without duplicate Telegram work", async () => {
    const current = harness();
    const tickets = Array.from({ length: 16 }, (_, index) => current.seedTicket({
      user: { id: 4200 + index },
      messageThreadId: 74200 + index
    }));
    createReplyAndClosePackage(current.db, "sixteen_reconciliation", tickets);

    for (const [index, ticket] of tickets.entries()) {
      recordConfirmedReply(current.db, "sixteen_reconciliation", ticket, 8900 + index);
      current.db.recordTicketBatchTopicEcho("sixteen_reconciliation", ticket.id, "SENT", {
        chatId: TEST_STAFF_CHAT_ID,
        threadId: ticket.message_thread_id,
        messageId: 9900 + index
      });
      current.db.closeTicketRecord(ticket.id, {
        type: "STAFF",
        displayName: "Synthetic Staff",
        username: "synthetic_staff"
      });
      current.db.markTicketArchivedAndDeleteMessages(ticket.id, 10_000 + index, 11_000 + index);
    }
    current.db.finalizeTicketBatchAnswerPackage("sixteen_reconciliation", TEST_STAFF_CHAT_ID);
    current.clearApiCalls();

    await current.bot.recoverPendingTicketBatchStaffOperations();

    assert.equal(current.db.listTicketBatchAnswerItems("sixteen_reconciliation").every((item) => item.state === "COMPLETED"), true);
    assert.equal(current.db.getTicketBatchAnswerPackage("sixteen_reconciliation", TEST_STAFF_CHAT_ID)?.status, "COMPLETED");
    assert.equal(current.countApiCalls("sendMessage"), 0);
    assert.equal(current.countApiCalls("sendDocument"), 0);
    assert.equal(current.countApiCalls("deleteForumTopic"), 0);
    assert.equal(current.countApiCalls("closeForumTopic"), 0);
  });

  it("resumes only archive work when SQLite closure already completed", async () => {
    const current = harness();
    const ticket = current.seedTicket({ user: { id: 4251 }, messageThreadId: 74251 });
    createReplyAndClosePackage(current.db, "closed_archive_pending", [ticket]);
    recordConfirmedReply(current.db, "closed_archive_pending", ticket, 8921);
    current.db.recordTicketBatchTopicEcho("closed_archive_pending", ticket.id, "SENT", {
      chatId: TEST_STAFF_CHAT_ID,
      threadId: ticket.message_thread_id,
      messageId: 9921
    });
    current.db.closeTicketRecord(ticket.id, {
      type: "STAFF",
      displayName: "Synthetic Staff",
      username: "synthetic_staff"
    });
    current.db.finalizeTicketBatchAnswerPackage("closed_archive_pending", TEST_STAFF_CHAT_ID);
    current.clearApiCalls();

    await current.bot.recoverPendingTicketBatchStaffOperations();

    assert.equal(current.findApiCalls("sendMessage").some((call) => call.payload.chat_id === ticket.user_telegram_id), false);
    assert.equal(current.findApiCalls("sendMessage").some((call) =>
      call.payload.message_thread_id === ticket.message_thread_id
        && String(call.payload.text).includes("Batch reply sent to user")
    ), false);
    assert.equal(current.countApiCalls("sendDocument"), 1);
    assert.equal(current.countApiCalls("deleteForumTopic"), 1);
    assert.ok(current.db.getTicket(ticket.id)?.archived_at);
    assert.equal(current.db.listTicketBatchAnswerItems("closed_archive_pending")[0]?.state, "COMPLETED");
  });

  it("reports user delivery separately from unresolved close and archive stages", async () => {
    const current = harness();
    const ticket = current.seedTicket({ user: { id: 4301 }, messageThreadId: 74301 });
    createReplyAndClosePackage(current.db, "summary_stages", [ticket]);
    recordConfirmedReply(current.db, "summary_stages", ticket, 8951);
    current.db.recordTicketBatchTopicEcho("summary_stages", ticket.id, "TERMINAL_FAILED", {
      lastError: "TELEGRAM_BAD_REQUEST"
    });
    current.db.claimTicketBatchAnswerPackage("summary_stages", TEST_STAFF_CHAT_ID);
    current.db.finalizeTicketBatchAnswerPackage("summary_stages", TEST_STAFF_CHAT_ID);
    current.db.queueTicketBatchFinalSummary("summary_stages", TEST_STAFF_CHAT_ID, {
      text: "stale summary",
      chatId: TEST_STAFF_CHAT_ID
    });

    await current.bot.recoverPendingTicketBatchStaffOperations();

    const summary = current.findApiCalls("sendMessage").find((call) =>
      call.payload.chat_id === TEST_STAFF_CHAT_ID
        && call.payload.message_thread_id === undefined
        && String(call.payload.text).includes("Delivered replies: 1")
    );
    assert.ok(summary);
    assert.match(String(summary.payload.text), /Staff echoes terminal failures: 1/);
    assert.match(String(summary.payload.text), /Tickets closed: 0/);
    assert.match(String(summary.payload.text), /Ticket closures pending\/failed: 1/);
    assert.match(String(summary.payload.text), /Archives completed: 0/);
    assert.match(String(summary.payload.text), /Archives pending\/failed: 1/);
    assert.match(String(summary.payload.text), /Topic closures unconfirmed: 0/);
    assert.equal(current.db.getTicketBatchAnswerPackage("summary_stages", TEST_STAFF_CHAT_ID)?.status, "PARTIAL");
  });

  it("serializes concurrent recovery passes for an already closed ticket", async () => {
    const current = harness();
    const ticket = current.seedTicket({ user: { id: 4351 }, messageThreadId: 74351 });
    createReplyAndClosePackage(current.db, "concurrent_recovery", [ticket]);
    recordConfirmedReply(current.db, "concurrent_recovery", ticket, 8961);
    current.db.recordTicketBatchTopicEcho("concurrent_recovery", ticket.id, "SENT", {
      chatId: TEST_STAFF_CHAT_ID,
      threadId: ticket.message_thread_id,
      messageId: 9961
    });
    current.db.closeTicketRecord(ticket.id, {
      type: "STAFF",
      displayName: "Synthetic Staff",
      username: "synthetic_staff"
    });
    current.db.finalizeTicketBatchAnswerPackage("concurrent_recovery", TEST_STAFF_CHAT_ID);
    current.clearApiCalls();

    await Promise.all([
      current.bot.recoverPendingTicketBatchStaffOperations(),
      current.bot.recoverPendingTicketBatchStaffOperations()
    ]);

    assert.equal(current.countApiCalls("sendDocument"), 1);
    assert.equal(current.countApiCalls("deleteForumTopic"), 1);
    assert.equal(current.findApiCalls("sendMessage").some((call) => call.payload.chat_id === ticket.user_telegram_id), false);
    assert.equal(current.db.listTicketBatchAnswerItems("concurrent_recovery")[0]?.state, "COMPLETED");
  });

  it("normalizes a pending echo after independent closure and resumes archive only", async () => {
    const current = harness();
    const ticket = current.seedTicket({ user: { id: 4401 }, messageThreadId: 74401 });
    createReplyAndClosePackage(current.db, "closed_pending_echo", [ticket]);
    recordConfirmedReply(current.db, "closed_pending_echo", ticket, 8971);
    current.db.recordTicketBatchTopicEcho("closed_pending_echo", ticket.id, "FAILED", {
      nextRetryAt: "2020-01-01T00:00:00.000Z"
    });
    current.db.closeTicketRecord(ticket.id, {
      type: "STAFF",
      displayName: "Synthetic Staff",
      username: "synthetic_staff"
    });
    current.db.finalizeTicketBatchAnswerPackage("closed_pending_echo", TEST_STAFF_CHAT_ID);
    current.clearApiCalls();

    await current.bot.recoverPendingTicketBatchStaffOperations();

    const item = current.db.listTicketBatchAnswerItems("closed_pending_echo")[0];
    assert.equal(item?.topic_echo_state, "NOT_REQUIRED");
    assert.equal(item?.state, "COMPLETED");
    assert.equal(current.countApiCalls("sendDocument"), 1);
    assert.equal(current.findApiCalls("sendMessage").some((call) =>
      call.payload.message_thread_id === ticket.message_thread_id
        && String(call.payload.text).includes("Batch reply sent to user")
    ), false);
    assert.equal(current.findApiCalls("sendMessage").some((call) => call.payload.chat_id === ticket.user_telegram_id), false);
  });

  it("persists archive retry_after and does not retry continuation before it is due", async () => {
    const current = harness();
    const ticket = current.seedTicket({ user: { id: 4451 }, messageThreadId: 74451 });
    createReplyAndClosePackage(current.db, "archive_retry_after", [ticket]);
    recordConfirmedReply(current.db, "archive_retry_after", ticket, 8981);
    current.db.recordTicketBatchTopicEcho("archive_retry_after", ticket.id, "SENT", {
      chatId: TEST_STAFF_CHAT_ID,
      threadId: ticket.message_thread_id,
      messageId: 9981
    });
    current.db.finalizeTicketBatchAnswerPackage("archive_retry_after", TEST_STAFF_CHAT_ID);
    current.setApiResponseOverride("sendDocument", () => ({
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters: { retry_after: 120 }
    }));

    await current.bot.recoverPendingTicketBatchStaffOperations();

    const pending = current.db.listTicketBatchAnswerItems("archive_retry_after")[0];
    assert.equal(current.db.getTicket(ticket.id)?.status, "CLOSED");
    assert.equal(current.db.getTicket(ticket.id)?.archived_at, null);
    assert.ok(pending?.topic_echo_next_retry_at);
    assert.ok(new Date(pending.topic_echo_next_retry_at).getTime() >= Date.now() + 119_000);

    current.clearApiOverrides();
    current.clearApiCalls();
    await current.bot.recoverPendingTicketBatchStaffOperations();
    assert.equal(current.countApiCalls("sendDocument"), 0);
    assert.equal(current.db.getTicket(ticket.id)?.archived_at, null);

    current.db.recordTicketBatchTopicEcho("archive_retry_after", ticket.id, "SENT", {
      nextRetryAt: "2020-01-01T00:00:00.000Z"
    });
    await current.bot.recoverPendingTicketBatchStaffOperations();
    assert.equal(current.countApiCalls("sendDocument"), 1);
    assert.ok(current.db.getTicket(ticket.id)?.archived_at);
    assert.equal(current.findApiCalls("sendMessage").some((call) => call.payload.chat_id === ticket.user_telegram_id), false);
  });
});
