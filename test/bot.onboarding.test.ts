import test from "node:test";
import assert from "node:assert/strict";
import type { Update } from "grammy/types";
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
    assert.match(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /Owner dashboard/);
  } finally { harness.cleanup(); }
});

test("owner dashboard recognizes the scoped Support Logs topic", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    db.setSetting(`support_logs_message_thread_id:${TEST_STAFF_CHAT_ID}`, "153");
    return service;
  } });
  try {
    await harness.bot.handleUpdate(privateMessage(1, "ordinary owner text"));
    const dashboard = String(harness.findApiCalls("sendMessage")[0]?.payload.text);
    assert.match(dashboard, /Support Logs: configured/);
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

test("ChatShared stores workspace only after centralized validation", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db); service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 }); return service;
  } });
  try {
    const update: Update = { update_id: 20, message: { message_id: 20, date: 1, from: { id: 1, is_bot: false, first_name: "Owner" }, chat: { id: 1, type: "private", first_name: "Owner" }, chat_shared: { request_id: 1300, chat_id: -100777, title: "Support", username: "support_team" } } };
    await harness.bot.handleUpdate(update);
    assert.equal(service.getStaffChatId(), -100777);
    assert.equal(harness.countApiCalls("createForumTopic"), 1);
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

test("RBAC activation preview explains the legacy cutover and retained roles", async () => {
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
    const preview = String(harness.findApiCalls("sendMessage")[0]?.payload.text);
    assert.match(preview, /Current authorization: LEGACY_TRUSTED_GROUP/);
    assert.match(preview, /OWNER: @owner/);
    assert.match(preview, /ADMIN: user_2/);
    assert.match(preview, /Unassigned staff-group participants will lose staff access/);
    assert.match(preview, /Telegram staff-workspace membership remains required/);
    const markup = harness.findApiCalls("sendMessage")[0]?.payload.reply_markup as {
      inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
    };
    const buttons = markup.inline_keyboard?.flat() ?? [];
    const activationData = buttons.find((button) => button.text === "Activate role-based access")?.callback_data ?? "";
    assert.match(activationData, /^rbac:activate:/);
    assert.equal(buttons.find((button) => button.text === "Cancel")?.callback_data, "rbac:cancel");

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, "rbac:cancel", 11));
    assert.equal(harness.countApiCalls("answerCallbackQuery"), 1);
    assert.equal(service.getState().authorizationMode, "LEGACY_TRUSTED_GROUP");

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(1, activationData, 12));
    assert.equal(service.getState().authorizationMode, "LEGACY_TRUSTED_GROUP");
  } finally { harness.cleanup(); }
});

test("RBAC activation preview stays within Telegram message limits for a large team", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    service = new InstallationService(db);
    service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    for (let userId = 2; userId <= 300; userId += 1) service.assignRole(1, userId, "AGENT");
    return service;
  } });
  try {
    await harness.bot.handleUpdate(privateCallback(1, "rbac:preview"));
    const previewMessages = harness.findApiCalls("sendMessage");
    assert.ok(previewMessages.length > 1);
    assert.ok(previewMessages.every((call) => String(call.payload.text).length <= 4096));
    assert.match(previewMessages.map((call) => String(call.payload.text)).join("\n"), /AGENT: user_300/);
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
