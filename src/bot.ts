import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, Keyboard } from "grammy";
import { randomUUID } from "node:crypto";
import type { CommandContext, Context } from "grammy";
import type { Message, ReactionTypeEmoji, User } from "grammy/types";
import packageMetadata from "../package.json" with { type: "json" };
import {
  archiveTicketIfPossible,
  getSupportLogsTopicInfo,
  initializeSupportLogsTopic,
  logBanEvent,
  setSupportLogsTopicOverride,
  type SupportLogsTopicInfo,
  type ArchiveActor
} from "./archive.js";
import { config, hostConfig, setRuntimeStaffChatId } from "./config.js";
import {
  SupportDatabase,
  type TicketBatchAnswerItemRecord,
  type TicketRecord,
  type TicketStatus,
  type TicketWithUser
} from "./db.js";
import {
  CLOSED_TEXT,
  RECEIVED_TEXT,
  START_TEXT,
  formatPinnedTicketSummary,
  formatFollowUpState,
  formatEscalationTarget,
  formatStatus,
  formatTicketDetails,
  formatTicketPost,
  formatTicketUpdate,
  formatWhois,
  formatUserTicketList,
  truncate
} from "./format.js";
import { logger } from "./logger.js";
import type { QuickRepliesRegistry } from "./quickReplies.js";
import {
  TicketBatchValidationError,
  buildAnswerPackagePreview,
  buildTicketBatchPreviewPages,
  buildTicketBatchExportSnapshot,
  cleanupTicketBatchZip,
  createTicketBatchZip,
  getAnswerPackageHash,
  getTicketSnapshotToken,
  parseAndValidateAnswerPackage,
  type TicketAnswerPackage
} from "./ticketBatch.js";
import {
  displayTelegramUser,
  getMessageContent,
  isCommandText,
  usernameOf
} from "./telegram.js";
import {
  classifyEnglishOnlyMessage,
  parseModerationConfig,
  scheduleModerationCleanup,
  type ModerationCleanupScheduler
} from "./languageModeration.js";
import type { EntityNotificationProviderRegistry } from "./entityNotifications.js";
import {
  formatDeliveryFailureCategory,
  normalizeTelegramDeliveryError,
  type NormalizedDeliveryError
} from "./deliveryDiagnostics.js";
import { StaffChatDeliveryCoordinator, type StaffChatDeliveryOptions } from "./staffChatDelivery.js";
import { InstallationService, type Permission } from "./installation.js";
import { formatWorkspaceChecklist, isPrivateInviteLink, parsePublicSupergroupReference, validateStaffWorkspace, type WorkspaceValidationResult } from "./workspaceValidation.js";
import {
  formatPublicChatPermissionChecklist,
  validatePublicModerationChat
} from "./publicChatModeration.js";

const STAFF_ONLY_TEXT = "This command is only available for staff.";
const BANNED_TEXT = "You are currently restricted from opening support tickets.";
const DEFAULT_BAN_REASON = "No reason provided.";
const STAFF_HELP_SENT_SETTING_PREFIX = "staff_help_sent";
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const MODERATION_SETTING_PREFIX = "language_moderation";
const ENTITY_NOTIFICATION_SETTING_PREFIX = "entity_notifications";
const STAFF_OPERATION_NO_RETRY_AT = "9999-12-31T23:59:59.999Z";
const pendingWarningTimers = new Map<string, ReturnType<typeof setTimeout>>();
type ModerationReactionEmoji = "\u{1F440}" | "\u{1F621}";
const MODERATION_STRIKE_REACTION: ModerationReactionEmoji = "\u{1F440}";
const MODERATION_SANCTION_REACTION: ModerationReactionEmoji = "\u{1F621}";
const installationServicesByApi = new WeakMap<object, InstallationService>();
const installationServicesByContext = new WeakMap<Context, InstallationService>();

const USER_HELP_TEXT = [
  "Support help",
  "",
  "Send one message here to open a ticket. You can include your AgentOn UID, wallet address, quest link, screenshots, documents, or transaction hash.",
  "",
  "Only one open ticket is active at a time. While it is open, keep sending messages in this chat and they will be added to the same ticket.",
  "",
  "Use the Close ticket button when the issue is solved. After the ticket is closed, your next message opens a new ticket.",
  "",
  "Commands:",
  "/start - show the initial instructions",
  "/status - show your latest ticket status",
  "/mytickets - show your recent tickets",
  "/help - show this help"
].join("\n");

const STAFF_HELP_TEXT = [
  "Staff help",
  "",
  "Workflow:",
  "- One ticket = one forum topic.",
  "- The first ticket message contains metadata and controls.",
  "- Follow-up user messages are compact.",
  "- Staff replies in the ticket topic are forwarded to the user.",
  "- Users only get automatic messages when a ticket opens and closes.",
  "- Closed tickets are archived to Support Logs as a .txt transcript.",
  "- Ticket topics are deleted or closed after archive when Telegram allows it.",
  "- Support Logs are scoped per STAFF_CHAT_ID.",
  "- If Support Logs is missing, the bot creates it automatically.",
  "",
  "Staff commands:",
  "/help - show this help",
  "/chatid - show current chat id",
  "/whois - show current ticket/user info inside a ticket topic",
  "/ticket <id> - show ticket details",
  "/close <id> - close ticket",
  "/ban <telegram_id> [reason] - ban user from opening tickets",
  "/unban <telegram_id> - unban user",
  "/bans - list banned users",
  "/setlogs - use current topic as Support Logs",
  "/logs - show/create current Support Logs topic status",
  "/exporttickets - export active tickets for an answer package",
  "Upload a validated answer package in the staff group to preview and apply its replies.",
  "/moderation <subcommand> - configure public English-only moderation",
  "/questnotify <subcommand> - configure new-entity notifications",
  "",
  "OWNER/ADMIN setup, team invitations, and role-based access are managed from the private staff dashboard."
].join("\n");

const STAFF_ONBOARDING_TEXT = [
  "Support bot is configured for this staff group.",
  "",
  "Key workflow:",
  "- One ticket = one forum topic.",
  "- Staff replies inside a ticket topic are forwarded to the user.",
  "- Follow-up user messages stay compact in the same topic.",
  "- Users only receive automatic messages when a ticket opens and closes.",
  "- Closed tickets are archived to Support Logs as .txt transcripts.",
  "",
  "Commands:",
  "/help, /chatid, /whois, /ticket <id>, /close <id>",
  "/ban <telegram_id> [reason], /unban <telegram_id>, /bans",
  "/setlogs, /logs",
  "/exporttickets, /moderation status",
  "/questnotify status|target|provider|enable|disable|help",
  "",
  "Run /setlogs inside any topic to make it Support Logs.",
  "Run /logs to show or create the current Support Logs topic.",
  "",
  "This onboarding message is sent only once per STAFF_CHAT_ID."
].join("\n");

type BotApi = Context["api"];

interface CloseTicketOptions {
  notifyUser?: boolean;
  userText?: string;
  staffNotice?: string;
  closedBy?: ArchiveActor;
  onArchiveFailure?: (diagnostic: NormalizedDeliveryError) => void;
}

interface BanCommand {
  userId: number;
  reason: string;
}

interface ErrorWithCode extends Error {
  code?: string;
}

interface StaffTextReplySource {
  chatId: number;
  messageId: number;
}

interface QuickRepliesCallbackTarget {
  ticket: TicketWithUser;
  messageChatId: number;
  messageId: number;
  messageThreadId: number;
}

type DeliverAndRecordStaffTextReply = (
  ticket: TicketWithUser,
  text: string,
  staffUser: User | undefined,
  source?: StaffTextReplySource
) => Promise<number>;

interface BotRuntimeDependencies {
  fetch?: typeof fetch;
  now?: () => Date;
  scheduleModerationCleanup?: ModerationCleanupScheduler;
  entityNotificationProviders?: EntityNotificationProviderRegistry;
  staffChatDelivery?: StaffChatDeliveryOptions;
  installationService?: InstallationService;
}

export type SupportBot = Bot<Context> & { recoverPendingTicketBatchStaffOperations(): Promise<void> };

export function createBot(
  db: SupportDatabase,
  quickRepliesRegistry: QuickRepliesRegistry,
  runtime: BotRuntimeDependencies = {}
): SupportBot {
  const bot = new Bot<Context>(config.botToken);
  const installation = runtime.installationService ?? new InstallationService(db);
  if (!runtime.installationService && !installation.getActiveWorkspace()) {
    if (hostConfig.staffChatId !== null) { installation.adoptLegacyInstallation(hostConfig.staffChatId); setRuntimeStaffChatId(hostConfig.staffChatId); }
  }
  installationServicesByApi.set(bot.api, installation);
  bot.use(async (ctx, next) => {
    installationServicesByContext.set(ctx, installation);
    await next();
  });
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  const moderationNow = runtime.now ?? (() => new Date());
  const moderationCleanupScheduler = runtime.scheduleModerationCleanup ?? scheduleModerationCleanup;
  const entityNotificationProviders = runtime.entityNotificationProviders ?? new Map();
  const runningTicketBatchExports = new Set<number>();
  const staffChatDelivery = new StaffChatDeliveryCoordinator(runtime.staffChatDelivery);
  const pendingPublicChatSelection = new Set<number>();
  const pendingPublicChatConfiguration = new Map<number, {
    chatId: number;
    field: "warning" | "allowlist" | "cooldown" | "threshold" | "lookback";
  }>();
  const privateOperatorCallbackNamespaces = new Set(["owner", "setup", "workspace", "dashboard", "batch-ui", "public", "team", "rbac"]);
  const pendingWorkspaceSelection = new Map<number, "SETUP" | "RECONFIGURE">();
  const privateUiMessages = new Map<number, { chatId: number; messageId: number }>();
  const workspacePickerPrompts = new Map<number, { chatId: number; messageId: number }>();
  let ticketBatchRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let ticketBatchRecoveryTimerAt: number | undefined;
  let ticketBatchRecoveryQueue: Promise<void> = Promise.resolve();

  const requirePermission = async (ctx: Context, permission: Permission): Promise<boolean> => {
    if (!isStaffChat(ctx) || !ctx.from) return false;
    if (installation.getState().authorizationMode === "LEGACY_TRUSTED_GROUP" || installation.can(ctx.from.id, permission)) return true;
    await ctx.reply(`Your application role does not allow this action (${permission.toLowerCase().replaceAll("_", " ")}).`);
    return false;
  };

  const hasRequiredPrivateWorkspaceMembership = async (ctx: Context): Promise<boolean> => {
    if (installation.getState().authorizationMode !== "RBAC_ACTIVE") return true;
    if (!ctx.from) return false;
    const staffChatId = installation.getStaffChatId();
    if (staffChatId === null) return false;
    try {
      const member = await ctx.api.getChatMember(staffChatId, ctx.from.id);
      return member.status !== "left" && member.status !== "kicked";
    } catch {
      return false;
    }
  };

  const requirePrivatePermission = async (ctx: Context, permission: Permission): Promise<boolean> => {
    if (!isPrivateChat(ctx) || !ctx.from || !installation.can(ctx.from.id, permission)) {
      if (isPrivateChat(ctx)) await ctx.reply("Your application role does not allow this action.");
      return false;
    }
    if (!await hasRequiredPrivateWorkspaceMembership(ctx)) {
      await ctx.reply("Staff workspace membership required for role-based access.");
      return false;
    }
    return true;
  };

  class StaffOnlyDeliveryError extends Error {
    constructor(readonly diagnostic: NormalizedDeliveryError, readonly retryAt: string | null) {
      super(diagnostic.category);
    }
  }

  async function runStaffChatOperation<T>(operation: () => Promise<T>, chatId = config.staffChatId): Promise<T> {
    const outcome = await staffChatDelivery.run(chatId, operation);
    if (outcome.value !== undefined) return outcome.value;
    throw new StaffOnlyDeliveryError(outcome.diagnostic ?? normalizeTelegramDeliveryError(new Error("Staff operation failed")), outcome.retryAt);
  }

  async function deliverAndRecordStaffTextReply(
    ticket: TicketWithUser,
    text: string,
    staffUser: User | undefined,
    source?: StaffTextReplySource
  ): Promise<number> {
    const sent = await bot.api.sendMessage(ticket.user_telegram_id, truncate(text.trim(), 3500));

    db.addMessage({
      ticketId: ticket.id,
      direction: "STAFF_TO_USER",
      sourceChatId: source?.chatId ?? ticket.staff_chat_id ?? config.staffChatId,
      sourceMessageId: source?.messageId ?? null,
      deliveryChatId: ticket.user_telegram_id,
      deliveryMessageId: sent.message_id,
      fromTelegramId: staffUser?.id ?? null,
      fromUsername: usernameOf(staffUser),
      senderType: "STAFF",
      senderDisplayName: staffUser ? displayTelegramUser(staffUser) : "Support",
      senderUsername: usernameOf(staffUser),
      text,
      mediaType: null,
      filename: null,
      fileId: null
    });
    return sent.message_id;
  }

  async function sendTicketBatchTopicEcho(
    ticket: TicketWithUser,
    item: ReturnType<SupportDatabase["listTicketBatchAnswerItems"]>[number]
  ): Promise<void> {
    if (item.topic_echo_state === "SENT" || item.topic_echo_state === "NOT_REQUIRED" || item.topic_echo_state === "TERMINAL_FAILED") return;
    if (ticket.staff_chat_id !== config.staffChatId || ticket.message_thread_id === null) {
      throw new Error("Ticket topic is unavailable for batch echo.");
    }
    const threadId = ticket.message_thread_id;
    const staffChatId = ticket.staff_chat_id;
    const hasContext = hasBatchFollowUpContext(item);
    if (item.action === "no_action" && !hasContext) {
      db.recordTicketBatchTopicEcho(item.answer_package_id, item.ticket_id, "NOT_REQUIRED");
      return;
    }
    const persistedItem = db.listTicketBatchAnswerItems(item.answer_package_id)
      .find((candidate) => candidate.ticket_id === item.ticket_id) ?? item;
    if (item.action !== "no_action" && !isConfirmedBatchReply(persistedItem)) {
      db.recordTicketBatchTopicEcho(item.answer_package_id, item.ticket_id, "NOT_REQUIRED", {
        lastError: "Success echo is not applicable after an unconfirmed user delivery."
      });
      logger.warn({ answerPackageId: item.answer_package_id, ticketId: item.ticket_id }, "Skipped contradictory ticket batch success echo");
      return;
    }
    const lines = [item.action === "no_action" ? "ℹ️ Batch follow-up updated — no user message sent" : "✅ Batch reply sent to user"];
    if (item.action !== "no_action" && item.reply_text) lines.push("", item.reply_text);
    if (item.follow_up_state !== "NONE") lines.push("", `Follow-up: ${formatFollowUpState(item.follow_up_state)}`);
    if (item.escalation_target !== "NONE") lines.push(`Escalation: ${formatEscalationTarget(item.escalation_target)}`);
    if (item.internal_note) lines.push(`Internal note: ${item.internal_note}`);
    let echoed: Awaited<ReturnType<typeof bot.api.sendMessage>>;
    try {
      echoed = await runStaffChatOperation(() => bot.api.sendMessage(staffChatId, truncate(lines.join("\n"), 3500), { message_thread_id: threadId }));
    } catch (error) {
      throw error;
    }
    db.recordTicketBatchTopicEcho(item.answer_package_id, item.ticket_id, "SENT", {
      chatId: staffChatId,
      threadId,
      messageId: echoed.message_id
    });
  }

  async function sendTicketBatchDeliveryFailureEvent(
    ticket: TicketWithUser,
    item: ReturnType<SupportDatabase["listTicketBatchAnswerItems"]>[number],
    diagnostic: NormalizedDeliveryError
  ): Promise<void> {
    if (item.delivery_failure_event_state === "SENT") return;
    if (item.action === "no_action" || item.delivery_message_id !== null || item.delivery_error_category === null) {
      db.recordTicketBatchFailureEvent(item.answer_package_id, item.ticket_id, "NOT_REQUIRED");
      return;
    }
    if (ticket.staff_chat_id !== config.staffChatId || ticket.message_thread_id === null) {
      throw new Error("Ticket topic is unavailable for batch delivery failure event.");
    }
    const threadId = ticket.message_thread_id;
    const staffChatId = ticket.staff_chat_id;
    const lines = [
      diagnostic.permanence === "UNKNOWN_DELIVERY"
        ? "⚠️ Batch delivery outcome is unknown"
        : "⚠️ Batch reply was not delivered",
      "",
      `Category: ${formatDeliveryFailureCategory(diagnostic.category)}`
    ];
    if (diagnostic.telegramErrorCode !== null) lines.push(`Telegram code: ${diagnostic.telegramErrorCode}`);
    if (diagnostic.retryAfterSeconds !== null) lines.push(`Retry after: ${diagnostic.retryAfterSeconds}s`);
    lines.push("Action: Ticket remains open");
    lines.push(diagnostic.category === "USER_BLOCKED_BOT" || diagnostic.category === "USER_DEACTIVATED"
      ? "Next step: Contact is not possible until the user restores bot access."
      : diagnostic.category === "CHAT_UNAVAILABLE"
        ? "Next step: Verify that the user can receive bot messages before a controlled retry."
        : diagnostic.permanence === "PERMANENT"
          ? "Next step: Manual review required before a controlled retry."
      : diagnostic.permanence === "TEMPORARY"
        ? "Next step: Prepare a controlled retry later."
        : "Next step: Do not resend automatically; manual review required.");
    let sent: Awaited<ReturnType<typeof bot.api.sendMessage>>;
    try {
      sent = await runStaffChatOperation(() => bot.api.sendMessage(staffChatId, lines.join("\n"), {
        message_thread_id: threadId
      }));
    } catch (error) {
      const failure = batchStaffFailure(error);
      db.recordTicketBatchFailureEvent(item.answer_package_id, item.ticket_id, "FAILED", null, {
        nextRetryAt: staffNextRetryAt(error),
        incrementAttempt: true
      });
      scheduleTicketBatchStaffRecovery(failure.retryAt);
      throw error;
    }
    db.recordTicketBatchFailureEvent(item.answer_package_id, item.ticket_id, "SENT", sent.message_id, { incrementAttempt: true });
  }

  function persistBatchFollowUp(ticket: TicketWithUser, item: ReturnType<SupportDatabase["listTicketBatchAnswerItems"]>[number]): void {
    db.setTicketFollowUpContext(ticket.id, {
      followUpState: item.follow_up_state,
      internalNote: item.internal_note,
      escalationTarget: item.escalation_target,
      sourceAnswerPackageId: item.answer_package_id
    });
    if (item.follow_up_state === "WAITING_USER") db.updateTicketStatus(ticket.id, "WAITING_USER");
    else if (item.follow_up_state !== "NONE" && ticket.status !== "CLOSED") db.updateTicketStatus(ticket.id, "IN_PROGRESS");
    else if (item.action !== "no_action" && ticket.status === "OPEN") db.updateTicketStatus(ticket.id, "IN_PROGRESS");
  }

  function hasBatchFollowUpContext(item: ReturnType<SupportDatabase["listTicketBatchAnswerItems"]>[number]): boolean {
    return item.follow_up_state !== "NONE" || item.internal_note !== null || item.escalation_target !== "NONE";
  }

  function isConfirmedBatchReply(item: ReturnType<SupportDatabase["listTicketBatchAnswerItems"]>[number]): boolean {
    return item.action !== "no_action"
      && item.delivery_message_id !== null
      && item.delivery_error_category === null
      && item.delivery_error_permanence === null
      && item.delivery_failure_event_state !== "SENT";
  }

  function quickRepliesCategoryKeyboard(ticketId: number): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    for (const category of quickRepliesRegistry.listCategories()) {
      keyboard.text(category.title, quickRepliesCategoryCallbackData(ticketId, category.id)).row();
    }

    return keyboard.text("Cancel", quickRepliesCancelCallbackData(ticketId));
  }

  function quickRepliesTemplateKeyboard(ticketId: number, categoryId: string, page: number): InlineKeyboard {
    const templates = quickRepliesRegistry.listTemplates(categoryId);
    const start = page * 6;
    const pageTemplates = templates.slice(start, start + 6);
    const keyboard = new InlineKeyboard();

    for (const template of pageTemplates) {
      keyboard.text(template.title, quickRepliesTemplateCallbackData(ticketId, template.id)).row();
    }

    if (page > 0) {
      keyboard.text("Previous", quickRepliesPageCallbackData(ticketId, categoryId, page - 1));
    }

    if (start + pageTemplates.length < templates.length) {
      keyboard.text("Next", quickRepliesPageCallbackData(ticketId, categoryId, page + 1));
    }

    if (page > 0 || start + pageTemplates.length < templates.length) {
      keyboard.row();
    }

    return keyboard
      .text("Back", quickRepliesBackCallbackData(ticketId))
      .text("Cancel", quickRepliesCancelCallbackData(ticketId));
  }

  async function resolveQuickRepliesCallbackTarget(
    ctx: Context,
    rawTicketId: string | undefined
  ): Promise<QuickRepliesCallbackTarget | null> {
    if (!isStaffChat(ctx)) {
      await ctx.answerCallbackQuery({
        text: "Quick Replies are available to staff only.",
        show_alert: true
      });
      return null;
    }
    if (!hasApplicationPermission(ctx, "REPLY_TO_TICKETS")) {
      await ctx.answerCallbackQuery({ text: "Your application role does not allow ticket replies.", show_alert: true });
      return null;
    }

    const ticketId = parseUserId(rawTicketId ?? "");
    if (!ticketId) {
      await ctx.answerCallbackQuery({ text: "Invalid ticket." });
      return null;
    }

    const ticket = db.getTicketWithUser(ticketId);
    if (!ticket || ticket.staff_chat_id !== config.staffChatId) {
      await ctx.answerCallbackQuery({ text: "Ticket not found in this staff chat." });
      return null;
    }

    if (ticket.status === "CLOSED") {
      await ctx.answerCallbackQuery({ text: "Ticket is already closed." });
      return null;
    }

    const callbackMessage = ctx.callbackQuery?.message;
    const ticketMessageThreadId = ticket.message_thread_id;
    const callbackMessageThreadId =
      callbackMessage && "message_thread_id" in callbackMessage
        ? callbackMessage.message_thread_id
        : undefined;

    if (
      !callbackMessage ||
      typeof ticketMessageThreadId !== "number" ||
      typeof callbackMessageThreadId !== "number" ||
      callbackMessageThreadId !== ticketMessageThreadId
    ) {
      await ctx.answerCallbackQuery({ text: "Use Quick Replies inside this ticket topic." });
      return null;
    }

    return {
      ticket,
      messageChatId: callbackMessage.chat.id,
      messageId: callbackMessage.message_id,
      messageThreadId: ticketMessageThreadId
    };
  }

  async function answerQuickRepliesCallbackOnce(
    ctx: Context,
    response: Parameters<Context["answerCallbackQuery"]>[0],
    logMessage: string
  ): Promise<void> {
    try {
      await ctx.answerCallbackQuery(response);
    } catch (error) {
      logger.warn({ err: error }, logMessage);
    }
  }

  async function runQuickRepliesCallbackOperation(
    ctx: Context,
    successText: string,
    operation: () => Promise<unknown>
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      await answerQuickRepliesCallbackOnce(
        ctx,
        {
          text: "Could not update Quick Replies.",
          show_alert: true
        },
        "Could not answer failed Quick Replies callback"
      );
      throw error;
    }

    await answerQuickRepliesCallbackOnce(
      ctx,
      { text: successText },
      "Could not answer successful Quick Replies callback"
    );
  }

  async function handleQuickRepliesCallback(ctx: Context, data: string): Promise<void> {
    const [, action, rawTicketId, rawResourceId, rawPage] = data.split(":");
    if (
      action !== "open" &&
      action !== "category" &&
      action !== "page" &&
      action !== "back" &&
      action !== "cancel" &&
      action !== "template"
    ) {
      await ctx.answerCallbackQuery({ text: "Quick Replies action is not available." });
      return;
    }

    const target = await resolveQuickRepliesCallbackTarget(ctx, rawTicketId);
    if (!target) {
      return;
    }

    if (action === "open") {
      await runQuickRepliesCallbackOperation(ctx, "Quick replies opened.", async () => {
        await ctx.api.sendMessage(config.staffChatId, "Quick replies\nChoose a category:", {
          message_thread_id: target.messageThreadId,
          reply_markup: quickRepliesCategoryKeyboard(target.ticket.id)
        });
      });
      return;
    }

    if (action === "cancel") {
      await runQuickRepliesCallbackOperation(ctx, "Quick replies closed.", async () => {
        await ctx.api.editMessageReplyMarkup(target.messageChatId, target.messageId, {
          reply_markup: undefined
        });
      });
      return;
    }

    if (action === "back") {
      await runQuickRepliesCallbackOperation(ctx, "Quick replies opened.", async () => {
        await ctx.api.editMessageText(target.messageChatId, target.messageId, "Quick replies\nChoose a category:", {
          reply_markup: quickRepliesCategoryKeyboard(target.ticket.id)
        });
      });
      return;
    }

    if (action === "template") {
      const template = quickRepliesRegistry.findTemplate(rawResourceId ?? "");
      if (!template) {
        await ctx.answerCallbackQuery({ text: "Quick Replies template not found." });
        return;
      }

      try {
        await deliverAndRecordStaffTextReply(target.ticket, template.text, ctx.from);
      } catch (error) {
        logger.error({ err: error, ticketId: target.ticket.id }, "Could not deliver Quick Reply to user");
        await sendStaffTopicNotice(
          ctx.api,
          target.ticket,
          `Could not send quick reply for ticket #${target.ticket.id} to user ${target.ticket.user_telegram_id}: ${describeError(error)}`
        );
        await ctx.answerCallbackQuery({
          text: "Could not send quick reply.",
          show_alert: true
        });
        return;
      }

      if (target.ticket.status === "OPEN") {
        try {
          db.updateTicketStatus(target.ticket.id, "IN_PROGRESS");
          await refreshStaffTicketMessage(db, ctx.api, target.ticket.id);
        } catch (error) {
          logger.warn({ err: error, ticketId: target.ticket.id }, "Could not refresh ticket after Quick Reply");
        }
      }

      try {
        await ctx.api.editMessageText(
          target.messageChatId,
          target.messageId,
          `Quick reply sent\n${template.title}`,
          { reply_markup: undefined }
        );
      } catch (error) {
        logger.warn({ err: error, ticketId: target.ticket.id }, "Could not clean up Quick Replies menu");
      }

      await ctx.answerCallbackQuery({ text: "Quick reply sent." });
      return;
    }

    const category = quickRepliesRegistry.findCategory(rawResourceId ?? "");
    if (!category) {
      await ctx.answerCallbackQuery({ text: "Quick Replies category not found." });
      return;
    }

    let page = 0;
    if (action === "page") {
      const parsedPage = parseQuickRepliesPage(rawPage);
      if (parsedPage === null) {
        await ctx.answerCallbackQuery({ text: "Invalid Quick Replies page." });
        return;
      }

      page = parsedPage;
    }

    const totalPages = Math.ceil(category.templates.length / 6);
    if (page >= totalPages) {
      await ctx.answerCallbackQuery({ text: "Quick Replies page is out of range." });
      return;
    }

    await runQuickRepliesCallbackOperation(ctx, "Quick Replies category opened.", async () => {
      await ctx.api.editMessageText(
        target.messageChatId,
        target.messageId,
        `Quick replies\n${category.title}\nChoose a reply:`,
        {
          reply_markup: quickRepliesTemplateKeyboard(target.ticket.id, category.id, page)
        }
      );
    });
  }

  function persistedPrivateScreen(userId: number): { chatId: number; messageId: number } | undefined {
    const session = installation.getOnboardingSession(userId);
    if (!session || session.primary_message_chat_id === null || session.primary_message_id === null) return undefined;
    return { chatId: session.primary_message_chat_id, messageId: session.primary_message_id };
  }

  function rememberPrivateScreen(ctx: Context, target: { chatId: number; messageId: number }): void {
    if (!ctx.from) return;
    privateUiMessages.set(ctx.from.id, target);
    if (!installation.getOnboardingSession(ctx.from.id)) installation.saveOnboardingStage(ctx.from.id, "WELCOME", "COMPLETED");
    installation.setOnboardingPrimaryMessage(ctx.from.id, target.chatId, target.messageId);
  }

  function isObsoletePrivateBatchCallback(ctx: Context): boolean {
    const message = ctx.callbackQuery?.message;
    if (!ctx.from || message?.chat.type !== "private") return true;
    const current = persistedPrivateScreen(ctx.from.id);
    return current !== undefined && (current.chatId !== message.chat.id || current.messageId !== message.message_id);
  }

  function isObsoletePrivateOperatorCallback(ctx: Context, namespace: string): boolean {
    if (!isPrivateChat(ctx) || !privateOperatorCallbackNamespaces.has(namespace)) return false;
    return isObsoletePrivateBatchCallback(ctx);
  }

  async function renderPrivateScreen(ctx: Context, text: string, replyMarkup: InlineKeyboard): Promise<void> {
    const callbackMessage = ctx.callbackQuery?.message;
    const callbackTarget = callbackMessage?.chat.type === "private"
      ? { chatId: callbackMessage.chat.id, messageId: callbackMessage.message_id }
      : undefined;
    const target = (ctx.from ? privateUiMessages.get(ctx.from.id) : undefined) ?? (ctx.from ? persistedPrivateScreen(ctx.from.id) : undefined) ?? callbackTarget;
    if (target) {
      try {
        await ctx.api.editMessageText(target.chatId, target.messageId, text, { reply_markup: replyMarkup });
        rememberPrivateScreen(ctx, target);
        return;
      } catch (error) {
        if (error instanceof GrammyError && error.description.includes("message is not modified")) {
          rememberPrivateScreen(ctx, target);
          return;
        }
        logger.warn({ userId: ctx.from?.id }, "Could not replace private UI screen");
      }
    }
    const sent = await ctx.reply(text, { reply_markup: replyMarkup });
    rememberPrivateScreen(ctx, { chatId: sent.chat.id, messageId: sent.message_id });
  }

  function privateUiTargets(ctx: Context): Array<{ chatId: number; messageId: number }> {
    const callbackMessage = ctx.callbackQuery?.message;
    const callbackTarget = callbackMessage?.chat.type === "private"
      ? { chatId: callbackMessage.chat.id, messageId: callbackMessage.message_id }
      : undefined;
    const trackedTarget = ctx.from ? privateUiMessages.get(ctx.from.id) : undefined;
    const persistedTarget = ctx.from ? persistedPrivateScreen(ctx.from.id) : undefined;
    return [callbackTarget, trackedTarget, persistedTarget].filter((target): target is { chatId: number; messageId: number } => Boolean(target))
      .filter((target, index, targets) => targets.findIndex((other) => other.chatId === target.chatId && other.messageId === target.messageId) === index);
  }

  async function retirePrivateScreens(ctx: Context): Promise<void> {
    for (const target of privateUiTargets(ctx)) {
      try {
        await ctx.api.deleteMessage(target.chatId, target.messageId);
      } catch {
        try {
          await ctx.api.editMessageReplyMarkup(target.chatId, target.messageId, { reply_markup: { inline_keyboard: [] } });
        } catch {
          logger.warn({ userId: ctx.from?.id }, "Could not retire private UI screen");
        }
      }
    }
    if (ctx.from) privateUiMessages.delete(ctx.from.id);
  }

  async function sendFreshPrivateScreen(ctx: Context, text: string, replyMarkup: InlineKeyboard) {
    const sent = await ctx.reply(text, { reply_markup: replyMarkup });
    rememberPrivateScreen(ctx, { chatId: sent.chat.id, messageId: sent.message_id });
    return sent;
  }

  async function refreshPrivateScreen(ctx: Context, text: string, replyMarkup: InlineKeyboard) {
    await retirePrivateScreens(ctx);
    return sendFreshPrivateScreen(ctx, text, replyMarkup);
  }

  async function retireWorkspacePickerPrompt(userId: number | undefined): Promise<void> {
    if (userId === undefined) return;
    const prompt = workspacePickerPrompts.get(userId);
    workspacePickerPrompts.delete(userId);
    if (!prompt) return;
    try {
      await bot.api.deleteMessage(prompt.chatId, prompt.messageId);
    } catch {
      logger.warn({ userId }, "Could not delete workspace picker prompt");
    }
  }

  function dashboardText(userId: number): string {
    const member = installation.getMember(userId);
    const counts = db.getInstallationOperationalCounts();
    return [member?.role === "OWNER" ? "Owner dashboard" : `${member?.role.replace("_", " ") ?? "Staff"} dashboard`, "",
      installation.getState().setupState === "READY" ? "Support is ready." : "Finish setup to activate support.",
      `Public chats: ${counts.publicChats}`].join("\n");
  }

  function systemStatusText(userId: number): string {
    const workspace = installation.getActiveWorkspace();
    const counts = db.getInstallationOperationalCounts();
    const roles = new Map<string, number>();
    for (const entry of installation.listTeamMembers()) roles.set(entry.role, (roles.get(entry.role) ?? 0) + 1);
    return ["System status", "",
      `Bot: @${bot.botInfo?.username ?? "loading"}`, `Version: ${packageMetadata.version}`, `Setup: ${installation.getState().setupState}`,
      `Authorization: ${installation.getState().authorizationMode}`, `Owner: ${installation.getOwner()?.username ? `@${installation.getOwner()?.username}` : installation.getOwner()?.userTelegramId ?? "not paired"}`,
      `Staff workspace: ${workspace?.title ?? workspace?.telegram_chat_id ?? "not configured"}`,
      `Support Logs: ${workspace && db.getSetting(`support_logs_message_thread_id:${workspace.telegram_chat_id}`) ? "configured" : "not configured"}`,
      `Public chats: ${counts.publicChats}`, `Team: OWNER ${roles.get("OWNER") ?? 0}, ADMIN ${roles.get("ADMIN") ?? 0}, SENIOR_AGENT ${roles.get("SENIOR_AGENT") ?? 0}, AGENT ${roles.get("AGENT") ?? 0}`,
      `Moderation enabled: ${counts.moderationEnabled}/${counts.publicChats}`, `Unhealthy moderation chats: ${counts.unhealthyModerationChats}`,
      `Pending moderation cleanup: ${counts.pendingCleanup}`, `Pending archives: ${counts.pendingArchives}`,
      `Pending batch staff operations: ${counts.pendingBatchStaffOperations}`, "Database: available"].join("\n");
  }

  function privateBatchWorkflowSettingKey(userId: number): string {
    return `private_batch_export:${userId}`;
  }

  function getPendingPrivateBatchExport(userId: number): string | undefined {
    const exportId = db.getSetting(privateBatchWorkflowSettingKey(userId))?.trim();
    if (!exportId) return undefined;
    return db.getTicketBatchExport(exportId, config.staffChatId)?.delivery_state === "DELIVERED" ? exportId : undefined;
  }

  function setPendingPrivateBatchExport(userId: number, exportId: string | undefined): void {
    db.setSetting(privateBatchWorkflowSettingKey(userId), exportId ?? "");
    installation.saveOnboardingStage(userId, exportId ? "BATCH_APPLY" : "WELCOME", exportId ? "ACTIVE" : "COMPLETED");
  }

  function dashboardKeyboard(userId: number, role: string): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    if (role === "OWNER" || role === "ADMIN") {
      if (installation.getState().setupState !== "READY") keyboard.text("Continue setup", "setup:resume").row();
      const pendingExport = getPendingPrivateBatchExport(userId);
      keyboard.text("Staff workspace", "dashboard:workspace").row().text("Public chats", "dashboard:public").text("Team", "dashboard:team").row().text("Moderation", "dashboard:moderation").row().text(pendingExport ? "Continue batch" : "Export tickets", pendingExport ? "batch-ui:continue" : "batch-ui:export").text("Batch status", "batch-ui:recent").row().text("System status", "dashboard:status").row();
    }
    return keyboard.text("Open test ticket as user", "dashboard:test-ticket");
  }

  function privateBatchWaitingKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("How to prepare answers", "batch-ui:help")
      .row()
      .text("Abort batch", "batch-ui:abort")
      .row()
      .text("Back", "dashboard:home");
  }

  function privateBatchWaitingText(exportId: string, notice?: string): string {
    return ["Waiting for answers", "", "Your ticket export is ready.", `Send the completed ticket-answers_${exportId}.json file here. Only a valid answer package for this export will continue.`, ...(notice ? ["", notice] : [])].join("\n");
  }

  async function showPrivateBatchWaiting(ctx: Context, exportId: string, refresh = false, notice?: string): Promise<void> {
    const render = refresh ? refreshPrivateScreen : renderPrivateScreen;
    await render(ctx, privateBatchWaitingText(exportId, notice), privateBatchWaitingKeyboard());
  }

  async function showPrivateBatchHelp(ctx: Context): Promise<void> {
    await renderPrivateScreen(ctx, ["Preparing batch answers", "", "1. Give your chosen AI assistant the product documentation, support policies, FAQ, tone guidance, and any other authoritative context it needs.", "2. Upload this ticket export ZIP to that assistant.", "3. Ask it to follow the instructions included in the archive and prepare the completed import file.", "4. Send the returned answer file here for preview and explicit approval."].join("\n"), new InlineKeyboard().text("Back", "batch-ui:continue"));
  }

  async function showDashboard(ctx: Context, fresh = false): Promise<void> {
    if (!ctx.from) return;
    const member = installation.getMember(ctx.from.id);
    if (!member) return;
    if (!await hasRequiredPrivateWorkspaceMembership(ctx)) {
      await ctx.reply("Staff workspace membership required for role-based access.");
      return;
    }
    const render = fresh ? refreshPrivateScreen : renderPrivateScreen;
    await render(ctx, dashboardText(ctx.from.id), dashboardKeyboard(ctx.from.id, member.role));
  }

  async function showSystemStatus(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    await renderPrivateScreen(ctx, systemStatusText(ctx.from.id), new InlineKeyboard().text("Back", "dashboard:home"));
  }

  async function showModerationDashboard(ctx: Context): Promise<void> {
    const chats = db.listManagedPublicChats();
    const enabled = chats.filter((chat) => chat.moderation_enabled === 1).length;
    const unhealthy = chats.filter((chat) => chat.permission_status === "UNHEALTHY").length;
    const text = ["Moderation", "", `Managed public chats: ${chats.length}`, `Enabled: ${enabled}`, `Needs attention: ${unhealthy}`, "", "Manage each public chat's moderation settings and permission health."].join("\n");
    await renderPrivateScreen(ctx, text, new InlineKeyboard().text("Manage public chats", "dashboard:public").row().text("Back", "dashboard:home"));
  }

  async function showStaffWorkspaceSettings(ctx: Context, notice?: string, refresh = false): Promise<void> {
    const workspace = installation.getActiveWorkspace();
    const current = workspace
      ? [workspace.title ?? "Unnamed workspace", workspace.username ? `@${workspace.username}` : String(workspace.telegram_chat_id)].join("\n")
      : "Not configured";
    const render = refresh ? refreshPrivateScreen : renderPrivateScreen;
    await render(ctx, ["Staff workspace", "", `Current:\n${current}`, ...(notice ? ["", notice] : [])].join("\n"), new InlineKeyboard()
      .text("Choose staff workspace", "workspace:select").row()
      .text("Back", "dashboard:home"));
  }

  const onboardingStages = ["WELCOME", "BOT_IDENTITY", "STAFF_WORKSPACE", "WORKSPACE_PERMISSIONS", "SUPPORT_LOGS", "PUBLIC_CHAT", "TEAM_ROLES", "SUMMARY", "ACTIVATE_SUPPORT"] as const;
  async function showOnboarding(ctx: Context, stage: (typeof onboardingStages)[number]): Promise<void> {
    if (!ctx.from) return;
    if (installation.getState().setupState === "READY") {
      installation.saveOnboardingStage(ctx.from.id, "ACTIVATE_SUPPORT", "COMPLETED");
      await showDashboard(ctx);
      return;
    }
    installation.saveOnboardingStage(ctx.from.id, stage);
    const copy: Record<(typeof onboardingStages)[number], string> = {
      WELCOME: "Welcome. Host secrets stay local; product configuration is stored in SQLite.", BOT_IDENTITY: `Bot identity verified: @${bot.botInfo?.username ?? "bot"}.`,
      STAFF_WORKSPACE: "Select the Telegram forum supergroup that staff will use.", WORKSPACE_PERMISSIONS: "The selected workspace must pass every permissions check.",
      SUPPORT_LOGS: "Support Logs will be validated or initialized after the workspace is accepted.", PUBLIC_CHAT: "Public-chat moderation is optional and can be configured later.",
      TEAM_ROLES: "Invite team roles before activating role-based access.", SUMMARY: "Review the workspace and team. Legacy trusted-group access remains active until explicit activation.",
      ACTIVATE_SUPPORT: "Activate support when the mandatory workspace is ready."
    };
    const index = onboardingStages.indexOf(stage); const keyboard = new InlineKeyboard();
    if (index > 0) keyboard.text("Back", `setup:stage:${onboardingStages[index - 1]}`).row();
    if (stage === "STAFF_WORKSPACE") {
      if (installation.getActiveWorkspace()?.imported_from_legacy) keyboard.text("Use existing staff workspace", "setup:use-existing").row();
      keyboard.text("Choose staff workspace", "setup:workspace").row();
    }
    else if (stage === "ACTIVATE_SUPPORT") keyboard.text("Activate support", "setup:activate").row();
    else keyboard.text("Continue", `setup:stage:${onboardingStages[Math.min(index + 1, onboardingStages.length - 1)]}`).row();
    if (stage === "PUBLIC_CHAT") keyboard.text("Skip optional step", "setup:stage:TEAM_ROLES").row();
    keyboard.text("Exit setup", "setup:exit");
    const text = `Setup ${index + 1}/9\n\n${copy[stage]}`;
    const callbackMessage = ctx.callbackQuery?.message;
    if (callbackMessage) {
      try { await ctx.api.editMessageText(callbackMessage.chat.id, callbackMessage.message_id, text, { reply_markup: keyboard }); installation.setOnboardingPrimaryMessage(ctx.from.id, callbackMessage.chat.id, callbackMessage.message_id); privateUiMessages.set(ctx.from.id, { chatId: callbackMessage.chat.id, messageId: callbackMessage.message_id }); return; }
      catch (error) { if (!(error instanceof GrammyError && error.description.includes("message is not modified"))) logger.warn({ userId: ctx.from.id }, "Could not reuse onboarding message"); }
    }
    const sent = await ctx.reply(text, { reply_markup: keyboard });
    installation.setOnboardingPrimaryMessage(ctx.from.id, sent.chat.id, sent.message_id);
    privateUiMessages.set(ctx.from.id, { chatId: sent.chat.id, messageId: sent.message_id });
  }

  async function sendWorkspacePicker(ctx: Context, mode: "SETUP" | "RECONFIGURE" = "SETUP"): Promise<void> {
    if (ctx.from) pendingWorkspaceSelection.set(ctx.from.id, mode);
    const rights = { is_anonymous: false, can_manage_chat: true, can_delete_messages: true, can_manage_video_chats: false, can_restrict_members: false, can_promote_members: false, can_change_info: false, can_invite_users: true, can_post_stories: false, can_edit_stories: false, can_delete_stories: false, can_post_messages: false, can_edit_messages: false, can_pin_messages: true, can_manage_topics: true };
    const keyboard = new Keyboard().requestChat("Select forum staff group", 1300, { chat_is_channel: false, chat_is_forum: true, bot_is_member: true, request_title: true, request_username: true, bot_administrator_rights: rights, user_administrator_rights: rights }).text("Cancel workspace selection").resized().oneTime();
    const prompt = await ctx.reply("Choose the staff forum group by title. You can also paste a public @username or t.me link.", { reply_markup: keyboard });
    if (ctx.from) workspacePickerPrompts.set(ctx.from.id, { chatId: prompt.chat.id, messageId: prompt.message_id });
  }

  async function completeWorkspaceSelection(ctx: Context, result: WorkspaceValidationResult, mode: "SETUP" | "RECONFIGURE", fallback?: { title?: string; username?: string }): Promise<void> {
    if (!ctx.from) return;
    pendingWorkspaceSelection.delete(ctx.from.id);
    await retireWorkspacePickerPrompt(ctx.from.id);
    if (!result.valid) {
      const notice = `Staff workspace is not ready:\n${formatWorkspaceChecklist(result)}`;
      if (mode === "RECONFIGURE") {
        await showStaffWorkspaceSettings(ctx, notice, true);
      } else {
        await renderPrivateScreen(ctx, notice, new InlineKeyboard().text("Retry", "setup:workspace").row().text("Back", "setup:stage:STAFF_WORKSPACE"));
      }
      return;
    }
    installation.activateWorkspace({ chatId: result.chatId, title: result.title ?? fallback?.title, username: result.username ?? fallback?.username });
    setRuntimeStaffChatId(result.chatId);
    if (mode === "RECONFIGURE") {
      if (!db.getSetting(`support_logs_message_thread_id:${result.chatId}`)) await initializeSupportLogsTopic(ctx.api, db);
      await showStaffWorkspaceSettings(ctx, `Workspace validated:\n${formatWorkspaceChecklist(result)}`, true);
      return;
    }
    installation.saveOnboardingStage(ctx.from.id, "WORKSPACE_PERMISSIONS");
    await initializeSupportLogsTopic(ctx.api, db);
    await renderPrivateScreen(ctx, `Staff workspace validated:\n${formatWorkspaceChecklist(result)}`, new InlineKeyboard().text("Continue", "setup:stage:SUPPORT_LOGS"));
  }

  function publicChatLabel(chat: ReturnType<SupportDatabase["getManagedPublicChat"]>): string {
    if (!chat) return "Unknown public chat";
    return chat.title ?? (chat.username ? `@${chat.username}` : String(chat.chat_id));
  }

  function publicChatButtonLabel(chat: ReturnType<SupportDatabase["getManagedPublicChat"]>): string {
    const label = publicChatLabel(chat);
    return label.length > 40 ? `${label.slice(0, 39)}...` : label;
  }

  function publicChatConnectionLabel(chat: NonNullable<ReturnType<SupportDatabase["getManagedPublicChat"]>>): string {
    if (chat.connection_status === "CONNECTED") return "yes";
    if (chat.connection_status === "UNREACHABLE") return "no";
    return "unknown";
  }

  async function showPublicChats(ctx: Context): Promise<void> {
    const chats = db.listManagedPublicChats();
    const keyboard = new InlineKeyboard().text("Add public chat", "public:add").row();
    for (const chat of chats) {
      keyboard.text(`Open settings: ${publicChatButtonLabel(chat)}`, `public:open:${chat.chat_id}`).row();
    }
    keyboard.text("Back", "dashboard:home");
    const lines = chats.length
      ? chats.flatMap((chat) => [
        "",
        publicChatLabel(chat),
        chat.username ? `@${chat.username}` : "No public username",
        `Connected: ${publicChatConnectionLabel(chat)}`,
        `Moderation: ${chat.moderation_enabled ? "enabled" : "disabled"}`,
        `Permissions: ${chat.permission_status.toLowerCase()}`,
        `Reactions: ${chat.reaction_status.toLowerCase()} (advisory)`
      ])
      : ["", "No public chats are configured."];
    await renderPrivateScreen(ctx, ["Public chats", ...lines].join("\n"), keyboard);
  }

  async function showPublicChatSettings(ctx: Context, chatId: number): Promise<void> {
    const chat = db.getManagedPublicChat(chatId);
    if (!chat) { await renderPrivateScreen(ctx, "This public chat is not managed.", new InlineKeyboard().text("Back", "public:list")); return; }
    const keyboard = new InlineKeyboard()
      .text(chat.moderation_enabled ? "Disable moderation" : "Enable moderation", `public:${chat.moderation_enabled ? "disable" : "enable"}:${chat.chat_id}`)
      .row()
      .text("Check permissions", `public:check:${chat.chat_id}`)
      .row()
      .text("Warning text", `public:config-warning:${chat.chat_id}`)
      .text("Allowlist", `public:config-allowlist:${chat.chat_id}`)
      .row()
      .text("Cooldown", `public:config-cooldown:${chat.chat_id}`)
      .text("Threshold", `public:config-threshold:${chat.chat_id}`)
      .text("Lookback", `public:config-lookback:${chat.chat_id}`)
      .row()
      .text("Remove chat", `public:remove:${chat.chat_id}`)
      .row()
      .text("Back", "public:list");
    await renderPrivateScreen(ctx, [
      "Public chat settings",
      "",
      `Title: ${chat.title ?? "unknown"}`,
      `Username: ${chat.username ? `@${chat.username}` : "not available"}`,
      `Chat ID: ${chat.chat_id}`,
      `Forum topics: ${chat.is_forum ? "enabled" : "not enabled"}`,
      `Connected: ${publicChatConnectionLabel(chat)}`,
      `Moderation: ${chat.moderation_enabled ? "enabled" : "disabled"}`,
      `Permissions: ${chat.permission_status.toLowerCase()}`,
      `Reactions: ${chat.reaction_status.toLowerCase()} (advisory only)`,
      `Warning: ${chat.warning_text}`,
      `Allowlist entries: ${chat.allowlist.length}`,
      `Warning cooldown: ${chat.warning_cooldown_minutes} minutes`,
      `Ordinary-message threshold: ${chat.warning_message_threshold}`,
      `Lookback: ${chat.lookback_minutes} minutes`
    ].join("\n"), keyboard);
  }

  async function sendPublicChatPicker(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    pendingPublicChatSelection.add(ctx.from.id);
    const rights = {
      is_anonymous: false,
      can_manage_chat: true,
      can_delete_messages: true,
      can_manage_video_chats: false,
      can_restrict_members: true,
      can_promote_members: false,
      can_change_info: false,
      can_invite_users: true,
      can_post_stories: false,
      can_edit_stories: false,
      can_delete_stories: false,
      can_post_messages: false,
      can_edit_messages: false,
      can_pin_messages: false,
      can_manage_topics: false
    };
    const keyboard = new Keyboard().requestChat("Select public supergroup", 1400, {
      chat_is_channel: false,
      bot_is_member: true,
      request_title: true,
      request_username: true,
      request_photo: false,
      bot_administrator_rights: rights,
      user_administrator_rights: rights
    }).resized().oneTime();
    await ctx.reply("Choose a public supergroup. You may also paste its public @username or t.me link.", { reply_markup: keyboard });
  }

  async function inspectAndSavePublicChat(ctx: Context, chatId: number, shared?: { title?: string; username?: string }): Promise<void> {
    if (!ctx.from || !bot.botInfo) return;
    const workspace = installation.getActiveWorkspace();
    if (!workspace) { await ctx.reply("Configure the staff workspace first."); return; }
    const result = await validatePublicModerationChat(ctx.api, chatId, bot.botInfo.id);
    db.upsertManagedPublicChat({
      chatId: result.chatId,
      workspaceId: workspace.id,
      title: result.title ?? shared?.title,
      username: result.username ?? shared?.username,
      isForum: result.isForum
    });
    db.recordManagedPublicChatPermissionHealth({
      chatId: result.chatId,
      healthy: result.valid,
      reactionsAvailable: result.reactionsAvailable,
      connected: true,
      title: result.title ?? shared?.title,
      username: result.username ?? shared?.username,
      isForum: result.isForum
    });
    pendingPublicChatSelection.delete(ctx.from.id);
    await ctx.reply(`Public chat saved. Moderation remains disabled until enabled explicitly.\n${formatPublicChatPermissionChecklist(result)}`);
    await showPublicChatSettings(ctx, result.chatId);
  }

  async function savePendingPublicChatConfiguration(ctx: Context, text: string): Promise<boolean> {
    if (!ctx.from) return false;
    const pending = pendingPublicChatConfiguration.get(ctx.from.id);
    if (!pending) return false;
    const chat = db.getManagedPublicChat(pending.chatId);
    if (!chat) {
      pendingPublicChatConfiguration.delete(ctx.from.id);
      await ctx.reply("This public chat is no longer managed.");
      return true;
    }
    let warningText = chat.warning_text;
    let allowlist = chat.allowlist;
    let warningCooldownMinutes = chat.warning_cooldown_minutes;
    let warningMessageThreshold = chat.warning_message_threshold;
    let lookbackMinutes = chat.lookback_minutes;
    const trimmed = text.trim();
    if (pending.field === "warning") {
      if (!trimmed || trimmed.length > 500) { await ctx.reply("Warning text must contain 1-500 characters."); return true; }
      warningText = trimmed;
    } else if (pending.field === "allowlist") {
      const entries = trimmed === "-" ? [] : [...new Set(trimmed.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
      if (entries.length > 100 || entries.some((entry) => entry.length > 80)) { await ctx.reply("Use at most 100 allowlist terms, each up to 80 characters."); return true; }
      allowlist = entries;
    } else {
      const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
      const maximum = pending.field === "threshold" ? 10_000 : 1_440;
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) { await ctx.reply(`Enter a whole number from 1 to ${maximum}.`); return true; }
      if (pending.field === "cooldown") warningCooldownMinutes = parsed;
      if (pending.field === "threshold") warningMessageThreshold = parsed;
      if (pending.field === "lookback") lookbackMinutes = parsed;
    }
    db.updateManagedPublicChatConfig(chat.chat_id, { warningText, allowlist, warningCooldownMinutes, warningMessageThreshold, lookbackMinutes });
    pendingPublicChatConfiguration.delete(ctx.from.id);
    await ctx.reply("Public chat moderation settings saved.");
    await showPublicChatSettings(ctx, chat.chat_id);
    return true;
  }

  bot.command("start", async (ctx) => {
    if (!isPrivateChat(ctx)) { await handlePublicLanguageModeration(db, ctx, moderationNow, moderationCleanupScheduler); return; }

    persistUserFromContext(db, ctx);
    const startParameter = ctx.match.trim();
    if (startParameter.startsWith("setup_") && ctx.from) {
      const result = installation.consumeOwnerPairingToken(startParameter.slice(6), { telegramId: ctx.from.id, username: ctx.from.username, firstName: ctx.from.first_name, lastName: ctx.from.last_name });
      if (result.kind === "PAIRED") { await showOnboarding(ctx, "WELCOME"); return; }
      if (result.kind === "TRANSFER_CONFIRMATION_REQUIRED") { await ctx.reply("Confirm ownership transfer. The current OWNER remains active until confirmation.", { reply_markup: new InlineKeyboard().text("Confirm ownership transfer", "owner:confirm-transfer") }); return; }
      await ctx.reply(result.kind === "EXPIRED" ? "This setup link has expired. Generate a new link locally." : "This setup link is invalid or already used."); return;
    }
    if (startParameter.startsWith("team_") && ctx.from) {
      const result = installation.consumeTeamInvitation(startParameter.slice(5), { telegramId: ctx.from.id, username: ctx.from.username, firstName: ctx.from.first_name, lastName: ctx.from.last_name });
      if (result.kind === "JOINED") { let joined = false; const chatId = installation.getStaffChatId(); if (chatId !== null) { try { const member = await ctx.api.getChatMember(chatId, ctx.from.id); joined = member.status !== "left" && member.status !== "kicked"; } catch {} } await ctx.reply(`Team invitation accepted. Role: ${result.role}.${joined ? "" : " Join the configured staff workspace before using staff commands."}`); if (joined || installation.getState().authorizationMode !== "RBAC_ACTIVE") await showDashboard(ctx); return; }
      await ctx.reply(result.kind === "EXPIRED" ? "This team invitation has expired." : "This team invitation is invalid or already used."); return;
    }
    if (await replyIfBanned(db, ctx)) {
      return;
    }

    if (ctx.from && installation.getMember(ctx.from.id)) { await showDashboard(ctx, true); return; }
    if (installation.getState().setupState === "SETUP_REQUIRED") { await ctx.reply("Support has not been configured yet. Please try again later."); return; }
    await ctx.reply(START_TEXT);
  });

  bot.command("help", async (ctx) => {
    if (isPrivateChat(ctx)) {
      if (ctx.from && installation.getMember(ctx.from.id)) await showDashboard(ctx);
      else await ctx.reply(installation.getState().setupState === "READY" ? USER_HELP_TEXT : "Support has not been configured yet.");
      return;
    }

    if (!isStaffChat(ctx)) {
      return;
    }

    const helpText = installation.getState().authorizationMode === "RBAC_ACTIVE"
      ? STAFF_HELP_TEXT.replace(
        "/exporttickets - export active tickets for an answer package\nUpload a validated answer package in the staff group to preview and apply its replies.",
        "Batch operations are available to OWNER and ADMIN in the bot's private chat."
      )
      : STAFF_HELP_TEXT;
    await ctx.reply(helpText, {
      message_thread_id: ctx.message?.message_thread_id
    });
  });

  bot.command("chatid", async (ctx) => {
    if (isPrivateChat(ctx)) {
      if (await replyIfBanned(db, ctx)) {
        return;
      }

      await ctx.reply(STAFF_ONLY_TEXT);
      return;
    }

    if (!isStaffChat(ctx) || !ctx.chat) {
      return;
    }

    await ctx.reply(`Chat ID: ${ctx.chat.id}`);
  });

  bot.command("setlogs", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!await requirePermission(ctx, "SUPPORT_LOGS")) return;
    const messageThreadId = ctx.message?.message_thread_id;
    if (typeof messageThreadId !== "number") {
      await ctx.reply("Please run /setlogs inside the forum topic you want to use as Support Logs.");
      return;
    }

    if (db.findTicketByStaffThread(config.staffChatId, messageThreadId)) {
      await ctx.reply("This topic belongs to a support ticket and cannot be used as Support Logs.", {
        message_thread_id: messageThreadId
      });
      return;
    }

    setSupportLogsTopicOverride(db, messageThreadId);
    await ctx.reply("This topic is now used as Support Logs.", {
      message_thread_id: messageThreadId
    });
  });

  bot.command("logs", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!await requirePermission(ctx, "SUPPORT_LOGS")) return;
    const topic = await getSupportLogsTopicInfo(ctx.api, db);
    await ctx.reply(formatSupportLogsTopicInfo(topic), {
      message_thread_id: ctx.message?.message_thread_id
    });
  });

  async function exportActiveTickets(ctx: Context, destinationChatId: number): Promise<string | undefined> {
    if (runningTicketBatchExports.has(config.staffChatId)) {
      await ctx.reply("An export is already running for this staff chat.");
      return undefined;
    }

    runningTicketBatchExports.add(config.staffChatId);
    let zip: Awaited<ReturnType<typeof createTicketBatchZip>> | undefined;
    let exportId: string | undefined;
    let deliveryAttempted = false;
    try {
      const tickets = db.listActiveTicketsForStaffChat(config.staffChatId).map((ticket) => ({
        ticket,
        messages: db.listMessagesChronological(ticket.id),
        followUpHistory: db.listTicketFollowUpHistory(ticket.id),
        deliveryFailure: db.getLatestTicketBatchDeliveryFailure(ticket.id, config.staffChatId),
        staffSync: db.getLatestTicketBatchStaffSyncContext(ticket.id, config.staffChatId)
      }));
      if (!tickets.length) {
        await ctx.reply("There are no active tickets to export.");
        return undefined;
      }

      exportId = `export_${randomUUID().replace(/-/g, "")}`;
      const createdAt = new Date().toISOString();
      const snapshot = buildTicketBatchExportSnapshot({ exportId, createdAt, staffChatId: config.staffChatId, tickets });
      zip = await createTicketBatchZip(snapshot, async (attachment) => {
        if (!attachment.fileId) {
          throw new TicketBatchValidationError(`Ticket #${attachment.ticketId} message ${attachment.messageId} has no downloadable media reference.`);
        }
        const file = await ctx.api.getFile(attachment.fileId);
        if (!file.file_path) {
          throw new TicketBatchValidationError(`Ticket #${attachment.ticketId} message ${attachment.messageId} attachment could not be retrieved.`);
        }
        const response = await fetchImpl(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
        if (!response.ok) {
          throw new TicketBatchValidationError(`Ticket #${attachment.ticketId} message ${attachment.messageId} attachment could not be downloaded.`);
        }
        return { bytes: new Uint8Array(await response.arrayBuffer()), telegramFilePath: file.file_path };
      });
      db.createTicketBatchExport({
        exportId,
        staffChatId: config.staffChatId,
        createdAt,
        selectionMode: "all_active",
        ticketCount: snapshot.records.length,
        items: snapshot.records.map((record) => ({ ticketId: record.ticket.id, snapshotToken: record.snapshot_token })),
        deliveryState: "PREPARING"
      });
      deliveryAttempted = true;
      const delivered = await ctx.api.sendDocument(destinationChatId, new InputFile(zip.filePath, zip.filename), {
        caption: formatTicketBatchExportCaption(exportId, zip)
      });
      try {
        db.markTicketBatchExportDelivered(exportId, config.staffChatId, delivered.message_id);
      } catch (error) {
        logger.error({ err: error, exportId }, "Ticket batch export delivery could not be persisted");
        await ctx.reply("Export delivery could not be confirmed. Do not upload an answer package for it.");
        return undefined;
      }
      return exportId;
    } catch (error) {
      logger.error({ err: error, exportId }, "Could not send ticket batch export");
      if (exportId) {
        try {
          if (deliveryAttempted && error instanceof HttpError) {
            db.markTicketBatchExportUnknownDelivery(exportId, config.staffChatId, "Export delivery outcome could not be confirmed.");
          } else {
            db.markTicketBatchExportFailed(exportId, config.staffChatId, "Export failed before confirmed delivery.");
          }
        } catch (persistenceError) {
          logger.warn({ err: persistenceError, exportId }, "Could not persist failed ticket batch export state");
        }
      }
      await ctx.reply("Export failed before delivery. Nothing was sent.");
      return undefined;
    } finally {
      if (zip) {
        try {
          await cleanupTicketBatchZip(zip);
        } catch (error) {
          logger.warn({ err: error, exportId }, "Could not clean up ticket batch export files");
        }
      }
      runningTicketBatchExports.delete(config.staffChatId);
    }
  }

  bot.command("exporttickets", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (installation.getState().authorizationMode === "RBAC_ACTIVE") {
      await ctx.reply("Batch operations are available to OWNER and ADMIN in the bot's private chat.");
      return;
    }
    if (!await requirePermission(ctx, "BATCH_OPERATIONS")) return;
    if (typeof ctx.message?.message_thread_id === "number") {
      await ctx.reply("Please run /exporttickets outside ticket topics.");
      return;
    }
    await exportActiveTickets(ctx, config.staffChatId);
  });

  bot.command("moderation", async (ctx) => {
    if (!isStaffChat(ctx)) { if (isPrivateChat(ctx)) await ctx.reply(STAFF_ONLY_TEXT); return; }
    if (!await requirePermission(ctx, "MODERATION_SETTINGS")) return;
    const [, action = "status", ...args] = (ctx.message?.text ?? "").trim().split(/\s+/);
    const current = moderationConfig(db);
    if (action === "status") { await ctx.reply(await formatModerationStatus(db, current, ctx.api, bot.botInfo?.id)); return; }
    if (action === "target") {
      const chatId = Number(args[0]);
      if (!Number.isSafeInteger(chatId)) { await ctx.reply("Usage: /moderation target <chat_id>"); return; }
      try {
        const chat = await ctx.api.getChat(chatId);
        const workspace = installation.getActiveWorkspace();
        db.setSetting(moderationSettingKey("target"), String(chatId));
        if (workspace) db.importManagedPublicChat(chatId, workspace.id);
        db.upsertManagedPublicChat({
          chatId,
          workspaceId: workspace?.id ?? null,
          title: "title" in chat ? chat.title ?? null : null,
          username: "username" in chat ? chat.username ?? null : null,
          isForum: chat.type === "supergroup" && chat.is_forum === true
        });
      } catch { await ctx.reply("The target chat is not reachable by this bot."); return; }
      await ctx.reply(`Moderation target set to ${chatId}. It remains disabled until /moderation enable succeeds.`);
      return;
    }
    if (action === "enable") {
      const rights = await validateModerationRights(ctx.api, current.targetChatId, bot.botInfo?.id);
      if (rights !== "ok") { await ctx.reply(`Moderation remains disabled: ${rights}`); return; }
      db.setSetting(moderationSettingKey("enabled"), "true");
      if (current.targetChatId !== null) db.setManagedPublicChatModerationEnabled(current.targetChatId, true);
      await ctx.reply("English-only moderation is enabled."); return;
    }
    if (action === "disable") {
      db.setSetting(moderationSettingKey("enabled"), "false");
      if (current.targetChatId !== null) db.setManagedPublicChatModerationEnabled(current.targetChatId, false);
      await ctx.reply("Moderation disabled. Existing strikes and tiers were preserved."); return;
    }
    if (action === "allowlist") { await ctx.reply(current.allowlist.length ? `Allowlist (${current.allowlist.length}): ${current.allowlist.join(", ")}` : "Allowlist is empty."); return; }
    if (action === "allow" || action === "unallow") {
      const term = args.join(" ").trim().toLowerCase();
      if (!term || term.length > 80) { await ctx.reply(`Usage: /moderation ${action} <term up to 80 characters>`); return; }
      const entries = new Set(current.allowlist);
      if (action === "allow") entries.add(term); else entries.delete(term);
      db.setSetting(moderationSettingKey("allowlist"), JSON.stringify([...entries].sort()));
      if (current.targetChatId !== null) db.updateManagedPublicChatConfig(current.targetChatId, {
        warningText: current.warningText,
        allowlist: [...entries].sort(),
        warningCooldownMinutes: current.warningCooldownMinutes,
        warningMessageThreshold: current.warningMessageThreshold,
        lookbackMinutes: current.lookbackMinutes
      });
      await ctx.reply(action === "allow" ? "Allowlist entry saved." : "Allowlist entry removed."); return;
    }
    const userId = Number(args[0]);
    if (!Number.isSafeInteger(userId) || !current.targetChatId) { await ctx.reply(`Usage: /moderation ${action} <user_id>`); return; }
    const state = db.getLanguageModerationUserState(current.targetChatId, userId) ?? { username: null, current_strikes: 0, sanction_tier: 0, first_strike_at: null };
    if (action === "user") { await ctx.reply(`User ${userId}: strikes ${state.current_strikes}/2, sanction tier ${state.sanction_tier}/3.`); return; }
    if (action === "resetstrikes") { db.upsertLanguageModerationUserState({ chat_id: current.targetChatId, user_telegram_id: userId, username: state.username, current_strikes: 0, sanction_tier: state.sanction_tier, first_strike_at: null }); db.clearLanguageModerationCycleViolations(current.targetChatId, userId, state.sanction_tier); await ctx.reply(`Strikes reset for ${userId}. Sanction tier remains ${state.sanction_tier}.`); return; }
    if (action === "resettier") { db.upsertLanguageModerationUserState({ chat_id: current.targetChatId, user_telegram_id: userId, username: state.username, current_strikes: state.current_strikes, sanction_tier: 0, first_strike_at: state.first_strike_at }); await ctx.reply(`Sanction tier reset for ${userId}. This does not unmute or unban the user.`); return; }
    await ctx.reply("Usage: /moderation status|target|enable|disable|allowlist|allow|unallow|user|resetstrikes|resettier");
  });

  bot.command("questnotify", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) await ctx.reply(STAFF_ONLY_TEXT);
      return;
    }

    if (!await requirePermission(ctx, "CONFIGURE_INSTALLATION")) return;
    const [, action = "status", ...args] = (ctx.message?.text ?? "").trim().split(/\s+/);
    if (action === "help") {
      await ctx.reply("Usage: /questnotify status | target <chat_id> | provider <provider_key> | enable | disable | help");
      return;
    }
    if (action === "status") {
      await ctx.reply(await formatEntityNotificationStatus(ctx.api, db, entityNotificationProviders));
      return;
    }
    if (action === "target") {
      const targetChatId = Number(args[0]);
      if (!Number.isSafeInteger(targetChatId) || targetChatId === 0) {
        await ctx.reply("Usage: /questnotify target <chat_id>");
        return;
      }
      try {
        await ctx.api.getChat(targetChatId);
      } catch {
        await ctx.reply("The notification target is not reachable by this bot.");
        return;
      }
      db.setSetting(entityNotificationSettingKey("target_chat_id"), String(targetChatId));
      await ctx.reply(`Entity notification target set to ${targetChatId}. It remains disabled until /questnotify enable succeeds.`);
      return;
    }
    if (action === "provider") {
      const providerKey = args[0]?.trim();
      const provider = providerKey ? entityNotificationProviders.get(providerKey) : undefined;
      if (!provider) {
        await ctx.reply("That entity notification provider is not registered.");
        return;
      }
      if (!provider.authoritative) {
        await ctx.reply("That entity notification provider is not authoritative.");
        return;
      }
      if (!isEntityNotificationProviderAvailable(provider)) {
        await ctx.reply(entityNotificationProviderStatus(provider));
        return;
      }
      db.setSetting(entityNotificationSettingKey("provider"), provider.key);
      await ctx.reply(`Entity notification provider set to ${provider.key}.`);
      return;
    }
    if (action === "enable") {
      const targetChatId = parseStoredEntityNotificationTarget(db.getSetting(entityNotificationSettingKey("target_chat_id")));
      if (targetChatId === null) {
        await ctx.reply("Entity notifications remain disabled: configure a reachable target first.");
        return;
      }
      try {
        await ctx.api.getChat(targetChatId);
      } catch {
        await ctx.reply("Entity notifications remain disabled: the configured target is not reachable.");
        return;
      }
      const providerKey = db.getSetting(entityNotificationSettingKey("provider"));
      const provider = providerKey ? entityNotificationProviders.get(providerKey) : undefined;
      if (!provider) {
        await ctx.reply("Entity notifications remain disabled: configure a registered provider first.");
        return;
      }
      if (!provider.authoritative) {
        await ctx.reply("Entity notifications remain disabled: the provider is not authoritative.");
        return;
      }
      if (!isEntityNotificationProviderAvailable(provider)) {
        await ctx.reply(`Entity notifications remain disabled: ${entityNotificationProviderStatus(provider)}`);
        return;
      }
      db.setSetting(entityNotificationSettingKey("enabled"), "true");
      await ctx.reply("Entity notifications enabled.");
      return;
    }
    if (action === "disable") {
      db.setSetting(entityNotificationSettingKey("enabled"), "false");
      await ctx.reply("Entity notifications disabled. Target, provider, and publication history were preserved.");
      return;
    }
    await ctx.reply("Usage: /questnotify status | target <chat_id> | provider <provider_key> | enable | disable | help");
  });

  bot.command("status", async (ctx) => {
    if (!isPrivateChat(ctx) || !ctx.from) {
      return;
    }

    if (installation.getState().setupState === "SETUP_REQUIRED") { await ctx.reply("Support has not been configured yet."); return; }
    persistUserFromContext(db, ctx);
    if (await replyIfBanned(db, ctx)) {
      return;
    }

    const ticket = db.getLatestTicketForUser(ctx.from.id, config.staffChatId);
    if (!ticket) {
      await ctx.reply("You do not have any tickets yet. Send a message here to create one.");
      return;
    }

    await ctx.reply(`Your latest ticket is #${ticket.id}.\nStatus: ${formatStatus(ticket.status)}`);
  });

  bot.command("mytickets", async (ctx) => {
    if (!isPrivateChat(ctx) || !ctx.from) {
      return;
    }

    if (installation.getState().setupState === "SETUP_REQUIRED") { await ctx.reply("Support has not been configured yet."); return; }
    persistUserFromContext(db, ctx);
    if (await replyIfBanned(db, ctx)) {
      return;
    }

    await ctx.reply(formatUserTicketList(db.listTicketsForUser(ctx.from.id, config.staffChatId)));
  });

  bot.command("ticket", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!await requirePermission(ctx, "VIEW_TICKETS")) return;

    const ticketId = parseTicketId(ctx);
    if (!ticketId) {
      await ctx.reply("Usage: /ticket ID");
      return;
    }

    const ticket = db.getTicketWithUser(ticketId);
    if (!ticket || ticket.staff_chat_id !== config.staffChatId) {
      await ctx.reply(`Ticket #${ticketId} was not found in this staff chat.`);
      return;
    }

    await ctx.reply(formatTicketDetails(ticket, db.listMessages(ticketId, 8)), {
      reply_markup: ticket.status === "CLOSED" ? undefined : staffTicketKeyboard(ticket.id)
    });
  });

  bot.command("close", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!await requirePermission(ctx, "CLOSE_TICKETS")) return;

    const ticketId = parseTicketId(ctx);
    if (!ticketId) {
      await ctx.reply("Usage: /close ID");
      return;
    }

    const result = await closeTicket(db, ctx.api, ticketId, {
      notifyUser: true,
      staffNotice: "Ticket closed by staff.",
      closedBy: staffActor(ctx.from)
    });
    await notifyStaff(ctx.api, result);
  });

  bot.command("ban", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!await requirePermission(ctx, "BAN_USERS")) return;
    const command = parseBanCommand(ctx);
    if (!command) {
      await ctx.reply("Usage: /ban USER_ID reason");
      return;
    }

    await banUserById(db, ctx.api, command.userId, command.reason, staffActor(ctx.from));
    await notifyStaff(ctx.api, `User ${command.userId} has been banned.`);
  });

  bot.command("unban", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!await requirePermission(ctx, "BAN_USERS")) return;
    const userId = parseUserId(ctx.match.trim());
    if (!userId) {
      await ctx.reply("Usage: /unban USER_ID");
      return;
    }

    const ban = db.getBannedUser(userId);
    const removed = db.unbanUser(userId);
    if (removed) {
      const user = db.getUser(userId);
      await logBanEvent(ctx.api, db, {
        action: "UNBANNED",
        userTelegramId: userId,
        username: ban?.username ?? user?.username ?? null,
        performedBy: staffActor(ctx.from)
      });
    }

    await ctx.reply(removed ? `User ${userId} has been unbanned.` : `User ${userId} is not banned.`);
  });

  bot.command("bans", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!await requirePermission(ctx, "BAN_USERS")) return;
    const bans = db.listBannedUsers();
    if (!bans.length) {
      await ctx.reply("There are no banned users.");
      return;
    }

    await ctx.reply(
      [
        "Banned users:",
        ...bans.map((ban) => {
          const username = ban.username ? `@${ban.username}` : "no username";
          return `${ban.user_telegram_id} (${username}) - ${ban.reason}`;
        })
      ].join("\n")
    );
  });

  bot.command("whois", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!await requirePermission(ctx, "VIEW_TICKETS")) return;

    const messageThreadId = ctx.message?.message_thread_id;
    if (typeof messageThreadId !== "number") {
      await ctx.reply("Use /whois inside a ticket topic.");
      return;
    }

    const ticket = db.findTicketByStaffThread(config.staffChatId, messageThreadId);
    if (!ticket) {
      await ctx.reply("This topic is not linked to a ticket.");
      return;
    }

    await ctx.reply(formatWhois(ticket, db.getBannedUser(ticket.user_telegram_id)), {
      message_thread_id: messageThreadId
    });
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [namespace] = data.split(":");

    if (isObsoletePrivateOperatorCallback(ctx, namespace ?? "")) {
      await ctx.answerCallbackQuery({ text: "This screen is no longer active. Use /start.", show_alert: true });
      return;
    }

    if (namespace === "owner" && data === "owner:confirm-transfer") {
      if (!isPrivateChat(ctx) || !ctx.from || !db.hasPendingOwnerTransfer(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "No pending owner transfer.", show_alert: true }); return; }
      if (!await hasRequiredPrivateWorkspaceMembership(ctx)) { await ctx.answerCallbackQuery({ text: "Staff workspace membership required.", show_alert: true }); return; }
      installation.confirmOwnerTransfer(ctx.from.id); await ctx.answerCallbackQuery({ text: "Ownership transferred." }); await showOnboarding(ctx, "WELCOME"); return;
    }

    if (namespace === "setup") {
      if (!isPrivateChat(ctx) || !ctx.from || !installation.can(ctx.from.id, "CONFIGURE_INSTALLATION")) { await ctx.answerCallbackQuery({ text: "Owner or administrator access required.", show_alert: true }); return; }
      if (!await hasRequiredPrivateWorkspaceMembership(ctx)) { await ctx.answerCallbackQuery({ text: "Staff workspace membership required.", show_alert: true }); return; }
      const [, action, value] = data.split(":");
      await ctx.answerCallbackQuery();
      if (installation.getState().setupState === "READY") {
        installation.saveOnboardingStage(ctx.from.id, "ACTIVATE_SUPPORT", "COMPLETED");
        await showDashboard(ctx);
        return;
      }
      if (action === "workspace") { await sendWorkspacePicker(ctx); return; }
      if (action === "use-existing") {
        const workspace = installation.getActiveWorkspace();
        if (!workspace) { await renderPrivateScreen(ctx, "No existing staff workspace is available.", new InlineKeyboard().text("Back", "setup:stage:STAFF_WORKSPACE")); return; }
        const result = await validateStaffWorkspace(ctx.api, workspace.telegram_chat_id, ctx.from.id);
        await completeWorkspaceSelection(ctx, result, "SETUP");
        return;
      }
      if (action === "exit") { const stage = installation.getOnboardingSession(ctx.from.id)?.stage as (typeof onboardingStages)[number] | undefined; installation.saveOnboardingStage(ctx.from.id, stage ?? "WELCOME", "EXITED"); await renderPrivateScreen(ctx, "Setup paused. Resume when you are ready.", new InlineKeyboard().text("Resume setup", "setup:resume")); return; }
      if (action === "resume") { const stage = installation.getOnboardingSession(ctx.from.id)?.stage as (typeof onboardingStages)[number] | undefined; await showOnboarding(ctx, stage ?? "WELCOME"); return; }
      if (action === "stage" && onboardingStages.includes(value as (typeof onboardingStages)[number])) { await showOnboarding(ctx, value as (typeof onboardingStages)[number]); return; }
      if (action === "activate") {
        try { const chatId = installation.getStaffChatId(); if (chatId === null) throw new Error("A validated staff workspace is required before activation."); setRuntimeStaffChatId(chatId); await initializeSupportLogsTopic(ctx.api, db); installation.markReady(); installation.saveOnboardingStage(ctx.from.id, "ACTIVATE_SUPPORT", "COMPLETED"); await showDashboard(ctx); }
        catch (error) { await renderPrivateScreen(ctx, error instanceof Error ? error.message : "Support could not be activated.", new InlineKeyboard().text("Retry activation", "setup:activate").row().text("Back", "setup:stage:SUMMARY")); }
        return;
      }
      return;
    }

    if (namespace === "workspace") {
      if (!isPrivateChat(ctx) || !ctx.from || !installation.can(ctx.from.id, "CONFIGURE_INSTALLATION")) { await ctx.answerCallbackQuery({ text: "Owner or administrator access required.", show_alert: true }); return; }
      if (!await hasRequiredPrivateWorkspaceMembership(ctx)) { await ctx.answerCallbackQuery({ text: "Staff workspace membership required.", show_alert: true }); return; }
      await ctx.answerCallbackQuery();
      if (data === "workspace:select") await sendWorkspacePicker(ctx, "RECONFIGURE");
      else await showStaffWorkspaceSettings(ctx);
      return;
    }

    if (namespace === "dashboard") {
      if (!isPrivateChat(ctx) || !ctx.from || !installation.getMember(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Staff access required.", show_alert: true }); return; }
      if (!await hasRequiredPrivateWorkspaceMembership(ctx)) { await ctx.answerCallbackQuery({ text: "Staff workspace membership required.", show_alert: true }); return; }
      const action = data.split(":")[1]; await ctx.answerCallbackQuery();
      if (action === "test-ticket") { db.setSetting(`staff_test_ticket_mode:${ctx.from.id}`, "true"); await ctx.reply("Test-ticket mode enabled for your next message. Send harmless test content now."); return; }
      if (action === "status") { await showSystemStatus(ctx); return; }
      if (action === "workspace") {
        if (!await requirePrivatePermission(ctx, "CONFIGURE_INSTALLATION")) return;
        await showStaffWorkspaceSettings(ctx);
        return;
      }
      if (action === "moderation") {
        if (!await requirePrivatePermission(ctx, "MODERATION_SETTINGS")) return;
        await showModerationDashboard(ctx);
        return;
      }
      if (action === "team") {
        if (!await requirePrivatePermission(ctx, "MANAGE_TEAM")) return;
        const actorRole = installation.getMember(ctx.from.id)?.role; const keyboard = new InlineKeyboard();
        if (actorRole === "OWNER") keyboard.text("Invite admin", "team:invite:ADMIN").row();
        keyboard.text("Invite senior agent", "team:invite:SENIOR_AGENT").text("Invite agent", "team:invite:AGENT").row();
        for (const member of installation.listTeamMembers().filter((entry) => entry.role !== "OWNER")) {
          if (actorRole === "ADMIN" && member.role === "ADMIN") continue;
          if (actorRole === "OWNER") keyboard.text(`Admin ${member.user_telegram_id}`, `team:set:${member.user_telegram_id}:ADMIN`);
          keyboard.text(`Senior ${member.user_telegram_id}`, `team:set:${member.user_telegram_id}:SENIOR_AGENT`).text(`Agent ${member.user_telegram_id}`, `team:set:${member.user_telegram_id}:AGENT`).text("Revoke", `team:revoke:${member.user_telegram_id}`).row();
        }
        if (actorRole === "OWNER") keyboard.text("Transfer ownership", "team:transfer").row().text("Review RBAC activation", "rbac:preview").row();
        keyboard.text("Back", "dashboard:home");
        await renderPrivateScreen(ctx, ["Team", ...installation.listTeamMembers().map((entry) => `${entry.role}: ${entry.username ? `@${entry.username}` : entry.user_telegram_id}`)].join("\n"), keyboard); return;
      }
      if (action === "public") {
        if (!await requirePrivatePermission(ctx, "CONFIGURE_INSTALLATION")) return;
        await showPublicChats(ctx);
        return;
      }
      if (action === "batch") {
        if (!await requirePrivatePermission(ctx, "BATCH_OPERATIONS")) return;
        const exportId = getPendingPrivateBatchExport(ctx.from.id);
        if (exportId) await showPrivateBatchWaiting(ctx, exportId);
        else await showDashboard(ctx);
        return;
      }
      await showDashboard(ctx); return;
    }

    if (namespace === "batch-ui") {
      if (!await requirePrivatePermission(ctx, "BATCH_OPERATIONS")) {
        await ctx.answerCallbackQuery({ text: "Batch operations require OWNER or ADMIN.", show_alert: true });
        return;
      }
      const action = data.split(":")[1];
      await ctx.answerCallbackQuery();
      if (action === "export") {
        if (!ctx.chat) return;
        const existing = getPendingPrivateBatchExport(ctx.from!.id);
        if (existing) {
          await showPrivateBatchWaiting(ctx, existing);
          return;
        }
        await retirePrivateScreens(ctx);
        const exportId = await exportActiveTickets(ctx, ctx.chat.id);
        if (exportId) {
          setPendingPrivateBatchExport(ctx.from!.id, exportId);
          await sendFreshPrivateScreen(ctx, privateBatchWaitingText(exportId), privateBatchWaitingKeyboard());
        }
        return;
      }
      if (action === "continue") {
        const exportId = getPendingPrivateBatchExport(ctx.from!.id);
        if (exportId) await showPrivateBatchWaiting(ctx, exportId);
        else await showDashboard(ctx);
        return;
      }
      if (action === "apply") {
        const exportId = getPendingPrivateBatchExport(ctx.from!.id);
        if (exportId) await showPrivateBatchWaiting(ctx, exportId);
        else await showDashboard(ctx);
        return;
      }
      if (action === "help") {
        const exportId = getPendingPrivateBatchExport(ctx.from!.id);
        if (exportId) await showPrivateBatchHelp(ctx);
        else await showDashboard(ctx);
        return;
      }
      if (action === "abort") {
        await renderPrivateScreen(ctx, "Abort this batch workflow? The export remains available in history, but this private answer-import flow will be cleared.", new InlineKeyboard().text("Abort batch", "batch-ui:abort-confirm").row().text("Keep waiting", "batch-ui:continue"));
        return;
      }
      if (action === "abort-confirm") {
        setPendingPrivateBatchExport(ctx.from!.id, undefined);
        await showDashboard(ctx);
        return;
      }
      if (action === "recent") {
        const pending = db.getInstallationOperationalCounts().pendingBatchStaffOperations;
        await renderPrivateScreen(ctx, `Batch status\n\nPending staff synchronization: ${pending}`, new InlineKeyboard().text("Back", "dashboard:home"));
        return;
      }
      await showDashboard(ctx);
      return;
    }

    if (namespace === "public") {
      if (!isPrivateChat(ctx) || !ctx.from || !installation.can(ctx.from.id, "CONFIGURE_INSTALLATION")) {
        await ctx.answerCallbackQuery({ text: "Owner or administrator access required.", show_alert: true });
        return;
      }
      if (!await hasRequiredPrivateWorkspaceMembership(ctx)) {
        await ctx.answerCallbackQuery({ text: "Staff workspace membership required.", show_alert: true });
        return;
      }
      const [, action, rawChatId] = data.split(":");
      const chatId = Number(rawChatId);
      if (action === "add") {
        await ctx.answerCallbackQuery();
        await sendPublicChatPicker(ctx);
        return;
      }
      if (action === "list") {
        await ctx.answerCallbackQuery();
        await showPublicChats(ctx);
        return;
      }
      if (!Number.isSafeInteger(chatId)) {
        await ctx.answerCallbackQuery({ text: "Invalid public chat.", show_alert: true });
        return;
      }
      const managed = db.getManagedPublicChat(chatId);
      if (!managed) {
        await ctx.answerCallbackQuery({ text: "This public chat is not managed.", show_alert: true });
        return;
      }
      if (action === "open") {
        await ctx.answerCallbackQuery();
        await showPublicChatSettings(ctx, chatId);
        return;
      }
      if (action?.startsWith("config-")) {
        const field = action.slice("config-".length);
        if (!(["warning", "allowlist", "cooldown", "threshold", "lookback"] as const).includes(field as "warning" | "allowlist" | "cooldown" | "threshold" | "lookback")) {
          await ctx.answerCallbackQuery({ text: "Unknown configuration field.", show_alert: true });
          return;
        }
        pendingPublicChatConfiguration.set(ctx.from.id, { chatId, field: field as "warning" | "allowlist" | "cooldown" | "threshold" | "lookback" });
        const prompts = {
          warning: "Send the warning text (1-500 characters).",
          allowlist: "Send comma-separated allowlist terms, or send a single dash to clear it.",
          cooldown: "Send the warning cooldown in minutes (1-1440).",
          threshold: "Send the ordinary-message threshold (1-10000).",
          lookback: "Send the violation lookback in minutes (1-1440)."
        } as const;
        await ctx.answerCallbackQuery();
        await ctx.reply(prompts[field as keyof typeof prompts]);
        return;
      }
      if (action === "disable") {
        db.setManagedPublicChatModerationEnabled(chatId, false);
        await ctx.answerCallbackQuery({ text: "Moderation disabled." });
        await showPublicChatSettings(ctx, chatId);
        return;
      }
      if (action === "remove") {
        await ctx.answerCallbackQuery();
        await renderPrivateScreen(ctx, `Remove ${publicChatLabel(managed)} from managed public chats? Historical moderation records will be preserved.`, new InlineKeyboard()
          .text("Confirm removal", `public:confirm-remove:${chatId}`)
          .row()
          .text("Cancel", `public:open:${chatId}`));
        return;
      }
      if (action === "confirm-remove") {
        db.deactivateManagedPublicChat(chatId);
        await ctx.answerCallbackQuery({ text: "Public chat removed." });
        await showPublicChats(ctx);
        return;
      }
      if (action === "check" || action === "enable") {
        try {
          if (!bot.botInfo) throw new Error("Bot identity is unavailable.");
          const result = await validatePublicModerationChat(ctx.api, chatId, bot.botInfo.id);
          db.recordManagedPublicChatPermissionHealth({
            chatId,
            healthy: result.valid,
            reactionsAvailable: result.reactionsAvailable,
            connected: true,
            title: result.title,
            username: result.username,
            isForum: result.isForum
          });
          if (action === "enable" && result.valid) db.setManagedPublicChatModerationEnabled(chatId, true);
          await ctx.answerCallbackQuery({
            text: action === "enable" && result.valid ? "Moderation enabled." : result.valid ? "Permissions are healthy." : "Required permissions are missing.",
            show_alert: !result.valid
          });
          await ctx.reply(formatPublicChatPermissionChecklist(result));
          await showPublicChatSettings(ctx, chatId);
        } catch (error) {
          db.recordManagedPublicChatUnreachable(chatId);
          logger.warn({ chatId, err: error }, "Could not validate managed public chat permissions");
          await ctx.answerCallbackQuery({ text: "The public chat could not be inspected.", show_alert: true });
        }
        return;
      }
      await ctx.answerCallbackQuery({ text: "Unknown public chat action.", show_alert: true });
      return;
    }

    if (namespace === "team") {
      if (!isPrivateChat(ctx) || !ctx.from) { await ctx.answerCallbackQuery({ text: "Private staff dashboard only.", show_alert: true }); return; }
      if (!await requirePrivatePermission(ctx, "MANAGE_TEAM")) { await ctx.answerCallbackQuery({ text: "Your application role cannot manage the team.", show_alert: true }); return; }
      const [, action, value, roleValue] = data.split(":");
      try {
        if (action === "transfer") { if (installation.getMember(ctx.from.id)?.role !== "OWNER") throw new Error("Only the OWNER can transfer ownership."); const token = installation.createOwnerRecoveryToken(); await ctx.answerCallbackQuery({ text: "Transfer link created." }); await ctx.reply(`One-use ownership transfer link (30 minutes):\nhttps://t.me/${bot.botInfo.username}?start=setup_${token}\n\nThe current OWNER remains active until the recipient confirms.`); return; }
        if (action === "set") { installation.assignRole(ctx.from.id, Number(value), roleValue as "ADMIN" | "SENIOR_AGENT" | "AGENT"); await ctx.answerCallbackQuery({ text: "Role updated." }); return; }
        if (action === "revoke") { installation.revokeMember(ctx.from.id, Number(value)); await ctx.answerCallbackQuery({ text: "Member revoked." }); return; }
        const role = value as "ADMIN" | "SENIOR_AGENT" | "AGENT";
        const token = installation.createTeamInvitation(ctx.from.id, role); await ctx.answerCallbackQuery({ text: "Invitation created." }); await ctx.reply(`One-use ${role} invitation (30 minutes):\nhttps://t.me/${bot.botInfo.username}?start=team_${token}`);
      }
      catch (error) { await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Invitation denied.", show_alert: true }); }
      return;
    }

    if (namespace === "rbac") {
      if (!isPrivateChat(ctx) || !ctx.from || installation.getMember(ctx.from.id)?.role !== "OWNER") { await ctx.answerCallbackQuery({ text: "OWNER access required.", show_alert: true }); return; }
      if (!await hasRequiredPrivateWorkspaceMembership(ctx)) { await ctx.answerCallbackQuery({ text: "Staff workspace membership required.", show_alert: true }); return; }
      const action = data.split(":")[1];
      if (action === "preview") {
        const preview = installation.previewRoleBasedAccessActivation();
        const retainedRoleLines = installation.listTeamMembers()
          .map((member) => `- ${member.role}: ${member.username ? `@${member.username}` : `user_${member.user_telegram_id}`}`);
        const retainedRoles = retainedRoleLines.join("\n");
        const keyboard = new InlineKeyboard()
          .text("Activate role-based access", `rbac:activate:${preview.confirmationToken}`)
          .row()
          .text("Cancel", "rbac:cancel");
        const warning = "Unassigned staff-group participants will lose staff access.\nTelegram staff-workspace membership remains required after activation.\n\nPairing did not activate this mode. Confirm only after assigning the team.";
        const message = `Role-based access cutover preview\n\nCurrent authorization: ${installation.getState().authorizationMode}\nAssigned application roles retained (${preview.activeRoleCount}):\n${retainedRoles}\n\n${warning}`;
        await ctx.answerCallbackQuery();
        if (message.length <= 4096) {
          await renderPrivateScreen(ctx, message, keyboard);
          return;
        }
        let roleChunk = "Assigned application roles retained:";
        for (const line of retainedRoleLines) {
          if (`${roleChunk}\n${line}`.length > 4096) {
            await ctx.reply(roleChunk);
            roleChunk = "Assigned application roles retained:";
          }
          roleChunk += `\n${line}`;
        }
        await ctx.reply(roleChunk);
        await renderPrivateScreen(ctx, `Role-based access cutover preview\n\nCurrent authorization: ${installation.getState().authorizationMode}\nAssigned application roles retained (${preview.activeRoleCount}): listed above.\n\n${warning}`, keyboard);
        return;
      }
      if (action === "activate") { try { installation.activateRoleBasedAccess(ctx.from.id, data.split(":")[2] ?? ""); await ctx.answerCallbackQuery({ text: "Role-based access activated." }); await showDashboard(ctx); } catch (error) { await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Activation failed.", show_alert: true }); } return; }
      if (action === "cancel") installation.cancelRoleBasedAccessActivation();
      await ctx.answerCallbackQuery({ text: "Activation cancelled." }); return;
    }

    if (namespace === "user") {
      await handleUserCallback(db, ctx, data);
      return;
    }

    if (namespace === "ticket") {
      await handleStaffCallback(db, ctx, data);
      return;
    }

    if (namespace === "qr") {
      await handleQuickRepliesCallback(ctx, data);
      return;
    }

    if (namespace === "batch") {
      if (isPrivateChat(ctx)) {
        if (!await requirePrivatePermission(ctx, "BATCH_OPERATIONS")) {
          await ctx.answerCallbackQuery({ text: "Batch operations require OWNER or ADMIN.", show_alert: true });
          return;
        }
      } else if (!isStaffChat(ctx)) {
        await ctx.answerCallbackQuery({ text: "Batch operations are available in the private staff dashboard.", show_alert: true });
        return;
      } else if (installation.getState().authorizationMode === "RBAC_ACTIVE") {
        await ctx.answerCallbackQuery({ text: "Batch operations are available to OWNER and ADMIN in the bot's private chat.", show_alert: true });
        return;
      } else if (!ctx.from || !hasApplicationPermission(ctx, "BATCH_OPERATIONS")) {
        await ctx.answerCallbackQuery({ text: "Batch operations require OWNER or ADMIN.", show_alert: true });
        return;
      }
      await handleTicketBatchCallback(ctx, data);
      return;
    }

    await ctx.answerCallbackQuery({ text: "Unknown action." });
  });

  bot.on("message:chat_shared", async (ctx) => {
    if (!ctx.from || !isPrivateChat(ctx) || !installation.can(ctx.from.id, "CONFIGURE_INSTALLATION")) return;
    if (!await hasRequiredPrivateWorkspaceMembership(ctx)) { await ctx.reply("Staff workspace membership required for role-based access."); return; }
    const shared = ctx.message.chat_shared;
    if (shared.request_id === 1400) {
      try {
        await inspectAndSavePublicChat(ctx, shared.chat_id, { title: shared.title, username: shared.username });
      } catch (error) {
        logger.warn({ chatId: shared.chat_id, err: error }, "Could not add selected public chat");
        await ctx.reply("The selected public chat could not be inspected. Add the bot as an administrator, then retry.");
      }
      return;
    }
    if (shared.request_id !== 1300) return;
    try {
      const result = await validateStaffWorkspace(ctx.api, shared.chat_id, ctx.from.id);
      const mode = pendingWorkspaceSelection.get(ctx.from.id) ?? "SETUP";
      await completeWorkspaceSelection(ctx, result, mode, { title: shared.title, username: shared.username });
    } catch {
      const mode = pendingWorkspaceSelection.get(ctx.from.id) ?? "SETUP";
      if (mode === "RECONFIGURE") await showStaffWorkspaceSettings(ctx, "The selected group could not be inspected. Add the bot as administrator, enable Topics, then retry.", true);
      else await renderPrivateScreen(ctx, "The selected group could not be inspected. Add the bot as administrator, enable Topics, then retry.", new InlineKeyboard().text("Retry", "setup:workspace").row().text("Back", "setup:stage:STAFF_WORKSPACE"));
    }
  });

  bot.on("message", async (ctx) => {
    if (isStaffChat(ctx)) {
      if (isTicketAnswerPackageDocument(ctx.message)) {
        if (typeof ctx.message.message_thread_id === "number") {
          await ctx.reply("Upload ticket answer packages outside ticket topics.");
          return;
        }
        if (installation.getState().authorizationMode === "RBAC_ACTIVE") {
          await ctx.reply("Batch operations are available to OWNER and ADMIN in the bot's private chat.");
          return;
        }
        if (!await requirePermission(ctx, "BATCH_OPERATIONS")) return;
        await handleTicketAnswerPackageUpload(ctx);
        return;
      }
      await handleStaffGroupMessage(db, ctx, deliverAndRecordStaffTextReply);
      return;
    }

    if (!isPrivateChat(ctx)) {
      await handlePublicLanguageModeration(db, ctx, moderationNow, moderationCleanupScheduler);
      return;
    }

    if (ctx.from && installation.getMember(ctx.from.id) && getPendingPrivateBatchExport(ctx.from.id)) {
      if (!await requirePrivatePermission(ctx, "BATCH_OPERATIONS")) return;
      const exportId = getPendingPrivateBatchExport(ctx.from.id)!;
      if (!isTicketAnswerPackageDocument(ctx.message)) {
        await showPrivateBatchWaiting(ctx, exportId, true, "That file is not an answer package for this workflow.");
        return;
      }
      const filename = ctx.message.document?.file_name ?? "";
      if (filename.toLowerCase() !== `ticket-answers_${exportId}.json`.toLowerCase()) {
        await showPrivateBatchWaiting(ctx, exportId, true, "This answer package belongs to a different export.");
        return;
      }
      await handleTicketAnswerPackageUpload(ctx, exportId);
      return;
    }

    if (ctx.from && installation.getMember(ctx.from.id) && db.getSetting(`staff_test_ticket_mode:${ctx.from.id}`) !== "true") {
      const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
      if (text && await savePendingPublicChatConfiguration(ctx, text)) return;
      if (pendingPublicChatSelection.has(ctx.from.id) && text) {
        if (isPrivateInviteLink(text)) {
          await ctx.reply("The Bot API cannot inspect an inaccessible private invite link. Add the bot to the group, then use the Telegram public-chat picker. You do not need a numeric chat ID.");
          return;
        }
        const reference = parsePublicSupergroupReference(text);
        if (reference) {
          try {
            const chat = await ctx.api.getChat(reference);
            await inspectAndSavePublicChat(ctx, chat.id);
          } catch (error) {
            logger.warn({ err: error }, "Could not resolve public chat reference");
            await ctx.reply("That public supergroup could not be validated. Check its public username and the bot permissions, or use the Telegram picker.");
          }
          return;
        }
      }
      const session = installation.getOnboardingSession(ctx.from.id);
      const workspaceMode = pendingWorkspaceSelection.get(ctx.from.id) ?? (session?.state === "ACTIVE" && session.stage === "STAFF_WORKSPACE" ? "SETUP" : undefined);
      if (workspaceMode && text) {
        if (workspaceMode === "RECONFIGURE" && text === "Cancel workspace selection") {
          pendingWorkspaceSelection.delete(ctx.from.id);
          await retireWorkspacePickerPrompt(ctx.from.id);
          await ctx.reply("Workspace selection cancelled.", { reply_markup: { remove_keyboard: true } });
          await showStaffWorkspaceSettings(ctx, undefined, true);
          return;
        }
        if (isPrivateInviteLink(text)) {
          const retry = workspaceMode === "RECONFIGURE" ? "workspace:select" : "setup:workspace";
          await renderPrivateScreen(ctx, "The bot cannot inspect an inaccessible private invite link. Add the bot to that group, then use the Telegram group picker.", new InlineKeyboard().text("Choose group", retry));
          return;
        }
        const reference = parsePublicSupergroupReference(text);
        if (reference) {
          try {
            const chat = await ctx.api.getChat(reference);
            const result = await validateStaffWorkspace(ctx.api, chat.id, ctx.from.id);
            await completeWorkspaceSelection(ctx, result, workspaceMode);
          } catch {
            if (workspaceMode === "RECONFIGURE") await showStaffWorkspaceSettings(ctx, "That public supergroup could not be validated. Check the username and bot permissions.", true);
            else await renderPrivateScreen(ctx, "That public supergroup could not be validated. Check the username and bot permissions.", new InlineKeyboard().text("Retry", "setup:workspace").row().text("Back", "setup:stage:STAFF_WORKSPACE"));
          }
          return;
        }
      }
      await showDashboard(ctx); return;
    }
    if (ctx.from && db.getSetting(`staff_test_ticket_mode:${ctx.from.id}`) === "true") db.setSetting(`staff_test_ticket_mode:${ctx.from.id}`, "false");
    if (installation.getState().setupState === "SETUP_REQUIRED") { await ctx.reply("Support has not been configured yet. Please try again later."); return; }
    if (await replyIfBanned(db, ctx)) {
      return;
    }

    if (ctx.message && "text" in ctx.message && isCommandText(ctx.message.text)) {
      await ctx.reply(START_TEXT);
      return;
    }

    await handlePrivateUserMessage(db, ctx);
  });

  async function handleTicketAnswerPackageUpload(ctx: Context, privateWorkflowExportId?: string): Promise<void> {
    const document = ctx.message && "document" in ctx.message ? ctx.message.document : undefined;
    if (!document || !ctx.chat) {
      return;
    }
    if (typeof document.file_size === "number" && document.file_size > 5 * 1024 * 1024) {
      if (privateWorkflowExportId && isPrivateChat(ctx)) {
        await showPrivateBatchWaiting(ctx, privateWorkflowExportId, true, "Ticket answer packages must be 5 MiB or smaller.");
      } else {
        await ctx.reply("Ticket answer packages must be 5 MiB or smaller.");
      }
      return;
    }
    const filename = document.file_name ?? "";
    const filenameMatch = /^ticket-answers_(.+)\.json$/i.exec(filename);
    const exportId = filenameMatch?.[1];
    if (!exportId) {
      return;
    }

    try {
      const file = await ctx.api.getFile(document.file_id);
      if (!file.file_path) {
        throw new TicketBatchValidationError("Telegram did not return a file path for the answer package.");
      }
      const response = await fetchImpl(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
      if (!response.ok) {
        throw new TicketBatchValidationError("Telegram could not download the answer package.");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 5 * 1024 * 1024) {
        throw new TicketBatchValidationError("Ticket answer packages must be 5 MiB or smaller.");
      }
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const exportRecord = db.getTicketBatchExport(exportId, config.staffChatId);
      if (!exportRecord) {
        throw new TicketBatchValidationError("This answer package references an unknown export for this staff chat.");
      }
      if (privateWorkflowExportId && exportId !== privateWorkflowExportId) {
        throw new TicketBatchValidationError("This answer package belongs to a different export.");
      }
      if (exportRecord.delivery_state !== "DELIVERED") {
        throw new TicketBatchValidationError("This answer package references an export whose delivery was not confirmed.");
      }
      const exportItems = db.listTicketBatchExportItems(exportId);
      const answerPackage = parseAndValidateAnswerPackage(raw, exportId, exportItems);
      const pages = buildTicketBatchPreviewPagesForAnswerPackage(answerPackage, exportItems);
      const packageHash = getAnswerPackageHash(answerPackage);
      const existingById = db.getTicketBatchAnswerPackage(answerPackage.answer_package_id, config.staffChatId);
      const existingByHash = db.getTicketBatchAnswerPackageByHash(packageHash, config.staffChatId);
      let persistedPackage = existingById;
      if (existingById && existingById.package_hash !== packageHash) {
        throw new TicketBatchValidationError("This answer_package_id was already imported with different content.");
      }
      if (!existingById && existingByHash) {
        throw new TicketBatchValidationError("This answer package content was already imported under a different identity.");
      }
      if (persistedPackage && persistedPackage.status !== "PENDING") {
        throw new TicketBatchValidationError("This answer package is no longer previewable.");
      }
      if (!persistedPackage) {
        persistedPackage = db.createTicketBatchAnswerPackage({
          answerPackageId: answerPackage.answer_package_id,
          exportId,
          staffChatId: config.staffChatId,
          packageHash,
          sourceChatId: ctx.chat.id,
          sourceMessageId: ctx.message?.message_id ?? null,
          packageCreatedAt: answerPackage.created_at,
          items: answerPackage.answers
        });
      }
      const previewToken = persistedPackage.preview_token ?? randomUUID().replace(/-/g, "");
      const previewPage = Math.min(Math.max(persistedPackage.preview_page ?? 0, 0), pages.length - 1);
      const text = formatTicketBatchPreviewPage(pages, previewPage);
      const keyboard = ticketBatchPreviewKeyboard(previewToken, previewPage, pages.length);
      if (persistedPackage.preview_chat_id !== null && persistedPackage.preview_message_id !== null) {
        await ctx.api.editMessageText(persistedPackage.preview_chat_id, persistedPackage.preview_message_id, text, { reply_markup: keyboard });
        db.updateTicketBatchAnswerPackagePreviewPage(persistedPackage.answer_package_id, config.staffChatId, previewPage);
        if (isPrivateChat(ctx) && ctx.from) {
          setPendingPrivateBatchExport(ctx.from.id, undefined);
        }
        return;
      }
      const previewMessage = privateWorkflowExportId && isPrivateChat(ctx)
        ? await refreshPrivateScreen(ctx, text, keyboard)
        : await ctx.reply(text, { reply_markup: keyboard });
      if (!db.setTicketBatchAnswerPackagePreview(persistedPackage.answer_package_id, config.staffChatId, {
        token: previewToken,
        chatId: ctx.chat.id,
        messageId: previewMessage.message_id,
        page: previewPage
      })) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, previewMessage.message_id);
        } catch (cleanupError) {
          logger.warn({ err: cleanupError, exportId }, "Could not remove untracked ticket batch preview");
        }
        throw new TicketBatchValidationError("This answer package already has an active preview.");
      }
      if (isPrivateChat(ctx) && ctx.from) {
        setPendingPrivateBatchExport(ctx.from.id, undefined);
      }
      logger.info({ exportId, previewMessageId: previewMessage.message_id }, "Ticket answer package preview created");
    } catch (error) {
      const message = error instanceof TicketBatchValidationError ? error.message : "Could not validate the ticket answer package.";
      logger.warn("Ticket answer package validation failed");
      if (privateWorkflowExportId && isPrivateChat(ctx)) {
        await showPrivateBatchWaiting(ctx, privateWorkflowExportId, true, message);
      } else {
        await ctx.reply(message);
      }
    }
  }

  async function handleTicketBatchCallback(ctx: Context, data: string): Promise<void> {
    const [, action, token, pageValue] = data.split(":");
    if ((action !== "cancel" && action !== "apply" && action !== "page") || !token) {
      await ctx.answerCallbackQuery({ text: "Unknown ticket batch action." });
      return;
    }
    const message = ctx.callbackQuery?.message;
    if (!message || !("chat" in message) || !("message_id" in message)) {
      await ctx.answerCallbackQuery({ text: "This preview message is no longer available." });
      return;
    }
    if ("message_thread_id" in message && typeof message.message_thread_id === "number") {
      await ctx.answerCallbackQuery({ text: "Use ticket batch controls outside ticket topics." });
      return;
    }
    const packageRecord = db.getTicketBatchAnswerPackageByPreviewToken(token, config.staffChatId);
    if (!packageRecord || packageRecord.preview_chat_id !== message.chat.id || packageRecord.preview_message_id !== message.message_id) {
      await ctx.answerCallbackQuery({ text: "This preview has expired." });
      return;
    }
    if (packageRecord.status !== "PENDING") {
      await ctx.answerCallbackQuery({ text: "This package can no longer be changed." });
      return;
    }
    if (action === "page") {
      const page = Number(pageValue);
      const pages = buildStoredTicketBatchPreviewPages(packageRecord);
      if (!Number.isInteger(page) || page < 0 || page >= pages.length) {
        await ctx.answerCallbackQuery({ text: "That preview page is not available." });
        return;
      }
      await ctx.api.editMessageText(message.chat.id, message.message_id, formatTicketBatchPreviewPage(pages, page), {
        reply_markup: ticketBatchPreviewKeyboard(token, page, pages.length)
      });
      db.updateTicketBatchAnswerPackagePreviewPage(packageRecord.answer_package_id, config.staffChatId, page);
      await ctx.answerCallbackQuery();
      return;
    }
    if (action === "cancel") {
      const cancelled = db.cancelTicketBatchAnswerPackage(packageRecord.answer_package_id, config.staffChatId);
      if (!cancelled) {
        await ctx.answerCallbackQuery({ text: "This package can no longer be cancelled." });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Ticket batch preview cancelled." });
      db.clearTicketBatchAnswerPackagePreview(packageRecord.answer_package_id, config.staffChatId);
      await cleanupTicketBatchPreview(packageRecord, "Package cancelled.");
      if (isPrivateChat(ctx) && ctx.from) {
        setPendingPrivateBatchExport(ctx.from.id, packageRecord.export_id);
        await showPrivateBatchWaiting(ctx, packageRecord.export_id, true, "The preview was cancelled. You can send another answer file for this export.");
      }
      return;
    }

    const beforeClaim = db.getTicketBatchAnswerPackage(packageRecord.answer_package_id, config.staffChatId);
    if (beforeClaim?.status === "APPLYING") {
      await ctx.answerCallbackQuery({ text: "Answer package is already being applied." });
      return;
    }
    if (beforeClaim?.status === "COMPLETED") {
      await ctx.answerCallbackQuery({ text: "Answer package is already completed." });
      return;
    }
    const claimed = db.claimTicketBatchAnswerPackage(packageRecord.answer_package_id, config.staffChatId);
    if (!claimed) {
      await ctx.answerCallbackQuery({ text: "Answer package not found." });
      return;
    }
    if (claimed.status === "CANCELLED") {
      await ctx.answerCallbackQuery({ text: "This package was cancelled." });
      return;
    }

    // Clear the active callback token immediately, but retain the message coordinates in final-summary state.
    db.clearTicketBatchAnswerPackagePreview(claimed.answer_package_id, config.staffChatId);
    await ctx.answerCallbackQuery({ text: "Applying answer package..." });
    await neutralizeTicketBatchPreview(claimed, "Applying...");
    const summary = await applyTicketBatchAnswerPackage(claimed.answer_package_id, ctx.from);
    db.queueTicketBatchFinalSummary(claimed.answer_package_id, config.staffChatId, {
      text: summary,
      chatId: ctx.chat?.id ?? config.staffChatId,
      originChatId: claimed.preview_chat_id,
      originMessageId: claimed.preview_message_id
    });
    await recoverTicketBatchStaffOperations(claimed.answer_package_id);
  }

  function buildStoredTicketBatchPreviewPages(packageRecord: ReturnType<SupportDatabase["getTicketBatchAnswerPackage"]>): string[] {
    if (!packageRecord) {
      throw new TicketBatchValidationError("Ticket answer package not found.");
    }
    const answerPackage: TicketAnswerPackage = {
      schema: "telegram_ticket_answer_package",
      version: 2,
      export_id: packageRecord.export_id,
      answer_package_id: packageRecord.answer_package_id,
      created_at: packageRecord.package_created_at,
      answers: db.listTicketBatchAnswerItems(packageRecord.answer_package_id).map((item) => ({
        ticket_id: item.ticket_id,
        snapshot_token: item.snapshot_token,
        action: item.action,
        reply_text: item.reply_text,
        follow_up_state: item.follow_up_state,
        internal_note: item.internal_note,
        escalation_target: item.escalation_target
      }))
    };
    return buildTicketBatchPreviewPagesForAnswerPackage(answerPackage, db.listTicketBatchExportItems(packageRecord.export_id));
  }

  function buildTicketBatchPreviewPagesForAnswerPackage(
    answerPackage: TicketAnswerPackage,
    exportItems: ReturnType<SupportDatabase["listTicketBatchExportItems"]>
  ): string[] {
    const preview = buildAnswerPackagePreview(answerPackage, exportItems, (ticketId) => {
      const ticket = db.getTicketWithUser(ticketId);
      if (!ticket || ticket.staff_chat_id !== config.staffChatId) return null;
      return { status: ticket.status, snapshotToken: getTicketSnapshotToken(ticket, db.listMessagesChronological(ticket.id)) };
    });
    return buildTicketBatchPreviewPages(answerPackage.export_id, preview);
  }

  async function cleanupTicketBatchPreview(packageRecord: NonNullable<ReturnType<SupportDatabase["getTicketBatchAnswerPackage"]>>, fallbackText: string): Promise<boolean> {
    if (packageRecord.preview_chat_id === null || packageRecord.preview_message_id === null) {
      return true;
    }
    try {
      await bot.api.deleteMessage(packageRecord.preview_chat_id, packageRecord.preview_message_id);
      return true;
    } catch (error) {
      const diagnostic = normalizeTelegramDeliveryError(error);
      logger.warn({ answerPackageId: packageRecord.answer_package_id, category: diagnostic.category }, "Could not delete ticket batch preview");
      try {
        await bot.api.editMessageText(packageRecord.preview_chat_id, packageRecord.preview_message_id, fallbackText, { reply_markup: undefined });
      } catch (editError) {
        const diagnostic = normalizeTelegramDeliveryError(editError);
        logger.warn({ answerPackageId: packageRecord.answer_package_id, category: diagnostic.category }, "Could not neutralize ticket batch preview");
      }
      return false;
    }
  }

  async function neutralizeTicketBatchPreview(packageRecord: NonNullable<ReturnType<SupportDatabase["getTicketBatchAnswerPackage"]>>, text: string): Promise<void> {
    if (packageRecord.preview_chat_id === null || packageRecord.preview_message_id === null) return;
    const previewChatId = packageRecord.preview_chat_id;
    const previewMessageId = packageRecord.preview_message_id;
    try {
      await runStaffChatOperation(() => bot.api.editMessageText(previewChatId, previewMessageId, text, { reply_markup: undefined }), previewChatId);
    } catch (error) {
      const failure = batchStaffFailure(error);
      scheduleTicketBatchStaffRecovery(failure.retryAt);
      logger.warn({ answerPackageId: packageRecord.answer_package_id, category: failure.category }, "Could not neutralize active ticket batch preview");
    }
  }

  async function applyTicketBatchAnswerPackage(answerPackageId: string, staffUser: User | undefined): Promise<string> {
    const packageRecord = db.getTicketBatchAnswerPackage(answerPackageId, config.staffChatId);
    if (!packageRecord) return "Answer package not found.";
    const exportItems = db.listTicketBatchExportItems(packageRecord.export_id);
    const exportTokens = new Map(exportItems.map((item) => [item.ticket_id, item.snapshot_token]));
    const items = db.listTicketBatchAnswerItems(answerPackageId);
    const totals = {
      keep: 0, close: 0, noAction: 0, stale: 0, inactive: 0, unknown: 0, replySent: 0, staffSync: 0, skipped: 0,
      permanentFailures: [] as Array<{ ticketId: number; category: string }>,
      temporaryFailures: [] as Array<{ ticketId: number; category: string; retryAfter: number | null }>
    };

    for (const item of items) {
      if (["COMPLETED", "NO_ACTION", "STALE", "INACTIVE"].includes(item.state)) { totals.skipped += 1; continue; }
      if (item.state === "UNKNOWN_DELIVERY" || item.state === "APPLYING") { db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "UNKNOWN_DELIVERY", { lastError: "Delivery outcome requires manual review." }); totals.unknown += 1; continue; }
      const ticket = db.getTicketWithUser(item.ticket_id);
      if (item.state === "STAFF_SYNC_PENDING") {
        if (!ticket || ticket.staff_chat_id !== config.staffChatId) { db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "INACTIVE", { applied: true }); totals.inactive += 1; continue; }
        if (ticket.status === "CLOSED" && item.action === "reply_and_close" && isConfirmedBatchReply(item)) {
          db.recordTicketBatchTopicEcho(answerPackageId, item.ticket_id, "NOT_REQUIRED", {
            lastError: "Staff topic echo is no longer available after ticket closure."
          });
          const continuation = await resumeReplyAndClosePostDelivery(item, staffUser);
          if (continuation === "COMPLETED") totals.close += 1;
          else if (continuation === "INACTIVE") totals.inactive += 1;
          else totals.replySent += 1;
          continue;
        }
        if (ticket.status === "CLOSED") { db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "INACTIVE", { applied: true }); totals.inactive += 1; continue; }
        try {
          await sendTicketBatchTopicEcho(ticket, item);
          await refreshStaffTicketMessage(db, bot.api, ticket.id);
          if (item.action === "no_action") {
            db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "NO_ACTION", { applied: true });
            totals.noAction += 1;
          } else if (item.action === "reply_and_close") {
            const continuation = await resumeReplyAndClosePostDelivery(item, staffUser);
            if (continuation === "COMPLETED") totals.close += 1;
            else if (continuation === "INACTIVE") totals.inactive += 1;
            else totals.replySent += 1;
          } else {
            db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "COMPLETED", { applied: true });
            totals.keep += 1;
          }
        } catch (error) {
          recordTicketBatchTopicEchoFailure(answerPackageId, item.ticket_id, error);
          totals.staffSync += 1;
        }
        continue;
      }
      if (item.state === "REPLY_SENT" && item.action === "reply_and_close") {
        if (!ticket || ticket.staff_chat_id !== config.staffChatId) {
          db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "INACTIVE", { applied: true });
          totals.inactive += 1;
          continue;
        }

        if (item.topic_echo_state !== "SENT" && ticket.status === "CLOSED") {
          db.recordTicketBatchTopicEcho(answerPackageId, item.ticket_id, "NOT_REQUIRED", {
            lastError: "Staff topic echo is no longer available after ticket closure."
          });
        } else if (item.topic_echo_state !== "SENT") {
          try {
            await sendTicketBatchTopicEcho(ticket, item);
          } catch (error) {
            recordTicketBatchTopicEchoFailure(answerPackageId, item.ticket_id, error);
            totals.staffSync += 1;
            continue;
          }
        }

        const continuation = await resumeReplyAndClosePostDelivery(item, staffUser);
        if (continuation === "COMPLETED") totals.close += 1;
        else if (continuation === "INACTIVE") totals.inactive += 1;
        else totals.replySent += 1;
        continue;
      }
      const expectedToken = exportTokens.get(item.ticket_id);
      if (!ticket || ticket.staff_chat_id !== config.staffChatId || ticket.status === "CLOSED") { db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "INACTIVE", { applied: true }); totals.inactive += 1; continue; }
      if (!expectedToken || item.snapshot_token !== expectedToken || getTicketSnapshotToken(ticket, db.listMessagesChronological(ticket.id)) !== expectedToken) { db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "STALE", { applied: true }); totals.stale += 1; continue; }
      if (!db.claimTicketBatchAnswerItem(answerPackageId, item.ticket_id)) { totals.skipped += 1; continue; }
      if (item.action === "no_action") {
        try {
          if (hasBatchFollowUpContext(item)) persistBatchFollowUp(ticket, item);
          await sendTicketBatchTopicEcho(ticket, item);
          await refreshStaffTicketMessage(db, bot.api, ticket.id);
          db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "NO_ACTION", { applied: true });
          totals.noAction += 1;
        } catch (error) {
          recordTicketBatchTopicEchoFailure(answerPackageId, item.ticket_id, error);
          db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "STAFF_SYNC_PENDING", { lastError: "Staff topic echo pending retry." });
          totals.staffSync += 1;
        }
        continue;
      }
      let deliveryMessageId: number;
      try {
        deliveryMessageId = await deliverAndRecordStaffTextReply(ticket, item.reply_text ?? "", staffUser);
      } catch (error) {
        const diagnostic = normalizeTelegramDeliveryError(error);
        const state = diagnostic.permanence === "UNKNOWN_DELIVERY" ? "UNKNOWN_DELIVERY" : "FAILED";
        db.recordTicketBatchDeliveryFailure(answerPackageId, item.ticket_id, state, diagnostic);
        db.recordTicketBatchTopicEcho(answerPackageId, item.ticket_id, "NOT_REQUIRED");
        logger.warn({ answerPackageId, ticketId: item.ticket_id, category: diagnostic.category, permanence: diagnostic.permanence, method: diagnostic.method, telegramErrorCode: diagnostic.telegramErrorCode, retryAfterSeconds: diagnostic.retryAfterSeconds }, "Ticket batch user delivery failed");
        const failedItem = db.listTicketBatchAnswerItems(answerPackageId).find((candidate) => candidate.ticket_id === item.ticket_id);
        if (failedItem) {
          try {
            await sendTicketBatchDeliveryFailureEvent(ticket, failedItem, diagnostic);
          } catch {
            logger.warn({ answerPackageId, ticketId: item.ticket_id, category: diagnostic.category }, "Could not post ticket batch delivery failure event");
          }
        }
        if (diagnostic.permanence === "PERMANENT") {
          totals.permanentFailures.push({ ticketId: item.ticket_id, category: diagnostic.category });
        } else if (diagnostic.permanence === "TEMPORARY") {
          totals.temporaryFailures.push({ ticketId: item.ticket_id, category: diagnostic.category, retryAfter: diagnostic.retryAfterSeconds });
        } else {
          totals.unknown += 1;
        }
        continue;
      }
      let postDeliveryStage = "FOLLOW_UP_PERSISTENCE";
      try {
        persistBatchFollowUp(ticket, item);
        db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "REPLY_SENT", { deliveryMessageId, applied: true });
        postDeliveryStage = "STAFF_TOPIC_ECHO";
        try {
          await sendTicketBatchTopicEcho(ticket, item);
        } catch (error) {
          recordTicketBatchTopicEchoFailure(answerPackageId, item.ticket_id, error);
          db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "STAFF_SYNC_PENDING", { deliveryMessageId, lastError: "Staff topic echo pending retry." });
          totals.staffSync += 1;
          continue;
        }
        if (item.action === "reply_keep_open") {
          postDeliveryStage = "STAFF_SUMMARY_REFRESH";
          db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "COMPLETED", { deliveryMessageId, applied: true });
          await refreshStaffTicketMessage(db, bot.api, ticket.id);
          totals.keep += 1;
          continue;
        }
        postDeliveryStage = "REPLY_AND_CLOSE_CONTINUATION";
        const continuation = await resumeReplyAndClosePostDelivery(item, staffUser);
        if (continuation === "COMPLETED") totals.close += 1;
        else if (continuation === "INACTIVE") totals.inactive += 1;
        else totals.replySent += 1;
      } catch (error) {
        const diagnostic = normalizeTelegramDeliveryError(error);
        db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "REPLY_SENT", { deliveryMessageId, lastError: "Reply sent; follow-up, staff sync, or close/archive pending." });
        logger.warn({
          answerPackageId,
          ticketId: item.ticket_id,
          stage: postDeliveryStage,
          category: diagnostic.category,
          method: diagnostic.method,
          telegramErrorCode: diagnostic.telegramErrorCode,
          httpStatus: diagnostic.httpStatus
        }, "Ticket batch post-delivery apply step remains pending");
        totals.replySent += 1;
      }
    }
    db.finalizeTicketBatchAnswerPackage(answerPackageId, config.staffChatId);
    return buildPersistedTicketBatchSummary(answerPackageId);
  }

  async function resumeReplyAndClosePostDelivery(
    item: TicketBatchAnswerItemRecord,
    staffUser: User | undefined
  ): Promise<"COMPLETED" | "PENDING" | "INACTIVE"> {
    const persistedItem = db.listTicketBatchAnswerItems(item.answer_package_id)
      .find((candidate) => candidate.ticket_id === item.ticket_id);
    if (!persistedItem || persistedItem.action !== "reply_and_close") return "INACTIVE";
    if (!isConfirmedBatchReply(persistedItem)) {
      logger.warn(
        { answerPackageId: item.answer_package_id, ticketId: item.ticket_id, stage: "USER_REPLY_DELIVERY" },
        "Refused reply-and-close continuation without confirmed user delivery"
      );
      return "PENDING";
    }
    const ticket = db.getTicketWithUser(item.ticket_id);
    if (!ticket || ticket.staff_chat_id !== config.staffChatId) {
      db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "INACTIVE", { applied: true });
      return "INACTIVE";
    }
    const echoResolved = persistedItem.topic_echo_state === "SENT"
      || (persistedItem.topic_echo_state === "NOT_REQUIRED" && ticket.status === "CLOSED");
    if (!echoResolved) return "PENDING";

    let archiveFailure: NormalizedDeliveryError | undefined;
    try {
      await closeTicket(db, bot.api, ticket.id, {
        notifyUser: true,
        staffNotice: "Ticket closed by batch answer.",
        closedBy: staffActor(staffUser),
        onArchiveFailure: (diagnostic) => {
          archiveFailure = diagnostic;
        }
      });
    } catch (error) {
      const diagnostic = normalizeTelegramDeliveryError(error);
      const retryAt = ticketBatchContinuationRetryAt(diagnostic, error);
      db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "REPLY_SENT", {
        lastError: "Reply sent; ticket close or archive pending."
      });
      db.setTicketBatchPostDeliveryRetry(item.answer_package_id, item.ticket_id, retryAt, diagnostic.category);
      if (retryAt !== STAFF_OPERATION_NO_RETRY_AT) scheduleTicketBatchStaffRecovery(retryAt);
      logger.warn({
        answerPackageId: item.answer_package_id,
        ticketId: item.ticket_id,
        stage: "TICKET_CLOSE_OR_ARCHIVE",
        category: diagnostic.category,
        method: diagnostic.method,
        telegramErrorCode: diagnostic.telegramErrorCode,
        httpStatus: diagnostic.httpStatus
      }, "Reply-and-close post-delivery continuation remains pending");
      return "PENDING";
    }

    const reconciledTicket = db.getTicketWithUser(item.ticket_id);
    if (reconciledTicket?.status === "CLOSED" && reconciledTicket.archived_at !== null) {
      db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "COMPLETED", { applied: true });
      db.setTicketBatchPostDeliveryRetry(item.answer_package_id, item.ticket_id, null, null);
      return "COMPLETED";
    }

    const pendingStage = reconciledTicket?.status === "CLOSED" ? "ARCHIVE" : "SQLITE_CLOSE";
    db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "REPLY_SENT", {
      lastError: pendingStage === "ARCHIVE"
        ? "Reply sent; transcript archive pending."
        : "Reply sent; ticket closure pending."
    });
    const retryAt = archiveFailure
      ? ticketBatchContinuationRetryAt(archiveFailure)
      : new Date(Date.now() + 60_000).toISOString();
    db.setTicketBatchPostDeliveryRetry(
      item.answer_package_id,
      item.ticket_id,
      retryAt,
      archiveFailure?.category ?? pendingStage
    );
    if (retryAt !== STAFF_OPERATION_NO_RETRY_AT) scheduleTicketBatchStaffRecovery(retryAt);
    logger.warn({
      answerPackageId: item.answer_package_id,
      ticketId: item.ticket_id,
      stage: pendingStage,
      category: archiveFailure?.category,
      method: archiveFailure?.method,
      telegramErrorCode: archiveFailure?.telegramErrorCode,
      httpStatus: archiveFailure?.httpStatus,
      retryAfterSeconds: archiveFailure?.retryAfterSeconds
    }, "Reply-and-close post-delivery continuation remains pending");
    return "PENDING";
  }

  function ticketBatchContinuationRetryAt(
    diagnostic: NormalizedDeliveryError,
    error?: unknown
  ): string {
    if (error instanceof StaffOnlyDeliveryError && error.retryAt !== null) return error.retryAt;
    if (diagnostic.category === "RATE_LIMITED") {
      return new Date(Date.now() + ((diagnostic.retryAfterSeconds ?? 1) * 1_000) + 250).toISOString();
    }
    if (diagnostic.permanence === "TEMPORARY" || (error !== undefined && !(error instanceof GrammyError) && !(error instanceof HttpError))) {
      return new Date(Date.now() + 60_000).toISOString();
    }
    return STAFF_OPERATION_NO_RETRY_AT;
  }

  function batchStaffFailure(error: unknown): { category: string; retryAt: string | null } {
    if (error instanceof StaffOnlyDeliveryError) return { category: error.diagnostic.category, retryAt: error.retryAt };
    return { category: normalizeTelegramDeliveryError(error).category, retryAt: null };
  }

  function staffNextRetryAt(error: unknown): string | null {
    if (error instanceof StaffOnlyDeliveryError) {
      return error.diagnostic.permanence === "TEMPORARY" ? error.retryAt : STAFF_OPERATION_NO_RETRY_AT;
    }
    return STAFF_OPERATION_NO_RETRY_AT;
  }

  function recordTicketBatchTopicEchoFailure(answerPackageId: string, ticketId: number, error: unknown): void {
    const diagnostic = error instanceof StaffOnlyDeliveryError ? error.diagnostic : normalizeTelegramDeliveryError(error);
    const retryAt = diagnostic.permanence === "TEMPORARY" ? staffNextRetryAt(error) : null;
    const state = diagnostic.permanence === "TEMPORARY" ? "FAILED" : "TERMINAL_FAILED";
    db.recordTicketBatchTopicEcho(answerPackageId, ticketId, state, {
      lastError: diagnostic.category,
      nextRetryAt: retryAt,
      incrementAttempt: true,
      diagnostic
    });
    if (retryAt !== null) scheduleTicketBatchStaffRecovery(retryAt);
    logger.warn({ answerPackageId, ticketId, category: diagnostic.category, method: diagnostic.method, telegramErrorCode: diagnostic.telegramErrorCode, httpStatus: diagnostic.httpStatus, description: diagnostic.description }, "Ticket batch staff topic event failed");
  }

  function buildPersistedTicketBatchSummary(answerPackageId: string): string {
    const items = db.listTicketBatchAnswerItems(answerPackageId);
    const delivered = items.filter((item) => item.delivery_message_id !== null).length;
    const noAction = items.filter((item) => item.action === "no_action").length;
    const permanent = items.filter((item) => item.delivery_error_permanence === "PERMANENT");
    const temporary = items.filter((item) => item.delivery_error_permanence === "TEMPORARY");
    const unknown = items.filter((item) => item.delivery_error_permanence === "UNKNOWN_DELIVERY" || item.state === "UNKNOWN_DELIVERY").length;
    const requiresStaffTopicEvent = (item: typeof items[number]): boolean =>
      item.action === "no_action" ? hasBatchFollowUpContext(item) : isConfirmedBatchReply(item);
    const staffPending = items.filter((item) =>
      (item.topic_echo_state === "PENDING" || item.topic_echo_state === "FAILED") && requiresStaffTopicEvent(item)
    ).length;
    const terminalStaffFailures = items.filter((item) =>
      item.topic_echo_state === "TERMINAL_FAILED" && requiresStaffTopicEvent(item)
    );
    const replyAndCloseItems = items.filter((item) => item.action === "reply_and_close" && isConfirmedBatchReply(item));
    const replyAndCloseTickets = replyAndCloseItems.map((item) => ({
      item,
      ticket: db.getTicketWithUser(item.ticket_id)
    }));
    const ticketsClosed = replyAndCloseTickets.filter(({ ticket }) => ticket?.status === "CLOSED").length;
    const ticketClosuresPending = replyAndCloseTickets.length - ticketsClosed;
    const archivesCompleted = replyAndCloseTickets.filter(({ ticket }) => ticket?.archived_at !== null && ticket?.archived_at !== undefined).length;
    const archivesPending = replyAndCloseTickets.length - archivesCompleted;
    const topicClosuresUnconfirmed = archivesCompleted;
    const hasIssues = permanent.length || temporary.length || unknown || staffPending
      || terminalStaffFailures.length || ticketClosuresPending || archivesPending;
    return [
      hasIssues ? "Ticket batch applied with issues." : "Answer package applied.",
      "",
      `Delivered replies: ${delivered}`,
      `No action: ${noAction}`,
      `Permanent user-delivery failures: ${permanent.length}`,
      `Temporary user-delivery failures: ${temporary.length}`,
      `Unknown user delivery: ${unknown}`,
      `Staff echoes pending/failed: ${staffPending}`,
      `Staff echoes terminal failures: ${terminalStaffFailures.length}`,
      `Tickets closed: ${ticketsClosed}`,
      `Ticket closures pending/failed: ${ticketClosuresPending}`,
      `Archives completed: ${archivesCompleted}`,
      `Archives pending/failed: ${archivesPending}`,
      `Topic closures unconfirmed: ${topicClosuresUnconfirmed}`,
      `Stale: ${items.filter((item) => item.state === "STALE").length}`,
      `Inactive: ${items.filter((item) => item.state === "INACTIVE").length}`,
      ...(permanent.length || temporary.length || unknown ? ["", "User delivery failures:", ...[...permanent, ...temporary, ...items.filter((item) => item.delivery_error_permanence === "UNKNOWN_DELIVERY" || item.state === "UNKNOWN_DELIVERY")].map((item) => `- #${item.ticket_id} — ${item.delivery_error_category ?? "UNKNOWN"}`)] : []),
      ...(terminalStaffFailures.length ? ["", "Staff sync failures:", ...terminalStaffFailures.map((item) => `- #${item.ticket_id} — ${item.topic_echo_error_category ?? item.topic_echo_last_error ?? "UNKNOWN"}`)] : [])
    ].join("\n");
  }

  function recoverTicketBatchStaffOperations(answerPackageId?: string): Promise<void> {
    const queued = ticketBatchRecoveryQueue.then(() => runTicketBatchStaffRecovery(answerPackageId));
    ticketBatchRecoveryQueue = queued.catch(() => undefined);
    return queued;
  }

  async function runTicketBatchStaffRecovery(answerPackageId?: string): Promise<void> {
    const at = new Date().toISOString();
    const packagesToFinalize = new Set<string>();
    const packagesToRefresh = new Set<string>();
    const invalidSuccessEchoes = db.listInvalidTicketBatchSuccessEchoes(config.staffChatId, 20)
      .filter((item) => answerPackageId === undefined || item.answer_package_id === answerPackageId);
    for (const item of invalidSuccessEchoes) {
      db.recordTicketBatchTopicEcho(item.answer_package_id, item.ticket_id, "NOT_REQUIRED", {
        lastError: "Success echo is not applicable after an unconfirmed user delivery."
      });
      logger.warn({ answerPackageId: item.answer_package_id, ticketId: item.ticket_id }, "Skipped invalid ticket batch success-echo recovery candidate");
    }
    const closedPendingEchoes = db.listClosedTicketBatchReplyAndClosePendingEchoes(config.staffChatId, 20)
      .filter((item) => answerPackageId === undefined || item.answer_package_id === answerPackageId);
    for (const item of closedPendingEchoes) {
      db.recordTicketBatchTopicEcho(item.answer_package_id, item.ticket_id, "NOT_REQUIRED", {
        lastError: "Staff topic echo is no longer available after ticket closure."
      });
      packagesToFinalize.add(item.answer_package_id);
    }
    const failureEvents = db.listPendingTicketBatchFailureEvents(config.staffChatId, at, 20)
      .filter((item) => answerPackageId === undefined || item.answer_package_id === answerPackageId);
    for (const item of failureEvents) {
      const ticket = db.getTicketWithUser(item.ticket_id);
      if (!ticket || ticket.staff_chat_id !== config.staffChatId || ticket.status === "CLOSED") {
        if (ticket?.status === "CLOSED") {
          db.recordTicketBatchFailureEvent(item.answer_package_id, item.ticket_id, "NOT_REQUIRED");
        }
        continue;
      }
      const diagnostic: NormalizedDeliveryError = {
        category: item.delivery_error_category ?? "UNKNOWN_TELEGRAM_ERROR",
        permanence: item.delivery_error_permanence ?? "UNKNOWN_DELIVERY",
        method: item.delivery_error_method,
        telegramErrorCode: item.delivery_error_code,
        httpStatus: item.delivery_http_status,
        retryAfterSeconds: item.delivery_retry_after_seconds,
        description: item.delivery_error_description,
        occurredAt: item.delivery_failed_at ?? at
      };
      try {
        await sendTicketBatchDeliveryFailureEvent(ticket, item, diagnostic);
      } catch (error) {
        const failure = batchStaffFailure(error);
        scheduleTicketBatchStaffRecovery(failure.retryAt);
      }
    }
    const echoes = db.listPendingTicketBatchTopicEchoes(config.staffChatId, at, 20)
      .filter((item) => answerPackageId === undefined || item.answer_package_id === answerPackageId);
    for (const item of echoes) {
      const ticket = db.getTicketWithUser(item.ticket_id);
      if (!ticket || ticket.staff_chat_id !== config.staffChatId || ticket.status === "CLOSED") continue;
      try {
        await sendTicketBatchTopicEcho(ticket, item);
        if (item.action === "no_action") db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "NO_ACTION", { applied: true });
        else if (item.state === "STAFF_SYNC_PENDING" && item.action === "reply_keep_open") db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "COMPLETED", { applied: true });
        packagesToFinalize.add(item.answer_package_id);
        packagesToRefresh.add(item.answer_package_id);
      } catch (error) {
        recordTicketBatchTopicEchoFailure(item.answer_package_id, item.ticket_id, error);
      }
    }

    const continuations = db.listPendingTicketBatchReplyAndCloseContinuations(config.staffChatId, at, 20)
      .filter((item) => answerPackageId === undefined || item.answer_package_id === answerPackageId);
    for (const item of continuations) {
      const result = await resumeReplyAndClosePostDelivery(item, undefined);
      packagesToFinalize.add(item.answer_package_id);
      if (result !== "PENDING") packagesToRefresh.add(item.answer_package_id);
    }
    for (const packageId of packagesToFinalize) {
      db.finalizeTicketBatchAnswerPackage(packageId, config.staffChatId);
    }
    for (const packageId of packagesToRefresh) {
      db.queueTicketBatchFinalSummaryRefresh(
        packageId,
        config.staffChatId,
        buildPersistedTicketBatchSummary(packageId)
      );
    }
    if (continuations.length === 20) {
      scheduleTicketBatchStaffRecovery(new Date(Date.now() + 250).toISOString());
    }

    const summaryAt = new Date().toISOString();
    const summaries = db.listPendingTicketBatchFinalSummaries(config.staffChatId, summaryAt, 20)
      .filter((item) => answerPackageId === undefined || item.answer_package_id === answerPackageId);
    for (const item of summaries) {
      const text = buildPersistedTicketBatchSummary(item.answer_package_id);
      db.queueTicketBatchFinalSummary(item.answer_package_id, config.staffChatId, {
        text,
        chatId: item.final_summary_chat_id ?? config.staffChatId,
        originChatId: item.final_summary_origin_chat_id,
        originMessageId: item.final_summary_origin_message_id
      });
      db.recordTicketBatchFinalSummaryAttempt(item.answer_package_id, config.staffChatId);
      try {
        if (item.final_summary_origin_chat_id !== null && item.final_summary_origin_message_id !== null) {
          const originChatId = item.final_summary_origin_chat_id;
          const originMessageId = item.final_summary_origin_message_id;
          await runStaffChatOperation(() => bot.api.editMessageText(originChatId, originMessageId, text, {
            reply_markup: originChatId > 0 ? new InlineKeyboard().text("Back to dashboard", "dashboard:home") : undefined
          }), originChatId);
          db.recordTicketBatchFinalSummarySent(item.answer_package_id, config.staffChatId, originMessageId);
        } else {
          const destinationChatId = item.final_summary_chat_id ?? config.staffChatId;
          const sent = await runStaffChatOperation(() => bot.api.sendMessage(destinationChatId, text, {
            reply_markup: destinationChatId > 0 ? new InlineKeyboard().text("Back to dashboard", "dashboard:home") : undefined
          }), destinationChatId);
          db.recordTicketBatchFinalSummarySent(item.answer_package_id, config.staffChatId, sent.message_id);
        }
      } catch (error) {
        const failure = batchStaffFailure(error);
        if (failure.retryAt !== null) {
          db.recordTicketBatchFinalSummaryFailure(item.answer_package_id, config.staffChatId, "FAILED", failure.category, failure.retryAt);
          scheduleTicketBatchStaffRecovery(failure.retryAt);
        } else if (item.final_summary_origin_message_id !== null) {
          // The preview cannot be replaced, so a single persisted fallback send can be attempted later.
          db.queueTicketBatchFinalSummary(item.answer_package_id, config.staffChatId, {
            text, chatId: item.final_summary_chat_id ?? config.staffChatId
          });
          const fallbackAt = new Date().toISOString();
          db.recordTicketBatchFinalSummaryFailure(item.answer_package_id, config.staffChatId, "FAILED", failure.category, fallbackAt);
          scheduleTicketBatchStaffRecovery(fallbackAt);
        } else {
          db.recordTicketBatchFinalSummaryFailure(item.answer_package_id, config.staffChatId, "UNKNOWN_DELIVERY", failure.category, null);
        }
        logger.warn({ answerPackageId: item.answer_package_id, category: failure.category }, "Ticket batch final summary remains pending");
      }
    }
    scheduleTicketBatchStaffRecovery(db.getNextTicketBatchStaffRetryAt(config.staffChatId) ?? null);
  }

  function scheduleTicketBatchStaffRecovery(nextRetryAt: string | null): void {
    if (!nextRetryAt) return;
    const target = new Date(nextRetryAt).getTime();
    if (!Number.isFinite(target)) return;
    if (ticketBatchRecoveryTimer && ticketBatchRecoveryTimerAt !== undefined && ticketBatchRecoveryTimerAt <= target) return;
    if (ticketBatchRecoveryTimer) clearTimeout(ticketBatchRecoveryTimer);
    const delay = Math.max(250, Math.min(2_147_000_000, target - Date.now()));
    ticketBatchRecoveryTimerAt = target;
    ticketBatchRecoveryTimer = setTimeout(() => {
      ticketBatchRecoveryTimer = undefined;
      ticketBatchRecoveryTimerAt = undefined;
      void recoverTicketBatchStaffOperations().catch((error) => logger.warn({ category: normalizeTelegramDeliveryError(error).category }, "Ticket batch staff recovery failed"));
    }, delay);
    ticketBatchRecoveryTimer.unref();
  }

  bot.catch(async (error) => {
    const ctx = error.ctx;
    logger.error(
      { err: error.error, updateId: ctx.update.update_id },
      "Bot failed while processing an update"
    );

    const staffChatId = installationServicesByApi.get(ctx.api)?.getStaffChatId();
    if (staffChatId !== null && staffChatId !== undefined && ctx.chat?.id === staffChatId) {
      await notifyStaff(
        ctx.api,
        `Bot error while processing update ${ctx.update.update_id}: ${describeError(error.error)}`,
        ctx.msg?.message_thread_id
      );
    }
  });

  const supportBot = bot as SupportBot;
  supportBot.recoverPendingTicketBatchStaffOperations = () => recoverTicketBatchStaffOperations();
  return supportBot;
}

export async function setBotCommands(bot: Bot<Context>, installation?: InstallationService): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Start support" },
    { command: "status", description: "Show your latest ticket status" },
    { command: "mytickets", description: "Show your recent tickets" },
    { command: "help", description: "Show help" }
  ]);

  const staffChatId = installation?.getStaffChatId() ?? installationServicesByApi.get(bot.api)?.getStaffChatId();
  if (staffChatId === null || staffChatId === undefined) return;
  await bot.api.setMyCommands(
    [
      { command: "help", description: "Show staff help" },
      { command: "chatid", description: "Show this chat id" },
      { command: "ticket", description: "Show ticket details" },
      { command: "close", description: "Close a ticket" },
      { command: "ban", description: "Ban a user from support" },
      { command: "unban", description: "Unban a user" },
      { command: "bans", description: "List banned users" },
      { command: "whois", description: "Show ticket user details" },
      { command: "exporttickets", description: "Export active tickets" },
      { command: "moderation", description: "Manage public chat moderation" },
      { command: "questnotify", description: "Manage new-entity notifications" },
      { command: "logs", description: "Show Support Logs topic status" },
      { command: "setlogs", description: "Use this topic as Support Logs" }
    ],
    { scope: { type: "chat", chat_id: staffChatId } }
  );
}

export async function sendStaffOnboardingIfNeeded(api: BotApi, db: SupportDatabase, installation?: InstallationService): Promise<void> {
  const staffChatId = installation?.getStaffChatId() ?? installationServicesByApi.get(api)?.getStaffChatId();
  if (staffChatId === null || staffChatId === undefined) return;
  const settingKey = staffHelpSentSettingKey();
  if (db.getSetting(settingKey) === "true") {
    return;
  }

  try {
    await api.sendMessage(staffChatId, STAFF_ONBOARDING_TEXT);
    db.setSetting(settingKey, "true");
  } catch (error) {
    logger.warn(
      { err: error, staffChatId },
      "Could not send staff onboarding message"
    );
  }
}

async function handlePrivateUserMessage(db: SupportDatabase, ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat || !ctx.message) {
    return;
  }

  if (!messageHasTextOrSupportedMedia(ctx.message)) {
    await ctx.reply("Please send your issue as text, photo, screenshot, or document.");
    return;
  }

  persistUserFromContext(db, ctx);

  const activeTicket = db.findActiveTicketForUser(ctx.from.id, config.staffChatId);
  if (activeTicket) {
    await appendToExistingTicket(db, ctx, activeTicket);
    return;
  }

  await createFreshTicketFromUserMessage(db, ctx);
}

async function createFreshTicketFromUserMessage(db: SupportDatabase, ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat || !ctx.message) {
    return;
  }

  let ticket: TicketRecord;
  try {
    ticket = db.createTicket(ctx.from.id, config.staffChatId);
  } catch (error) {
    if (isSqliteConstraint(error)) {
      const activeTicket = db.findActiveTicketForUser(ctx.from.id, config.staffChatId);
      if (activeTicket) {
        await appendToExistingTicket(db, ctx, activeTicket);
        return;
      }
    }

    throw error;
  }

  const content = getMessageContent(ctx.message);

  db.addMessage({
    ticketId: ticket.id,
    direction: "USER_TO_STAFF",
    sourceChatId: ctx.chat.id,
    sourceMessageId: ctx.message.message_id,
    fromTelegramId: ctx.from.id,
    fromUsername: usernameOf(ctx.from),
    senderType: "USER",
    senderDisplayName: displayTelegramUser(ctx.from),
    senderUsername: usernameOf(ctx.from),
    text: content.text,
    mediaType: content.mediaType,
    filename: content.filename,
    fileId: content.fileId
  });

  let messageThreadId: number;
  try {
    const topic = await ctx.api.createForumTopic(config.staffChatId, topicName(ticket.id, ctx.from));
    messageThreadId = topic.message_thread_id;
    db.updateTicketForumTopic(ticket.id, config.staffChatId, messageThreadId);
  } catch (error) {
    logger.error({ err: error, ticketId: ticket.id }, "Could not create staff forum topic");
    db.updateTicketStatus(ticket.id, "CLOSED");
    db.deleteMessagesForTicket(ticket.id);
    await ctx.reply("Sorry, we could not create a support topic. Please try again later.");
    return;
  }

  const ticketWithTopic = db.getTicketWithUser(ticket.id);
  if (!ticketWithTopic?.message_thread_id) {
    db.updateTicketStatus(ticket.id, "CLOSED");
    db.deleteMessagesForTicket(ticket.id);
    await ctx.reply("Sorry, we could not route your request to support. Please try again later.");
    return;
  }

  try {
    const summary = await ctx.api.sendMessage(
      config.staffChatId,
      formatPinnedTicketSummary(ticketWithTopic),
      {
        message_thread_id: messageThreadId,
        reply_markup: staffTicketKeyboard(ticket.id)
      }
    );
    db.updateTicketStaffMessage(ticket.id, summary.chat.id, summary.message_id);
    await pinMessageSafely(ctx.api, summary.chat.id, summary.message_id, ticket.id);

    await ctx.api.sendMessage(
      config.staffChatId,
      formatTicketPost(ticketWithTopic, content.text),
      {
        message_thread_id: messageThreadId
      }
    );
  } catch (error) {
    logger.error({ err: error, ticketId: ticket.id }, "Could not send ticket intro to staff topic");
    db.updateTicketStatus(ticket.id, "CLOSED");
    db.deleteMessagesForTicket(ticket.id);
    await closeForumTopicSafely(ctx.api, ticketWithTopic);
    await ctx.reply("Sorry, we could not route your request to support. Please try again later.");
    return;
  }

  db.closeOtherActiveTicketsForUserInStaffChat(ctx.from.id, config.staffChatId, ticket.id);
  await maybeCopyOriginalMessageToStaff(db, ctx, ticketWithTopic, content.shouldCopyOriginal);
  await ctx.reply(RECEIVED_TEXT, {
    reply_markup: userTicketKeyboard(ticket.id)
  });
}

async function appendToExistingTicket(
  db: SupportDatabase,
  ctx: Context,
  activeTicket: TicketRecord
): Promise<void> {
  if (!ctx.from || !ctx.chat || !ctx.message) {
    return;
  }

  if (activeTicket.staff_chat_id !== config.staffChatId || activeTicket.message_thread_id === null) {
    const readyTicket = await waitForTicketTopic(db, activeTicket.id);
    if (readyTicket && readyTicket.status !== "CLOSED") {
      await appendToExistingTicket(db, ctx, readyTicket);
      return;
    }

    logger.warn({ ticketId: activeTicket.id }, "Active ticket topic was not created in time");
    if (readyTicket?.status !== "CLOSED") {
      db.closeTicketRecord(activeTicket.id, systemActor());
      await archiveTicketIfPossible(ctx.api, db, activeTicket.id);
    }
    await createFreshTicketFromUserMessage(db, ctx);
    return;
  }

  const content = getMessageContent(ctx.message);

  try {
    await ctx.api.sendMessage(
      config.staffChatId,
      formatTicketUpdate(ctx.from, content.text, content.mediaType, content.filename),
      {
        message_thread_id: activeTicket.message_thread_id
      }
    );

    db.addMessage({
      ticketId: activeTicket.id,
      direction: "USER_TO_STAFF",
      sourceChatId: ctx.chat.id,
      sourceMessageId: ctx.message.message_id,
      fromTelegramId: ctx.from.id,
      fromUsername: usernameOf(ctx.from),
      senderType: "USER",
      senderDisplayName: displayTelegramUser(ctx.from),
      senderUsername: usernameOf(ctx.from),
      text: content.text,
      mediaType: content.mediaType,
      filename: content.filename,
      fileId: content.fileId
    });

    if (activeTicket.status === "WAITING_USER") {
      db.clearWaitingUserFollowUp(activeTicket.id);
      db.updateTicketStatus(activeTicket.id, "IN_PROGRESS");
    }

    const ticketWithUser = db.getTicketWithUser(activeTicket.id);
    if (ticketWithUser) {
      await maybeCopyOriginalMessageToStaff(db, ctx, ticketWithUser, content.shouldCopyOriginal);
      await refreshStaffTicketMessage(db, ctx.api, activeTicket.id);
    }

    db.closeOtherActiveTicketsForUserInStaffChat(ctx.from.id, config.staffChatId, activeTicket.id);
  } catch (error) {
    if (isForumTopicUnavailable(error)) {
      logger.warn(
        { err: error, ticketId: activeTicket.id, messageThreadId: activeTicket.message_thread_id },
        "Staff forum topic is unavailable; creating a fresh ticket"
      );
      db.closeTicketRecord(activeTicket.id, systemActor());
      await archiveTicketIfPossible(ctx.api, db, activeTicket.id);
      await createFreshTicketFromUserMessage(db, ctx);
      return;
    }

    logger.error({ err: error, ticketId: activeTicket.id }, "Could not notify staff about user update");
    await ctx.reply("Sorry, we could not route your update to support. Please try again later.");
    return;
  }
}

async function handleStaffGroupMessage(
  db: SupportDatabase,
  ctx: Context,
  deliverAndRecordStaffTextReply: DeliverAndRecordStaffTextReply
): Promise<void> {
  if (!ctx.message || !ctx.chat) {
    return;
  }

  if ("text" in ctx.message && isCommandText(ctx.message.text)) {
    return;
  }

  const messageThreadId = ctx.message.message_thread_id;
  if (typeof messageThreadId !== "number") {
    return;
  }

  const ticket = db.findTicketByStaffThread(ctx.chat.id, messageThreadId);
  if (!ticket) {
    return;
  }

  if (!hasApplicationPermission(ctx, "REPLY_TO_TICKETS")) {
    await ctx.reply("Your application role does not allow ticket replies.", { message_thread_id: messageThreadId });
    return;
  }

  if (!messageHasTextOrSupportedMedia(ctx.message)) {
    return;
  }

  if (ticket.status === "CLOSED") {
    await sendStaffTopicNotice(ctx.api, ticket, `Ticket #${ticket.id} is closed. The reply was not sent to the user.`);
    return;
  }

  const content = getMessageContent(ctx.message);

  try {
    if (content.mediaType) {
      const delivered = await deliverStaffMediaReplyToUser(ctx.api, ticket, ctx.message.message_id);

      db.addMessage({
        ticketId: ticket.id,
        direction: "STAFF_TO_USER",
        sourceChatId: ctx.chat.id,
        sourceMessageId: ctx.message.message_id,
        deliveryChatId: ticket.user_telegram_id,
        deliveryMessageId: delivered,
        fromTelegramId: ctx.from?.id ?? null,
        fromUsername: usernameOf(ctx.from),
        senderType: "STAFF",
        senderDisplayName: ctx.from ? displayTelegramUser(ctx.from) : "Support",
        senderUsername: usernameOf(ctx.from),
        text: content.text,
        mediaType: content.mediaType,
        filename: content.filename,
        fileId: content.fileId
      });
    } else {
      await deliverAndRecordStaffTextReply(ticket, content.text ?? "", ctx.from, {
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id
      });
    }

    if (ticket.status === "OPEN") {
      db.updateTicketStatus(ticket.id, "IN_PROGRESS");
      await refreshStaffTicketMessage(db, ctx.api, ticket.id);
    }
  } catch (error) {
    logger.error({ err: error, ticketId: ticket.id }, "Could not deliver staff reply to user");
    await sendStaffTopicNotice(
      ctx.api,
      ticket,
      `Could not deliver staff reply for ticket #${ticket.id} to user ${ticket.user_telegram_id}: ${describeError(error)}`
    );
  }
}

async function handleUserCallback(db: SupportDatabase, ctx: Context, data: string): Promise<void> {
  if (!isPrivateChat(ctx) || !ctx.from) {
    await ctx.answerCallbackQuery({
      text: "This action is only available in private chat.",
      show_alert: true
    });
    return;
  }

  const [, action, rawTicketId] = data.split(":");
  if (action !== "close") {
    await ctx.answerCallbackQuery({ text: "Unknown action." });
    return;
  }

  const ticketId = Number(rawTicketId);
  if (!Number.isInteger(ticketId)) {
    await ctx.answerCallbackQuery({ text: "Invalid ticket." });
    return;
  }

  const ticket = db.getTicketWithUser(ticketId);
  if (!ticket || ticket.user_telegram_id !== ctx.from.id || ticket.staff_chat_id !== config.staffChatId) {
    await ctx.answerCallbackQuery({
      text: "Ticket not found.",
      show_alert: true
    });
    return;
  }

  if (ticket.status === "CLOSED") {
    await ctx.answerCallbackQuery({ text: "Ticket is already closed." });
    return;
  }

  await closeTicket(db, ctx.api, ticket.id, {
    notifyUser: false,
    staffNotice: "User closed this ticket.",
    closedBy: userActor(ctx.from)
  });

  await ctx.answerCallbackQuery({ text: "Ticket closed." });
  await ctx.reply(CLOSED_TEXT);
}

async function handleStaffCallback(db: SupportDatabase, ctx: Context, data: string): Promise<void> {
  if (!isStaffChat(ctx)) {
    await ctx.answerCallbackQuery({
      text: "Staff only.",
      show_alert: true
    });
    return;
  }

  const [, action, rawTicketId, rawStatus] = data.split(":");
  const ticketId = Number(rawTicketId);
  if (!Number.isInteger(ticketId)) {
    await ctx.answerCallbackQuery({ text: "Invalid ticket." });
    return;
  }

  const ticket = db.getTicketWithUser(ticketId);
  if (!ticket || ticket.staff_chat_id !== config.staffChatId) {
    await ctx.answerCallbackQuery({ text: "Ticket not found in this staff chat." });
    return;
  }

  if (action === "close") {
    if (!hasApplicationPermission(ctx, "CLOSE_TICKETS")) {
      await ctx.answerCallbackQuery({ text: "Your application role cannot close tickets.", show_alert: true });
      return;
    }
    const result = await closeTicket(db, ctx.api, ticket.id, {
      notifyUser: true,
      staffNotice: "Ticket closed by staff.",
      closedBy: staffActor(ctx.from)
    });
    await ctx.answerCallbackQuery({ text: result });
    return;
  }

  if (action === "status" && isTicketStatus(rawStatus)) {
    if (!hasApplicationPermission(ctx, "CLOSE_TICKETS")) {
      await ctx.answerCallbackQuery({ text: "Your application role cannot update tickets.", show_alert: true });
      return;
    }
    if (ticket.status === "CLOSED") {
      await ctx.answerCallbackQuery({ text: "Ticket is already closed." });
      return;
    }

    db.updateTicketStatus(ticket.id, rawStatus);
    await refreshStaffTicketMessage(db, ctx.api, ticket.id);
    await sendStaffTopicNotice(ctx.api, ticket, `Ticket marked ${formatStatus(rawStatus)}.`);
    await ctx.answerCallbackQuery({ text: `Marked ${formatStatus(rawStatus)}.` });
    return;
  }

  if (action === "ban") {
    if (!ctx.from || !hasApplicationPermission(ctx, "BAN_USERS")) {
      await ctx.answerCallbackQuery({ text: "Your role cannot ban users.", show_alert: true });
      return;
    }
    await banUserForTicket(db, ctx.api, ticket, staffActor(ctx.from), `Banned from ticket #${ticket.id}`);
    await ctx.answerCallbackQuery({ text: `User ${ticket.user_telegram_id} banned.` });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action." });
}

async function banUserById(
  db: SupportDatabase,
  api: BotApi,
  userId: number,
  reason: string,
  actor: ArchiveActor
): Promise<void> {
  const user = db.getUser(userId);
  db.banUser({
    userTelegramId: userId,
    username: user?.username ?? null,
    reason,
    bannedBy: actor.telegramId
  });

  await logBanEvent(api, db, {
    action: "BANNED",
    userTelegramId: userId,
    username: user?.username ?? null,
    reason,
    performedBy: actor
  });

  const activeTicket = db.findActiveTicketForUser(userId, config.staffChatId);
  if (activeTicket) {
    const ticket = db.getTicketWithUser(activeTicket.id);
    if (ticket) {
      await closeTicket(db, api, ticket.id, {
        notifyUser: true,
        userText: BANNED_TEXT,
        staffNotice: `User ${userId} was banned. Reason: ${reason}`,
        closedBy: actor
      });
      db.closeOtherActiveTicketsForUserInStaffChat(userId, config.staffChatId, ticket.id);
      return;
    }
  }

  await notifyUserOrStaff(api, userId, BANNED_TEXT, activeTicket?.message_thread_id ?? null);
}

async function banUserForTicket(
  db: SupportDatabase,
  api: BotApi,
  ticket: TicketWithUser,
  actor: ArchiveActor,
  reason: string
): Promise<void> {
  db.banUser({
    userTelegramId: ticket.user_telegram_id,
    username: ticket.username,
    reason,
    bannedBy: actor.telegramId
  });

  await logBanEvent(api, db, {
    action: "BANNED",
    userTelegramId: ticket.user_telegram_id,
    username: ticket.username,
    reason,
    performedBy: actor
  });

  await closeTicket(db, api, ticket.id, {
    notifyUser: true,
    userText: BANNED_TEXT,
    staffNotice: `User ${ticket.user_telegram_id} has been banned. Reason: ${reason}`,
    closedBy: actor
  });
  db.closeOtherActiveTicketsForUserInStaffChat(ticket.user_telegram_id, config.staffChatId, ticket.id);
}

async function closeTicket(
  db: SupportDatabase,
  api: BotApi,
  ticketId: number,
  options: CloseTicketOptions = {}
): Promise<string> {
  const ticket = db.getTicketWithUser(ticketId);
  if (!ticket || ticket.staff_chat_id !== config.staffChatId) {
    return `Ticket #${ticketId} was not found in this staff chat.`;
  }

  if (ticket.status === "CLOSED") {
    const archived = await archiveTicketIfPossible(api, db, ticketId, {
      onFailure: options.onArchiveFailure
    });
    return archived
      ? `Ticket #${ticketId} is already closed and archived.`
      : `Ticket #${ticketId} is already closed. Transcript archive is pending retry.`;
  }

  const closedTicket = db.closeTicketRecord(ticketId, options.closedBy ?? systemActor());
  await refreshStaffTicketMessage(db, api, ticketId);

  if (options.staffNotice) {
    await sendStaffTopicNotice(api, ticket, options.staffNotice);
  }

  if (options.notifyUser) {
    await notifyUserOrStaff(api, ticket.user_telegram_id, options.userText ?? CLOSED_TEXT, ticket.message_thread_id);
  }

  const archived = await archiveTicketIfPossible(api, db, ticketId, {
    onFailure: options.onArchiveFailure
  });

  return archived
    ? `Ticket #${closedTicket?.id ?? ticketId} closed and archived.`
    : `Ticket #${closedTicket?.id ?? ticketId} closed. Transcript archive is pending retry.`;
}

async function refreshStaffTicketMessage(
  db: SupportDatabase,
  api: BotApi,
  ticketId: number
): Promise<void> {
  const ticket = db.getTicketWithUser(ticketId);
  if (
    !ticket?.staff_chat_id ||
    ticket.staff_chat_id !== config.staffChatId ||
    !ticket.staff_message_id
  ) {
    return;
  }

  try {
    await api.editMessageText(
      ticket.staff_chat_id,
      ticket.staff_message_id,
      formatPinnedTicketSummary(ticket),
      {
        reply_markup: ticket.status === "CLOSED" ? undefined : staffTicketKeyboard(ticket.id)
      }
    );
  } catch (error) {
    if (error instanceof GrammyError && error.description.includes("message is not modified")) {
      return;
    }

    logger.warn({ err: error, ticketId }, "Could not refresh staff ticket intro");
  }
}

async function maybeCopyOriginalMessageToStaff(
  db: SupportDatabase,
  ctx: Context,
  ticket: TicketWithUser,
  shouldCopyOriginal: boolean
): Promise<void> {
  if (!shouldCopyOriginal || !ctx.chat || !ctx.message || !ticket.message_thread_id) {
    return;
  }

  try {
    await ctx.api.copyMessage(config.staffChatId, ctx.chat.id, ctx.message.message_id, {
      message_thread_id: ticket.message_thread_id
    });
  } catch (error) {
    logger.error({ err: error, ticketId: ticket.id }, "Could not copy original user message to staff topic");
    await sendStaffTopicNotice(
      ctx.api,
      ticket,
      `Ticket #${ticket.id} was created, but the attachment could not be copied: ${describeError(error)}`
    );
  }
}

async function deliverStaffMediaReplyToUser(
  api: BotApi,
  ticket: TicketWithUser,
  sourceMessageId: number
): Promise<number> {
  const sourceChatId = ticket.staff_chat_id ?? config.staffChatId;
  const copied = await api.copyMessage(ticket.user_telegram_id, sourceChatId, sourceMessageId);
  return copied.message_id;
}

async function pinMessageSafely(
  api: BotApi,
  chatId: number,
  messageId: number,
  ticketId: number
): Promise<void> {
  try {
    await api.pinChatMessage(chatId, messageId, {
      disable_notification: true
    });
  } catch (error) {
    logger.warn({ err: error, ticketId }, "Could not pin ticket summary");
  }
}

async function waitForTicketTopic(
  db: SupportDatabase,
  ticketId: number,
  attempts = 10
): Promise<TicketRecord | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ticket = db.getTicket(ticketId);
    if (!ticket || ticket.status === "CLOSED" || ticket.message_thread_id !== null) {
      return ticket;
    }

    await sleep(250);
  }

  return db.getTicket(ticketId);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function sendStaffTopicNotice(api: BotApi, ticket: TicketRecord, text: string): Promise<void> {
  if (!ticket.staff_chat_id || !ticket.message_thread_id) {
    await notifyStaff(api, text);
    return;
  }

  try {
    await api.sendMessage(ticket.staff_chat_id, truncate(text, 3500), {
      message_thread_id: ticket.message_thread_id
    });
  } catch (error) {
    logger.error({ err: error, ticketId: ticket.id }, "Could not send staff topic notice");
  }
}

async function notifyStaff(api: BotApi, text: string, messageThreadId?: number | null): Promise<void> {
  try {
    await api.sendMessage(config.staffChatId, truncate(text, 3500), {
      message_thread_id: messageThreadId ?? undefined
    });
  } catch (error) {
    logger.error({ err: error }, "Could not send log message to staff chat");
  }
}

async function notifyUserOrStaff(
  api: BotApi,
  userTelegramId: number,
  text: string,
  messageThreadId?: number | null
): Promise<void> {
  try {
    await api.sendMessage(userTelegramId, text);
  } catch (error) {
    logger.error({ err: error, userTelegramId }, "Could not message user");
    await notifyStaff(
      api,
      `Could not message user ${userTelegramId}: ${describeError(error)}`,
      messageThreadId
    );
  }
}

async function closeForumTopicSafely(api: BotApi, ticket: TicketRecord): Promise<void> {
  if (!ticket.staff_chat_id || !ticket.message_thread_id) {
    return;
  }

  try {
    await api.closeForumTopic(ticket.staff_chat_id, ticket.message_thread_id);
  } catch (error) {
    logger.warn({ err: error, ticketId: ticket.id }, "Could not close forum topic");
  }
}

function staffTicketKeyboard(ticketId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Close ticket", `ticket:close:${ticketId}`)
    .row()
    .text("Mark waiting user", `ticket:status:${ticketId}:WAITING_USER`)
    .row()
    .text("Mark in progress", `ticket:status:${ticketId}:IN_PROGRESS`)
    .row()
    .text("Ban user", `ticket:ban:${ticketId}`)
    .row()
    .text("Quick replies", quickRepliesOpenCallbackData(ticketId));
}

function quickRepliesOpenCallbackData(ticketId: number): string {
  return validateQuickRepliesCallbackData(`qr:open:${ticketId}`);
}

function quickRepliesCategoryCallbackData(ticketId: number, categoryId: string): string {
  return validateQuickRepliesCallbackData(`qr:category:${ticketId}:${categoryId}`);
}

function quickRepliesTemplateCallbackData(ticketId: number, templateId: string): string {
  return validateQuickRepliesCallbackData(`qr:template:${ticketId}:${templateId}`);
}

function quickRepliesPageCallbackData(ticketId: number, categoryId: string, page: number): string {
  return validateQuickRepliesCallbackData(`qr:page:${ticketId}:${categoryId}:${page}`);
}

function quickRepliesBackCallbackData(ticketId: number): string {
  return validateQuickRepliesCallbackData(`qr:back:${ticketId}`);
}

function quickRepliesCancelCallbackData(ticketId: number): string {
  return validateQuickRepliesCallbackData(`qr:cancel:${ticketId}`);
}

function validateQuickRepliesCallbackData(callbackData: string): string {
  const byteLength = Buffer.byteLength(callbackData, "utf8");
  if (byteLength > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error(
      `Quick Replies callback_data exceeds ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes (${byteLength} bytes): ${callbackData}`
    );
  }

  return callbackData;
}

function ticketBatchCancelCallbackData(previewToken: string): string {
  const callbackData = `batch:cancel:${previewToken}`;
  const byteLength = Buffer.byteLength(callbackData, "utf8");
  if (byteLength > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error(`Ticket batch callback_data exceeds ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes (${byteLength} bytes).`);
  }
  return callbackData;
}

function ticketBatchApplyCallbackData(previewToken: string): string {
  return validateTicketBatchCallbackData(`batch:apply:${previewToken}`);
}

function ticketBatchPageCallbackData(previewToken: string, page: number): string {
  return validateTicketBatchCallbackData(`batch:page:${previewToken}:${page}`);
}

function validateTicketBatchCallbackData(callbackData: string): string {
  const byteLength = Buffer.byteLength(callbackData, "utf8");
  if (byteLength > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error(`Ticket batch callback_data exceeds ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes (${byteLength} bytes).`);
  }
  return callbackData;
}

function isTicketAnswerPackageDocument(message: Message | undefined): boolean {
  if (!message || !("document" in message) || !message.document) {
    return false;
  }
  return /^ticket-answers_.+\.json$/i.test(message.document.file_name ?? "");
}

function ticketBatchPreviewKeyboard(previewToken: string, page: number, pageCount: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text("Previous", ticketBatchPageCallbackData(previewToken, page - 1));
  if (page + 1 < pageCount) keyboard.text("Next", ticketBatchPageCallbackData(previewToken, page + 1));
  return keyboard.row()
    .text("Apply", ticketBatchApplyCallbackData(previewToken))
    .text("Cancel", ticketBatchCancelCallbackData(previewToken));
}

function formatTicketBatchPreviewPage(pages: string[], page: number): string {
  const content = pages[page];
  if (content === undefined) {
    throw new TicketBatchValidationError("Ticket answer package preview page is not available.");
  }
  return `${content}\n\nPage ${page + 1}/${pages.length}`;
}

function formatTicketBatchExportCaption(
  exportId: string,
  zip: Pick<Awaited<ReturnType<typeof createTicketBatchZip>>, "ticketCount" | "messageCount" | "attachmentCount">
): string {
  return [
    "Ticket export ready",
    `Export: ${exportId}`,
    `Tickets: ${zip.ticketCount}`,
    `Messages: ${zip.messageCount}`,
    `Attachments: ${zip.attachmentCount}`,
    `Use the included instructions to prepare and return ticket-answers_${exportId}.json.`
  ].join("\n");
}

function userTicketKeyboard(ticketId: number): InlineKeyboard {
  return new InlineKeyboard().text("Close ticket", `user:close:${ticketId}`);
}

function formatSupportLogsTopicInfo(topic: SupportLogsTopicInfo): string {
  const lines = [
    "Support Logs topic",
    "",
    "Staff chat ID:",
    String(config.staffChatId),
    "",
    "Thread ID:",
    String(topic.threadId),
    "",
    "Status:",
    topic.state
  ];

  if (topic.previousThreadId !== null) {
    lines.push("", "Previous thread ID:", String(topic.previousThreadId));
  }

  return lines.join("\n");
}

function staffHelpSentSettingKey(): string {
  return `${STAFF_HELP_SENT_SETTING_PREFIX}:${config.staffChatId}`;
}

function topicName(ticketId: number, user: { id: number; username?: string }): string {
  const userLabel = user.username ? `@${user.username}` : `user_${user.id}`;
  return truncate(`#${ticketId} | ${userLabel}`, 128);
}

function staffActor(user: Context["from"]): ArchiveActor {
  if (!user) {
    return systemActor();
  }

  return {
    type: "STAFF",
    displayName: displayTelegramUser(user),
    username: usernameOf(user),
    telegramId: user.id
  };
}

function userActor(user: NonNullable<Context["from"]>): ArchiveActor {
  return {
    type: "USER",
    displayName: "user",
    username: usernameOf(user),
    telegramId: user.id
  };
}

function systemActor(): ArchiveActor {
  return {
    type: "SYSTEM",
    displayName: "system",
    username: null,
    telegramId: null
  };
}

function persistUserFromContext(db: SupportDatabase, ctx: Context): void {
  if (!ctx.from) {
    return;
  }

  db.upsertUser({
    telegramId: ctx.from.id,
    username: ctx.from.username ?? null,
    firstName: ctx.from.first_name ?? null,
    lastName: ctx.from.last_name ?? null
  });
}

async function replyIfBanned(db: SupportDatabase, ctx: Context): Promise<boolean> {
  if (!ctx.from || !isPrivateChat(ctx)) {
    return false;
  }

  const ban = db.getBannedUser(ctx.from.id);
  if (!ban) {
    return false;
  }

  await ctx.reply(BANNED_TEXT);
  return true;
}

function entityNotificationSettingKey(name: string): string {
  return `${ENTITY_NOTIFICATION_SETTING_PREFIX}:${name}`;
}

function parseStoredEntityNotificationTarget(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

async function formatEntityNotificationStatus(
  api: BotApi,
  db: SupportDatabase,
  providers: EntityNotificationProviderRegistry
): Promise<string> {
  const targetChatId = parseStoredEntityNotificationTarget(db.getSetting(entityNotificationSettingKey("target_chat_id")));
  let target = "not configured";
  let targetReachable = false;
  if (targetChatId !== null) {
    try {
      const chat = await api.getChat(targetChatId);
      targetReachable = true;
      const title = typeof chat === "object" && chat !== null && "title" in chat && typeof chat.title === "string"
        ? ` (${chat.title})`
        : "";
      target = `${targetChatId}${title}`;
    } catch {
      target = `${targetChatId} (unreachable)`;
    }
  }
  const providerKey = db.getSetting(entityNotificationSettingKey("provider"));
  const provider = providerKey ? providers.get(providerKey) : undefined;
  const providerRegistered = Boolean(provider);
  const providerAuthoritative = provider?.authoritative ?? false;
  const providerAvailable = provider ? isEntityNotificationProviderAvailable(provider) : false;
  const canPublish = db.getSetting(entityNotificationSettingKey("enabled")) === "true"
    && targetChatId !== null
    && targetReachable
    && providerRegistered
    && providerAuthoritative
    && providerAvailable;
  return [
    `Entity notifications: ${db.getSetting(entityNotificationSettingKey("enabled")) === "true" ? "enabled" : "disabled"}`,
    `Target: ${target}`,
    `Provider: ${providerKey ?? "not configured"}`,
    `Provider registered: ${providerRegistered ? "yes" : "no"}`,
    `Authoritative: ${providerAuthoritative ? "yes" : "no"}`,
    `Available: ${providerAvailable ? "yes" : "no"}`,
    `Publication can run: ${canPublish ? "yes" : "no"}`,
    `Published events: ${db.countEntityNotificationPublications("PUBLISHED")}`
  ].join("\n");
}

function isEntityNotificationProviderAvailable(provider: { isAvailable(): boolean }): boolean {
  try {
    return provider.isAvailable();
  } catch {
    return false;
  }
}

function entityNotificationProviderStatus(provider: { status?(): string }): string {
  try {
    return provider.status?.() || "That entity notification provider is unavailable.";
  } catch {
    return "That entity notification provider is unavailable.";
  }
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
    allowlist: db.getSetting(moderationSettingKey("allowlist"))
  });
  const managed = legacy.targetChatId === null ? undefined : db.getManagedPublicChat(legacy.targetChatId, true);
  if (managed?.active === 0) return { ...legacy, enabled: false, targetChatId: null };
  return managed ? {
    enabled: managed.moderation_enabled === 1,
    targetChatId: managed.chat_id,
    warningText: managed.warning_text,
    lookbackMinutes: managed.lookback_minutes,
    warningCooldownMinutes: managed.warning_cooldown_minutes,
    warningMessageThreshold: managed.warning_message_threshold,
    allowlist: managed.allowlist
  } : legacy;
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
      allowlist: managed.allowlist
    };
  }
  const legacy = moderationConfig(db);
  return legacy.targetChatId === chatId ? legacy : { ...legacy, enabled: false, targetChatId: null };
}

async function formatModerationStatus(
  db: SupportDatabase,
  moderation: ReturnType<typeof moderationConfig>,
  api: BotApi,
  botId: number | undefined
): Promise<string> {
  const pending = db.listLanguageModerationRecoveryJobs(config.staffChatId, new Date().toISOString()).length;
  const rights = await validateModerationRights(api, moderation.targetChatId, botId);
  return [
    `Moderation: ${moderation.enabled ? "enabled" : "disabled"}`,
    `Target: ${moderation.targetChatId ?? "not configured"}`,
    `Bot rights: ${rights}`,
    `Warning cooldown: ${moderation.warningCooldownMinutes} minutes and ${moderation.warningMessageThreshold} ordinary messages`,
    `Lookback: ${moderation.lookbackMinutes} minutes`,
    `Allowlist entries: ${moderation.allowlist.length}`,
    `Due cleanup/log recovery jobs: ${pending}`
  ].join("\n");
}

async function validateModerationRights(api: BotApi, targetChatId: number | null, botId: number | undefined): Promise<string> {
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
  now: () => Date,
  cleanupScheduler: ModerationCleanupScheduler
): Promise<void> {
  if (!ctx.chat || !ctx.from || !ctx.message || ctx.from.is_bot) return;
  const moderation = moderationConfigForChat(db, ctx.chat.id);
  if (!moderation.enabled || moderation.targetChatId !== ctx.chat.id || ctx.chat.id === config.staffChatId) return;
  const content = getMessageContent(ctx.message).text;
  const messageThreadId = typeof ctx.message.message_thread_id === "number" ? ctx.message.message_thread_id : null;
  const chatState = db.getLanguageModerationWarningState(ctx.chat.id, messageThreadId);
  db.upsertLanguageModerationWarningState(ctx.chat.id, messageThreadId, {
    lastWarningMessageId: chatState?.last_warning_message_id ?? null,
    lastWarningAt: chatState?.last_warning_at ?? null,
    ordinaryMessagesSinceWarning: (chatState?.ordinary_messages_since_warning ?? 0) + 1,
    pendingWarningDueAt: chatState?.pending_warning_due_at ?? null,
    pendingWarningStartedAt: chatState?.pending_warning_started_at ?? null
  });
  if (!content || isCommandText(content) || classifyEnglishOnlyMessage(content, moderation.allowlist) !== "violation") return;

  const state = db.getLanguageModerationUserState(ctx.chat.id, ctx.from.id) ?? { current_strikes: 0, sanction_tier: 0, first_strike_at: null };
  if (!db.addLanguageModerationViolation({ chat_id: ctx.chat.id, user_telegram_id: ctx.from.id, message_id: ctx.message.message_id, message_thread_id: messageThreadId, username: usernameOf(ctx.from), cycle_tier: state.sanction_tier })) return;
  if (state.current_strikes === 0) {
    const currentChatState = db.getLanguageModerationWarningState(ctx.chat.id, messageThreadId);
    const currentTime = now();
    const lastWarningAt = currentChatState?.last_warning_at ? Date.parse(currentChatState.last_warning_at) : 0;
    const canWarn = !lastWarningAt || (
      currentTime.getTime() - lastWarningAt >= moderation.warningCooldownMinutes * 60_000 &&
      (currentChatState?.ordinary_messages_since_warning ?? 0) >= moderation.warningMessageThreshold
    );
    if (canWarn) {
      if (!currentChatState?.pending_warning_due_at) {
        const startedAt = currentTime;
        const dueAt = new Date(startedAt.getTime() + 3_000);
        db.upsertLanguageModerationWarningState(ctx.chat.id, messageThreadId, { lastWarningMessageId: currentChatState?.last_warning_message_id ?? null, lastWarningAt: currentChatState?.last_warning_at ?? null, ordinaryMessagesSinceWarning: currentChatState?.ordinary_messages_since_warning ?? 0, pendingWarningStartedAt: startedAt.toISOString(), pendingWarningDueAt: dueAt.toISOString() });
        schedulePendingWarning(ctx.api, db, ctx.chat.id, messageThreadId, 3_000);
      }
    } else {
      db.upsertLanguageModerationUserState({ chat_id: ctx.chat.id, user_telegram_id: ctx.from.id, username: usernameOf(ctx.from), current_strikes: 1, sanction_tier: state.sanction_tier, first_strike_at: currentTime.toISOString() });
      await setModerationReaction(
        ctx.api,
        ctx.chat.id,
        ctx.message.message_id,
        MODERATION_STRIKE_REACTION
      );
    }
    return;
  }
  if (state.current_strikes === 1) {
    db.upsertLanguageModerationUserState({ chat_id: ctx.chat.id, user_telegram_id: ctx.from.id, username: usernameOf(ctx.from), current_strikes: 2, sanction_tier: state.sanction_tier, first_strike_at: state.first_strike_at });
    await setModerationReaction(
      ctx.api,
      ctx.chat.id,
      ctx.message.message_id,
      MODERATION_STRIKE_REACTION
    );
    return;
  }
  const tier = Math.min(state.sanction_tier, 2);
  try {
    await setModerationReaction(
      ctx.api,
      ctx.chat.id,
      ctx.message.message_id,
      MODERATION_SANCTION_REACTION
    );
    if (tier === 2) await ctx.api.banChatMember(ctx.chat.id, ctx.from.id);
    else await ctx.api.restrictChatMember(ctx.chat.id, ctx.from.id, { can_send_messages: false }, { until_date: Math.floor(now().getTime() / 1000) + (tier === 0 ? 86_400 : 604_800) });
    const nextTier = Math.min(3, state.sanction_tier + 1);
    const violationCycleId = randomUUID();
    db.assignLanguageModerationViolationCycle(ctx.chat.id, ctx.from.id, state.sanction_tier, violationCycleId);
    db.upsertLanguageModerationUserState({ chat_id: ctx.chat.id, user_telegram_id: ctx.from.id, username: usernameOf(ctx.from), current_strikes: 0, sanction_tier: nextTier, first_strike_at: null });
    const cleanupJobId = db.createLanguageModerationCleanupJob({ staff_chat_id: config.staffChatId, chat_id: ctx.chat.id, user_telegram_id: ctx.from.id, username: usernameOf(ctx.from) ?? null, chat_title: ("title" in ctx.chat ? ctx.chat.title : null) ?? null, sanction_tier: nextTier, sanction_kind: tier === 0 ? "24-hour mute" : tier === 1 ? "7-day mute" : "permanent ban", violation_cycle_id: violationCycleId, cleanup_due_at: new Date(now().getTime() + 10_000).toISOString() });
    cleanupScheduler(ctx.api, db, cleanupJobId);
  } catch (error) {
    const managed = db.getManagedPublicChat(ctx.chat.id);
    if (managed) {
      db.recordManagedPublicChatPermissionHealth({
        chatId: ctx.chat.id,
        healthy: false,
        reactionsAvailable: managed.reaction_status === "UNKNOWN" ? null : managed.reaction_status === "AVAILABLE"
      });
      db.setManagedPublicChatModerationEnabled(ctx.chat.id, false);
    } else {
      db.setSetting(moderationSettingKey("enabled"), "false");
    }
    logger.error({ chatId: ctx.chat.id, userId: ctx.from.id, err: error }, "Language moderation sanction failed; moderation disabled");
  }
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
        description: diagnostic.description
      },
      "Could not set moderation reaction"
    );
  }
}

function schedulePendingWarning(api: BotApi, db: SupportDatabase, chatId: number, messageThreadId: number | null, delayMs: number): void {
  const key = `${chatId}:${messageThreadId ?? 0}`;
  if (pendingWarningTimers.has(key)) return;
  const timer = setTimeout(() => {
    pendingWarningTimers.delete(key);
    void processPendingWarning(api, db, chatId, messageThreadId);
  }, delayMs);
  timer.unref();
  pendingWarningTimers.set(key, timer);
}

export async function processPendingWarning(api: BotApi, db: SupportDatabase, chatId: number, messageThreadId: number | null = null): Promise<void> {
  const state = db.getLanguageModerationWarningState(chatId, messageThreadId);
  if (!state?.pending_warning_due_at || Date.parse(state.pending_warning_due_at) > Date.now()) return;
  const moderation = moderationConfigForChat(db, chatId);
  if (!moderation.enabled || moderation.targetChatId !== chatId) return;
  const grouped = db.claimLanguageModerationFirstStrikes(chatId, new Date(Date.now() - moderation.lookbackMinutes * 60_000).toISOString(), messageThreadId);
  if (!grouped.length) {
    db.upsertLanguageModerationWarningState(chatId, messageThreadId, {
      lastWarningMessageId: state.last_warning_message_id,
      lastWarningAt: state.last_warning_at,
      ordinaryMessagesSinceWarning: state.ordinary_messages_since_warning,
      pendingWarningDueAt: null,
      pendingWarningStartedAt: null
    });
    return;
  }
  for (const user of grouped) {
    await setModerationReaction(api, chatId, user.messageId, MODERATION_STRIKE_REACTION);
  }
  if (state.last_warning_message_id) { try { await api.deleteMessage(chatId, state.last_warning_message_id); } catch {} }
  try {
    const warning = await api.sendMessage(chatId, moderation.warningText, messageThreadId === null ? {} : { message_thread_id: messageThreadId });
    db.upsertLanguageModerationWarningState(chatId, messageThreadId, { lastWarningMessageId: warning.message_id, lastWarningAt: new Date().toISOString(), ordinaryMessagesSinceWarning: 0, pendingWarningDueAt: null, pendingWarningStartedAt: null });
  } catch (error) {
    logger.warn({ chatId, err: error }, "Could not send pending language moderation warning");
  }
}

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

function isStaffChat(ctx: Context): boolean {
  const installation = installationServicesByContext.get(ctx);
  const staffChatId = installation?.getStaffChatId();
  if (staffChatId === null || staffChatId === undefined || ctx.chat?.id !== staffChatId) return false;
  if (!ctx.from) return false;
  return installation?.isStaffAuthorized(ctx.from.id, staffChatId) ?? false;
}

function hasApplicationPermission(ctx: Context, permission: Permission): boolean {
  if (!ctx.from) return false;
  const installation = installationServicesByContext.get(ctx);
  if (!installation) return false;
  return installation.getState().authorizationMode === "LEGACY_TRUSTED_GROUP" || installation.can(ctx.from.id, permission);
}

function isTicketStatus(value: string | undefined): value is TicketStatus {
  return value === "OPEN" || value === "WAITING_USER" || value === "IN_PROGRESS" || value === "CLOSED";
}

function parseTicketId(ctx: CommandContext<Context>): number | null {
  return parseUserId(ctx.match.trim());
}

function parseUserId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseQuickRepliesPage(value: string | undefined): number | null {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }

  const page = Number(value);
  return Number.isSafeInteger(page) ? page : null;
}

function parseBanCommand(ctx: CommandContext<Context>): BanCommand | null {
  const raw = ctx.match.trim();
  if (!raw) {
    return null;
  }

  const [rawUserId, ...reasonParts] = raw.split(/\s+/);
  const userId = parseUserId(rawUserId ?? "");
  if (!userId) {
    return null;
  }

  return {
    userId,
    reason: reasonParts.join(" ").trim() || DEFAULT_BAN_REASON
  };
}

function describeError(error: unknown): string {
  if (error instanceof GrammyError) {
    return `${error.error_code}: ${error.description}`;
  }

  if (error instanceof HttpError) {
    return `HTTP error: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isForumTopicUnavailable(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return (
    message.includes("message thread not found") ||
    message.includes("message_thread_id") ||
    message.includes("topic not found") ||
    message.includes("message to be replied not found") ||
    message.includes("reply message not found") ||
    message.includes("replied message not found")
  );
}

function isSqliteConstraint(error: unknown): error is ErrorWithCode {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as ErrorWithCode).code === "string" &&
    (error as ErrorWithCode).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function messageHasTextOrSupportedMedia(message: Message | undefined): boolean {
  if (!message) {
    return false;
  }

  const content = getMessageContent(message);
  return Boolean(content.text || content.mediaType);
}
