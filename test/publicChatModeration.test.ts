import assert from "node:assert/strict";
import test from "node:test";
import { SupportDatabase } from "../src/db.js";
import {
  formatPublicChatPermissionChecklist,
  validatePublicModerationChat
} from "../src/publicChatModeration.js";
import { createBotHarness, TEST_BOT_IDENTITY } from "./helpers/botHarness.js";

const STAFF_CHAT_ID = -100500;
const CHAT_A = -100701;
const CHAT_B = -100702;

function seedWorkspace(db: SupportDatabase): number {
  return db.upsertWorkspace({ telegramChatId: STAFF_CHAT_ID, title: "Synthetic staff workspace" }).id;
}

test("managed public chats keep independent moderation configuration", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const workspaceId = seedWorkspace(db);
    db.upsertManagedPublicChat({
      chatId: CHAT_A,
      workspaceId,
      title: "Community A",
      username: "community_a",
      isForum: true
    });
    db.upsertManagedPublicChat({
      chatId: CHAT_B,
      workspaceId,
      title: "Community B",
      username: "community_b",
      isForum: false
    });
    db.updateManagedPublicChatConfig(CHAT_A, {
      warningText: "Warning A",
      allowlist: ["alpha"],
      warningCooldownMinutes: 7,
      warningMessageThreshold: 11,
      lookbackMinutes: 4
    });
    db.updateManagedPublicChatConfig(CHAT_B, {
      warningText: "Warning B",
      allowlist: ["beta"],
      warningCooldownMinutes: 17,
      warningMessageThreshold: 21,
      lookbackMinutes: 9
    });
    db.setManagedPublicChatModerationEnabled(CHAT_A, true);

    const first = db.getManagedPublicChat(CHAT_A);
    const second = db.getManagedPublicChat(CHAT_B);
    assert.equal(first?.moderation_enabled, 1);
    assert.equal(second?.moderation_enabled, 0);
    assert.equal(first?.warning_text, "Warning A");
    assert.equal(second?.warning_text, "Warning B");
    assert.deepEqual(first?.allowlist, ["alpha"]);
    assert.deepEqual(second?.allowlist, ["beta"]);
    assert.equal(first?.is_forum, 1);
    assert.equal(second?.is_forum, 0);
    assert.equal(db.listManagedPublicChats().length, 2);
  } finally {
    db.close();
  }
});

test("removing management deactivates a chat without deleting moderation history", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const workspaceId = seedWorkspace(db);
    db.upsertManagedPublicChat({ chatId: CHAT_A, workspaceId, title: "Community A" });
    db.upsertLanguageModerationUserState({
      chat_id: CHAT_A,
      user_telegram_id: 91,
      username: "synthetic_user",
      current_strikes: 2,
      sanction_tier: 1,
      first_strike_at: "2026-08-09T00:00:00.000Z"
    });

    assert.equal(db.deactivateManagedPublicChat(CHAT_A), true);
    assert.equal(db.getManagedPublicChat(CHAT_A), undefined);
    assert.equal(db.getManagedPublicChat(CHAT_A, true)?.active, 0);
    assert.equal(db.getLanguageModerationUserState(CHAT_A, 91)?.sanction_tier, 1);
  } finally {
    db.close();
  }
});

test("warning state is independent per forum topic while strikes remain chat scoped", () => {
  const db = new SupportDatabase(":memory:");
  try {
    db.upsertLanguageModerationWarningState(CHAT_A, 101, {
      lastWarningMessageId: 501,
      lastWarningAt: "2026-08-09T00:00:00.000Z",
      ordinaryMessagesSinceWarning: 3
    });
    db.upsertLanguageModerationWarningState(CHAT_A, 202, {
      lastWarningMessageId: 502,
      lastWarningAt: "2026-08-09T00:01:00.000Z",
      ordinaryMessagesSinceWarning: 8
    });
    db.upsertLanguageModerationUserState({
      chat_id: CHAT_A,
      user_telegram_id: 55,
      username: null,
      current_strikes: 1,
      sanction_tier: 0,
      first_strike_at: "2026-08-09T00:00:00.000Z"
    });

    assert.equal(db.getLanguageModerationWarningState(CHAT_A, 101)?.last_warning_message_id, 501);
    assert.equal(db.getLanguageModerationWarningState(CHAT_A, 202)?.ordinary_messages_since_warning, 8);
    assert.equal(db.getLanguageModerationUserState(CHAT_A, 55)?.current_strikes, 1);
  } finally {
    db.close();
  }
});

test("violations persist their originating forum topic", () => {
  const db = new SupportDatabase(":memory:");
  try {
    assert.equal(db.addLanguageModerationViolation({
      chat_id: CHAT_A,
      user_telegram_id: 55,
      message_id: 800,
      message_thread_id: 404,
      username: null,
      cycle_tier: 0
    }), true);
    assert.equal(db.listLanguageModerationViolations(CHAT_A, "1970-01-01T00:00:00.000Z")[0]?.message_thread_id, 404);
  } finally {
    db.close();
  }
});

test("public moderation permission checks keep reactions advisory", async () => {
  const harness = createBotHarness();
  try {
    harness.setApiResponseOverride("getChat", (_call, success) => ({
      ...success,
      result: {
        id: CHAT_A,
        type: "supergroup",
        title: "Synthetic forum",
        username: "synthetic_forum",
        is_forum: true,
        available_reactions: []
      }
    }));
    harness.setApiResponseOverride("getChatMember", (call, success) => {
      if (call.payload.user_id !== TEST_BOT_IDENTITY.id) return success;
      return {
        ...success,
        result: {
          status: "administrator",
          user: TEST_BOT_IDENTITY,
          can_manage_chat: true,
          can_delete_messages: true,
          can_restrict_members: true
        }
      };
    });

    const result = await validatePublicModerationChat(harness.bot.api, CHAT_A, TEST_BOT_IDENTITY.id);
    assert.equal(result.valid, true);
    assert.equal(result.reactionsAvailable, false);
    assert.match(formatPublicChatPermissionChecklist(result), /Reactions: unavailable/);
  } finally {
    harness.cleanup();
  }
});

test("custom or paid reactions do not imply moderation emoji availability", async () => {
  const harness = createBotHarness();
  try {
    harness.setApiResponseOverride("getChat", (_call, success) => ({
      ...success,
      result: {
        id: CHAT_A,
        type: "supergroup",
        title: "Synthetic forum",
        available_reactions: [
          { type: "custom_emoji", custom_emoji_id: "synthetic-custom-emoji" },
          { type: "paid" }
        ]
      }
    }));
    harness.setApiResponseOverride("getChatMember", (call, success) => call.payload.user_id === TEST_BOT_IDENTITY.id
      ? {
          ...success,
          result: {
            status: "administrator",
            user: TEST_BOT_IDENTITY,
            can_manage_chat: true,
            can_delete_messages: true,
            can_restrict_members: true
          }
        }
      : success);

    const result = await validatePublicModerationChat(harness.bot.api, CHAT_A, TEST_BOT_IDENTITY.id);
    assert.equal(result.valid, true);
    assert.equal(result.reactionsAvailable, false);
  } finally {
    harness.cleanup();
  }
});

test("reaction advisory reports available only when both moderation emojis are allowed", async () => {
  const harness = createBotHarness();
  try {
    let availableReactions: Array<{ type: "emoji"; emoji: "👀" | "😡" }> = [{ type: "emoji", emoji: "👀" }];
    harness.setApiResponseOverride("getChat", (_call, success) => ({
      ...success,
      result: { id: CHAT_A, type: "supergroup", title: "Synthetic forum", available_reactions: availableReactions }
    }));
    harness.setApiResponseOverride("getChatMember", (call, success) => call.payload.user_id === TEST_BOT_IDENTITY.id
      ? { ...success, result: { status: "administrator", user: TEST_BOT_IDENTITY, can_manage_chat: true, can_delete_messages: true, can_restrict_members: true } }
      : success);

    assert.equal((await validatePublicModerationChat(harness.bot.api, CHAT_A, TEST_BOT_IDENTITY.id)).reactionsAvailable, false);
    availableReactions = [{ type: "emoji", emoji: "👀" }, { type: "emoji", emoji: "😡" }];
    assert.equal((await validatePublicModerationChat(harness.bot.api, CHAT_A, TEST_BOT_IDENTITY.id)).reactionsAvailable, true);
  } finally {
    harness.cleanup();
  }
});

test("dashboard counts disabled unhealthy managed chats", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const workspaceId = seedWorkspace(db);
    db.upsertManagedPublicChat({ chatId: CHAT_A, workspaceId, title: "Community A" });
    db.recordManagedPublicChatPermissionHealth({ chatId: CHAT_A, healthy: false, reactionsAvailable: null, connected: true });
    assert.equal(db.getInstallationOperationalCounts().unhealthyModerationChats, 1);
  } finally {
    db.close();
  }
});

test("permission refresh can clear stale optional Telegram metadata", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const workspaceId = seedWorkspace(db);
    db.upsertManagedPublicChat({ chatId: CHAT_A, workspaceId, title: "Community A", username: "old_username" });
    db.recordManagedPublicChatPermissionHealth({
      chatId: CHAT_A,
      healthy: true,
      reactionsAvailable: true,
      connected: true,
      title: "Community A",
      username: null,
      isForum: false
    });
    assert.equal(db.getManagedPublicChat(CHAT_A)?.username, null);
    assert.equal(db.getManagedPublicChat(CHAT_A)?.connection_status, "CONNECTED");
  } finally {
    db.close();
  }
});

test("missing core enforcement rights make a public chat unhealthy", async () => {
  const harness = createBotHarness();
  try {
    harness.setApiResponseOverride("getChatMember", (call, success) => {
      if (call.payload.user_id !== TEST_BOT_IDENTITY.id) return success;
      return {
        ...success,
        result: {
          status: "administrator",
          user: TEST_BOT_IDENTITY,
          can_manage_chat: true,
          can_delete_messages: true,
          can_restrict_members: false
        }
      };
    });

    const result = await validatePublicModerationChat(harness.bot.api, CHAT_A, TEST_BOT_IDENTITY.id);
    assert.equal(result.valid, false);
    assert.match(formatPublicChatPermissionChecklist(result), /Restrict and ban members/);
  } finally {
    harness.cleanup();
  }
});
