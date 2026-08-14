import test from "node:test";
import assert from "node:assert/strict";
import type { Update } from "grammy/types";
import packageMetadata from "../package.json" with { type: "json" };
import { CLOSED_TEXT } from "../src/format.js";
import { InstallationService } from "../src/installation.js";
import { createBotHarness, TEST_STAFF_CHAT_ID } from "./helpers/botHarness.js";

function privateMessage(userId: number, text: string, messageId = 1): Update {
  const command = text.startsWith("/");
  return { update_id: messageId, message: { message_id: messageId, date: 1, from: { id: userId, is_bot: false, first_name: `User ${userId}`, username: `user_${userId}` }, chat: { id: userId, type: "private", first_name: `User ${userId}` }, text, ...(command ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }] } : {}) } };
}

function privateCallback(userId: number, data: string, messageId = 10): Update {
  return { update_id: messageId, callback_query: { id: `cb-${messageId}`, from: { id: userId, is_bot: false, first_name: `User ${userId}`, username: `user_${userId}` }, chat_instance: "private", data, message: { message_id: messageId, date: 1, chat: { id: userId, type: "private", first_name: `User ${userId}` }, text: "Dashboard" } } };
}

test("unknown user cannot create a ticket while setup is required", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => (service = new InstallationService(db)) });
  try {
    await harness.bot.handleUpdate(privateMessage(501, "Need help"));
    assert.equal(harness.db.listTicketsForUser(501, TEST_STAFF_CHAT_ID).length, 0);
    assert.match(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /not been configured/i);
    assert.equal(service.getState().setupState, "SETUP_REQUIRED");
  } finally { harness.cleanup(); }
});

test("legacy ready installation still creates normal user tickets", async () => {
  const harness = createBotHarness();
  try {
    harness.setApiResponseOverride("getChatMember", () => ({ ok: true, result: { status: "left", user: { id: 502, is_bot: false, first_name: "User 502" } } }));
    await harness.bot.handleUpdate(privateMessage(502, "Need help"));
    assert.equal(harness.db.listTicketsForUser(502, TEST_STAFF_CHAT_ID).length, 1);
    assert.equal(harness.countApiCalls("createForumTopic"), 1);
  } finally { harness.cleanup(); }
});

test("owner pairing deep link creates owner and opens onboarding", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => (service = new InstallationService(db)) });
  try {
    const token = service.createOwnerPairingToken();
    await harness.bot.handleUpdate(privateMessage(1, `/start setup_${token}`));
    assert.equal(service.getOwner()?.userTelegramId, 1);
    assert.equal(service.getOnboardingSession(1)?.stage, "WELCOME");
    assert.match(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /Setup 1\/9/);
  } finally { harness.cleanup(); }
});

test("owner receives dashboard instead of accidentally creating a ticket", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db); service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" }); return service;
  } });
  try {
    await harness.bot.handleUpdate(privateMessage(1, "ordinary owner text"));
    assert.equal(harness.db.listTicketsForUser(1, TEST_STAFF_CHAT_ID).length, 0);
    const dashboard = String(harness.findApiCalls("sendMessage")[0]?.payload.text);
    assert.match(dashboard, /Owner dashboard/);
    assert.doesNotMatch(dashboard, new RegExp(`Version: ${packageMetadata.version.replaceAll(".", "\\.")}`));
  } finally { harness.cleanup(); }
});

test("current staff members are enrolled as agents from private and workspace interactions", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    service.activateReadyRoleBasedAccess();
    return service;
  } });
  try {
    harness.setStaffMembership(22);
    await harness.bot.handleUpdate(privateMessage(22, "/start", 22));
    assert.equal(service.getMember(22)?.role, "AGENT");
    assert.match(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /AGENT dashboard/);

    harness.clearApiCalls();
    const staffMessage = privateMessage(23, "Workspace hello", 23);
    if (!staffMessage.message) throw new Error("Expected message update.");
    staffMessage.message.chat = { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Staff workspace" };
    await harness.bot.handleUpdate(staffMessage);
    assert.equal(service.getMember(23)?.role, "AGENT");
  } finally { harness.cleanup(); }
});

test("system status recognizes the scoped Support Logs topic", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    db.setSetting(`support_logs_message_thread_id:${TEST_STAFF_CHAT_ID}`, "153");
    return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:status"));
    const status = String(harness.findApiCalls("editMessageText")[0]?.payload.text);
    assert.match(status, /Support Logs: configured/);
  } finally { harness.cleanup(); }
});

test("ready dashboard is concise and opens system status in the same message", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    db.setSetting(`support_logs_message_thread_id:${TEST_STAFF_CHAT_ID}`, "153");
    return service;
  } });
  try {
    await harness.bot.handleUpdate(privateMessage(1, "owner dashboard", 1));
    const dashboard = harness.findApiCalls("sendMessage")[0];
    assert.match(String(dashboard?.payload.text), /Owner dashboard/);
    assert.doesNotMatch(String(dashboard?.payload.text), /Version:|Authorization:|Database:/);
    const keyboard = dashboard?.payload.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    assert.equal(keyboard.inline_keyboard?.flat().some((button) => button.callback_data === "setup:resume"), false);
    const currentMessageId = dashboard!.responseMessageId!;

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:status", currentMessageId));
    assert.equal(harness.countApiCalls("editMessageText"), 1);
    assert.equal(harness.countApiCalls("sendMessage"), 0);
    const status = harness.findApiCalls("editMessageText")[0];
    assert.match(String(status?.payload.text), /System status/);
    assert.match(String(status?.payload.text), /Version:/);
    const statusKeyboard = status?.payload.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    assert.equal(statusKeyboard.inline_keyboard?.flat().some((button) => button.callback_data === "dashboard:home"), true);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:home", currentMessageId));
    assert.equal(harness.countApiCalls("editMessageText"), 1);
    assert.equal(harness.countApiCalls("sendMessage"), 0);
    assert.match(String(harness.findApiCalls("editMessageText")[0]?.payload.text), /Owner dashboard/);
  } finally { harness.cleanup(); }
});

test("dashboard moderation replaces the dashboard with moderation management", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:moderation", 10));
    assert.equal(harness.countApiCalls("editMessageText"), 1);
    assert.equal(harness.countApiCalls("sendMessage"), 0);
    const screen = harness.findApiCalls("editMessageText")[0];
    assert.match(String(screen?.payload.text), /^Moderation$/m);
    assert.doesNotMatch(String(screen?.payload.text), /Owner dashboard/);
    const keyboard = screen?.payload.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    assert.equal(keyboard.inline_keyboard?.flat().some((button) => button.callback_data === "dashboard:public"), true);
    assert.equal(keyboard.inline_keyboard?.flat().some((button) => button.callback_data === "dashboard:home"), true);
  } finally { harness.cleanup(); }
});

test("team screen returns to the dashboard through the current message", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:team", 10));
    const team = harness.findApiCalls("editMessageText")[0];
    assert.match(String(team?.payload.text), /Owner: @owner/);
    assert.doesNotMatch(String(team?.payload.text), /user_telegram_id|\b1\b/);
    const keyboard = team?.payload.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    assert.equal(keyboard.inline_keyboard?.flat().some((button) => button.callback_data === "dashboard:home"), true);
    assert.equal(keyboard.inline_keyboard?.flat().some((button) => button.callback_data === "rbac:preview"), true);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:home", 10));
    assert.equal(harness.countApiCalls("editMessageText"), 1);
    assert.equal(harness.countApiCalls("sendMessage"), 0);
    assert.match(String(harness.findApiCalls("editMessageText")[0]?.payload.text), /Owner dashboard/);
  } finally { harness.cleanup(); }
});

test("team details use human labels and do not expose member IDs", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    db.upsertTeamMember({ userId: 77, displayName: "Riley", role: "AGENT" });
    return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:team", 10));
    const team = harness.findApiCalls("editMessageText")[0]!;
    assert.match(String(team.payload.text), /Agent: Riley/);
    assert.doesNotMatch(String(team.payload.text), /\b77\b/);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, "team:member:77", 10));
    const detail = harness.findApiCalls("editMessageText")[0]!;
    assert.match(String(detail.payload.text), /Member: Riley/);
    assert.match(String(detail.payload.text), /Role: Agent/);
    assert.doesNotMatch(String(detail.payload.text), /\b77\b/);
  } finally { harness.cleanup(); }
});

test("staff explicitly enables one-message test-ticket mode", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db); service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 }); return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:test-ticket"));
    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateMessage(1, "Harmless test ticket", 11));
    assert.equal(harness.db.listTicketsForUser(1, TEST_STAFF_CHAT_ID).length, 1);
    assert.equal(harness.db.getSetting("staff_test_ticket_mode:1"), "false");
    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateMessage(1, "Normal staff text", 12));
    assert.equal(harness.db.listTicketsForUser(1, TEST_STAFF_CHAT_ID).length, 1);
    assert.match(String(harness.findApiCalls("sendMessage").at(-1)?.payload.text), /Owner dashboard/);
  } finally { harness.cleanup(); }
});

test("a staff test ticket retires its prompt and returns only its owner to a fresh dashboard after close", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db); service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 }); return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:test-ticket", 10));
    const promptMessageId = harness.findApiCalls("sendMessage").at(-1)?.responseMessageId;
    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateMessage(1, "Harmless test ticket", 11));
    const ticket = harness.db.findActiveTicketForUser(1, TEST_STAFF_CHAT_ID)!;
    const acknowledgement = harness.findApiCalls("sendMessage").find((call) => call.payload.chat_id === 1 && String(call.payload.text).startsWith("Thanks, your request"))!;
    assert.equal(harness.findApiCalls("deleteMessage").some((call) => call.payload.message_id === promptMessageId), true);
    assert.equal(harness.findApiCalls("deleteMessage").some((call) => call.payload.message_id === 11), false);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, `user:close:${ticket.id}`, acknowledgement.responseMessageId));
    assert.equal(harness.findApiCalls("deleteMessage").some((call) => call.payload.message_id === acknowledgement.responseMessageId), false);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === 1 && call.payload.text === CLOSED_TEXT), true);
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === 1 && /Owner dashboard/.test(String(call.payload.text))).length, 1);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, `user:close:${ticket.id}`, acknowledgement.responseMessageId));
    assert.equal(harness.findApiCalls("sendMessage").some((call) => /Owner dashboard/.test(String(call.payload.text))), false);
  } finally { harness.cleanup(); }
});

test("a failed staff test-ticket creation clears its prompt and restores the dashboard without deleting the test content", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db); service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 }); return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:test-ticket", 10));
    const promptMessageId = harness.findApiCalls("sendMessage").at(-1)?.responseMessageId;
    harness.failNextApiCall("createForumTopic");
    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateMessage(1, "Harmless failed test ticket", 11));
    assert.equal(harness.db.findActiveTicketForUser(1, TEST_STAFF_CHAT_ID), undefined);
    assert.equal(harness.findApiCalls("deleteMessage").some((call) => call.payload.message_id === promptMessageId), true);
    assert.equal(harness.findApiCalls("deleteMessage").some((call) => call.payload.message_id === 11), false);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => /Sorry, we could not create a support topic/.test(String(call.payload.text))), true);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => /Owner dashboard/.test(String(call.payload.text))), true);
  } finally { harness.cleanup(); }
});

test("workspace picker requests a forum and required admin rights", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db); service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 }); return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "setup:workspace"));
    const markup = harness.findApiCalls("sendMessage")[0]?.payload.reply_markup as { keyboard?: Array<Array<{ request_chat?: Record<string, unknown> }>> };
    const request = markup.keyboard?.[0]?.[0]?.request_chat;
    assert.equal(request?.chat_is_channel, false);
    assert.equal(request?.chat_is_forum, true);
    assert.equal(request?.request_title, true);
    assert.equal((request?.bot_administrator_rights as Record<string, unknown>)?.can_manage_topics, true);
    assert.equal((request?.bot_administrator_rights as Record<string, unknown>)?.can_delete_messages, true);
  } finally { harness.cleanup(); }
});

test("stale private operator callbacks are inert while the current dashboard and nested public-chat controls remain active", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    const workspaceId = db.getActiveWorkspace()!.id;
    db.upsertManagedPublicChat({ chatId: -100701, workspaceId, title: "Synthetic public chat" });
    service.setOnboardingPrimaryMessage(1, 1, 100);
    return service;
  } });
  try {
    for (const [index, data] of ["dashboard:status", "dashboard:test-ticket", "dashboard:team", "dashboard:workspace", "dashboard:moderation", "dashboard:public"].entries()) {
      await harness.bot.handleUpdate(privateCallback(1, data, 10 + index));
    }
    assert.equal(harness.countApiCalls("editMessageText"), 0);
    assert.equal(harness.db.getSetting("staff_test_ticket_mode:1"), undefined);
    assert.equal(harness.findApiCalls("answerCallbackQuery").every((call) => /no longer active/i.test(String(call.payload.text))), true);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:public", 100));
    assert.match(String(harness.findApiCalls("editMessageText")[0]?.payload.text), /Public chats/);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, "public:remove:-100701", 100));
    const confirmation = harness.findApiCalls("editMessageText")[0]!;
    assert.match(String(confirmation.payload.text), /Remove Synthetic public chat/);
    assert.equal(service.getOnboardingSession(1)?.primary_message_id, 100);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, "public:confirm-remove:-100701", 100));
    assert.equal(harness.db.getManagedPublicChat(-100701), undefined);
  } finally { harness.cleanup(); }
});

test("workspace picker cancellation retires its temporary prompt and restores the workspace screen", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:workspace", 10));
    await harness.bot.handleUpdate(privateCallback(1, "workspace:select", 10));
    harness.clearApiCalls();

    await harness.bot.handleUpdate(privateMessage(1, "Cancel workspace selection", 20));

    assert.equal(service.getStaffChatId(), TEST_STAFF_CHAT_ID);
    assert.equal(harness.countApiCalls("deleteMessage"), 2);
    assert.match(String(harness.findApiCalls("sendMessage").at(-1)?.payload.text), /^Staff workspace$/m);
  } finally { harness.cleanup(); }
});

test("ChatShared stores workspace only after centralized validation", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db); service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 }); return service;
  } });
  try {
    harness.setStaffMembership(1, "administrator");
    const update: Update = { update_id: 20, message: { message_id: 20, date: 1, from: { id: 1, is_bot: false, first_name: "Owner" }, chat: { id: 1, type: "private", first_name: "Owner" }, chat_shared: { request_id: 1300, chat_id: -100777, title: "Support", username: "support_team" } } };
    await harness.bot.handleUpdate(update);
    assert.equal(service.getStaffChatId(), -100777);
    assert.equal(harness.countApiCalls("createForumTopic"), 1);
  } finally { harness.cleanup(); }
});

test("activation completes setup and replaces the wizard with the ready dashboard", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    service.activateWorkspace({ chatId: TEST_STAFF_CHAT_ID, title: "Staff" });
    return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "setup:activate", 10));
    assert.equal(service.getState().setupState, "READY");
    assert.equal(service.getOnboardingSession(1)?.state, "COMPLETED");
    assert.equal(harness.countApiCalls("editMessageText"), 1);
    assert.equal(harness.countApiCalls("sendMessage"), 0);
    assert.match(String(harness.findApiCalls("editMessageText")[0]?.payload.text), /Owner dashboard/);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, "setup:exit", 10));
    assert.equal(service.getOnboardingSession(1)?.state, "COMPLETED");
    assert.equal(harness.countApiCalls("editMessageText"), 1);
    assert.match(String(harness.findApiCalls("editMessageText")[0]?.payload.text), /Owner dashboard/);
  } finally { harness.cleanup(); }
});

test("ready staff workspace selection refreshes its active screen below picker output", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    service.saveOnboardingStage(1, "ACTIVATE_SUPPORT", "COMPLETED");
    db.setSetting(`support_logs_message_thread_id:${TEST_STAFF_CHAT_ID}`, "153");
    return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:workspace", 10));
    assert.equal(harness.countApiCalls("editMessageText"), 1);
    assert.match(String(harness.findApiCalls("editMessageText")[0]?.payload.text), /^Staff workspace$/m);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, "workspace:select", 10));
    assert.equal(harness.countApiCalls("sendMessage"), 1);

    harness.clearApiCalls();
    const update: Update = { update_id: 21, message: { message_id: 21, date: 1, from: { id: 1, is_bot: false, first_name: "Owner" }, chat: { id: 1, type: "private", first_name: "Owner" }, chat_shared: { request_id: 1300, chat_id: TEST_STAFF_CHAT_ID, title: "Staff" } } };
    await harness.bot.handleUpdate(update);
    assert.equal(service.getOnboardingSession(1)?.stage, "ACTIVATE_SUPPORT");
    assert.equal(service.getOnboardingSession(1)?.state, "COMPLETED");
    assert.equal(harness.countApiCalls("createForumTopic"), 0);
    assert.equal(harness.countApiCalls("deleteMessage"), 2);
    assert.equal(harness.countApiCalls("editMessageText"), 0);
    assert.equal(harness.countApiCalls("sendMessage"), 1);
    assert.match(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /^Staff workspace$/m);
    assert.doesNotMatch(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /Setup 5\/9/);
  } finally { harness.cleanup(); }
});

test("workspace screen refresh survives cleanup failure without repeating workspace setup", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    db.setSetting(`support_logs_message_thread_id:${TEST_STAFF_CHAT_ID}`, "153");
    return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:workspace", 10));
    await harness.bot.handleUpdate(privateCallback(1, "workspace:select", 10));
    harness.clearApiCalls();
    harness.failNextApiCall("deleteMessage");
    const update: Update = { update_id: 22, message: { message_id: 22, date: 1, from: { id: 1, is_bot: false, first_name: "Owner" }, chat: { id: 1, type: "private", first_name: "Owner" }, chat_shared: { request_id: 1300, chat_id: TEST_STAFF_CHAT_ID, title: "Staff" } } };
    await harness.bot.handleUpdate(update);
    assert.equal(harness.countApiCalls("deleteMessage"), 2);
    assert.equal(harness.countApiCalls("editMessageReplyMarkup"), 0);
    assert.equal(harness.countApiCalls("sendMessage"), 1);
    assert.equal(harness.countApiCalls("createForumTopic"), 0);
    assert.equal(service.getStaffChatId(), TEST_STAFF_CHAT_ID);
  } finally { harness.cleanup(); }
});

test("RBAC keeps group membership boundary and denies AGENT bans", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db); service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 }); service.assignRole(1, 4, "AGENT");
    const preview = service.previewRoleBasedAccessActivation(); service.activateRoleBasedAccess(1, preview.confirmationToken); return service;
  } });
  try {
    const update: Update = { update_id: 30, message: { message_id: 30, date: 1, from: { id: 4, is_bot: false, first_name: "Agent" }, chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Staff" }, text: "/ban 99 test", entities: [{ type: "bot_command", offset: 0, length: 4 }] } };
    await harness.bot.handleUpdate(update);
    assert.equal(harness.db.getBannedUser(99), undefined);
    assert.match(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /does not allow/i);
  } finally { harness.cleanup(); }
});

test("RBAC denies private staff controls without current workspace membership", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 });
    service.assignRole(1, 2, "ADMIN");
    const preview = service.previewRoleBasedAccessActivation();
    service.activateRoleBasedAccess(1, preview.confirmationToken);
    return service;
  } });
  harness.setApiResponseOverride("getChatMember", (call, response) => Number(call.payload.user_id) === 2
    ? { ok: true, result: { status: "left", user: { id: 2, is_bot: false, first_name: "Admin" } } }
    : response);
  try {
    await harness.bot.handleUpdate(privateCallback(2, "dashboard:team"));
    assert.equal(harness.countApiCalls("answerCallbackQuery"), 1);
    assert.match(String(harness.findApiCalls("answerCallbackQuery")[0]?.payload.text), /workspace membership required/i);
    assert.equal(harness.countApiCalls("sendMessage"), 0);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateMessage(2, "ordinary admin text", 11));
    assert.equal(harness.db.listTicketsForUser(2, TEST_STAFF_CHAT_ID).length, 0);
    assert.match(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /workspace membership required/i);
  } finally { harness.cleanup(); }
});

test("legacy RBAC activation remains an explicit owner action after pairing", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    service.assignRole(1, 2, "ADMIN");
    return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "rbac:preview"));
    assert.equal(harness.countApiCalls("answerCallbackQuery"), 1);
    assert.match(String(harness.findApiCalls("editMessageText")[0]?.payload.text), /cutover preview|activate role-based access/i);
    assert.equal(service.getState().authorizationMode, "LEGACY_TRUSTED_GROUP");
  } finally { harness.cleanup(); }
});

test("private invite link provides picker guidance without numeric IDs", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db); service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 }); service.saveOnboardingStage(1, "STAFF_WORKSPACE"); return service;
  } });
  try {
    await harness.bot.handleUpdate(privateMessage(1, "https://t.me/+privateInvite"));
    const text = String(harness.findApiCalls("sendMessage")[0]?.payload.text);
    assert.match(text, /cannot inspect/i); assert.doesNotMatch(text, /chat id/i);
  } finally { harness.cleanup(); }
});
