import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Update } from "grammy/types";
import { InstallationService } from "../src/installation.js";
import { TEST_BOT_IDENTITY, TEST_STAFF_CHAT_ID, createBotHarness, type BotHarness } from "./helpers/botHarness.js";

const OWNER_ID = 41;
const PUBLIC_CHAT_A = -100701;
const PUBLIC_CHAT_B = -100702;
const USER_ID = 501;
const FIXED_NOW = new Date("2026-09-04T08:00:00.000Z");
const harnesses: BotHarness[] = [];

afterEach(() => {
  for (const harness of harnesses) {
    harness.bot.stopBackgroundWork();
    harness.cleanup();
  }
  harnesses.length = 0;
});

function createHarness(): { harness: BotHarness; installation: InstallationService } {
  let installation!: InstallationService;
  const harness = createBotHarness({
    moderationNow: () => FIXED_NOW,
    installationServiceFactory: (db) => {
      installation = new InstallationService(db);
      installation.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
      installation.consumeOwnerPairingToken(installation.createOwnerPairingToken(), {
        telegramId: OWNER_ID,
        username: "synthetic_owner",
      });
      installation.assignRole(OWNER_ID, 42, "ADMIN");
      installation.assignRole(OWNER_ID, 43, "SENIOR_AGENT");
      installation.assignRole(OWNER_ID, 44, "AGENT");
      return installation;
    },
  });
  harnesses.push(harness);
  manage(harness, PUBLIC_CHAT_A, true);
  manage(harness, PUBLIC_CHAT_B, true);
  return { harness, installation };
}

function manage(harness: BotHarness, chatId: number, enabled: boolean): void {
  const workspaceId = harness.db.getActiveWorkspace()!.id;
  harness.db.upsertManagedPublicChat({ chatId, workspaceId, title: `Community ${Math.abs(chatId)}` });
  harness.db.setManagedPublicChatModerationEnabled(chatId, enabled);
}

function publicMessage(
  messageId: number,
  options: {
    chatId?: number;
    userId?: number;
    username?: string;
    text?: string;
    threadId?: number;
    isBot?: boolean;
    contentType?: "text" | "photo" | "sticker" | "service";
    caption?: string;
    senderChat?: boolean;
  } = {}
): Update {
  const chatId = options.chatId ?? PUBLIC_CHAT_A;
  const userId = options.userId ?? USER_ID;
  const content =
    options.contentType === "photo"
      ? {
          photo: [
            { file_id: `photo-${messageId}`, file_unique_id: `photo-unique-${messageId}`, width: 100, height: 100 },
          ],
          ...(options.caption === undefined ? {} : { caption: options.caption }),
        }
      : options.contentType === "sticker"
        ? {
            sticker: {
              file_id: `sticker-${messageId}`,
              file_unique_id: `sticker-unique-${messageId}`,
              type: "regular" as const,
              width: 100,
              height: 100,
              is_animated: false,
              is_video: false,
            },
          }
        : options.contentType === "service"
          ? { new_chat_title: "Renamed Community" }
          : { text: options.text ?? "ordinary English chat message" };
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(FIXED_NOW.getTime() / 1000),
      from: {
        id: userId,
        is_bot: options.isBot ?? false,
        first_name: "Synthetic User",
        username: options.username ?? `synthetic_${userId}`,
      },
      chat: { id: chatId, type: "supergroup", title: "Synthetic Community" },
      ...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }),
      ...(options.senderChat
        ? { sender_chat: { id: chatId, type: "supergroup" as const, title: "Anonymous Community" } }
        : {}),
      ...content,
    },
  };
}

function reactionUpdate(
  updateId: number,
  messageId: number,
  options: {
    actorId?: number;
    actorIsBot?: boolean;
    actorChat?: boolean;
    chatId?: number;
    chatType?: "supergroup" | "private";
    oldEyes?: boolean;
    newEyes?: boolean;
    extraEmoji?: boolean;
    reaction?: "👀" | "🔥" | "👍";
    oldReaction?: "👀" | "🔥" | "👍";
  } = {}
): Update {
  const chatId = options.chatId ?? PUBLIC_CHAT_A;
  const chat =
    options.chatType === "private"
      ? { id: chatId, type: "private" as const, first_name: "Private" }
      : { id: chatId, type: "supergroup" as const, title: "Synthetic Community" };
  const trigger = options.reaction ?? "👀";
  const previous = options.oldReaction ?? (options.oldEyes ? "👀" : undefined);
  const oldReaction = previous ? [{ type: "emoji" as const, emoji: previous }] : [];
  const newReaction = [
    ...(options.newEyes === false ? [] : [{ type: "emoji" as const, emoji: trigger }]),
    ...(options.extraEmoji ? [{ type: "emoji" as const, emoji: "🔥" as const }] : []),
  ];
  return {
    update_id: updateId,
    message_reaction: {
      chat,
      message_id: messageId,
      date: Math.floor(FIXED_NOW.getTime() / 1000),
      old_reaction: oldReaction,
      new_reaction: newReaction,
      ...(options.actorChat
        ? { actor_chat: { id: -100999, type: "supergroup" as const, title: "Anonymous Admin" } }
        : { user: { id: options.actorId ?? OWNER_ID, is_bot: options.actorIsBot ?? false, first_name: "Reactor" } }),
    },
  };
}

describe("OWNER manual moderation reaction", () => {
  it("maps an eligible public message and immediately advances one existing strike", async () => {
    const { harness } = createHarness();

    await harness.bot.handleUpdate(publicMessage(81, { threadId: 7, username: "original_user" }));
    assert.deepEqual(
      { ...harness.db.getLanguageModerationMessageAuthor(PUBLIC_CHAT_A, 81), created_at: undefined },
      {
        chat_id: PUBLIC_CHAT_A,
        message_id: 81,
        user_telegram_id: USER_ID,
        username: "original_user",
        message_thread_id: 7,
        created_at: undefined,
      }
    );

    harness.clearApiCalls();
    await harness.bot.handleUpdate(reactionUpdate(9001, 81, { extraEmoji: true }));

    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.current_strikes, 1);
    assert.equal(harness.db.listLanguageModerationViolations(PUBLIC_CHAT_A, "1970-01-01T00:00:00.000Z").length, 1);
    assert.equal(harness.countApiCalls("setMessageReaction"), 0);
  });

  it("maps text and captioned or media-only ordinary user messages", async () => {
    const { harness } = createHarness();

    await harness.bot.handleUpdate(publicMessage(82, { text: "plain text" }));
    await harness.bot.handleUpdate(publicMessage(83, { contentType: "photo", caption: "photo caption" }));
    await harness.bot.handleUpdate(publicMessage(84, { contentType: "photo" }));
    await harness.bot.handleUpdate(publicMessage(85, { contentType: "sticker" }));

    for (const messageId of [82, 83, 84, 85]) {
      const mapping = harness.db.getLanguageModerationMessageAuthor(PUBLIC_CHAT_A, messageId);
      assert.equal(mapping?.user_telegram_id, USER_ID);
      assert.deepEqual(Object.keys(mapping ?? {}).sort(), [
        "chat_id",
        "created_at",
        "message_id",
        "message_thread_id",
        "user_telegram_id",
        "username",
      ]);
    }
    assert.ok(harness.db.getLanguageModerationMessageFeatures(PUBLIC_CHAT_A, 82));
    assert.ok(harness.db.getLanguageModerationMessageFeatures(PUBLIC_CHAT_A, 83));
    assert.equal(harness.db.getLanguageModerationMessageFeatures(PUBLIC_CHAT_A, 84), undefined);
    assert.equal(harness.db.getLanguageModerationMessageFeatures(PUBLIC_CHAT_A, 85), undefined);
  });

  it("honors per-chat manual strike enablement and configurable reactions", async () => {
    const { harness } = createHarness();
    harness.db.updateManagedPublicChatManualStrikeConfig(PUBLIC_CHAT_A, { enabled: false });
    await harness.bot.handleUpdate(publicMessage(89));
    await harness.bot.handleUpdate(reactionUpdate(9089, 89));
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID), undefined);
    assert.equal(harness.db.countLanguageModerationOwnerFeedback(PUBLIC_CHAT_A), 0);

    harness.db.updateManagedPublicChatManualStrikeConfig(PUBLIC_CHAT_A, { enabled: true, reaction: "🔥" });
    await harness.bot.handleUpdate(publicMessage(90));
    await harness.bot.handleUpdate(reactionUpdate(9090, 90));
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID), undefined);
    await harness.bot.handleUpdate(reactionUpdate(9091, 90, { actorId: 42, reaction: "🔥" }));
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID), undefined);
    await harness.bot.handleUpdate(reactionUpdate(9092, 90, { reaction: "🔥" }));
    await harness.bot.handleUpdate(reactionUpdate(9093, 90, { reaction: "🔥" }));
    await harness.bot.handleUpdate(reactionUpdate(9094, 90, { oldReaction: "🔥", newEyes: false, reaction: "🔥" }));
    await harness.bot.handleUpdate(reactionUpdate(9095, 90, { reaction: "🔥" }));
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.current_strikes, 1);
    assert.equal(harness.db.countLanguageModerationOwnerFeedback(PUBLIC_CHAT_A), 1);

    await harness.bot.handleUpdate(publicMessage(91, { chatId: PUBLIC_CHAT_B }));
    await harness.bot.handleUpdate(reactionUpdate(9096, 91, { chatId: PUBLIC_CHAT_B }));
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_B, USER_ID)?.current_strikes, 1);
  });

  it("learns exact OWNER-confirmed uncertain text only inside the originating chat", async () => {
    const { harness } = createHarness();
    const text = "zorpa velin qumra";
    await harness.bot.handleUpdate(publicMessage(92, { text }));
    await harness.bot.handleUpdate(reactionUpdate(9093, 92));

    await harness.bot.handleUpdate(publicMessage(93, { text }));
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.current_strikes, 2);
    assert.equal(harness.db.listLanguageModerationViolations(PUBLIC_CHAT_A, "1970-01-01T00:00:00.000Z").length, 2);

    await harness.bot.handleUpdate(publicMessage(94, { chatId: PUBLIC_CHAT_B, text }));
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_B, USER_ID), undefined);
  });

  it("lets OWNER manually strike a media-only message", async () => {
    const { harness } = createHarness();
    await harness.bot.handleUpdate(publicMessage(86, { contentType: "photo" }));

    await harness.bot.handleUpdate(reactionUpdate(9086, 86));

    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.current_strikes, 1);
    assert.equal(harness.db.listLanguageModerationViolations(PUBLIC_CHAT_A, "1970-01-01T00:00:00.000Z").length, 1);
  });

  it("does not map anonymous sender_chat or service messages", async () => {
    const { harness } = createHarness();
    await harness.bot.handleUpdate(publicMessage(87, { contentType: "photo", senderChat: true }));
    await harness.bot.handleUpdate(publicMessage(88, { contentType: "service" }));

    assert.equal(harness.db.getLanguageModerationMessageAuthor(PUBLIC_CHAT_A, 87), undefined);
    assert.equal(harness.db.getLanguageModerationMessageAuthor(PUBLIC_CHAT_A, 88), undefined);
  });

  it("ignores reactions from every non-OWNER or unprovable actor", async () => {
    const { harness } = createHarness();
    const actors = [42, 43, 44, 999];
    for (const [index, actorId] of actors.entries()) {
      const messageId = 100 + index;
      await harness.bot.handleUpdate(publicMessage(messageId));
      await harness.bot.handleUpdate(reactionUpdate(9100 + index, messageId, { actorId }));
    }

    await harness.bot.handleUpdate(publicMessage(110));
    await harness.bot.handleUpdate(reactionUpdate(9110, 110, { actorId: TEST_BOT_IDENTITY.id, actorIsBot: true }));
    await harness.bot.handleUpdate(publicMessage(111));
    await harness.bot.handleUpdate(reactionUpdate(9111, 111, { actorChat: true }));
    await harness.bot.handleUpdate(publicMessage(112));
    await harness.bot.handleUpdate(reactionUpdate(9112, 112, { newEyes: false, extraEmoji: true }));

    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID), undefined);
    assert.equal(harness.db.listLanguageModerationViolations(PUBLIC_CHAT_A, "1970-01-01T00:00:00.000Z").length, 0);
  });

  it("is idempotent across duplicate delivery, removal, and re-adding eyes", async () => {
    const { harness } = createHarness();
    await harness.bot.handleUpdate(publicMessage(120));

    await harness.bot.handleUpdate(reactionUpdate(9120, 120));
    await harness.bot.handleUpdate(reactionUpdate(9120, 120));
    await harness.bot.handleUpdate(reactionUpdate(9121, 120, { oldEyes: true, newEyes: false }));
    await harness.bot.handleUpdate(reactionUpdate(9122, 120));

    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.current_strikes, 1);
    assert.equal(harness.db.listLanguageModerationViolations(PUBLIC_CHAT_A, "1970-01-01T00:00:00.000Z").length, 1);
  });

  it("uses the existing 0 to 1 to 2 to sanction ladder and cleanup cycle", async () => {
    const { harness } = createHarness();

    const messages = [
      [130, "alpha bravo charlie delta"],
      [131, "echo foxtrot golf hotel"],
      [132, "india juliet kilo lima"],
    ] as const;
    for (const [messageId, text] of messages) {
      await harness.bot.handleUpdate(publicMessage(messageId, { text }));
      await harness.bot.handleUpdate(reactionUpdate(9200 + messageId, messageId));
    }

    const state = harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID);
    assert.equal(state?.current_strikes, 0);
    assert.equal(state?.sanction_tier, 1);
    assert.equal(harness.countApiCalls("restrictChatMember"), 1);
    assert.equal(
      harness.findApiCalls("restrictChatMember")[0]?.payload.until_date,
      Math.floor(FIXED_NOW.getTime() / 1000) + 86_400
    );
    assert.equal(harness.countApiCalls("banChatMember"), 0);
    assert.equal(harness.countApiCalls("setMessageReaction"), 1);
    assert.equal(harness.scheduledModerationCleanupJobIds.length, 1);
    const violations = harness.db.listLanguageModerationViolations(PUBLIC_CHAT_A, "1970-01-01T00:00:00.000Z");
    assert.equal(violations.length, 3);
    assert.equal(new Set(violations.map((violation) => violation.moderation_cycle_id)).size, 1);
    assert.ok(violations.every((violation) => violation.moderation_cycle_id));
  });

  it("uses the existing seven-day and permanent sanction tiers", async () => {
    const week = createHarness().harness;
    week.db.upsertLanguageModerationUserState({
      chat_id: PUBLIC_CHAT_A,
      user_telegram_id: USER_ID,
      username: "synthetic_user",
      current_strikes: 2,
      sanction_tier: 1,
      first_strike_at: FIXED_NOW.toISOString(),
    });
    await week.bot.handleUpdate(publicMessage(133));
    await week.bot.handleUpdate(reactionUpdate(9333, 133));
    assert.equal(
      week.findApiCalls("restrictChatMember")[0]?.payload.until_date,
      Math.floor(FIXED_NOW.getTime() / 1000) + 604_800
    );
    assert.equal(week.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.sanction_tier, 2);

    const permanent = createHarness().harness;
    permanent.db.upsertLanguageModerationUserState({
      chat_id: PUBLIC_CHAT_A,
      user_telegram_id: USER_ID,
      username: "synthetic_user",
      current_strikes: 2,
      sanction_tier: 2,
      first_strike_at: FIXED_NOW.toISOString(),
    });
    await permanent.bot.handleUpdate(publicMessage(134));
    await permanent.bot.handleUpdate(reactionUpdate(9334, 134));
    assert.equal(permanent.countApiCalls("banChatMember"), 1);
    assert.equal(permanent.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.sanction_tier, 3);
  });

  it("preserves existing fail-closed sanction behavior", async () => {
    const { harness } = createHarness();
    harness.db.upsertLanguageModerationUserState({
      chat_id: PUBLIC_CHAT_A,
      user_telegram_id: USER_ID,
      username: "synthetic_user",
      current_strikes: 2,
      sanction_tier: 0,
      first_strike_at: FIXED_NOW.toISOString(),
    });
    await harness.bot.handleUpdate(publicMessage(135));
    harness.failNextApiCall("restrictChatMember");
    await harness.bot.handleUpdate(reactionUpdate(9335, 135));

    const state = harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID);
    assert.equal(state?.current_strikes, 2);
    assert.equal(state?.sanction_tier, 0);
    assert.equal(harness.db.getManagedPublicChat(PUBLIC_CHAT_A)?.moderation_enabled, 0);
    assert.equal(harness.scheduledModerationCleanupJobIds.length, 0);
  });

  it("immediately claims an automatically detected pending first strike without double-counting", async () => {
    const { harness } = createHarness();
    await harness.bot.handleUpdate(publicMessage(140, { text: "привет как твои дела сегодня" }));

    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID), undefined);
    assert.equal(harness.db.listLanguageModerationViolations(PUBLIC_CHAT_A, "1970-01-01T00:00:00.000Z").length, 1);

    await harness.bot.handleUpdate(reactionUpdate(9140, 140));
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.current_strikes, 1);
    assert.equal(harness.db.listLanguageModerationViolations(PUBLIC_CHAT_A, "1970-01-01T00:00:00.000Z").length, 1);

    await harness.bot.handleUpdate(reactionUpdate(9141, 140));
    await harness.bot.handleUpdate(reactionUpdate(9142, 140, { oldEyes: true, newEyes: false }));
    await harness.bot.handleUpdate(reactionUpdate(9143, 140));
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.current_strikes, 1);
    assert.equal(harness.db.countLanguageModerationOwnerFeedback(PUBLIC_CHAT_A), 1);

    const otherUserId = 502;
    await harness.bot.handleUpdate(publicMessage(141, { userId: otherUserId, text: "привет как твои дела сегодня" }));

    const warning = harness.db.getLanguageModerationWarningState(PUBLIC_CHAT_A, null)!;
    harness.db.upsertLanguageModerationWarningState(PUBLIC_CHAT_A, null, {
      lastWarningMessageId: warning.last_warning_message_id,
      lastWarningAt: warning.last_warning_at,
      ordinaryMessagesSinceWarning: warning.ordinary_messages_since_warning,
      pendingWarningDueAt: new Date(0).toISOString(),
      pendingWarningStartedAt: warning.pending_warning_started_at,
    });
    const { processPendingWarning } = await import("../src/bot.js");
    await processPendingWarning(harness.bot.api, harness.db, PUBLIC_CHAT_A);

    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.current_strikes, 1);
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, otherUserId)?.current_strikes, 1);
    assert.equal(harness.db.listLanguageModerationViolations(PUBLIC_CHAT_A, "1970-01-01T00:00:00.000Z").length, 2);
  });

  it("does not reuse an already-consumed automatic violation", async () => {
    const { harness } = createHarness();
    harness.db.upsertLanguageModerationWarningState(PUBLIC_CHAT_A, null, {
      lastWarningAt: FIXED_NOW.toISOString(),
      ordinaryMessagesSinceWarning: 0,
    });
    await harness.bot.handleUpdate(publicMessage(142, { text: "привет как твои дела сегодня" }));
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.current_strikes, 1);

    await harness.bot.handleUpdate(reactionUpdate(9144, 142));

    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.current_strikes, 1);
    assert.equal(harness.db.listLanguageModerationViolations(PUBLIC_CHAT_A, "1970-01-01T00:00:00.000Z").length, 1);
    assert.equal(harness.db.countLanguageModerationOwnerFeedback(PUBLIC_CHAT_A), 1);
  });

  it("does not reuse a historical violation from a completed sanction cycle", async () => {
    const { harness } = createHarness();
    await harness.bot.handleUpdate(publicMessage(143));
    assert.equal(
      harness.db.addLanguageModerationViolation({
        chat_id: PUBLIC_CHAT_A,
        user_telegram_id: USER_ID,
        message_id: 143,
        username: "synthetic_user",
        cycle_tier: 0,
      }),
      true
    );
    assert.equal(harness.db.assignLanguageModerationViolationCycle(PUBLIC_CHAT_A, USER_ID, 0, "completed-cycle"), 1);
    harness.db.upsertLanguageModerationUserState({
      chat_id: PUBLIC_CHAT_A,
      user_telegram_id: USER_ID,
      username: "synthetic_user",
      current_strikes: 0,
      sanction_tier: 0,
      first_strike_at: null,
    });

    await harness.bot.handleUpdate(reactionUpdate(9145, 143));

    const state = harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID);
    assert.equal(state?.current_strikes, 0);
    assert.equal(state?.sanction_tier, 0);
  });

  it("fails closed for missing authors and out-of-scope chats", async () => {
    const { harness } = createHarness();
    manage(harness, -100703, false);

    await harness.bot.handleUpdate(reactionUpdate(9150, 999));
    await harness.bot.handleUpdate(publicMessage(151, { chatId: -100799 }));
    await harness.bot.handleUpdate(reactionUpdate(9151, 151, { chatId: -100799 }));
    await harness.bot.handleUpdate(publicMessage(152, { chatId: -100703 }));
    await harness.bot.handleUpdate(reactionUpdate(9152, 152, { chatId: -100703 }));
    await harness.bot.handleUpdate(reactionUpdate(9153, 153, { chatId: TEST_STAFF_CHAT_ID }));
    await harness.bot.handleUpdate(reactionUpdate(9154, 154, { chatId: OWNER_ID, chatType: "private" }));

    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID), undefined);
    assert.equal(harness.db.getLanguageModerationMessageAuthor(-100799, 151), undefined);
    assert.equal(harness.db.getLanguageModerationMessageAuthor(-100703, 152), undefined);
    assert.equal(harness.countApiCalls("restrictChatMember"), 0);
    assert.equal(harness.db.countLanguageModerationOwnerFeedback(PUBLIC_CHAT_A), 0);
  });

  it("keeps identical message ids isolated between managed public chats", async () => {
    const { harness } = createHarness();
    await harness.bot.handleUpdate(publicMessage(160, { chatId: PUBLIC_CHAT_A }));
    await harness.bot.handleUpdate(publicMessage(160, { chatId: PUBLIC_CHAT_B }));

    await harness.bot.handleUpdate(reactionUpdate(9160, 160, { chatId: PUBLIC_CHAT_A }));
    await harness.bot.handleUpdate(reactionUpdate(9161, 160, { chatId: PUBLIC_CHAT_B }));

    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_A, USER_ID)?.current_strikes, 1);
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_B, USER_ID)?.current_strikes, 1);
  });

  it("does not map bot-authored messages as manual moderation targets", async () => {
    const { harness } = createHarness();
    await harness.bot.handleUpdate(publicMessage(170, { userId: TEST_BOT_IDENTITY.id, isBot: true }));
    assert.equal(harness.db.getLanguageModerationMessageAuthor(PUBLIC_CHAT_A, 170), undefined);
  });

  it("subscribes to reaction updates without dropping existing update types", async () => {
    const { TELEGRAM_ALLOWED_UPDATES } = await import("../src/bot.js");
    assert.deepEqual(TELEGRAM_ALLOWED_UPDATES, ["message", "callback_query", "chat_member", "message_reaction"]);
  });
});
