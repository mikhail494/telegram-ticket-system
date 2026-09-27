import { randomUUID } from "node:crypto";
import { Bot, GrammyError } from "grammy";
import type { Context } from "grammy";
import type { Message, ReactionType, ReactionTypeEmoji, User } from "grammy/types";
import {
  ADAPTIVE_LEARNING_HORIZON_MS,
  ADAPTIVE_MESSAGE_FEATURE_TTL_MS,
  classifyEnglishOnlyMessage,
  extractAdaptiveModerationFeatures,
  parseModerationConfig,
  type ModerationCleanupScheduler,
} from "./languageModeration.js";
import { SupportDatabase, type LanguageModerationUserState, type LanguageModerationViolation } from "./db.js";
import { logger } from "./logger.js";
import { InstallationService, type Permission } from "./installation.js";
import type { BackgroundTaskTracker } from "./lifecycle.js";
import { validatePublicModerationChat } from "./publicChatModeration.js";
import { normalizeTelegramDeliveryError } from "./deliveryDiagnostics.js";
import { getMessageContent, isCommandText, usernameOf } from "./telegram.js";

const MODERATION_SETTING_PREFIX = "language_moderation";
const ORDINARY_MODERATION_MESSAGE_FIELDS = [
  "text",
  "rich_message",
  "animation",
  "audio",
  "document",
  "live_photo",
  "paid_media",
  "photo",
  "sticker",
  "story",
  "video",
  "video_note",
  "voice",
  "contact",
  "dice",
  "game",
  "poll",
  "venue",
  "location",
  "checklist",
] as const satisfies readonly (keyof Message)[];
type ModerationReactionEmoji = "\u{1F440}" | "\u{1F621}";
const MODERATION_STRIKE_REACTION: ModerationReactionEmoji = "\u{1F440}";
const MODERATION_SANCTION_REACTION: ModerationReactionEmoji = "\u{1F621}";
type BotApi = Context["api"];

export interface PublicModerationTelegramDependencies {
  bot: Bot<Context>;
  db: SupportDatabase;
  installation: InstallationService;
  now(): Date;
  cleanupScheduler: ModerationCleanupScheduler;
  pendingWarnings: PendingWarningScheduler;
  requireStaffChatId(): number;
  isStaffChat(ctx: Context): boolean;
  isPrivateChat(ctx: Context): boolean;
  requirePermission(ctx: Context, permission: Permission): Promise<boolean>;
  staffOnlyText: string;
}

export function createPublicModerationTelegramSurface(dependencies: PublicModerationTelegramDependencies) {
  const {
    bot,
    db,
    installation,
    now: moderationNow,
    cleanupScheduler: moderationCleanupScheduler,
    pendingWarnings,
    requireStaffChatId,
    isStaffChat,
    isPrivateChat,
    requirePermission,
    staffOnlyText: STAFF_ONLY_TEXT,
  } = dependencies;

  function registerCommand(): void {
    bot.command("moderation", async (ctx) => {
      if (!isStaffChat(ctx)) {
        if (isPrivateChat(ctx)) await ctx.reply(STAFF_ONLY_TEXT);
        return;
      }
      if (!(await requirePermission(ctx, "MODERATION_SETTINGS"))) return;
      const [, action = "status", ...args] = (ctx.message?.text ?? "").trim().split(/\s+/);
      const current = moderationConfig(db);
      if (action === "status") {
        await ctx.reply(await formatModerationStatus(db, current, ctx.api, bot.botInfo?.id, requireStaffChatId()));
        return;
      }
      if (action === "target") {
        const chatId = Number(args[0]);
        if (!Number.isSafeInteger(chatId)) {
          await ctx.reply("Usage: /moderation target <chat_id>");
          return;
        }
        try {
          const chat = await ctx.api.getChat(chatId);
          const workspace = installation.getActiveWorkspace();
          db.setSetting(moderationSettingKey("target"), String(chatId));
          if (workspace) db.importManagedPublicChat(chatId, workspace.id);
          db.upsertManagedPublicChat({
            chatId,
            workspaceId: workspace?.id ?? null,
            title: "title" in chat ? (chat.title ?? null) : null,
            username: "username" in chat ? (chat.username ?? null) : null,
            isForum: chat.type === "supergroup" && chat.is_forum === true,
          });
        } catch {
          await ctx.reply("The target chat is not reachable by this bot.");
          return;
        }
        await ctx.reply(`Moderation target set to ${chatId}. It remains disabled until /moderation enable succeeds.`);
        return;
      }
      if (action === "enable") {
        const rights = await validateModerationRights(ctx.api, current.targetChatId, bot.botInfo?.id);
        if (rights !== "ok") {
          await ctx.reply(`Moderation remains disabled: ${rights}`);
          return;
        }
        db.setSetting(moderationSettingKey("enabled"), "true");
        if (current.targetChatId !== null) db.setManagedPublicChatModerationEnabled(current.targetChatId, true);
        await ctx.reply("English-only moderation is enabled.");
        return;
      }
      if (action === "disable") {
        db.setSetting(moderationSettingKey("enabled"), "false");
        if (current.targetChatId !== null) db.setManagedPublicChatModerationEnabled(current.targetChatId, false);
        await ctx.reply("Moderation disabled. Existing strikes and tiers were preserved.");
        return;
      }
      if (action === "allowlist") {
        await ctx.reply(
          current.allowlist.length
            ? `Allowlist (${current.allowlist.length}): ${current.allowlist.join(", ")}`
            : "Allowlist is empty."
        );
        return;
      }
      if (action === "allow" || action === "unallow") {
        const term = args.join(" ").trim().toLowerCase();
        if (!term || term.length > 80) {
          await ctx.reply(`Usage: /moderation ${action} <term up to 80 characters>`);
          return;
        }
        const entries = new Set(current.allowlist);
        if (action === "allow") entries.add(term);
        else entries.delete(term);
        db.setSetting(moderationSettingKey("allowlist"), JSON.stringify([...entries].sort()));
        if (current.targetChatId !== null)
          db.updateManagedPublicChatConfig(current.targetChatId, {
            warningText: current.warningText,
            allowlist: [...entries].sort(),
            warningCooldownMinutes: current.warningCooldownMinutes,
            warningMessageThreshold: current.warningMessageThreshold,
            lookbackMinutes: current.lookbackMinutes,
          });
        await ctx.reply(action === "allow" ? "Allowlist entry saved." : "Allowlist entry removed.");
        return;
      }
      const userId = Number(args[0]);
      if (!Number.isSafeInteger(userId) || !current.targetChatId) {
        await ctx.reply(`Usage: /moderation ${action} <user_id>`);
        return;
      }
      const state = db.getLanguageModerationUserState(current.targetChatId, userId) ?? {
        username: null,
        current_strikes: 0,
        sanction_tier: 0,
        first_strike_at: null,
      };
      if (action === "user") {
        await ctx.reply(`User ${userId}: strikes ${state.current_strikes}/2, sanction tier ${state.sanction_tier}/3.`);
        return;
      }
      if (action === "resetstrikes") {
        db.upsertLanguageModerationUserState({
          chat_id: current.targetChatId,
          user_telegram_id: userId,
          username: state.username,
          current_strikes: 0,
          sanction_tier: state.sanction_tier,
          first_strike_at: null,
        });
        db.clearLanguageModerationCycleViolations(current.targetChatId, userId, state.sanction_tier);
        await ctx.reply(`Strikes reset for ${userId}. Sanction tier remains ${state.sanction_tier}.`);
        return;
      }
      if (action === "resettier") {
        db.upsertLanguageModerationUserState({
          chat_id: current.targetChatId,
          user_telegram_id: userId,
          username: state.username,
          current_strikes: state.current_strikes,
          sanction_tier: 0,
          first_strike_at: state.first_strike_at,
        });
        await ctx.reply(`Sanction tier reset for ${userId}. This does not unmute or unban the user.`);
        return;
      }
      await ctx.reply(
        "Usage: /moderation status|target|enable|disable|allowlist|allow|unallow|user|resetstrikes|resettier"
      );
    });
  }

  function registerManualReaction(): void {
    bot.on("message_reaction", async (ctx) => {
      const reaction = ctx.messageReaction;
      const actor = reaction.user;
      const owner = installation.getOwner();
      const managed = db.getManagedPublicChat(reaction.chat.id, true);
      const triggerReaction = managed?.manual_strike_reaction;
      if (
        !actor ||
        reaction.actor_chat ||
        actor.is_bot ||
        !owner ||
        owner.userTelegramId !== actor.id ||
        !managed ||
        managed.active !== 1 ||
        managed.moderation_enabled !== 1 ||
        managed.manual_strikes_enabled !== 1 ||
        reaction.chat.id === requireStaffChatId() ||
        !triggerReaction ||
        hasEmojiReaction(reaction.old_reaction, triggerReaction) ||
        !hasEmojiReaction(reaction.new_reaction, triggerReaction)
      )
        return;

      const author = db.getLanguageModerationMessageAuthor(reaction.chat.id, reaction.message_id);
      if (!author) {
        logger.debug(
          { chatId: reaction.chat.id, messageId: reaction.message_id },
          "Manual moderation reaction has no stored message author"
        );
        return;
      }

      const feedbackTime = moderationNow();
      const feedback = db.recordLanguageModerationOwnerFeedback({
        chatId: reaction.chat.id,
        messageId: reaction.message_id,
        userTelegramId: author.user_telegram_id,
        recordedAt: feedbackTime.toISOString(),
        retainUntil: new Date(feedbackTime.getTime() + ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
      });
      if (feedback.feedbackRecorded && !feedback.featuresAvailable) {
        logger.debug(
          { chatId: reaction.chat.id, messageId: reaction.message_id, targetUserId: author.user_telegram_id },
          "Manual moderation feedback has no stored adaptive features"
        );
      }

      const state = db.getLanguageModerationUserState(reaction.chat.id, author.user_telegram_id) ?? {
        current_strikes: 0,
        sanction_tier: 0,
        first_strike_at: null,
      };
      const added = db.addLanguageModerationViolation({
        chat_id: reaction.chat.id,
        user_telegram_id: author.user_telegram_id,
        message_id: reaction.message_id,
        message_thread_id: author.message_thread_id,
        username: author.username,
        cycle_tier: state.sanction_tier,
      });
      if (
        !added &&
        !isPendingCurrentCycleFirstStrike(
          db.getLanguageModerationViolation(reaction.chat.id, reaction.message_id),
          author.user_telegram_id,
          state
        )
      ) {
        if (feedback.feedbackRecorded) {
          logger.info(
            {
              chatId: reaction.chat.id,
              messageId: reaction.message_id,
              targetUserId: author.user_telegram_id,
              targetUsername: author.username,
              triggerReaction,
            },
            "Manual moderation feedback recorded without another strike"
          );
        }
        return;
      }

      const outcome = await advanceModerationStrike({
        db,
        api: ctx.api,
        chatId: reaction.chat.id,
        chatTitle: ("title" in reaction.chat ? reaction.chat.title : null) ?? null,
        userId: author.user_telegram_id,
        username: author.username,
        messageId: reaction.message_id,
        state,
        now: moderationNow,
        botId: bot.botInfo?.id,
        cleanupScheduler: moderationCleanupScheduler,
        staffChatId: requireStaffChatId(),
        setStrikeReaction: false,
      });
      if (outcome) {
        logger.info(
          {
            chatId: reaction.chat.id,
            messageId: reaction.message_id,
            targetUserId: author.user_telegram_id,
            targetUsername: author.username,
            currentStrikes: outcome.currentStrikes,
            sanctionTier: outcome.sanctionTier,
            triggerReaction,
            feedbackRecorded: feedback.feedbackRecorded,
          },
          "Manual moderation strike applied"
        );
      }
    });
  }

  async function handlePublicMessage(ctx: Context): Promise<void> {
    await handlePublicLanguageModeration(
      db,
      ctx,
      installation,
      bot.botInfo?.id,
      moderationNow,
      moderationCleanupScheduler,
      pendingWarnings
    );
  }

  return { registerCommand, registerManualReaction, handlePublicMessage };
}

function moderationSettingKey(name: string): string {
  return `${MODERATION_SETTING_PREFIX}:${name}`;
}

function moderationConfig(db: SupportDatabase) {
  const legacy = parseModerationConfig({
    enabled: db.getSetting(moderationSettingKey("enabled")),
    target: db.getSetting(moderationSettingKey("target")),
    warning_text: db.getSetting(moderationSettingKey("warning_text")),
    lookback_minutes: db.getSetting(moderationSettingKey("lookback_minutes")),
    warning_cooldown_minutes: db.getSetting(moderationSettingKey("warning_cooldown_minutes")),
    warning_message_threshold: db.getSetting(moderationSettingKey("warning_message_threshold")),
    allowlist: db.getSetting(moderationSettingKey("allowlist")),
  });
  const managed = legacy.targetChatId === null ? undefined : db.getManagedPublicChat(legacy.targetChatId, true);
  if (managed?.active === 0) return { ...legacy, enabled: false, targetChatId: null };
  return managed
    ? {
        enabled: managed.moderation_enabled === 1,
        targetChatId: managed.chat_id,
        warningText: managed.warning_text,
        lookbackMinutes: managed.lookback_minutes,
        warningCooldownMinutes: managed.warning_cooldown_minutes,
        warningMessageThreshold: managed.warning_message_threshold,
        allowlist: managed.allowlist,
      }
    : legacy;
}

function moderationConfigForChat(db: SupportDatabase, chatId: number) {
  const managed = db.getManagedPublicChat(chatId, true);
  if (managed) {
    return {
      enabled: managed.active === 1 && managed.moderation_enabled === 1,
      targetChatId: managed.active === 1 ? managed.chat_id : null,
      warningText: managed.warning_text,
      lookbackMinutes: managed.lookback_minutes,
      warningCooldownMinutes: managed.warning_cooldown_minutes,
      warningMessageThreshold: managed.warning_message_threshold,
      allowlist: managed.allowlist,
    };
  }
  const legacy = moderationConfig(db);
  return legacy.targetChatId === chatId ? legacy : { ...legacy, enabled: false, targetChatId: null };
}

async function formatModerationStatus(
  db: SupportDatabase,
  moderation: ReturnType<typeof moderationConfig>,
  api: BotApi,
  botId: number | undefined,
  staffChatId: number
): Promise<string> {
  const pending = db.listLanguageModerationRecoveryJobs(staffChatId, new Date().toISOString()).length;
  const rights = await validateModerationRights(api, moderation.targetChatId, botId);
  return [
    `Moderation: ${moderation.enabled ? "enabled" : "disabled"}`,
    `Target: ${moderation.targetChatId ?? "not configured"}`,
    `Bot rights: ${rights}`,
    `Warning cooldown: ${moderation.warningCooldownMinutes} minutes and ${moderation.warningMessageThreshold} ordinary messages`,
    `Lookback: ${moderation.lookbackMinutes} minutes`,
    `Allowlist entries: ${moderation.allowlist.length}`,
    `Due cleanup/log recovery jobs: ${pending}`,
  ].join("\n");
}

async function validateModerationRights(
  api: BotApi,
  targetChatId: number | null,
  botId: number | undefined
): Promise<string> {
  if (!targetChatId || !botId) return "configure a reachable target chat first.";
  try {
    const result = await validatePublicModerationChat(api, targetChatId, botId);
    const missing = result.checks.filter((check) => !check.passed).map((check) => check.label.toLowerCase());
    return result.valid ? "ok" : `missing required rights: ${missing.join(", ")}.`;
  } catch {
    return "the target chat or bot membership could not be verified.";
  }
}

async function handlePublicLanguageModeration(
  db: SupportDatabase,
  ctx: Context,
  installation: InstallationService,
  botId: number | undefined,
  now: () => Date,
  cleanupScheduler: ModerationCleanupScheduler,
  pendingWarnings: PendingWarningScheduler
): Promise<void> {
  if (!ctx.chat || !ctx.from || !ctx.message || ctx.from.is_bot) return;
  const moderation = moderationConfigForChat(db, ctx.chat.id);
  if (
    !moderation.enabled ||
    moderation.targetChatId !== ctx.chat.id ||
    ctx.chat.id === installation.requireStaffChatId()
  )
    return;
  const content = getMessageContent(ctx.message).text;
  const messageThreadId = typeof ctx.message.message_thread_id === "number" ? ctx.message.message_thread_id : null;
  if (isOrdinaryUserModerationTarget(ctx.message, ctx.from)) {
    db.addLanguageModerationMessageAuthor({
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      userTelegramId: ctx.from.id,
      username: usernameOf(ctx.from),
      messageThreadId,
    });
  }
  const chatState = db.getLanguageModerationWarningState(ctx.chat.id, messageThreadId);
  db.upsertLanguageModerationWarningState(ctx.chat.id, messageThreadId, {
    lastWarningMessageId: chatState?.last_warning_message_id ?? null,
    lastWarningAt: chatState?.last_warning_at ?? null,
    ordinaryMessagesSinceWarning: (chatState?.ordinary_messages_since_warning ?? 0) + 1,
    pendingWarningDueAt: chatState?.pending_warning_due_at ?? null,
    pendingWarningStartedAt: chatState?.pending_warning_started_at ?? null,
  });
  if (!content || isCommandText(content)) return;
  const classificationTime = now();
  const adaptiveFeatures = extractAdaptiveModerationFeatures(content, moderation.allowlist);
  let adaptiveEvidence;
  if (adaptiveFeatures && isOrdinaryUserModerationTarget(ctx.message, ctx.from)) {
    db.recordLanguageModerationObservation({
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      userTelegramId: ctx.from.id,
      features: adaptiveFeatures,
      observedAt: classificationTime.toISOString(),
      expiresAt: new Date(classificationTime.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS).toISOString(),
    });
    adaptiveEvidence = db.getLanguageModerationAdaptiveEvidence({
      chatId: ctx.chat.id,
      features: adaptiveFeatures,
      activeSince: new Date(classificationTime.getTime() - ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
      currentTime: classificationTime.toISOString(),
    });
  }
  if (classifyEnglishOnlyMessage(content, moderation.allowlist, adaptiveEvidence, classificationTime) !== "violation")
    return;

  const state = db.getLanguageModerationUserState(ctx.chat.id, ctx.from.id) ?? {
    current_strikes: 0,
    sanction_tier: 0,
    first_strike_at: null,
  };
  if (
    !db.addLanguageModerationViolation({
      chat_id: ctx.chat.id,
      user_telegram_id: ctx.from.id,
      message_id: ctx.message.message_id,
      message_thread_id: messageThreadId,
      username: usernameOf(ctx.from),
      cycle_tier: state.sanction_tier,
    })
  )
    return;
  if (state.current_strikes === 0) {
    const currentChatState = db.getLanguageModerationWarningState(ctx.chat.id, messageThreadId);
    const currentTime = now();
    const lastWarningAt = currentChatState?.last_warning_at ? Date.parse(currentChatState.last_warning_at) : 0;
    const canWarn =
      !lastWarningAt ||
      (currentTime.getTime() - lastWarningAt >= moderation.warningCooldownMinutes * 60_000 &&
        (currentChatState?.ordinary_messages_since_warning ?? 0) >= moderation.warningMessageThreshold);
    if (canWarn) {
      if (!currentChatState?.pending_warning_due_at) {
        const startedAt = currentTime;
        const dueAt = new Date(startedAt.getTime() + 3_000);
        db.upsertLanguageModerationWarningState(ctx.chat.id, messageThreadId, {
          lastWarningMessageId: currentChatState?.last_warning_message_id ?? null,
          lastWarningAt: currentChatState?.last_warning_at ?? null,
          ordinaryMessagesSinceWarning: currentChatState?.ordinary_messages_since_warning ?? 0,
          pendingWarningStartedAt: startedAt.toISOString(),
          pendingWarningDueAt: dueAt.toISOString(),
        });
        pendingWarnings.schedule(ctx.api, db, ctx.chat.id, messageThreadId, 3_000);
      }
    } else {
      await advanceModerationStrike({
        db,
        api: ctx.api,
        chatId: ctx.chat.id,
        chatTitle: ("title" in ctx.chat ? ctx.chat.title : null) ?? null,
        userId: ctx.from.id,
        username: usernameOf(ctx.from),
        messageId: ctx.message.message_id,
        state,
        now,
        botId,
        cleanupScheduler,
        staffChatId: installation.requireStaffChatId(),
        setStrikeReaction: true,
        strikeTime: currentTime,
      });
    }
    return;
  }
  await advanceModerationStrike({
    db,
    api: ctx.api,
    chatId: ctx.chat.id,
    chatTitle: ("title" in ctx.chat ? ctx.chat.title : null) ?? null,
    userId: ctx.from.id,
    username: usernameOf(ctx.from),
    messageId: ctx.message.message_id,
    state,
    now,
    botId,
    cleanupScheduler,
    staffChatId: installation.requireStaffChatId(),
    setStrikeReaction: true,
  });
}

function isOrdinaryUserModerationTarget(message: Message, from: User): boolean {
  if (from.is_bot || message.sender_chat || message.message_id <= 0) return false;
  return ORDINARY_MODERATION_MESSAGE_FIELDS.some((field) => field in message);
}

function isPendingCurrentCycleFirstStrike(
  violation: LanguageModerationViolation | undefined,
  userId: number,
  state: Pick<LanguageModerationUserState, "current_strikes" | "sanction_tier">
): boolean {
  return Boolean(
    violation &&
    state.current_strikes === 0 &&
    violation.user_telegram_id === userId &&
    violation.cycle_tier === state.sanction_tier &&
    violation.moderation_cycle_id === null &&
    violation.cleanup_state === "PENDING"
  );
}

async function advanceModerationStrike(input: {
  db: SupportDatabase;
  api: BotApi;
  chatId: number;
  chatTitle: string | null;
  userId: number;
  username: string | null;
  messageId: number;
  state: Pick<LanguageModerationUserState, "current_strikes" | "sanction_tier" | "first_strike_at">;
  now: () => Date;
  botId: number | undefined;
  cleanupScheduler: ModerationCleanupScheduler;
  staffChatId: number;
  setStrikeReaction: boolean;
  strikeTime?: Date;
}): Promise<{ currentStrikes: number; sanctionTier: number } | undefined> {
  if (input.state.current_strikes < 2) {
    const currentStrikes = input.state.current_strikes + 1;
    input.db.upsertLanguageModerationUserState({
      chat_id: input.chatId,
      user_telegram_id: input.userId,
      username: input.username,
      current_strikes: currentStrikes,
      sanction_tier: input.state.sanction_tier,
      first_strike_at:
        input.state.current_strikes === 0
          ? (input.strikeTime ?? input.now()).toISOString()
          : input.state.first_strike_at,
    });
    if (input.setStrikeReaction) {
      await setModerationReaction(input.api, input.chatId, input.messageId, MODERATION_STRIKE_REACTION);
    }
    return { currentStrikes, sanctionTier: input.state.sanction_tier };
  }

  const tier = Math.min(input.state.sanction_tier, 2);
  const sanctionKind = tier === 0 ? "24-hour mute" : tier === 1 ? "7-day mute" : "permanent ban";
  await setModerationReaction(input.api, input.chatId, input.messageId, MODERATION_SANCTION_REACTION);
  try {
    if (tier === 2) await input.api.banChatMember(input.chatId, input.userId);
    else
      await input.api.restrictChatMember(
        input.chatId,
        input.userId,
        { can_send_messages: false },
        { until_date: Math.floor(input.now().getTime() / 1000) + (tier === 0 ? 86_400 : 604_800) }
      );
  } catch (error) {
    await containModerationSanctionFailure(input, sanctionKind, error);
    return undefined;
  }

  const nextTier = Math.min(3, input.state.sanction_tier + 1);
  const violationCycleId = randomUUID();
  let cleanupJobId: number;
  try {
    cleanupJobId = input.db.completeLanguageModerationSanction({
      chatId: input.chatId,
      userId: input.userId,
      cycleTier: input.state.sanction_tier,
      violationCycleId,
      userState: {
        chat_id: input.chatId,
        user_telegram_id: input.userId,
        username: input.username,
        current_strikes: 0,
        sanction_tier: nextTier,
        first_strike_at: null,
      },
      cleanupJob: {
        staff_chat_id: input.staffChatId,
        chat_id: input.chatId,
        user_telegram_id: input.userId,
        username: input.username,
        chat_title: input.chatTitle,
        sanction_tier: nextTier,
        sanction_kind: sanctionKind,
        violation_cycle_id: violationCycleId,
        cleanup_due_at: new Date(input.now().getTime() + 10_000).toISOString(),
      },
    });
  } catch (error) {
    logger.error(
      {
        phase: "post_sanction_persistence",
        chatId: input.chatId,
        userId: input.userId,
        sanctionTier: tier,
        sanctionKind,
        errorName: error instanceof Error ? error.name : "unknown",
      },
      "MODERATION_POST_SANCTION_PERSISTENCE_FAILED"
    );
    throw error;
  }

  try {
    input.cleanupScheduler(input.api, input.db, cleanupJobId);
  } catch (error) {
    logger.warn(
      {
        chatId: input.chatId,
        userId: input.userId,
        cleanupJobId,
        sanctionTier: tier,
        sanctionKind,
        errorName: error instanceof Error ? error.name : "unknown",
      },
      "MODERATION_CLEANUP_SCHEDULE_FAILED"
    );
  }
  return { currentStrikes: 0, sanctionTier: nextTier };
}

async function containModerationSanctionFailure(
  input: {
    db: SupportDatabase;
    api: BotApi;
    chatId: number;
    userId: number;
    botId: number | undefined;
    state: Pick<LanguageModerationUserState, "sanction_tier">;
  },
  sanctionKind: string,
  error: unknown
): Promise<void> {
  const diagnostic = normalizeTelegramDeliveryError(error);
  logger.warn(
    {
      chatId: input.chatId,
      userId: input.userId,
      sanctionTier: input.state.sanction_tier,
      sanctionKind,
      category: diagnostic.category,
      permanence: diagnostic.permanence,
      telegramErrorCode: diagnostic.telegramErrorCode,
    },
    "MODERATION_SANCTION_FAILED"
  );

  if (diagnostic.permanence !== "PERMANENT") return;
  if (input.botId === undefined) {
    logger.warn(
      {
        chatId: input.chatId,
        userId: input.userId,
        sanctionTier: input.state.sanction_tier,
        sanctionKind,
        category: diagnostic.category,
        permanence: diagnostic.permanence,
      },
      "MODERATION_RIGHTS_REVALIDATION_UNKNOWN"
    );
    return;
  }

  let validation;
  try {
    validation = await validatePublicModerationChat(input.api, input.chatId, input.botId);
  } catch (validationError) {
    const validationDiagnostic = normalizeTelegramDeliveryError(validationError);
    if (isConfirmedTelegramChatAccessLoss(validationError)) {
      disableModerationAfterConfirmedRightsLoss(input, sanctionKind, ["bot_member", "bot_admin"], true);
      return;
    }
    logger.warn(
      {
        chatId: input.chatId,
        userId: input.userId,
        sanctionTier: input.state.sanction_tier,
        sanctionKind,
        category: validationDiagnostic.category,
        permanence: validationDiagnostic.permanence,
        telegramErrorCode: validationDiagnostic.telegramErrorCode,
      },
      "MODERATION_RIGHTS_REVALIDATION_UNKNOWN"
    );
    return;
  }

  if (validation.valid) return;

  const missingChecks = validation.checks.filter((check) => !check.passed).map((check) => check.key);
  disableModerationAfterConfirmedRightsLoss(input, sanctionKind, missingChecks, false, validation);
}

function disableModerationAfterConfirmedRightsLoss(
  input: {
    db: SupportDatabase;
    chatId: number;
    userId: number;
    state: Pick<LanguageModerationUserState, "sanction_tier">;
  },
  sanctionKind: string,
  missingChecks: readonly string[],
  connectionUnreachable: boolean,
  validation?: {
    reactionsAvailable: boolean | null;
    title: string | null;
    username: string | null;
    isForum: boolean;
  }
): void {
  const managed = input.db.getManagedPublicChat(input.chatId);
  if (managed) {
    if (connectionUnreachable) input.db.recordManagedPublicChatUnreachable(input.chatId);
    else if (validation)
      input.db.recordManagedPublicChatPermissionHealth({
        chatId: input.chatId,
        healthy: false,
        reactionsAvailable: validation.reactionsAvailable,
        connected: true,
        title: validation.title,
        username: validation.username,
        isForum: validation.isForum,
      });
    input.db.setManagedPublicChatModerationEnabled(input.chatId, false);
  } else {
    input.db.setSetting(moderationSettingKey("enabled"), "false");
  }
  logger.error(
    {
      chatId: input.chatId,
      userId: input.userId,
      sanctionTier: input.state.sanction_tier,
      sanctionKind,
      missingChecks,
      managed: Boolean(managed),
    },
    "MODERATION_RIGHTS_CONFIRMED_MISSING"
  );
}

function isConfirmedTelegramChatAccessLoss(error: unknown): boolean {
  if (!(error instanceof GrammyError) || (error.error_code !== 400 && error.error_code !== 403)) return false;
  const description = error.description.toLowerCase();
  return [
    "bot is not a member of the chat",
    "bot is not a member of the supergroup chat",
    "bot was kicked from the chat",
    "bot was kicked from the supergroup chat",
    "chat not found",
  ].some((phrase) => description.includes(phrase));
}

function hasEmojiReaction(reactions: readonly ReactionType[], emoji: string): boolean {
  return reactions.some((reaction) => reaction.type === "emoji" && reaction.emoji === emoji);
}

async function setModerationReaction(
  api: BotApi,
  chatId: number,
  messageId: number,
  emoji: ModerationReactionEmoji
): Promise<void> {
  try {
    const reaction: ReactionTypeEmoji = { type: "emoji", emoji };
    await api.setMessageReaction(chatId, messageId, [reaction]);
  } catch (error) {
    const diagnostic = normalizeTelegramDeliveryError(error);
    logger.warn(
      {
        chatId,
        messageId,
        emoji,
        telegramErrorCode: diagnostic.telegramErrorCode,
        description: diagnostic.description,
      },
      "Could not set moderation reaction"
    );
  }
}

type PendingWarningTimer = ReturnType<typeof setTimeout>;
type PendingWarningTimerFactory = (callback: () => void, delayMs: number) => PendingWarningTimer;

export class PendingWarningScheduler {
  private readonly timers = new Map<string, PendingWarningTimer>();

  constructor(
    private readonly backgroundTasks?: BackgroundTaskTracker,
    private readonly createTimer: PendingWarningTimerFactory = setTimeout,
    private readonly clearTimer: (timer: PendingWarningTimer) => void = clearTimeout
  ) {}

  schedule(api: BotApi, db: SupportDatabase, chatId: number, messageThreadId: number | null, delayMs: number): void {
    const key = `${chatId}:${messageThreadId ?? 0}`;
    if (this.timers.has(key)) return;
    const timer = this.createTimer(() => {
      this.timers.delete(key);
      const run = () => processPendingWarning(api, db, chatId, messageThreadId);
      if (this.backgroundTasks) {
        const accepted = this.backgroundTasks.run(run);
        if (!accepted)
          logger.debug(
            { operation: "moderation_pending_warning", chatId, messageThreadId },
            "Background work was dropped during shutdown"
          );
      } else void run();
    }, delayMs);
    timer.unref();
    this.timers.set(key, timer);
  }

  stop(): void {
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
  }
}

export async function processPendingWarning(
  api: BotApi,
  db: SupportDatabase,
  chatId: number,
  messageThreadId: number | null = null
): Promise<void> {
  const state = db.getLanguageModerationWarningState(chatId, messageThreadId);
  if (!state?.pending_warning_due_at || Date.parse(state.pending_warning_due_at) > Date.now()) return;
  const moderation = moderationConfigForChat(db, chatId);
  if (!moderation.enabled || moderation.targetChatId !== chatId) return;
  const grouped = db.claimLanguageModerationFirstStrikes(
    chatId,
    new Date(Date.now() - moderation.lookbackMinutes * 60_000).toISOString(),
    messageThreadId
  );
  if (!grouped.length) {
    db.upsertLanguageModerationWarningState(chatId, messageThreadId, {
      lastWarningMessageId: state.last_warning_message_id,
      lastWarningAt: state.last_warning_at,
      ordinaryMessagesSinceWarning: state.ordinary_messages_since_warning,
      pendingWarningDueAt: null,
      pendingWarningStartedAt: null,
    });
    return;
  }
  for (const user of grouped) {
    await setModerationReaction(api, chatId, user.messageId, MODERATION_STRIKE_REACTION);
  }
  if (state.last_warning_message_id) {
    try {
      await api.deleteMessage(chatId, state.last_warning_message_id);
    } catch {}
  }
  try {
    const warning = await api.sendMessage(
      chatId,
      moderation.warningText,
      messageThreadId === null ? {} : { message_thread_id: messageThreadId }
    );
    db.upsertLanguageModerationWarningState(chatId, messageThreadId, {
      lastWarningMessageId: warning.message_id,
      lastWarningAt: new Date().toISOString(),
      ordinaryMessagesSinceWarning: 0,
      pendingWarningDueAt: null,
      pendingWarningStartedAt: null,
    });
  } catch (error) {
    logger.warn({ chatId, err: error }, "Could not send pending language moderation warning");
  }
}
