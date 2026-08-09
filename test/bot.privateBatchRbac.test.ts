import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Update } from "grammy/types";
import { InstallationService } from "../src/installation.js";
import { getTicketSnapshotToken } from "../src/ticketBatch.js";
import { buildStaffDocumentUpdate, buildStaffTextMessageUpdate, createBotHarness, TEST_STAFF_CHAT_ID, type BotHarness, type RecordedApiCall } from "./helpers/botHarness.js";

const harnesses: BotHarness[] = [];

afterEach(() => {
  for (const harness of harnesses) harness.cleanup();
  harnesses.length = 0;
});

function createReadyHarness(options: { role?: "OWNER" | "ADMIN" | "SENIOR_AGENT" | "AGENT"; rbac?: boolean } = {}) {
  let installation!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    installation = new InstallationService(db);
    installation.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    installation.consumeOwnerPairingToken(installation.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    if (options.role && options.role !== "OWNER") installation.assignRole(1, 2, options.role);
    if (options.rbac) {
      const preview = installation.previewRoleBasedAccessActivation();
      installation.activateRoleBasedAccess(1, preview.confirmationToken);
    }
    return installation;
  } });
  harnesses.push(harness);
  return { harness, installation };
}

function privateMessage(userId: number, text: string, messageId = 1): Update {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1,
      from: { id: userId, is_bot: false, first_name: `User ${userId}`, username: `user_${userId}` },
      chat: { id: userId, type: "private", first_name: `User ${userId}` },
      text
    }
  };
}

function privateCallback(userId: number, data: string, messageId = 10): Update {
  return {
    update_id: messageId,
    callback_query: {
      id: `private-callback-${messageId}`,
      from: { id: userId, is_bot: false, first_name: `User ${userId}`, username: `user_${userId}` },
      chat_instance: "private",
      data,
      message: { message_id: messageId, date: 1, chat: { id: userId, type: "private", first_name: `User ${userId}` }, text: "Dashboard" }
    }
  };
}

function privateDocument(userId: number, fileName: string, messageId = 20): Update {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1,
      from: { id: userId, is_bot: false, first_name: `User ${userId}`, username: `user_${userId}` },
      chat: { id: userId, type: "private", first_name: `User ${userId}` },
      document: { file_id: "answer-package", file_unique_id: "answer-package-unique", file_name: fileName, file_size: 200 }
    }
  };
}

function callbackData(call: RecordedApiCall, label: string): string {
  const markup = call.payload.reply_markup as { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> } | undefined;
  const button = markup?.inline_keyboard?.flat().find((entry) => entry.text === label);
  if (!button?.callback_data) throw new Error(`Missing ${label} button`);
  return button.callback_data;
}

function answerPackage(exportId: string, ticketId: number, snapshotToken: string): string {
  return JSON.stringify({
    schema: "telegram_ticket_answer_package",
    version: 1,
    export_id: exportId,
    answer_package_id: "private_answers_1",
    created_at: "2026-08-09T00:00:00.000Z",
    answers: [{ ticket_id: ticketId, snapshot_token: snapshotToken, action: "reply_keep_open", reply_text: "Private batch reply" }]
  });
}

test("OWNER and ADMIN receive private batch controls while junior roles do not", async () => {
  for (const role of ["OWNER", "ADMIN", "SENIOR_AGENT", "AGENT"] as const) {
    const { harness } = createReadyHarness({ role, rbac: true });
    const userId = role === "OWNER" ? 1 : 2;
    await harness.bot.handleUpdate(privateCallback(userId, "dashboard:batch", userId + 10));
    const edited = harness.findApiCalls("editMessageText").map((call) => String(call.payload.text)).join("\n");
    const sent = harness.findApiCalls("sendMessage").map((call) => String(call.payload.text)).join("\n");
    if (role === "OWNER" || role === "ADMIN") assert.match(edited, /Batch operations/);
    else assert.doesNotMatch(sent, /Export active tickets/);
  }
});

test("private export uses the existing exporter and targets the initiating administrator", async () => {
  const { harness } = createReadyHarness({ role: "ADMIN", rbac: true });
  harness.seedTicket();

  await harness.bot.handleUpdate(privateCallback(2, "batch-ui:export"));

  const exportCall = harness.findApiCalls("sendDocument")[0];
  assert.equal(exportCall?.payload.chat_id, 2);
  assert.equal(harness.findApiCalls("sendDocument").some((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID), false);
});

test("private Apply requires an explicit session and rechecks the role at confirmation", async () => {
  const { harness, installation } = createReadyHarness({ role: "ADMIN", rbac: true });
  const ticket = harness.seedTicket();
  const token = getTicketSnapshotToken(ticket, []);
  harness.db.createTicketBatchExport({
    exportId: "private_export",
    staffChatId: TEST_STAFF_CHAT_ID,
    createdAt: "2026-08-09T00:00:00.000Z",
    selectionMode: "all_active",
    ticketCount: 1,
    items: [{ ticketId: ticket.id, snapshotToken: token }]
  });
  harness.setDownloadResponse(answerPackage("private_export", ticket.id, token));

  await harness.bot.handleUpdate(privateDocument(2, "random.zip"));
  assert.equal(harness.db.listTicketBatchAnswerItems("private_answers_1").length, 0);

  await harness.bot.handleUpdate(privateCallback(2, "batch-ui:apply", 30));
  await harness.bot.handleUpdate(privateDocument(2, "ticket-answers_private_export.json", 31));
  const preview = harness.findApiCalls("sendMessage").find((call) => String(call.payload.text).includes("Ticket answer package preview"));
  assert.ok(preview);
  const applyData = callbackData(preview!, "Apply");
  installation.revokeMember(1, 2);
  harness.clearApiCalls();

  await harness.bot.handleUpdate(privateCallback(2, applyData, 32));

  assert.equal(harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === ticket.user_telegram_id), false);
  assert.match(String(harness.findApiCalls("answerCallbackQuery")[0]?.payload.text), /OWNER or ADMIN/i);
});

test("RBAC-active staff batch command is redirected without exporting", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  harness.seedTicket();
  const update: Update = {
    update_id: 40,
    message: {
      message_id: 40,
      date: 1,
      from: { id: 1, is_bot: false, first_name: "Owner", username: "owner" },
      chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Staff" },
      text: "/exporttickets",
      entities: [{ type: "bot_command", offset: 0, length: 14 }]
    }
  };

  await harness.bot.handleUpdate(update);

  assert.equal(harness.countApiCalls("sendDocument"), 0);
  assert.match(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /private chat/i);
});

test("RBAC-active staff answer-package upload is redirected before preview creation", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  harness.setDownloadResponse("{}");

  await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_any.json", staff: { id: 1, username: "owner" } }));

  assert.equal(harness.db.listTicketBatchAnswerItems("anything").length, 0);
  assert.equal(harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("private chat")), true);
});

test("AGENT can reply to a ticket but cannot open team or public-chat controls", async () => {
  const { harness } = createReadyHarness({ role: "AGENT", rbac: true });
  const ticket = harness.seedTicket({ messageThreadId: 5000 });

  await harness.bot.handleUpdate(buildStaffTextMessageUpdate({
    staff: { id: 2, username: "agent" },
    messageThreadId: ticket.message_thread_id ?? 5000,
    text: "Agent reply"
  }));
  assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length, 1);

  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateCallback(2, "dashboard:team", 50));
  await harness.bot.handleUpdate(privateCallback(2, "dashboard:public", 51));
  const denials = harness.findApiCalls("sendMessage").map((call) => String(call.payload.text)).join("\n");
  assert.match(denials, /does not allow/i);
});
