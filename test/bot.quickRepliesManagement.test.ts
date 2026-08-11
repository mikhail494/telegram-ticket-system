import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Update } from "grammy/types";
import { InstallationService } from "../src/installation.js";
import { createBotHarness, TEST_STAFF_CHAT_ID, type BotHarness } from "./helpers/botHarness.js";

const harnesses: BotHarness[] = [];

afterEach(() => {
  for (const harness of harnesses) harness.cleanup();
  harnesses.length = 0;
});

function createReadyHarness(role: "OWNER" | "ADMIN" | "SENIOR_AGENT" | "AGENT") {
  let installation!: InstallationService;
  const harness = createBotHarness({
    installationServiceFactory: (db) => {
      installation = new InstallationService(db);
      installation.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
      installation.consumeOwnerPairingToken(installation.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
      if (role !== "OWNER") installation.assignRole(1, 2, role);
      return installation;
    }
  });
  harness.setStaffMembership(role === "OWNER" ? 1 : 2);
  harnesses.push(harness);
  return harness;
}

function privateMessage(userId: number, text: string, messageId = 20): Update {
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
      id: `quick-management-${messageId}`,
      from: { id: userId, is_bot: false, first_name: `User ${userId}`, username: `user_${userId}` },
      chat_instance: "private",
      data,
      message: { message_id: messageId, date: 1, chat: { id: userId, type: "private", first_name: `User ${userId}` }, text: "Dashboard" }
    }
  };
}

function buttons(call: { payload: Record<string, unknown> } | undefined): string[] {
  const markup = call?.payload.reply_markup as { inline_keyboard?: Array<Array<{ text?: string }>> } | undefined;
  return markup?.inline_keyboard?.flat().map((button) => button.text ?? "") ?? [];
}

function currentScreenId(harness: BotHarness, userId: number): number {
  const messageId = harness.db.getOnboardingSession(userId)?.primary_message_id;
  assert.ok(messageId);
  return messageId;
}

function exportIdFromCaption(harness: BotHarness): string {
  const caption = String(harness.findApiCalls("sendDocument")[0]?.payload.caption);
  const match = /^Export: (export_[a-f0-9]+)$/m.exec(caption);
  if (!match) throw new Error("Missing private batch export ID.");
  return match[1]!;
}

async function beginPendingPrivateBatch(harness: BotHarness, userId: number): Promise<string> {
  harness.seedTicket();
  await harness.bot.handleUpdate(privateCallback(userId, "batch-ui:export"));
  return exportIdFromCaption(harness);
}

test("OWNER and ADMIN can open private Quick Replies management", async () => {
  for (const [role, userId] of [["OWNER", 1], ["ADMIN", 2]] as const) {
    const harness = createReadyHarness(role);
    await harness.bot.handleUpdate(privateCallback(userId, "dashboard:quick"));

    const screen = harness.findApiCalls("editMessageText")[0];
    assert.match(String(screen?.payload.text), /Quick replies/);
    assert.ok(buttons(screen).includes("Add reply"));
  }
});

test("junior roles and ordinary users cannot manage Quick Replies", async () => {
  for (const role of ["SENIOR_AGENT", "AGENT"] as const) {
    const harness = createReadyHarness(role);
    await harness.bot.handleUpdate(privateCallback(2, "dashboard:quick"));
    assert.equal(harness.findApiCalls("editMessageText").length, 0);
    assert.match(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /role does not allow/i);
  }

  const harness = createReadyHarness("OWNER");
  await harness.bot.handleUpdate(privateCallback(99, "dashboard:quick"));
  assert.equal(harness.findApiCalls("editMessageText").length, 0);
  assert.match(String(harness.findApiCalls("answerCallbackQuery")[0]?.payload.text), /staff access required/i);
});

test("management lists human labels, edits persisted text, and ticket callbacks use the new content", async () => {
  const harness = createReadyHarness("OWNER");
  await harness.bot.handleUpdate(privateCallback(1, "dashboard:quick"));
  const list = harness.findApiCalls("editMessageText")[0];
  assert.ok(buttons(list).includes("Ask for UID"));
  assert.doesNotMatch(String(list?.payload.text), /ask_uid/);

  await harness.bot.handleUpdate(privateCallback(1, "quick:view:ask_uid", currentScreenId(harness, 1)));
  const detail = harness.findApiCalls("editMessageText").at(-1);
  assert.match(String(detail?.payload.text), /Name: Ask for UID/);
  assert.match(String(detail?.payload.text), /Text:/);

  await harness.bot.handleUpdate(privateCallback(1, "quick:edit-text:ask_uid", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateMessage(1, "Please share your account reference.", 31));
  assert.equal(harness.registry.findTemplate("ask_uid")?.text, "Please share your account reference.");

  const ticket = harness.seedTicket();
  harness.clearApiCalls();
  await harness.bot.handleUpdate({
    update_id: 32,
    callback_query: {
      id: "ticket-quick-reply",
      from: { id: 42, is_bot: false, first_name: "Staff" },
      chat_instance: "staff",
      data: `qr:template:${ticket.id}:ask_uid`,
      message: { message_id: 700, date: 1, chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Staff" }, message_thread_id: ticket.message_thread_id ?? 5000, text: "Ticket" }
    }
  });
  assert.equal(harness.findApiCalls("sendMessage").find((call) => call.payload.chat_id === ticket.user_telegram_id)?.payload.text, "Please share your account reference.");
});

test("invalid input and Back leave no mutation or competing management prompt", async () => {
  const harness = createReadyHarness("ADMIN");
  await harness.bot.handleUpdate(privateCallback(2, "dashboard:quick"));
  await harness.bot.handleUpdate(privateCallback(2, "quick:edit-name:ask_uid", currentScreenId(harness, 2)));
  await harness.bot.handleUpdate(privateMessage(2, "   ", 40));
  assert.equal(harness.registry.findTemplate("ask_uid")?.title, "Ask for UID");
  assert.match(String(harness.findApiCalls("editMessageText").at(-1)?.payload.text), /value cannot be empty/i);

  await harness.bot.handleUpdate(privateCallback(2, "quick:list", currentScreenId(harness, 2)));
  assert.match(String(harness.findApiCalls("editMessageText").at(-1)?.payload.text), /^Quick replies/m);
});

test("pending Batch waits for files without hijacking Quick Reply or moderation editor text", async () => {
  const harness = createReadyHarness("OWNER");
  const exportId = await beginPendingPrivateBatch(harness, 1);

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:quick", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateCallback(1, "quick:edit-name:ask_uid", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateMessage(1, "Checking", 70));
  assert.equal(harness.registry.findTemplate("ask_uid")?.title, "Checking");

  await harness.bot.handleUpdate(privateCallback(1, "quick:edit-text:ask_uid", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateMessage(1, "We are checking.", 71));
  assert.equal(harness.registry.findTemplate("ask_uid")?.text, "We are checking.");

  await harness.bot.handleUpdate(privateCallback(1, "quick:add", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateCallback(1, "quick:add-category:status", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateMessage(1, "Escalated", 72));
  await harness.bot.handleUpdate(privateMessage(1, "We have escalated this request.", 73));
  assert.match(String(harness.findApiCalls("editMessageText").at(-1)?.payload.text), /New Quick reply/);
  await harness.bot.handleUpdate(privateCallback(1, "quick:list", currentScreenId(harness, 1)));

  const workspaceId = harness.db.getActiveWorkspace()!.id;
  harness.db.upsertManagedPublicChat({ chatId: -100710, workspaceId, title: "Synthetic public chat", isForum: false });
  await harness.bot.handleUpdate(privateCallback(1, "public:config-warning:-100710", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateMessage(1, "Synthetic moderation warning.", 74));
  assert.equal(harness.db.getManagedPublicChat(-100710)?.warning_text, "Synthetic moderation warning.");

  assert.equal(harness.db.getSetting("private_batch_export:1"), exportId);
  assert.equal(harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("That file is not an answer package")), false);
});

test("pending Batch ignores arbitrary private text but still leaves its export resumable", async () => {
  const harness = createReadyHarness("OWNER");
  const exportId = await beginPendingPrivateBatch(harness, 1);
  harness.clearApiCalls();

  await harness.bot.handleUpdate(privateMessage(1, "Checking", 80));

  assert.equal(harness.db.getSetting("private_batch_export:1"), exportId);
  assert.equal(harness.db.listTicketBatchAnswerItems("private_answers_1").length, 0);
  assert.equal(harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("That file is not an answer package")), false);
});

test("Add persists only after preview confirmation and Delete requires confirmation", async () => {
  const harness = createReadyHarness("OWNER");
  await harness.bot.handleUpdate(privateCallback(1, "dashboard:quick"));
  await harness.bot.handleUpdate(privateCallback(1, "quick:add", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateCallback(1, "quick:add-category:status", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateMessage(1, "Resolved", 50));
  await harness.bot.handleUpdate(privateMessage(1, "This issue is resolved.", 51));
  assert.equal(harness.registry.listTemplates("status").some((template) => template.title === "Resolved"), false);
  await harness.bot.handleUpdate(privateCallback(1, "quick:list", currentScreenId(harness, 1)));
  assert.equal(harness.registry.listTemplates("status").some((template) => template.title === "Resolved"), false);

  await harness.bot.handleUpdate(privateCallback(1, "quick:add", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateCallback(1, "quick:add-category:status", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateMessage(1, "Resolved", 52));
  await harness.bot.handleUpdate(privateMessage(1, "This issue is resolved.", 53));
  await harness.bot.handleUpdate(privateCallback(1, "quick:add-save", currentScreenId(harness, 1)));
  const created = harness.registry.listTemplates("status").find((template) => template.title === "Resolved");
  assert.equal(created?.text, "This issue is resolved.");

  await harness.bot.handleUpdate(privateCallback(1, "quick:delete:ask_uid", currentScreenId(harness, 1)));
  assert.ok(harness.registry.findTemplate("ask_uid"));
  assert.match(String(harness.findApiCalls("editMessageText").at(-1)?.payload.text), /Delete "Ask for UID"/);
  await harness.bot.handleUpdate(privateCallback(1, "quick:confirm-delete:ask_uid", currentScreenId(harness, 1)));
  assert.equal(harness.registry.findTemplate("ask_uid"), undefined);
});

test("stale management callbacks and deleted ticket Quick Replies are inert", async () => {
  const harness = createReadyHarness("OWNER");
  await harness.bot.handleUpdate(privateCallback(1, "dashboard:quick", 60));
  await harness.bot.handleUpdate(privateCallback(1, "quick:edit-name:ask_uid", currentScreenId(harness, 1)));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateCallback(1, "quick:edit-name:ask_uid", 60));
  assert.match(String(harness.findApiCalls("answerCallbackQuery")[0]?.payload.text), /no longer active/i);
  assert.equal(harness.registry.findTemplate("ask_uid")?.title, "Ask for UID");

  await harness.bot.handleUpdate(privateCallback(1, "quick:list", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateCallback(1, "quick:delete:ask_uid", currentScreenId(harness, 1)));
  await harness.bot.handleUpdate(privateCallback(1, "quick:confirm-delete:ask_uid", currentScreenId(harness, 1)));
  const ticket = harness.seedTicket();
  harness.clearApiCalls();
  await harness.bot.handleUpdate({
    update_id: 61,
    callback_query: {
      id: "deleted-ticket-template",
      from: { id: 42, is_bot: false, first_name: "Staff" },
      chat_instance: "staff",
      data: `qr:template:${ticket.id}:ask_uid`,
      message: { message_id: 701, date: 1, chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Staff" }, message_thread_id: ticket.message_thread_id ?? 5000, text: "Ticket" }
    }
  });
  assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length, 0);
  assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
  assert.match(String(harness.findApiCalls("answerCallbackQuery")[0]?.payload.text), /not found/i);
});
