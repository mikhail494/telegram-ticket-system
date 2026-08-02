import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Update } from "grammy/types";
import {
  TEST_STAFF_CHAT_ID,
  createBotHarness,
  type ApiMockSuccess,
  type BotHarness,
  type RecordedApiCall
} from "./helpers/botHarness.js";
import {
  processModerationCleanupJob,
  processModerationRecovery,
  scheduleModerationCleanup
} from "../src/languageModeration.js";

const PUBLIC_CHAT_ID = -100777;
const FIXED_NOW = new Date("2026-07-31T12:00:00.000Z");
const CYRILLIC = "\u041f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430 \u043f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u043c\u043e\u0439 \u0430\u043a\u043a\u0430\u0443\u043d\u0442";
const SUPPORT_LOGS_KEY = `support_logs_message_thread_id:${TEST_STAFF_CHAT_ID}`;

const harnesses: BotHarness[] = [];

afterEach(() => {
  for (const harness of harnesses) harness.cleanup();
  harnesses.length = 0;
});

function createHarness(): BotHarness {
  const harness = createBotHarness({ moderationNow: () => FIXED_NOW });
  harnesses.push(harness);
  return harness;
}

function enable(harness: BotHarness): void {
  harness.db.setSetting("language_moderation:enabled", "true");
  harness.db.setSetting("language_moderation:target", String(PUBLIC_CHAT_ID));
}

function publicMessage(messageId: number, userId: number, text = CYRILLIC): Update {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(FIXED_NOW.getTime() / 1000),
      from: { id: userId, is_bot: false, first_name: "Public User", username: `public_${userId}` },
      chat: { id: PUBLIC_CHAT_ID, type: "supergroup", title: "Public Community" },
      text
    }
  };
}

function privateMessage(messageId: number, userId: number, text = "I need private support."): Update {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(FIXED_NOW.getTime() / 1000),
      from: { id: userId, is_bot: false, first_name: "Private User", username: `private_${userId}` },
      chat: { id: userId, type: "private", first_name: "Private User" },
      text
    }
  };
}

function moderationCommand(command: string, chatId = TEST_STAFF_CHAT_ID): Update {
  return {
    update_id: 9000,
    message: {
      message_id: 9000,
      date: Math.floor(FIXED_NOW.getTime() / 1000),
      from: { id: 42, is_bot: false, first_name: "Staff", username: "staff" },
      chat: chatId === TEST_STAFF_CHAT_ID
        ? { id: chatId, type: "supergroup", title: "Staff" }
        : { id: chatId, type: "private", first_name: "Not Staff" },
      text: command,
      entities: [{ offset: 0, length: (command.split(" ")[0] ?? command).length, type: "bot_command" }]
    }
  };
}

function seedSanctionState(harness: BotHarness, userId: number, sanctionTier: number): void {
  harness.db.upsertLanguageModerationUserState({
    chat_id: PUBLIC_CHAT_ID,
    user_telegram_id: userId,
    username: `public_${userId}`,
    current_strikes: 2,
    sanction_tier: sanctionTier,
    first_strike_at: "2026-07-31T11:00:00.000Z"
  });
}

function createDueJob(
  harness: BotHarness,
  userId: number,
  sanctionTier = 1,
  state?: "CLEANING" | "LOG_PENDING",
  cleanupDueAt = "2026-07-31T11:59:59.000Z",
  staffChatId = TEST_STAFF_CHAT_ID,
  violationCycleId = `test-cycle:${userId}:${sanctionTier - 1}`
): number {
  const jobId = harness.db.createLanguageModerationCleanupJob({
    staff_chat_id: staffChatId,
    chat_id: PUBLIC_CHAT_ID,
    user_telegram_id: userId,
    username: `public_${userId}`,
    chat_title: "Public Community",
    sanction_tier: sanctionTier,
    sanction_kind: sanctionTier === 1 ? "24-hour mute" : sanctionTier === 2 ? "7-day mute" : "permanent ban",
    violation_cycle_id: violationCycleId,
    cleanup_due_at: cleanupDueAt
  });
  if (state) harness.db.updateLanguageModerationCleanupJob(jobId, state);
  return jobId;
}

function seedCycleViolation(harness: BotHarness, userId: number, messageId: number, cycleTier = 0, violationCycleId = `test-cycle:${userId}:${cycleTier}`): void {
  assert.equal(harness.db.addLanguageModerationViolation({
    chat_id: PUBLIC_CHAT_ID,
    user_telegram_id: userId,
    message_id: messageId,
    username: `public_${userId}`,
    cycle_tier: cycleTier
  }), true);
  harness.db.assignLanguageModerationViolationCycle(PUBLIC_CHAT_ID, userId, cycleTier, violationCycleId);
}

function seedUnboundCycleViolation(harness: BotHarness, userId: number, messageId: number, cycleTier: number): void {
  assert.equal(harness.db.addLanguageModerationViolation({
    chat_id: PUBLIC_CHAT_ID,
    user_telegram_id: userId,
    message_id: messageId,
    username: `public_${userId}`,
    cycle_tier: cycleTier
  }), true);
}

function publicLogMessages(harness: BotHarness): RecordedApiCall[] {
  return harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID);
}

function moderationReactionEmoji(harness: BotHarness): string | undefined {
  const reaction = harness.findApiCalls("setMessageReaction")[0]?.payload.reaction;
  if (!Array.isArray(reaction)) return undefined;
  const firstReaction = reaction[0];
  return typeof firstReaction === "object" && firstReaction !== null && "emoji" in firstReaction && typeof firstReaction.emoji === "string" ? firstReaction.emoji : undefined;
}

function administrator(canDelete = true, canRestrict = true): ApiMockSuccess {
  return {
    ok: true,
    result: {
      status: "administrator",
      user: { id: 777, is_bot: true, first_name: "Test Support Bot" },
      can_delete_messages: canDelete,
      can_restrict_members: canRestrict
    }
  };
}

describe("public language moderation sanctions", () => {
  it("applies a 24-hour mute before scheduling the exact cleanup job", async () => {
    const harness = createHarness();
    enable(harness);
    seedSanctionState(harness, 10, 0);

    await harness.bot.handleUpdate(publicMessage(101, 10));

    assert.equal(moderationReactionEmoji(harness), "\u{1F621}");
    const restriction = harness.findApiCalls("restrictChatMember");
    assert.equal(restriction.length, 1);
    assert.equal(restriction[0]?.payload.until_date, Math.floor(FIXED_NOW.getTime() / 1000) + 86_400);
    const state = harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, 10);
    assert.equal(state?.current_strikes, 0);
    assert.equal(state?.first_strike_at, null);
    assert.equal(state?.sanction_tier, 1);
    assert.equal(harness.scheduledModerationCleanupJobIds.length, 1);
    const job = harness.db.getLanguageModerationCleanupJob(harness.scheduledModerationCleanupJobIds[0] ?? 0);
    assert.ok(job);
    assert.equal(job?.sanction_kind, "24-hour mute");
    assert.ok(harness.findApiCalls("restrictChatMember").length > 0, "enforcement precedes scheduling");
  });

  it("advances the second and third completed cycles, then caps permanent bans at tier 3", async () => {
    const harness = createHarness();
    enable(harness);
    seedSanctionState(harness, 11, 1);
    await harness.bot.handleUpdate(publicMessage(102, 11));
    assert.equal(harness.findApiCalls("restrictChatMember")[0]?.payload.until_date, Math.floor(FIXED_NOW.getTime() / 1000) + 604_800);
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, 11)?.sanction_tier, 2);

    seedSanctionState(harness, 11, 2);
    await harness.bot.handleUpdate(publicMessage(103, 11));
    assert.equal(harness.countApiCalls("banChatMember"), 1);
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, 11)?.sanction_tier, 3);

    seedSanctionState(harness, 11, 3);
    await harness.bot.handleUpdate(publicMessage(104, 11));
    assert.equal(harness.countApiCalls("banChatMember"), 2);
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, 11)?.sanction_tier, 3);
    assert.deepEqual(harness.scheduledModerationCleanupJobIds.length, 3);
  });

  it("keeps the successful sanction path intact when the blocked reaction fails", async () => {
    const harness = createHarness();
    enable(harness);
    seedSanctionState(harness, 12, 0);
    harness.failNextApiCall("setMessageReaction");

    await harness.bot.handleUpdate(publicMessage(105, 12));

    assert.equal(harness.countApiCalls("restrictChatMember"), 1);
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, 12)?.sanction_tier, 1);
    assert.equal(harness.db.getSetting("language_moderation:enabled"), "true");
  });

  it("fails closed without changing state or scheduling cleanup when enforcement fails", async () => {
    const harness = createHarness();
    enable(harness);
    seedSanctionState(harness, 13, 0);
    harness.failNextApiCall("restrictChatMember");

    await harness.bot.handleUpdate(publicMessage(106, 13));

    const state = harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, 13);
    assert.equal(state?.current_strikes, 2);
    assert.equal(state?.sanction_tier, 0);
    assert.equal(harness.scheduledModerationCleanupJobIds.length, 0);
    assert.equal(harness.db.getSetting("language_moderation:enabled"), "false");
    assert.equal(harness.db.getBannedUser(13), undefined);
  });

  it("preserves strikes and tier when a permanent-ban request fails", async () => {
    const harness = createHarness();
    enable(harness);
    seedSanctionState(harness, 16, 2);
    harness.failNextApiCall("banChatMember");

    await harness.bot.handleUpdate(publicMessage(109, 16));

    const state = harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, 16);
    assert.equal(state?.current_strikes, 2);
    assert.equal(state?.sanction_tier, 2);
    assert.equal(harness.scheduledModerationCleanupJobIds.length, 0);
    assert.equal(harness.db.getSetting("language_moderation:enabled"), "false");
  });

  it("does not sanction a duplicate public Telegram message twice and gives nearby users distinct job ids", async () => {
    const harness = createHarness();
    enable(harness);
    seedSanctionState(harness, 14, 0);
    seedSanctionState(harness, 15, 0);

    await harness.bot.handleUpdate(publicMessage(107, 14));
    await harness.bot.handleUpdate(publicMessage(107, 14));
    await harness.bot.handleUpdate(publicMessage(108, 15));

    assert.equal(harness.countApiCalls("restrictChatMember"), 2);
    assert.equal(harness.scheduledModerationCleanupJobIds.length, 2);
    assert.notEqual(harness.scheduledModerationCleanupJobIds[0], harness.scheduledModerationCleanupJobIds[1]);
  });

  it("cleans each exact violation cycle through a repeated capped tier-3 sanction", async () => {
    const harness = createHarness();
    enable(harness);
    const userId = 18;
    const cleanupTime = new Date(FIXED_NOW.getTime() + 11_000);
    const cycleMessages = [[301, 302, 303], [311, 312, 313], [321, 322, 323], [331, 332, 333]];
    const cycleIds: string[] = [];

    for (const [sourceTier, messageIds] of cycleMessages.entries()) {
      const tier = Math.min(sourceTier, 3);
      seedSanctionState(harness, userId, tier);
      seedUnboundCycleViolation(harness, userId, messageIds[0]!, tier);
      seedUnboundCycleViolation(harness, userId, messageIds[1]!, tier);
      if (tier === 3) await harness.bot.handleUpdate(publicMessage(999, userId, "ordinary English conversation"));
      await harness.bot.handleUpdate(publicMessage(messageIds[2]!, userId));

      const jobId = harness.scheduledModerationCleanupJobIds.at(-1);
      assert.ok(jobId);
      const job = harness.db.getLanguageModerationCleanupJob(jobId!);
      assert.ok(job?.violation_cycle_id);
      cycleIds.push(job!.violation_cycle_id!);
      assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, userId)?.sanction_tier, Math.min(tier + 1, 3));

      harness.clearApiCalls();
      await processModerationCleanupJob(harness.bot.api, harness.db, jobId!, cleanupTime);
      assert.deepEqual(harness.findApiCalls("deleteMessage").map((call) => call.payload.message_id), messageIds);
      assert.equal(harness.db.getLanguageModerationCleanupJob(jobId!)?.state, "COMPLETED");
    }

    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, userId)?.sanction_tier, 3);
    assert.notEqual(cycleIds[2], cycleIds[3]);
    assert.equal(harness.findApiCalls("deleteMessage").some((call) => call.payload.message_id === 999), false);
  });
});

describe("moderation cleanup and Support Logs recovery", () => {
  it("deduplicates only identical in-process cleanup job ids without real sleeps", () => {
    const harness = createHarness();
    const scheduled: Array<{ delayMs: number; callback: () => void }> = [];
    const createTimer = (callback: () => void, delayMs: number) => {
      scheduled.push({ callback, delayMs });
      return { unref: () => undefined };
    };

    scheduleModerationCleanup(harness.bot.api, harness.db, 70_001, 10_000, createTimer);
    scheduleModerationCleanup(harness.bot.api, harness.db, 70_001, 10_000, createTimer);
    scheduleModerationCleanup(harness.bot.api, harness.db, 70_002, 10_000, createTimer);

    assert.deepEqual(scheduled.map((item) => item.delayMs), [10_000, 10_000]);
  });

  it("does nothing before a job is due and cleans only the completed sanction cycle once due", async () => {
    const harness = createHarness();
    const jobId = createDueJob(harness, 20);
    seedCycleViolation(harness, 20, 201, 0);
    seedCycleViolation(harness, 20, 202, 0);
    seedCycleViolation(harness, 20, 203, 0);
    seedCycleViolation(harness, 20, 204, 1);
    seedCycleViolation(harness, 21, 205, 0);

    await processModerationCleanupJob(harness.bot.api, harness.db, jobId, new Date("2026-07-31T11:00:00.000Z"));
    assert.equal(harness.countApiCalls("deleteMessage"), 0);
    assert.equal(harness.db.getLanguageModerationCleanupJob(jobId)?.state, "PENDING");

    await processModerationCleanupJob(harness.bot.api, harness.db, jobId, FIXED_NOW);
    assert.deepEqual(harness.findApiCalls("deleteMessage").map((call) => call.payload.message_id), [201, 202, 203]);
    assert.equal(harness.db.listLanguageModerationCycleViolations(PUBLIC_CHAT_ID, 20, 0).length, 0);
    assert.equal(harness.db.listLanguageModerationCycleViolations(PUBLIC_CHAT_ID, 20, 1).length, 1);
    assert.equal(harness.db.listLanguageModerationCycleViolations(PUBLIC_CHAT_ID, 21, 0).length, 1);
    assert.equal(harness.db.getLanguageModerationCleanupJob(jobId)?.state, "COMPLETED");

    harness.clearApiCalls();
    await processModerationCleanupJob(harness.bot.api, harness.db, jobId, new Date("2026-08-01T00:00:00.000Z"));
    assert.equal(harness.apiCalls.length, 0);
  });

  it("retains retryable deletion work until recovery deletes it and emits one Support Logs event", async () => {
    const harness = createHarness();
    enable(harness);
    const jobId = createDueJob(harness, 22);
    seedCycleViolation(harness, 22, 205);
    seedCycleViolation(harness, 22, 206);
    harness.failNextApiCall("deleteMessage");

    await processModerationCleanupJob(harness.bot.api, harness.db, jobId, FIXED_NOW);

    assert.equal(harness.countApiCalls("deleteMessage"), 2);
    assert.equal(harness.db.getLanguageModerationCleanupJob(jobId)?.state, "CLEANING");
    assert.equal(harness.db.listLanguageModerationCycleViolations(PUBLIC_CHAT_ID, 22, 0).length, 2);
    assert.equal(publicLogMessages(harness).length, 0);
    assert.equal(harness.db.getSetting("language_moderation:enabled"), "true");
    assert.equal(harness.countApiCalls("restrictChatMember"), 0);
    assert.equal(harness.countApiCalls("banChatMember"), 0);

    harness.clearApiCalls();
    await processModerationRecovery(harness.bot.api, harness.db, new Date("2026-07-31T12:01:00.000Z"));

    assert.equal(harness.countApiCalls("deleteMessage"), 1);
    assert.equal(harness.db.listLanguageModerationCycleViolations(PUBLIC_CHAT_ID, 22, 0).length, 0);
    assert.equal(harness.db.getLanguageModerationCleanupJob(jobId)?.state, "COMPLETED");
    assert.equal(publicLogMessages(harness).length, 1);

    await processModerationRecovery(harness.bot.api, harness.db, new Date("2026-07-31T12:02:00.000Z"));
    assert.equal(publicLogMessages(harness).length, 1);
  });

  it("records an already-absent violation as deleted before retrying Support Logs", async () => {
    const harness = createHarness();
    const jobId = createDueJob(harness, 28);
    seedCycleViolation(harness, 28, 212);
    harness.setApiResponseOverride("deleteMessage", () => ({ ok: false, error_code: 400, description: "Bad Request: message to delete not found" }));
    harness.failNextApiCall("sendMessage");

    await processModerationCleanupJob(harness.bot.api, harness.db, jobId, FIXED_NOW);

    assert.equal(harness.db.getLanguageModerationCleanupJob(jobId)?.state, "LOG_PENDING");
    assert.equal(harness.db.listLanguageModerationCycleViolations(PUBLIC_CHAT_ID, 28, 0)[0]?.cleanup_state, "ALREADY_ABSENT");

    harness.clearApiCalls();
    await processModerationRecovery(harness.bot.api, harness.db, new Date("2026-07-31T12:01:00.000Z"));

    assert.equal(harness.countApiCalls("deleteMessage"), 0);
    assert.equal(harness.db.getLanguageModerationCleanupJob(jobId)?.state, "COMPLETED");
  });

  it("keeps a failed log job recoverable without repeating cleanup or sanctions", async () => {
    const harness = createHarness();
    harness.db.setSetting(SUPPORT_LOGS_KEY, "8000");
    const jobId = createDueJob(harness, 23);
    seedCycleViolation(harness, 23, 207);
    harness.failNextApiCall("sendMessage");

    await processModerationCleanupJob(harness.bot.api, harness.db, jobId, FIXED_NOW);
    assert.equal(harness.db.getLanguageModerationCleanupJob(jobId)?.state, "LOG_PENDING");
    assert.equal(harness.countApiCalls("deleteMessage"), 1);
    assert.equal(harness.db.listLanguageModerationCycleViolations(PUBLIC_CHAT_ID, 23, 0).length, 1);

    await processModerationRecovery(harness.bot.api, harness.db, new Date("2026-07-31T12:01:00.000Z"));
    assert.equal(harness.db.getLanguageModerationCleanupJob(jobId)?.state, "COMPLETED");
    assert.equal(harness.countApiCalls("deleteMessage"), 1, "LOG_PENDING retries only Support Logs delivery");
    assert.equal(harness.countApiCalls("restrictChatMember"), 0);
    assert.equal(harness.countApiCalls("banChatMember"), 0);

    const sentLogs = publicLogMessages(harness).length;
    await processModerationRecovery(harness.bot.api, harness.db, new Date("2026-07-31T12:02:00.000Z"));
    assert.equal(publicLogMessages(harness).length, sentLogs);
  });

  it("resumes interrupted CLEANING jobs and lets one failed job leave another job recoverable", async () => {
    const harness = createHarness();
    harness.db.setSetting(SUPPORT_LOGS_KEY, "8000");
    const cleaningJob = createDueJob(harness, 24, 1, "CLEANING");
    const secondJob = createDueJob(harness, 25);
    seedCycleViolation(harness, 24, 208);
    seedCycleViolation(harness, 25, 209);
    harness.failNextApiCall("sendMessage");

    await processModerationRecovery(harness.bot.api, harness.db, FIXED_NOW);

    assert.equal(harness.db.getLanguageModerationCleanupJob(cleaningJob)?.state, "LOG_PENDING");
    assert.equal(harness.db.getLanguageModerationCleanupJob(secondJob)?.state, "COMPLETED");
    assert.equal(harness.countApiCalls("restrictChatMember"), 0);
    assert.equal(harness.countApiCalls("banChatMember"), 0);
  });

  it("recovers an invalid ticket-topic Support Logs override before writing a moderation event", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ messageThreadId: 6000 });
    harness.db.setSetting(SUPPORT_LOGS_KEY, String(ticket.message_thread_id));
    const jobId = createDueJob(harness, 26);
    seedCycleViolation(harness, 26, 210);

    await processModerationCleanupJob(harness.bot.api, harness.db, jobId, FIXED_NOW);

    const log = publicLogMessages(harness).at(-1);
    assert.ok(log);
    assert.notEqual(log?.payload.message_thread_id, ticket.message_thread_id);
    assert.equal(harness.countApiCalls("createForumTopic"), 1);
  });

  it("does not recover jobs owned by another staff chat", async () => {
    const harness = createHarness();
    const jobId = createDueJob(harness, 27, 1, undefined, "2026-07-31T11:59:59.000Z", -100999);
    seedCycleViolation(harness, 27, 211);

    await processModerationRecovery(harness.bot.api, harness.db, FIXED_NOW);

    assert.equal(harness.db.getLanguageModerationCleanupJob(jobId)?.state, "PENDING");
    assert.equal(harness.apiCalls.length, 0);
  });
});

describe("moderation commands and public/private isolation", () => {
  it("reports status with target, rights, thresholds, allowlist, and pending recovery count", async () => {
    const harness = createHarness();
    enable(harness);
    harness.db.setSetting("language_moderation:allowlist", JSON.stringify(["brand"]));
    createDueJob(harness, 30, 1, undefined, new Date(Date.now() - 1_000).toISOString());
    harness.setApiResponseOverride("getChatMember", () => administrator());

    await harness.bot.handleUpdate(moderationCommand("/moderation status"));

    const text = String(harness.findApiCalls("sendMessage").at(-1)?.payload.text);
    assert.match(text, /Moderation: enabled/);
    assert.match(text, new RegExp(`Target: ${PUBLIC_CHAT_ID}`));
    assert.match(text, /Bot rights: ok/);
    assert.match(text, /Warning cooldown: 10 minutes and 15 ordinary messages/);
    assert.match(text, /Allowlist entries: 1/);
    assert.match(text, /Due cleanup\/log recovery jobs: 1/);
  });

  it("persists only reachable targets and enables only with the required moderation rights", async () => {
    const harness = createHarness();
    harness.setApiResponseOverride("getChat", () => ({ ok: true, result: { id: PUBLIC_CHAT_ID, type: "supergroup", title: "Public Community" } }));
    await harness.bot.handleUpdate(moderationCommand(`/moderation target ${PUBLIC_CHAT_ID}`));
    assert.equal(harness.db.getSetting("language_moderation:target"), String(PUBLIC_CHAT_ID));
    assert.notEqual(harness.db.getSetting("language_moderation:enabled"), "true");

    harness.setApiResponseOverride("getChatMember", () => administrator(false, true));
    await harness.bot.handleUpdate(moderationCommand("/moderation enable"));
    assert.notEqual(harness.db.getSetting("language_moderation:enabled"), "true");
    assert.match(String(harness.findApiCalls("sendMessage").at(-1)?.payload.text), /delete messages/);

    harness.setApiResponseOverride("getChatMember", () => administrator(true, true));
    await harness.bot.handleUpdate(moderationCommand("/moderation enable"));
    assert.equal(harness.db.getSetting("language_moderation:enabled"), "true");

    harness.failNextApiCall("getChat");
    await harness.bot.handleUpdate(moderationCommand("/moderation target -100999"));
    assert.equal(harness.db.getSetting("language_moderation:target"), String(PUBLIC_CHAT_ID));
  });

  it("keeps command controls staff-only and manages case-insensitive allowlist and user resets safely", async () => {
    const harness = createHarness();
    await harness.bot.handleUpdate(moderationCommand("/moderation allow Brand"));
    await harness.bot.handleUpdate(moderationCommand("/moderation allow brand"));
    assert.deepEqual(JSON.parse(harness.db.getSetting("language_moderation:allowlist") ?? "[]"), ["brand"]);
    await harness.bot.handleUpdate(moderationCommand("/moderation unallow BRAND"));
    assert.deepEqual(JSON.parse(harness.db.getSetting("language_moderation:allowlist") ?? "[]"), []);
    await harness.bot.handleUpdate(moderationCommand("/moderation unallow missing"));
    assert.deepEqual(JSON.parse(harness.db.getSetting("language_moderation:allowlist") ?? "[]"), []);
    await harness.bot.handleUpdate(moderationCommand(`/moderation allow ${"a".repeat(81)}`));
    assert.equal(harness.db.getSetting("language_moderation:allowlist"), "[]");

    harness.db.setSetting("language_moderation:target", String(PUBLIC_CHAT_ID));
    harness.db.upsertLanguageModerationUserState({ chat_id: PUBLIC_CHAT_ID, user_telegram_id: 31, username: "public_31", current_strikes: 2, sanction_tier: 1, first_strike_at: "2026-07-31T11:00:00.000Z" });
    seedCycleViolation(harness, 31, 211, 0);
    seedCycleViolation(harness, 31, 212, 1);
    await harness.bot.handleUpdate(moderationCommand("/moderation resetstrikes 31"));
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, 31)?.current_strikes, 0);
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, 31)?.sanction_tier, 1);
    assert.equal(harness.db.listLanguageModerationCycleViolations(PUBLIC_CHAT_ID, 31, 1).length, 0);
    assert.equal(harness.db.listLanguageModerationCycleViolations(PUBLIC_CHAT_ID, 31, 0).length, 1);
    await harness.bot.handleUpdate(moderationCommand("/moderation resettier 31"));
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, 31)?.sanction_tier, 0);
    assert.equal(harness.countApiCalls("unrestrictChatMember"), 0);
    assert.equal(harness.countApiCalls("unbanChatMember"), 0);

    harness.db.setSetting("language_moderation:enabled", "true");
    await harness.bot.handleUpdate(moderationCommand("/moderation disable"));
    assert.equal(harness.db.getSetting("language_moderation:enabled"), "false");
    assert.equal(harness.db.getLanguageModerationUserState(PUBLIC_CHAT_ID, 31)?.current_strikes, 0);

    await harness.bot.handleUpdate(moderationCommand("/moderation disable", 999));
    assert.equal(harness.db.getSetting("language_moderation:enabled"), "false");
  });

  it("keeps public sanctions separate from private support, while private support bans still apply", async () => {
    const harness = createHarness();
    enable(harness);
    await harness.bot.handleUpdate(privateMessage(300, 40));
    const originalTicket = harness.db.getLatestTicketForUser(40, TEST_STAFF_CHAT_ID);
    assert.ok(originalTicket);
    seedSanctionState(harness, 40, 2);
    await harness.bot.handleUpdate(publicMessage(301, 40));
    assert.equal(harness.countApiCalls("banChatMember"), 1);
    assert.equal(harness.db.getBannedUser(40), undefined);

    await harness.bot.handleUpdate(privateMessage(302, 40));
    assert.equal(harness.db.getLatestTicketForUser(40, TEST_STAFF_CHAT_ID)?.id, originalTicket?.id);

    harness.db.banUser({ userTelegramId: 41, username: "private_41", reason: "Support abuse", bannedBy: 42 });
    await harness.bot.handleUpdate(privateMessage(303, 41));
    assert.equal(harness.db.getLatestTicketForUser(41, TEST_STAFF_CHAT_ID), undefined);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === 41 && call.payload.text === "You are currently restricted from opening support tickets."), true);
  });

  it("keeps staff help complete without exposing staff commands to private users", async () => {
    const harness = createHarness();
    await harness.bot.handleUpdate(moderationCommand("/help"));
    const staffHelp = String(harness.findApiCalls("sendMessage").at(-1)?.payload.text);
    assert.match(staffHelp, /\/exporttickets/);
    assert.match(staffHelp, /answer package/i);
    assert.match(staffHelp, /\/moderation/);

    await harness.bot.handleUpdate(privateMessage(304, 42, "/help"));
    const privateHelp = String(harness.findApiCalls("sendMessage").at(-1)?.payload.text);
    assert.doesNotMatch(privateHelp, /\/moderation/);
    assert.doesNotMatch(privateHelp, /\/exporttickets/);
  });
});
