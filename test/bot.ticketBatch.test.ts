import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Update } from "grammy/types";
import { strFromU8, unzipSync } from "fflate";
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

function callbackData(call: RecordedApiCall, label: string): string {
  const markup = call.payload.reply_markup;
  if (!markup || typeof markup !== "object" || !("inline_keyboard" in markup)) throw new Error("Expected inline keyboard");
  const rows = markup.inline_keyboard;
  if (!Array.isArray(rows)) throw new Error("Expected keyboard rows");
  const buttons = rows.flat().filter((button): button is { callback_data: string } =>
    typeof button === "object" && button !== null && "callback_data" in button && typeof button.callback_data === "string"
  );
  const button = buttons.find((candidate) => "text" in candidate && candidate.text === label);
  if (!button || typeof button.callback_data !== "string") throw new Error(`Expected ${label} callback data`);
  return button.callback_data;
}

function batchCallback(data: string, updateId: number, preview: RecordedApiCall): Update {
  if (typeof preview.responseMessageId !== "number") throw new Error("Expected preview response message ID");
  return {
    update_id: updateId,
    callback_query: {
      id: `batch-callback-${updateId}`,
      from: { id: 42, is_bot: false, first_name: "Test Staff", username: "test_staff" },
      chat_instance: "test-chat-instance",
      data,
      message: {
        message_id: preview.responseMessageId,
        date: 1,
        chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Test Staff Chat" },
        text: String(preview.payload.text)
      }
    }
  };
}

describe("ticket batch Telegram workflow", () => {
  it("sends one self-contained export document without copying attachments into the staff chat", async () => {
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
    harness.setFileDownload("photo", new Uint8Array([7, 8, 9]), { filePath: "evidence/photo.jpg" });

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("sendDocument"), 1);
    const exportDocument = harness.findApiCalls("sendDocument")[0];
    assert.equal(exportDocument?.payload.chat_id, TEST_STAFF_CHAT_ID);
    assert.ok(exportDocument?.documentBytes);
    const entries = unzipSync(exportDocument.documentBytes);
    const mediaIndex = JSON.parse(strFromU8(entries["media-index.json"]!)) as Array<{ archive_path: string }>;
    assert.equal(mediaIndex.length, 1);
    assert.deepEqual(entries[mediaIndex[0]!.archive_path], new Uint8Array([7, 8, 9]));
    assert.equal(harness.countApiCalls("copyMessage"), 0);
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length, 0);
    assert.equal(harness.db.listActiveTicketsForStaffChat(TEST_STAFF_CHAT_ID).some((ticket) => ticket.id === closed.id), false);
  });

  it("fails the whole export before delivery when an attachment cannot be downloaded", async () => {
    const harness = createHarness();
    const active = harness.seedTicket();
    harness.db.addMessage({ ticketId: active.id, direction: "USER_TO_STAFF", sourceChatId: active.user_telegram_id, sourceMessageId: 99, mediaType: "document", fileId: "file_1" });
    harness.setFileDownload("file_1", new Uint8Array(), { status: 404 });

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("copyMessage"), 0);
    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("Export failed before delivery")), true);
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
    assert.match(String(preview.payload.text), /Ticket #1/);
    assert.match(String(preview.payload.text), /Action: reply_keep_open/);
    assert.match(String(preview.payload.text), /Reply:\nA valid reply/);
    const apply = callbackData(preview, "Apply");
    assert.ok(Buffer.byteLength(apply, "utf8") <= 64);
    assert.equal(harness.db.getTicket(ticket.id)?.status, "OPEN");
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);

    await harness.bot.handleUpdate(batchCallback(apply, 2, preview));
    assert.equal(harness.countApiCalls("answerCallbackQuery"), 1);
    assert.equal(harness.countApiCalls("deleteMessage"), 1);
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
    const cancel = callbackData(preview, "Cancel");
    await harness.bot.handleUpdate(batchCallback(cancel, 3, preview));

    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "CANCELLED");
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1").length, 1);
    assert.equal(harness.countApiCalls("deleteMessage"), 1);
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length, 0);
    assert.equal(harness.db.claimTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "CANCELLED");
  });

  it("reuses the same preview message for a repeated pending upload", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({ exportId: "export_repeat", staffChatId: TEST_STAFF_CHAT_ID, createdAt: "2026-07-30T00:00:00.000Z", selectionMode: "all_active", ticketCount: 1, items: [{ ticketId: ticket.id, snapshotToken: token }] });
    harness.setDownloadResponse(answerPackage("export_repeat", ticket.id, token));

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_repeat.json" }));
    const preview = harness.findApiCalls("sendMessage").find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    harness.clearApiCalls();
    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ messageId: 7002, fileName: "ticket-answers_export_repeat.json" }));

    assert.equal(harness.countApiCalls("sendMessage"), 0);
    assert.equal(harness.countApiCalls("editMessageText"), 1);
    assert.equal(harness.findApiCalls("editMessageText")[0]?.payload.message_id, preview.responseMessageId);
  });

  it("neutralizes the same preview when deletion fails without duplicating Apply", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({ exportId: "export_cleanup", staffChatId: TEST_STAFF_CHAT_ID, createdAt: "2026-07-30T00:00:00.000Z", selectionMode: "all_active", ticketCount: 1, items: [{ ticketId: ticket.id, snapshotToken: token }] });
    harness.setDownloadResponse(answerPackage("export_cleanup", ticket.id, token));
    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_cleanup.json" }));
    const preview = harness.findApiCalls("sendMessage").find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    harness.failNextApiCall("deleteMessage", "Delete unavailable", 500);

    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 25, preview));

    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply").length, 1);
    assert.equal(harness.countApiCalls("deleteMessage"), 2);
    assert.equal(harness.countApiCalls("editMessageText"), 1);
    assert.equal(harness.findApiCalls("editMessageText")[0]?.payload.message_id, preview.responseMessageId);
  });

  it("paginates a large persistent preview by editing the same message", async () => {
    const harness = createHarness();
    const entries = Array.from({ length: 52 }, (_, index) => {
      const ticket = harness.seedTicket({ user: { id: 900 + index }, messageThreadId: 6000 + index });
      return { ticket, token: getTicketSnapshotToken(ticket, []) };
    });
    harness.db.createTicketBatchExport({
      exportId: "export_pages",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: entries.length,
      items: entries.map(({ ticket, token }) => ({ ticketId: ticket.id, snapshotToken: token }))
    });
    harness.setDownloadResponse(multiAnswerPackage("export_pages", entries.map(({ ticket, token }) => ({
      ticketId: ticket.id,
      token,
      action: "reply_keep_open",
      text: `Reply ${"x".repeat(150)} for ticket ${ticket.id}`
    }))));

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_pages.json" }));
    const preview = harness.findApiCalls("sendMessage").find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    assert.match(String(preview.payload.text), /Page 1\/\d+/);
    const next = callbackData(preview, "Next");
    await harness.bot.handleUpdate(batchCallback(next, 30, preview));

    assert.equal(harness.countApiCalls("editMessageText"), 1);
    const edit = harness.findApiCalls("editMessageText")[0];
    assert.equal(edit?.payload.message_id, preview.responseMessageId);
    assert.match(String(edit?.payload.text), /Page 2\/\d+/);
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length, 1);
  });

  it("does not create a replacement preview for a partially applied package", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({ exportId: "export_close", staffChatId: TEST_STAFF_CHAT_ID, createdAt: "2026-07-30T00:00:00.000Z", selectionMode: "all_active", ticketCount: 1, items: [{ ticketId: ticket.id, snapshotToken: token }] });
    harness.setDownloadResponse(answerPackage("export_close", ticket.id, token, "reply_and_close"));
    harness.failNextApiCall("sendDocument", "Archive unavailable", 500);

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_close.json" }));
    const firstPreview = harness.findApiCalls("sendMessage").find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(firstPreview);
    await harness.bot.handleUpdate(batchCallback(callbackData(firstPreview, "Apply"), 4, firstPreview));

    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply").length, 1);
    assert.equal(harness.db.listMessagesChronological(ticket.id).filter((message) => message.direction === "STAFF_TO_USER").length, 1);
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "REPLY_SENT");
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "PARTIAL");

    const userRepliesBeforeRepeat = harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply").length;
    harness.clearApiCalls();
    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ messageId: 7002, fileName: "ticket-answers_export_close.json" }));
    assert.equal(harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("no longer previewable")), true);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("Ticket answer package preview")), false);
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length, 0);
    assert.equal(userRepliesBeforeRepeat, 1);
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "REPLY_SENT");
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "PARTIAL");
  });

  it("does not create a preview for an already applying package", async () => {
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
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => String(call.payload.text).includes("Ticket answer package preview")).length, 1);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("no longer previewable")), true);
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "APPLYING");
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
    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 7, preview));

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
    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 8, preview));

    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "FAILED");
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[1]?.state, "COMPLETED");
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === failed.user_telegram_id).length, 1);
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === valid.user_telegram_id && call.payload.text === "Second reply").length, 1);
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "PARTIAL");
  });
});
