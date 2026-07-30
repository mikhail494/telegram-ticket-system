import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Update } from "grammy/types";
import { getTicketSnapshotToken } from "../src/ticketBatch.js";
import {
  TEST_STAFF_CHAT_ID,
  buildStaffDocumentUpdate,
  createBotHarness,
  type BotHarness,
  type RecordedApiCall
} from "./helpers/botHarness.js";

const harnesses: BotHarness[] = [];

afterEach(() => {
  for (const harness of harnesses) harness.cleanup();
  harnesses.length = 0;
});

function createHarness(): BotHarness {
  const harness = createBotHarness();
  harnesses.push(harness);
  return harness;
}

function exportCommand(messageThreadId?: number): Update {
  return {
    update_id: 1,
    message: {
      message_id: 7001,
      date: 1,
      from: { id: 42, is_bot: false, first_name: "Test Staff", username: "test_staff" },
      chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Test Staff Chat" },
      ...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }),
      text: "/exporttickets",
      entities: [{ offset: 0, length: 14, type: "bot_command" }]
    }
  };
}

function answerPackage(
  exportId: string,
  ticketId: number,
  token: string,
  action: "reply_keep_open" | "reply_and_close" | "no_action" = "reply_keep_open"
): string {
  return JSON.stringify({
    schema: "telegram_ticket_answer_package",
    version: 1,
    export_id: exportId,
    answer_package_id: "answers_1",
    created_at: "2026-07-30T00:00:00.000Z",
    answers: [{ ticket_id: ticketId, snapshot_token: token, action, reply_text: action === "no_action" ? null : "A valid reply" }]
  });
}

function multiAnswerPackage(
  exportId: string,
  answers: Array<{ ticketId: number; token: string; action: "reply_keep_open" | "reply_and_close" | "no_action"; text?: string }>
): string {
  return JSON.stringify({
    schema: "telegram_ticket_answer_package",
    version: 1,
    export_id: exportId,
    answer_package_id: "answers_1",
    created_at: "2026-07-30T00:00:00.000Z",
    answers: answers.map((answer) => ({
      ticket_id: answer.ticketId,
      snapshot_token: answer.token,
      action: answer.action,
      reply_text: answer.action === "no_action" ? null : answer.text ?? `Reply for ${answer.ticketId}`
    }))
  });
}

function callbackData(call: RecordedApiCall, index = 0): string {
  const markup = call.payload.reply_markup;
  if (!markup || typeof markup !== "object" || !("inline_keyboard" in markup)) throw new Error("Expected inline keyboard");
  const rows = markup.inline_keyboard;
  if (!Array.isArray(rows)) throw new Error("Expected keyboard rows");
  const buttons = rows.flat().filter((button): button is { callback_data: string } =>
    typeof button === "object" && button !== null && "callback_data" in button && typeof button.callback_data === "string"
  );
  const data = buttons[index]?.callback_data;
  if (typeof data !== "string") throw new Error("Expected callback data string");
  return data;
}

function batchCallback(data: string, updateId: number): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `batch-callback-${updateId}`,
      from: { id: 42, is_bot: false, first_name: "Test Staff", username: "test_staff" },
      chat_instance: "test-chat-instance",
      data,
      message: {
        message_id: 8000 + updateId,
        date: 1,
        chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Test Staff Chat" },
        text: "Ticket answer package preview"
      }
    }
  };
}

describe("ticket batch Telegram workflow", () => {
  it("exports active tickets, maps attachments in the staff chat, and skips closed tickets", async () => {
    const harness = createHarness();
    const active = harness.seedTicket({ messageThreadId: 5000 });
    const closed = harness.seedTicket({ user: { id: 124 }, messageThreadId: 5001, status: "CLOSED" });
    harness.db.addMessage({
      ticketId: active.id,
      direction: "USER_TO_STAFF",
      sourceChatId: active.user_telegram_id,
      sourceMessageId: 99,
      mediaType: "photo",
      fileId: "photo",
      text: "evidence"
    });

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("copyMessage"), 1);
    assert.equal(harness.findApiCalls("copyMessage")[0]?.payload.chat_id, TEST_STAFF_CHAT_ID);
    assert.equal(harness.countApiCalls("sendDocument"), 1);
    assert.equal(harness.findApiCalls("sendDocument")[0]?.payload.chat_id, TEST_STAFF_CHAT_ID);
    assert.equal(harness.db.listActiveTicketsForStaffChat(TEST_STAFF_CHAT_ID).some((ticket) => ticket.id === closed.id), false);
  });

  it("continues export when attachment copying fails", async () => {
    const harness = createHarness();
    const active = harness.seedTicket();
    harness.db.addMessage({ ticketId: active.id, direction: "USER_TO_STAFF", sourceChatId: active.user_telegram_id, sourceMessageId: 99, mediaType: "document" });
    harness.failNextApiCall("copyMessage", "Forbidden", 403);

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("copyMessage"), 1);
    assert.equal(harness.countApiCalls("sendDocument"), 1);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("failed")), true);
  });

  it("rejects export commands inside ticket topics", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    await harness.bot.handleUpdate(exportCommand(ticket.message_thread_id ?? 0));
    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("outside ticket topics")), true);
  });

  it("persists and applies a valid answer package through the existing staff text delivery path", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({ exportId: "export_test", staffChatId: TEST_STAFF_CHAT_ID, createdAt: "2026-07-30T00:00:00.000Z", selectionMode: "all_active", ticketCount: 1, items: [{ ticketId: ticket.id, snapshotToken: token }] });
    harness.setDownloadResponse(answerPackage("export_test", ticket.id, token));

    await harness.bot.handleUpdate(buildStaffDocumentUpdate());

    const preview = harness.findApiCalls("sendMessage").find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    assert.match(String(preview.payload.text), /#1 - reply, keep open/);
    const cancel = callbackData(preview);
    assert.ok(Buffer.byteLength(cancel, "utf8") <= 64);
    assert.equal(harness.db.getTicket(ticket.id)?.status, "OPEN");
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);

    await harness.bot.handleUpdate(batchCallback(cancel, 2));
    assert.equal(harness.countApiCalls("answerCallbackQuery"), 1);
    assert.equal(harness.findApiCalls("editMessageReplyMarkup").length, 1);
    assert.equal(
      harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
      1
    );
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
    assert.equal(harness.db.getTicket(ticket.id)?.status, "IN_PROGRESS");
  });

  it("rejects malformed packages and answer packages inside ticket topics without forwarding them", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.setDownloadResponse("{");
    await harness.bot.handleUpdate(buildStaffDocumentUpdate());
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
    assert.equal(harness.countApiCalls("copyMessage"), 0);

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ messageThreadId: ticket.message_thread_id ?? 0 }));
    assert.equal(harness.countApiCalls("copyMessage"), 0);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("outside ticket topics")), true);
  });

  it("cancels a pending package without deleting its items or sending a user reply", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({ exportId: "export_cancel", staffChatId: TEST_STAFF_CHAT_ID, createdAt: "2026-07-30T00:00:00.000Z", selectionMode: "all_active", ticketCount: 1, items: [{ ticketId: ticket.id, snapshotToken: token }] });
    harness.setDownloadResponse(answerPackage("export_cancel", ticket.id, token));

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_cancel.json" }));
    const preview = harness.findApiCalls("sendMessage").find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    const cancel = callbackData(preview, 1);
    await harness.bot.handleUpdate(batchCallback(cancel, 3));

    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "CANCELLED");
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1").length, 1);
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length, 0);
    assert.equal(harness.db.claimTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "CANCELLED");
  });

  it("retries only close and archive after a reply_and_close archive failure", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({ exportId: "export_close", staffChatId: TEST_STAFF_CHAT_ID, createdAt: "2026-07-30T00:00:00.000Z", selectionMode: "all_active", ticketCount: 1, items: [{ ticketId: ticket.id, snapshotToken: token }] });
    harness.setDownloadResponse(answerPackage("export_close", ticket.id, token, "reply_and_close"));
    harness.failNextApiCall("sendDocument", "Archive unavailable", 500);

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_close.json" }));
    const firstPreview = harness.findApiCalls("sendMessage").find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(firstPreview);
    await harness.bot.handleUpdate(batchCallback(callbackData(firstPreview), 4));

    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply").length, 1);
    assert.equal(harness.db.listMessagesChronological(ticket.id).filter((message) => message.direction === "STAFF_TO_USER").length, 1);
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "REPLY_SENT");
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "PARTIAL");

    harness.clearApiCalls();
    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ messageId: 7002, fileName: "ticket-answers_export_close.json" }));
    const secondPreview = harness.findApiCalls("sendMessage").find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(secondPreview);
    await harness.bot.handleUpdate(batchCallback(callbackData(secondPreview), 5));

    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply").length, 0);
    assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "COMPLETED");
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "COMPLETED");
  });

  it("marks interrupted APPLYING items as UNKNOWN_DELIVERY without resending", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({ exportId: "export_unknown", staffChatId: TEST_STAFF_CHAT_ID, createdAt: "2026-07-30T00:00:00.000Z", selectionMode: "all_active", ticketCount: 1, items: [{ ticketId: ticket.id, snapshotToken: token }] });
    harness.setDownloadResponse(answerPackage("export_unknown", ticket.id, token));

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_unknown.json" }));
    harness.db.claimTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID);
    harness.db.claimTicketBatchAnswerItem("answers_1", ticket.id);
    harness.db.finalizeTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID);
    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ messageId: 7003, fileName: "ticket-answers_export_unknown.json" }));
    const preview = harness.findApiCalls("sendMessage").filter((call) => String(call.payload.text).includes("Ticket answer package preview")).at(-1);
    assert.ok(preview);
    await harness.bot.handleUpdate(batchCallback(callbackData(preview), 6));

    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "UNKNOWN_DELIVERY");
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length, 0);
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "PARTIAL");
  });

  it("isolates stale and no_action items while applying later valid replies", async () => {
    const harness = createHarness();
    const stale = harness.seedTicket({ user: { id: 201 }, messageThreadId: 5201 });
    const valid = harness.seedTicket({ user: { id: 202 }, messageThreadId: 5202 });
    const noAction = harness.seedTicket({ user: { id: 203 }, messageThreadId: 5203 });
    const staleToken = getTicketSnapshotToken(stale, []);
    const validToken = getTicketSnapshotToken(valid, []);
    const noActionToken = getTicketSnapshotToken(noAction, []);
    harness.db.createTicketBatchExport({
      exportId: "export_isolation",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 3,
      items: [
        { ticketId: stale.id, snapshotToken: staleToken },
        { ticketId: valid.id, snapshotToken: validToken },
        { ticketId: noAction.id, snapshotToken: noActionToken }
      ]
    });
    harness.db.addMessage({ ticketId: stale.id, direction: "USER_TO_STAFF", text: "new evidence" });
    harness.setDownloadResponse(multiAnswerPackage("export_isolation", [
      { ticketId: stale.id, token: staleToken, action: "reply_keep_open" },
      { ticketId: valid.id, token: validToken, action: "reply_keep_open", text: "Valid reply" },
      { ticketId: noAction.id, token: noActionToken, action: "no_action" }
    ]));

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_isolation.json" }));
    const preview = harness.findApiCalls("sendMessage").find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    await harness.bot.handleUpdate(batchCallback(callbackData(preview), 7));

    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === valid.user_telegram_id && call.payload.text === "Valid reply").length, 1);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === stale.user_telegram_id), false);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === noAction.user_telegram_id), false);
    assert.deepEqual(harness.db.listTicketBatchAnswerItems("answers_1").map((item) => item.state), ["STALE", "COMPLETED", "NO_ACTION"]);
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "COMPLETED");
  });

  it("continues later items after a delivery failure without retrying the failed reply", async () => {
    const harness = createHarness();
    const failed = harness.seedTicket({ user: { id: 301 }, messageThreadId: 5301 });
    const valid = harness.seedTicket({ user: { id: 302 }, messageThreadId: 5302 });
    const failedToken = getTicketSnapshotToken(failed, []);
    const validToken = getTicketSnapshotToken(valid, []);
    harness.db.createTicketBatchExport({ exportId: "export_failure", staffChatId: TEST_STAFF_CHAT_ID, createdAt: "2026-07-30T00:00:00.000Z", selectionMode: "all_active", ticketCount: 2, items: [{ ticketId: failed.id, snapshotToken: failedToken }, { ticketId: valid.id, snapshotToken: validToken }] });
    harness.setDownloadResponse(multiAnswerPackage("export_failure", [
      { ticketId: failed.id, token: failedToken, action: "reply_keep_open", text: "First reply" },
      { ticketId: valid.id, token: validToken, action: "reply_keep_open", text: "Second reply" }
    ]));
    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_failure.json" }));
    const preview = harness.findApiCalls("sendMessage").find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    harness.failNextApiCall("sendMessage", "User unavailable", 403);
    await harness.bot.handleUpdate(batchCallback(callbackData(preview), 8));

    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "FAILED");
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[1]?.state, "COMPLETED");
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === failed.user_telegram_id).length, 1);
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === valid.user_telegram_id && call.payload.text === "Second reply").length, 1);
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "PARTIAL");
  });
});
