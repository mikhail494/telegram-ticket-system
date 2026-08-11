import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Update } from "grammy/types";
import { InstallationService } from "../src/installation.js";
import {
  createBotHarness,
  TEST_BOT_IDENTITY,
  type ApiMockSuccess,
  type BotHarness
} from "./helpers/botHarness.js";

const { processPendingWarning } = await import("../src/bot.js");

const STAFF_CHAT = -100900;
const CHAT_A = -100710;
const CHAT_B = -100720;
const OWNER_ID = 41;
const ADMIN_ID = 42;
const USER_ID = 91;
const VIOLATION = "\u043f\u0440\u0438\u0432\u0435\u0442 \u043a\u0430\u043a \u0442\u0432\u043e\u0438 \u0434\u0435\u043b\u0430 \u0441\u0435\u0433\u043e\u0434\u043d\u044f";
const harnesses: BotHarness[] = [];

afterEach(() => {
  for (const harness of harnesses) harness.cleanup();
  harnesses.length = 0;
});

function createHarness(): { harness: BotHarness; installation: InstallationService } {
  let installation!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => {
    installation = new InstallationService(db);
    installation.adoptLegacyInstallation(STAFF_CHAT);
    installation.consumeOwnerPairingToken(installation.createOwnerPairingToken(), { telegramId: OWNER_ID, username: "synthetic_owner" });
    installation.assignRole(OWNER_ID, ADMIN_ID, "ADMIN");
    return installation;
  } });
  harnesses.push(harness);
  return { harness, installation };
}

function manage(harness: BotHarness, chatId: number, enabled: boolean, isForum = true): void {
  const workspaceId = harness.db.getActiveWorkspace()!.id;
  harness.db.upsertManagedPublicChat({ chatId, workspaceId, title: `Community ${Math.abs(chatId)}`, isForum });
  harness.db.setManagedPublicChatModerationEnabled(chatId, enabled);
}

function publicMessage(chatId: number, messageId: number, messageThreadId?: number, userId = USER_ID, text = VIOLATION): Update {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1,
      from: { id: userId, is_bot: false, first_name: "Synthetic User", username: `synthetic_${userId}` },
      chat: { id: chatId, type: "supergroup", title: "Synthetic Community", ...(messageThreadId === undefined ? {} : { is_forum: true as const }) },
      ...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }),
      text
    }
  };
}

function privateCallback(userId: number, data: string, messageId = 1): Update {
  return {
    update_id: messageId,
    callback_query: {
      id: `callback-${messageId}`,
      from: { id: userId, is_bot: false, first_name: "Synthetic Staff", username: `staff_${userId}` },
      chat_instance: "private-test",
      data,
      message: { message_id: messageId, date: 1, chat: { id: userId, type: "private", first_name: "Synthetic Staff" }, text: "Dashboard" }
    }
  };
}

function privateText(userId: number, text: string, messageId = 1): Update {
  return { update_id: messageId, message: { message_id: messageId, date: 1, from: { id: userId, is_bot: false, first_name: "Synthetic Staff" }, chat: { id: userId, type: "private", first_name: "Synthetic Staff" }, text } };
}

function privateStart(userId: number, messageId = 1): Update {
  return { update_id: messageId, message: { message_id: messageId, date: 1, from: { id: userId, is_bot: false, first_name: "Synthetic Staff" }, chat: { id: userId, type: "private", first_name: "Synthetic Staff" }, text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] } };
}

function healthyBotMember(): ApiMockSuccess {
  return { ok: true, result: { status: "administrator", user: TEST_BOT_IDENTITY, can_manage_chat: true, can_delete_messages: true, can_restrict_members: true } };
}

function setReachablePublicChat(harness: BotHarness, chatId: number): void {
  harness.setApiResponseOverride("getChat", (_call, success) => ({ ...success, result: { id: chatId, type: "supergroup", title: "Synthetic Public Chat", username: "synthetic_public", is_forum: true, available_reactions: [] } }));
  harness.setApiResponseOverride("getChatMember", (call, success) => call.payload.user_id === TEST_BOT_IDENTITY.id
    ? healthyBotMember()
    : success);
}

async function makeWarningDue(harness: BotHarness, chatId: number, threadId: number | null): Promise<void> {
  const state = harness.db.getLanguageModerationWarningState(chatId, threadId)!;
  harness.db.upsertLanguageModerationWarningState(chatId, threadId, {
    lastWarningMessageId: state.last_warning_message_id,
    lastWarningAt: state.last_warning_at,
    ordinaryMessagesSinceWarning: state.ordinary_messages_since_warning,
    pendingWarningDueAt: new Date(0).toISOString(),
    pendingWarningStartedAt: state.pending_warning_started_at
  });
  await processPendingWarning(harness.bot.api, harness.db, chatId, threadId);
}

describe("multi-public-chat moderation", () => {
  it("moderates enabled chats independently and ignores unmanaged or disabled chats", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, true);
    manage(harness, CHAT_B, false);

    await harness.bot.handleUpdate(publicMessage(CHAT_A, 1));
    await harness.bot.handleUpdate(publicMessage(CHAT_B, 2));
    await harness.bot.handleUpdate(publicMessage(-100730, 3));
    await makeWarningDue(harness, CHAT_A, null);

    assert.equal(harness.db.getLanguageModerationUserState(CHAT_A, USER_ID)?.current_strikes, 1);
    assert.equal(harness.db.getLanguageModerationUserState(CHAT_B, USER_ID), undefined);
    assert.equal(harness.db.getLanguageModerationUserState(-100730, USER_ID), undefined);
  });

  it("does not revive a removed legacy target through global-setting fallback", async () => {
    const { harness } = createHarness();
    harness.db.setSetting("language_moderation:target", String(CHAT_A));
    harness.db.setSetting("language_moderation:enabled", "true");
    manage(harness, CHAT_A, true);
    harness.db.deactivateManagedPublicChat(CHAT_A);

    await harness.bot.handleUpdate(publicMessage(CHAT_A, 1));

    assert.equal(harness.db.getLanguageModerationUserState(CHAT_A, USER_ID), undefined);
    assert.equal(harness.db.listLanguageModerationViolations(CHAT_A, "1970-01-01T00:00:00.000Z").length, 0);
  });

  it("keeps sanction ladders independent between managed chats", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, true);
    manage(harness, CHAT_B, true);
    harness.db.upsertLanguageModerationUserState({ chat_id: CHAT_A, user_telegram_id: USER_ID, username: null, current_strikes: 1, sanction_tier: 2, first_strike_at: new Date().toISOString() });

    await harness.bot.handleUpdate(publicMessage(CHAT_B, 1));
    await makeWarningDue(harness, CHAT_B, null);

    assert.equal(harness.db.getLanguageModerationUserState(CHAT_A, USER_ID)?.sanction_tier, 2);
    assert.equal(harness.db.getLanguageModerationUserState(CHAT_B, USER_ID)?.sanction_tier, 0);
  });

  it("disables only the affected managed chat when core enforcement fails", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, true);
    manage(harness, CHAT_B, true);
    harness.db.upsertLanguageModerationUserState({
      chat_id: CHAT_A,
      user_telegram_id: USER_ID,
      username: null,
      current_strikes: 2,
      sanction_tier: 0,
      first_strike_at: new Date().toISOString()
    });
    harness.failNextApiCall("restrictChatMember");

    await harness.bot.handleUpdate(publicMessage(CHAT_A, 1));

    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.moderation_enabled, 0);
    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.permission_status, "UNHEALTHY");
    assert.equal(harness.db.getManagedPublicChat(CHAT_B)?.moderation_enabled, 1);
    assert.equal(harness.db.getLanguageModerationUserState(CHAT_A, USER_ID)?.sanction_tier, 0);
  });

  it("sends grouped warnings into their originating forum topics", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, true);
    await harness.bot.handleUpdate(publicMessage(CHAT_A, 1, 101, 501));
    await harness.bot.handleUpdate(publicMessage(CHAT_A, 2, 202, 502));
    await makeWarningDue(harness, CHAT_A, 101);
    await makeWarningDue(harness, CHAT_A, 202);

    const warnings = harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === CHAT_A);
    assert.deepEqual(warnings.map((call) => call.payload.message_thread_id), [101, 202]);
  });

  it("retains chat-level strikes when a user moves between topics", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, true);
    await harness.bot.handleUpdate(publicMessage(CHAT_A, 1, 101));
    await makeWarningDue(harness, CHAT_A, 101);
    await harness.bot.handleUpdate(publicMessage(CHAT_A, 2, 202));

    assert.equal(harness.db.getLanguageModerationUserState(CHAT_A, USER_ID)?.current_strikes, 2);
    assert.equal(harness.db.listLanguageModerationViolations(CHAT_A, "1970-01-01T00:00:00.000Z")[1]?.message_thread_id, 202);
  });

  it("clears an empty topic aggregation window after another topic claims the user", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, true);
    await harness.bot.handleUpdate(publicMessage(CHAT_A, 1, 101));
    await harness.bot.handleUpdate(publicMessage(CHAT_A, 2, 202));
    await makeWarningDue(harness, CHAT_A, 101);
    await makeWarningDue(harness, CHAT_A, 202);

    assert.equal(harness.db.getLanguageModerationWarningState(CHAT_A, 202)?.pending_warning_due_at, null);

    await harness.bot.handleUpdate(publicMessage(CHAT_A, 3, 202, USER_ID + 1));
    assert.ok(harness.db.getLanguageModerationWarningState(CHAT_A, 202)?.pending_warning_due_at);
  });

  it("keeps non-forum warning delivery unchanged", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, true, false);
    await harness.bot.handleUpdate(publicMessage(CHAT_A, 1));
    await makeWarningDue(harness, CHAT_A, null);
    const warning = harness.findApiCalls("sendMessage").find((call) => call.payload.chat_id === CHAT_A);
    assert.equal(warning?.payload.message_thread_id, undefined);
  });

  it("OWNER and ADMIN can open the public-chat picker, but junior roles cannot", async () => {
    const { harness, installation } = createHarness();
    installation.assignRole(ADMIN_ID, 43, "SENIOR_AGENT");
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, "public:add", 1));
    await harness.bot.handleUpdate(privateCallback(ADMIN_ID, "public:add", 2));
    await harness.bot.handleUpdate(privateCallback(43, "public:add", 3));

    assert.equal(harness.findApiCalls("sendMessage").filter((call) => String(call.payload.text).includes("Choose a public supergroup")).length, 2);
    const denied = harness.findApiCalls("answerCallbackQuery").find((call) => call.payload.callback_query_id === "callback-3");
    assert.equal(denied?.payload.show_alert, true);
    const picker = harness.findApiCalls("sendMessage")[0]?.payload.reply_markup as { keyboard?: Array<Array<{ request_chat?: { request_id?: number; chat_is_forum?: boolean } }>> };
    assert.equal(picker.keyboard?.[0]?.[0]?.request_chat?.request_id, 1400);
    assert.equal(picker.keyboard?.[0]?.[0]?.request_chat?.chat_is_forum, undefined);
  });

  it("retires the active private screen before opening the public-chat picker", async () => {
    const { harness } = createHarness();

    await harness.bot.handleUpdate(privateCallback(OWNER_ID, "public:add", 100));

    assert.equal(harness.findApiCalls("deleteMessage")[0]?.payload.message_id, 100);
    assert.equal(harness.countApiCalls("sendMessage"), 1);
    assert.match(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /Choose a public supergroup/);
  });

  it("adds a native-picker chat disabled and records advisory reaction health", async () => {
    const { harness } = createHarness();
    setReachablePublicChat(harness, CHAT_A);
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, "public:add"));
    await harness.bot.handleUpdate({ update_id: 2, message: { message_id: 2, date: 1, from: { id: OWNER_ID, is_bot: false, first_name: "Owner" }, chat: { id: OWNER_ID, type: "private", first_name: "Owner" }, chat_shared: { request_id: 1400, chat_id: CHAT_A, title: "Synthetic Public Chat", username: "synthetic_public" } } });

    const chat = harness.db.getManagedPublicChat(CHAT_A);
    assert.equal(chat?.moderation_enabled, 0);
    assert.equal(chat?.permission_status, "HEALTHY");
    assert.equal(chat?.reaction_status, "UNAVAILABLE");
    assert.equal(chat?.connection_status, "CONNECTED");
    assert.match(String(harness.findApiCalls("editMessageText").at(-1)?.payload.text), /Connected: yes/);
  });

  it("reuses the visible keyboard-removal message as the public-chat settings screen after a shared chat", async () => {
    const { harness } = createHarness();
    setReachablePublicChat(harness, CHAT_A);
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, "public:add", 100));
    const pickerPromptId = harness.findApiCalls("sendMessage")[0]!.responseMessageId!;
    harness.clearApiCalls();

    await harness.bot.handleUpdate({ update_id: 2, message: { message_id: 2, date: 1, from: { id: OWNER_ID, is_bot: false, first_name: "Owner" }, chat: { id: OWNER_ID, type: "private", first_name: "Owner" }, chat_shared: { request_id: 1400, chat_id: CHAT_A, title: "Synthetic Public Chat", username: "synthetic_public" } } });

    assert.ok(harness.db.getManagedPublicChat(CHAT_A));
    assert.equal(harness.findApiCalls("deleteMessage")[0]?.payload.message_id, pickerPromptId);
    const keyboardRemoval = harness.findApiCalls("sendMessage");
    assert.equal(keyboardRemoval.length, 1);
    assert.equal((keyboardRemoval[0]?.payload.reply_markup as { remove_keyboard?: boolean }).remove_keyboard, true);
    assert.equal(keyboardRemoval[0]?.payload.text, "Updating...");
    assert.doesNotMatch(String(keyboardRemoval[0]?.payload.text), /Public chat saved/i);
    const settings = harness.findApiCalls("editMessageText");
    assert.equal(settings.length, 1);
    assert.equal(settings[0]?.payload.message_id, keyboardRemoval[0]?.responseMessageId);
    assert.match(String(settings[0]?.payload.text), /Public chat settings/);
    assert.match(String(settings[0]?.payload.text), /Public chat saved\. Moderation remains disabled/);
  });

  it("retires a failed temporary keyboard-removal message before sending fresh public-chat settings", async () => {
    const { harness } = createHarness();
    setReachablePublicChat(harness, CHAT_A);
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, "public:add", 100));
    harness.clearApiCalls();
    harness.failNextApiCall("editMessageText");

    await harness.bot.handleUpdate({ update_id: 2, message: { message_id: 2, date: 1, from: { id: OWNER_ID, is_bot: false, first_name: "Owner" }, chat: { id: OWNER_ID, type: "private", first_name: "Owner" }, chat_shared: { request_id: 1400, chat_id: CHAT_A, title: "Synthetic Public Chat", username: "synthetic_public" } } });

    const sent = harness.findApiCalls("sendMessage");
    const temporary = sent.find((call) => call.payload.text === "Updating...");
    const settings = sent.find((call) => String(call.payload.text).includes("Public chat settings"));
    assert.ok(temporary);
    assert.ok(settings);
    assert.ok(harness.findApiCalls("deleteMessage").some((call) => call.payload.message_id === temporary.responseMessageId));
    assert.equal(harness.findApiCalls("editMessageText").length, 1);
    assert.equal(sent.filter((call) => String(call.payload.text).includes("Public chat settings")).length, 1);
  });

  it("resolves public usernames and links while guiding private invite links back to the picker", async () => {
    const { harness } = createHarness();
    setReachablePublicChat(harness, CHAT_A);
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, "public:add"));
    await harness.bot.handleUpdate(privateText(OWNER_ID, "@synthetic_public", 2));
    assert.ok(harness.db.getManagedPublicChat(CHAT_A));
    assert.ok(harness.findApiCalls("getChat").some((call) => call.payload.chat_id === "@synthetic_public"));
    let currentMessageId = Number(harness.findApiCalls("editMessageText").at(-1)?.payload.message_id);

    harness.db.deactivateManagedPublicChat(CHAT_A);
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, "public:add", currentMessageId));
    await harness.bot.handleUpdate(privateText(OWNER_ID, "https://t.me/synthetic_public", 4));
    assert.ok(harness.db.getManagedPublicChat(CHAT_A));
    currentMessageId = Number(harness.findApiCalls("editMessageText").at(-1)?.payload.message_id);

    harness.db.deactivateManagedPublicChat(CHAT_A);
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, "public:add", currentMessageId));
    await harness.bot.handleUpdate(privateText(OWNER_ID, "https://t.me/+syntheticInvite", 6));
    const guidance = harness.findApiCalls("editMessageText").at(-1);
    assert.match(String(guidance?.payload.text), /cannot inspect/i);
    assert.doesNotMatch(String(guidance?.payload.text), /enter.*chat id/i);
  });

  it("records an unreachable configured chat without crashing or changing another chat", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, false);
    manage(harness, CHAT_B, true);
    harness.failNextApiCall("getChat");

    await harness.bot.handleUpdate(privateCallback(OWNER_ID, `public:check:${CHAT_A}`, 1));

    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.connection_status, "UNREACHABLE");
    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.permission_status, "UNHEALTHY");
    assert.equal(harness.db.getManagedPublicChat(CHAT_B)?.moderation_enabled, 1);
  });

  it("keeps permission checks and enablement inside the managed settings screen", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, false);
    setReachablePublicChat(harness, CHAT_A);

    await harness.bot.handleUpdate(privateCallback(OWNER_ID, `public:check:${CHAT_A}`, 100));
    assert.equal(harness.countApiCalls("sendMessage"), 0);
    assert.equal(harness.countApiCalls("editMessageText"), 1);
    assert.match(String(harness.findApiCalls("editMessageText")[0]?.payload.text), /Permissions checked: healthy\./);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, `public:enable:${CHAT_A}`, 100));
    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.moderation_enabled, 1);
    assert.equal(harness.countApiCalls("sendMessage"), 0);
    assert.equal(harness.countApiCalls("editMessageText"), 1);
    assert.match(String(harness.findApiCalls("editMessageText")[0]?.payload.text), /Moderation enabled\. Permissions are healthy\./);
  });

  it("cancels a public-chat picker without leaving its keyboard or pending selection active", async () => {
    const { harness } = createHarness();
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, "public:add", 100));
    const pickerPromptId = harness.findApiCalls("sendMessage")[0]!.responseMessageId!;
    harness.clearApiCalls();

    await harness.bot.handleUpdate(privateText(OWNER_ID, "Cancel public chat selection", 2));

    assert.equal(harness.findApiCalls("deleteMessage")[0]?.payload.message_id, pickerPromptId);
    assert.equal((harness.findApiCalls("sendMessage")[0]?.payload.reply_markup as { remove_keyboard?: boolean }).remove_keyboard, true);
    assert.match(String(harness.findApiCalls("editMessageText")[0]?.payload.text), /Public chats/);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateText(OWNER_ID, "@synthetic_public", 3));
    assert.equal(harness.countApiCalls("getChat"), 0);
  });

  it("cleans a pending public-chat picker before rendering a fresh dashboard for /start", async () => {
    const { harness } = createHarness();
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, "public:add", 100));
    const pickerPromptId = harness.findApiCalls("sendMessage")[0]!.responseMessageId!;
    harness.clearApiCalls();

    await harness.bot.handleUpdate(privateStart(OWNER_ID, 2));

    assert.equal(harness.findApiCalls("deleteMessage")[0]?.payload.message_id, pickerPromptId);
    assert.equal((harness.findApiCalls("sendMessage")[0]?.payload.reply_markup as { remove_keyboard?: boolean }).remove_keyboard, true);
    assert.match(String(harness.findApiCalls("sendMessage").at(-1)?.payload.text), /Owner dashboard/);
  });

  it("prevents enablement until core permissions recover, regardless of reactions", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, false);
    harness.setApiResponseOverride("getChatMember", (call, success) => call.payload.user_id === TEST_BOT_IDENTITY.id
      ? { ...healthyBotMember(), result: { ...(healthyBotMember().result as object), can_restrict_members: false } }
      : success);
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, `public:enable:${CHAT_A}`, 1));
    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.moderation_enabled, 0);

    setReachablePublicChat(harness, CHAT_A);
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, `public:enable:${CHAT_A}`, 1));
    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.moderation_enabled, 1);
    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.reaction_status, "UNAVAILABLE");
  });

  it("removal requires confirmation and preserves strikes", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, true);
    harness.db.upsertLanguageModerationUserState({ chat_id: CHAT_A, user_telegram_id: USER_ID, username: null, current_strikes: 2, sanction_tier: 1, first_strike_at: new Date().toISOString() });
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, `public:remove:${CHAT_A}`, 1));
    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.active, 1);
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, `public:confirm-remove:${CHAT_A}`, 1));
    assert.equal(harness.db.getManagedPublicChat(CHAT_A), undefined);
    assert.equal(harness.db.getLanguageModerationUserState(CHAT_A, USER_ID)?.sanction_tier, 1);
  });

  it("OWNER configuration prompts update only the selected public chat", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, false);
    manage(harness, CHAT_B, false);
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, `public:config-warning:${CHAT_A}`, 1));
    await harness.bot.handleUpdate(privateText(OWNER_ID, "Synthetic warning A", 2));
    const currentMessageId = harness.findApiCalls("sendMessage").at(-1)?.responseMessageId!;
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, `public:config-cooldown:${CHAT_A}`, currentMessageId));
    await harness.bot.handleUpdate(privateText(OWNER_ID, "23", 4));

    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.warning_text, "Synthetic warning A");
    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.warning_cooldown_minutes, 23);
    assert.notEqual(harness.db.getManagedPublicChat(CHAT_B)?.warning_text, "Synthetic warning A");
    assert.equal(harness.db.getManagedPublicChat(CHAT_B)?.warning_cooldown_minutes, 10);
  });

  it("explains public-chat settings and returns one fresh settings screen after validated input", async () => {
    const { harness } = createHarness();
    manage(harness, CHAT_A, false);

    await harness.bot.handleUpdate(privateCallback(OWNER_ID, `public:config-cooldown:${CHAT_A}`, 1));
    const prompt = harness.findApiCalls("sendMessage").at(-1)!;
    assert.match(String(prompt.payload.text), /minimum time after a warning/i);
    assert.match(String(prompt.payload.text), /Current value: 10 minutes/i);
    assert.match(String(prompt.payload.text), /Example: 30/i);
    assert.equal(harness.countApiCalls("deleteMessage"), 1);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateText(OWNER_ID, "0", 2));
    assert.equal(harness.countApiCalls("sendMessage"), 0);
    assert.match(String(harness.findApiCalls("editMessageText")[0]?.payload.text), /whole number from 1 to 1440/i);
    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.warning_cooldown_minutes, 10);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateText(OWNER_ID, "30", 3));
    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.warning_cooldown_minutes, 30);
    assert.equal(harness.countApiCalls("deleteMessage"), 1);
    assert.equal(harness.countApiCalls("sendMessage"), 1);
    assert.match(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /Warning cooldown: 30 minutes/);

    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateCallback(OWNER_ID, `public:config-warning:${CHAT_A}`, 1));
    assert.match(String(harness.findApiCalls("answerCallbackQuery")[0]?.payload.text), /no longer active/i);
    assert.equal(harness.db.getManagedPublicChat(CHAT_A)?.warning_text, "Please use English in the main chat. Further violations may be reviewed by an authorized moderator under the current community policy.");
  });

});
