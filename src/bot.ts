import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile } from "grammy";
import { randomUUID } from "node:crypto";
import type { CommandContext, Context } from "grammy";
import type { Message, User } from "grammy/types";
import {
  archiveTicketIfPossible,
  getSupportLogsTopicInfo,
  logBanEvent,
  setSupportLogsTopicOverride,
  type SupportLogsTopicInfo,
  type ArchiveActor
} from "./archive.js";
import { config } from "./config.js";
import { SupportDatabase, type TicketRecord, type TicketStatus, type TicketWithUser } from "./db.js";
import {
  CLOSED_TEXT,
  RECEIVED_TEXT,
  START_TEXT,
  formatPinnedTicketSummary,
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

const STAFF_ONLY_TEXT = "This command is only available for staff.";
const BANNED_TEXT = "You are currently restricted from opening support tickets.";
const DEFAULT_BAN_REASON = "No reason provided.";
const STAFF_HELP_SENT_SETTING_PREFIX = "staff_help_sent";
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const MODERATION_SETTING_PREFIX = "language_moderation";
const ENTITY_NOTIFICATION_SETTING_PREFIX = "entity_notifications";
const pendingWarningTimers = new Map<number, ReturnType<typeof setTimeout>>();

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
  "/questnotify <subcommand> - configure new-entity notifications"
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
}

export function createBot(
  db: SupportDatabase,
  quickRepliesRegistry: QuickRepliesRegistry,
  runtime: BotRuntimeDependencies = {}
): Bot<Context> {
  const bot = new Bot<Context>(config.botToken);
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  const moderationNow = runtime.now ?? (() => new Date());
  const moderationCleanupScheduler = runtime.scheduleModerationCleanup ?? scheduleModerationCleanup;
  const entityNotificationProviders = runtime.entityNotificationProviders ?? new Map();
  const runningTicketBatchExports = new Set<number>();

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

  bot.command("start", async (ctx) => {
    if (!isPrivateChat(ctx)) { await handlePublicLanguageModeration(db, ctx, moderationNow, moderationCleanupScheduler); return; }

    persistUserFromContext(db, ctx);
    if (await replyIfBanned(db, ctx)) {
      return;
    }

    await ctx.reply(START_TEXT);
  });

  bot.command("help", async (ctx) => {
    if (isPrivateChat(ctx)) {
      await ctx.reply(USER_HELP_TEXT);
      return;
    }

    if (!isStaffChat(ctx)) {
      return;
    }

    await ctx.reply(STAFF_HELP_TEXT, {
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

    const topic = await getSupportLogsTopicInfo(ctx.api, db);
    await ctx.reply(formatSupportLogsTopicInfo(topic), {
      message_thread_id: ctx.message?.message_thread_id
    });
  });

  bot.command("exporttickets", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (typeof ctx.message?.message_thread_id === "number") {
      await ctx.reply("Please run /exporttickets outside ticket topics.");
      return;
    }

    if (runningTicketBatchExports.has(config.staffChatId)) {
      await ctx.reply("An export is already running for this staff chat.");
      return;
    }

    runningTicketBatchExports.add(config.staffChatId);
    let zip: Awaited<ReturnType<typeof createTicketBatchZip>> | undefined;
    let exportId: string | undefined;
    let deliveryAttempted = false;
    try {
      const tickets = db.listActiveTicketsForStaffChat(config.staffChatId).map((ticket) => ({
        ticket,
        messages: db.listMessagesChronological(ticket.id)
      }));
      if (!tickets.length) {
        await ctx.reply("There are no active tickets to export.");
        return;
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
      const delivered = await ctx.api.sendDocument(config.staffChatId, new InputFile(zip.filePath, zip.filename), {
        caption: formatTicketBatchExportCaption(exportId, zip)
      });
      try {
        db.markTicketBatchExportDelivered(exportId, config.staffChatId, delivered.message_id);
      } catch (error) {
        logger.error({ err: error, exportId }, "Ticket batch export delivery could not be persisted");
        await ctx.reply("Export delivery could not be confirmed. Do not upload an answer package for it.");
      }
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
  });

  bot.command("moderation", async (ctx) => {
    if (!isStaffChat(ctx)) { if (isPrivateChat(ctx)) await ctx.reply(STAFF_ONLY_TEXT); return; }
    const [, action = "status", ...args] = (ctx.message?.text ?? "").trim().split(/\s+/);
    const current = moderationConfig(db);
    if (action === "status") { await ctx.reply(await formatModerationStatus(db, current, ctx.api, bot.botInfo?.id)); return; }
    if (action === "target") {
      const chatId = Number(args[0]);
      if (!Number.isSafeInteger(chatId)) { await ctx.reply("Usage: /moderation target <chat_id>"); return; }
      try { await ctx.api.getChat(chatId); } catch { await ctx.reply("The target chat is not reachable by this bot."); return; }
      db.setSetting(moderationSettingKey("target"), String(chatId));
      await ctx.reply(`Moderation target set to ${chatId}. It remains disabled until /moderation enable succeeds.`);
      return;
    }
    if (action === "enable") {
      const rights = await validateModerationRights(ctx.api, current.targetChatId, bot.botInfo?.id);
      if (rights !== "ok") { await ctx.reply(`Moderation remains disabled: ${rights}`); return; }
      db.setSetting(moderationSettingKey("enabled"), "true"); await ctx.reply("English-only moderation is enabled."); return;
    }
    if (action === "disable") { db.setSetting(moderationSettingKey("enabled"), "false"); await ctx.reply("Moderation disabled. Existing strikes and tiers were preserved."); return; }
    if (action === "allowlist") { await ctx.reply(current.allowlist.length ? `Allowlist (${current.allowlist.length}): ${current.allowlist.join(", ")}` : "Allowlist is empty."); return; }
    if (action === "allow" || action === "unallow") {
      const term = args.join(" ").trim().toLowerCase();
      if (!term || term.length > 80) { await ctx.reply(`Usage: /moderation ${action} <term up to 80 characters>`); return; }
      const entries = new Set(current.allowlist);
      if (action === "allow") entries.add(term); else entries.delete(term);
      db.setSetting(moderationSettingKey("allowlist"), JSON.stringify([...entries].sort()));
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
      await handleTicketBatchCallback(ctx, data);
      return;
    }

    await ctx.answerCallbackQuery({ text: "Unknown action." });
  });

  bot.on("message", async (ctx) => {
    if (isStaffChat(ctx)) {
      if (isTicketAnswerPackageDocument(ctx.message)) {
        if (typeof ctx.message.message_thread_id === "number") {
          await ctx.reply("Upload ticket answer packages outside ticket topics.");
          return;
        }
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

    if (await replyIfBanned(db, ctx)) {
      return;
    }

    if (ctx.message && "text" in ctx.message && isCommandText(ctx.message.text)) {
      await ctx.reply(START_TEXT);
      return;
    }

    await handlePrivateUserMessage(db, ctx);
  });

  async function handleTicketAnswerPackageUpload(ctx: Context): Promise<void> {
    const document = ctx.message && "document" in ctx.message ? ctx.message.document : undefined;
    if (!document || !ctx.chat) {
      return;
    }
    if (typeof document.file_size === "number" && document.file_size > 5 * 1024 * 1024) {
      await ctx.reply("Ticket answer packages must be 5 MiB or smaller.");
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
        return;
      }
      const previewMessage = await ctx.reply(text, { reply_markup: keyboard });
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
      logger.info({ exportId, previewMessageId: previewMessage.message_id }, "Ticket answer package preview created");
    } catch (error) {
      const message = error instanceof TicketBatchValidationError ? error.message : "Could not validate the ticket answer package.";
      logger.warn("Ticket answer package validation failed");
      await ctx.reply(message);
    }
  }

  async function handleTicketBatchCallback(ctx: Context, data: string): Promise<void> {
    if (!isStaffChat(ctx)) {
      await ctx.answerCallbackQuery({ text: "Staff only.", show_alert: true });
      return;
    }
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
      await deleteTicketBatchPreview(packageRecord, "Package cancelled.");
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

    await ctx.answerCallbackQuery({ text: "Applying answer package..." });
    const previewRemoved = await deleteTicketBatchPreview(claimed, "Applying...");
    const summary = await applyTicketBatchAnswerPackage(claimed.answer_package_id, ctx.from);
    if (!previewRemoved) {
      await deleteTicketBatchPreview(claimed, "Applying...");
    }
    await ctx.api.sendMessage(config.staffChatId, summary);
  }

  function buildStoredTicketBatchPreviewPages(packageRecord: ReturnType<SupportDatabase["getTicketBatchAnswerPackage"]>): string[] {
    if (!packageRecord) {
      throw new TicketBatchValidationError("Ticket answer package not found.");
    }
    const answerPackage: TicketAnswerPackage = {
      schema: "telegram_ticket_answer_package",
      version: 1,
      export_id: packageRecord.export_id,
      answer_package_id: packageRecord.answer_package_id,
      created_at: packageRecord.package_created_at,
      answers: db.listTicketBatchAnswerItems(packageRecord.answer_package_id).map((item) => ({
        ticket_id: item.ticket_id,
        snapshot_token: item.snapshot_token,
        action: item.action,
        reply_text: item.reply_text
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

  async function deleteTicketBatchPreview(packageRecord: NonNullable<ReturnType<SupportDatabase["getTicketBatchAnswerPackage"]>>, fallbackText: string): Promise<boolean> {
    if (packageRecord.preview_chat_id === null || packageRecord.preview_message_id === null) {
      return true;
    }
    try {
      await bot.api.deleteMessage(packageRecord.preview_chat_id, packageRecord.preview_message_id);
      db.clearTicketBatchAnswerPackagePreview(packageRecord.answer_package_id, config.staffChatId);
      return true;
    } catch (error) {
      logger.warn({ err: error, answerPackageId: packageRecord.answer_package_id }, "Could not delete ticket batch preview");
      try {
        await bot.api.editMessageText(packageRecord.preview_chat_id, packageRecord.preview_message_id, fallbackText, { reply_markup: undefined });
      } catch (editError) {
        logger.warn({ err: editError, answerPackageId: packageRecord.answer_package_id }, "Could not neutralize ticket batch preview");
      }
      return false;
    }
  }

  async function applyTicketBatchAnswerPackage(answerPackageId: string, staffUser: User | undefined): Promise<string> {
    const packageRecord = db.getTicketBatchAnswerPackage(answerPackageId, config.staffChatId);
    if (!packageRecord) return "Answer package not found.";
    const exportItems = db.listTicketBatchExportItems(packageRecord.export_id);
    const exportTokens = new Map(exportItems.map((item) => [item.ticket_id, item.snapshot_token]));
    const items = db.listTicketBatchAnswerItems(answerPackageId);
    const totals = { keep: 0, close: 0, noAction: 0, stale: 0, inactive: 0, failed: 0, unknown: 0, replySent: 0, skipped: 0 };

    for (const item of items) {
      if (["COMPLETED", "NO_ACTION", "STALE", "INACTIVE"].includes(item.state)) { totals.skipped += 1; continue; }
      if (item.state === "UNKNOWN_DELIVERY" || item.state === "APPLYING") { db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "UNKNOWN_DELIVERY", { lastError: "Delivery outcome requires manual review." }); totals.unknown += 1; continue; }
      const ticket = db.getTicketWithUser(item.ticket_id);
      if (item.state === "REPLY_SENT" && item.action === "reply_and_close") {
        if (!ticket || ticket.staff_chat_id !== config.staffChatId) {
          db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "INACTIVE", { applied: true });
          totals.inactive += 1;
          continue;
        }

        try {
          const result = await closeTicket(db, bot.api, ticket.id, {
            notifyUser: true,
            staffNotice: "Ticket closed by batch answer.",
            closedBy: staffActor(staffUser)
          });
          if (result.includes("pending retry")) {
            db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "REPLY_SENT", { lastError: "Reply sent; close/archive pending." });
            totals.replySent += 1;
          } else {
            db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "COMPLETED", { applied: true });
            totals.close += 1;
          }
        } catch {
          db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "REPLY_SENT", { lastError: "Reply sent; close/archive pending." });
          totals.replySent += 1;
        }
        continue;
      }
      const expectedToken = exportTokens.get(item.ticket_id);
      if (!ticket || ticket.staff_chat_id !== config.staffChatId || ticket.status === "CLOSED") { db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "INACTIVE", { applied: true }); totals.inactive += 1; continue; }
      if (!expectedToken || item.snapshot_token !== expectedToken || getTicketSnapshotToken(ticket, db.listMessagesChronological(ticket.id)) !== expectedToken) { db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "STALE", { applied: true }); totals.stale += 1; continue; }
      if (!db.claimTicketBatchAnswerItem(answerPackageId, item.ticket_id)) { totals.skipped += 1; continue; }
      if (item.action === "no_action") { db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "NO_ACTION", { applied: true }); totals.noAction += 1; continue; }
      try {
        const deliveryMessageId = await deliverAndRecordStaffTextReply(ticket, item.reply_text ?? "", staffUser);
        if (item.action === "reply_keep_open") {
          db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "COMPLETED", { deliveryMessageId, applied: true });
          if (ticket.status === "OPEN") {
            db.updateTicketStatus(ticket.id, "IN_PROGRESS");
            try {
              await refreshStaffTicketMessage(db, bot.api, ticket.id);
            } catch (error) {
              logger.warn({ err: error, ticketId: ticket.id }, "Could not refresh ticket summary after batch reply");
            }
          }
          totals.keep += 1;
          continue;
        }
        db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "REPLY_SENT", { deliveryMessageId, applied: true });
        try {
          const closeResult = await closeTicket(db, bot.api, ticket.id, { notifyUser: true, staffNotice: "Ticket closed by batch answer.", closedBy: staffActor(staffUser) });
          if (closeResult.includes("pending retry")) { db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "REPLY_SENT", { lastError: "Reply sent; close/archive pending." }); totals.replySent += 1; } else { db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "COMPLETED", { applied: true }); totals.close += 1; }
        } catch {
          db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "REPLY_SENT", { lastError: "Reply sent; close/archive pending." });
          totals.replySent += 1;
        }
      } catch (error) { db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "FAILED", { lastError: "Ticket batch action failed." }); totals.failed += 1; }
    }
    db.finalizeTicketBatchAnswerPackage(answerPackageId, config.staffChatId);
    return `Answer package applied\nReplies sent: ${totals.keep + totals.close}\nTickets closed: ${totals.close}\nKept open: ${totals.keep}\nNo action: ${totals.noAction}\nBlocked: stale ${totals.stale}, inactive ${totals.inactive}, failed ${totals.failed}, manual review ${totals.unknown + totals.replySent}.`;
  }

  bot.catch(async (error) => {
    const ctx = error.ctx;
    logger.error(
      { err: error.error, updateId: ctx.update.update_id },
      "Bot failed while processing an update"
    );

    if (ctx.chat?.id === config.staffChatId) {
      await notifyStaff(
        ctx.api,
        `Bot error while processing update ${ctx.update.update_id}: ${describeError(error.error)}`,
        ctx.msg?.message_thread_id
      );
    }
  });

  return bot;
}

export async function setBotCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Start support" },
    { command: "status", description: "Show your latest ticket status" },
    { command: "mytickets", description: "Show your recent tickets" },
    { command: "help", description: "Show help" }
  ]);

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
    { scope: { type: "chat", chat_id: config.staffChatId } }
  );
}

export async function sendStaffOnboardingIfNeeded(api: BotApi, db: SupportDatabase): Promise<void> {
  const settingKey = staffHelpSentSettingKey();
  if (db.getSetting(settingKey) === "true") {
    return;
  }

  try {
    await api.sendMessage(config.staffChatId, STAFF_ONBOARDING_TEXT);
    db.setSetting(settingKey, "true");
  } catch (error) {
    logger.warn(
      { err: error, staffChatId: config.staffChatId },
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
      db.updateTicketStatus(activeTicket.id, "OPEN");
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
    const result = await closeTicket(db, ctx.api, ticket.id, {
      notifyUser: true,
      staffNotice: "Ticket closed by staff.",
      closedBy: staffActor(ctx.from)
    });
    await ctx.answerCallbackQuery({ text: result });
    return;
  }

  if (action === "status" && isTicketStatus(rawStatus)) {
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
    const archived = await archiveTicketIfPossible(api, db, ticketId);
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

  const archived = await archiveTicketIfPossible(api, db, ticketId);

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
    `Upload this ZIP to ChatGPT and return ticket-answers_${exportId}.json.`
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
  return parseModerationConfig({
    enabled: db.getSetting(moderationSettingKey("enabled")),
    target: db.getSetting(moderationSettingKey("target")),
    warning_text: db.getSetting(moderationSettingKey("warning_text")),
    lookback_minutes: db.getSetting(moderationSettingKey("lookback_minutes")),
    warning_cooldown_minutes: db.getSetting(moderationSettingKey("warning_cooldown_minutes")),
    warning_message_threshold: db.getSetting(moderationSettingKey("warning_message_threshold")),
    allowlist: db.getSetting(moderationSettingKey("allowlist"))
  });
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
    await api.getChat(targetChatId);
    const member = await api.getChatMember(targetChatId, botId);
    if (member.status !== "administrator" && member.status !== "creator") return "the bot is not an administrator in the target chat.";
    const capabilities = member as { can_delete_messages?: boolean; can_restrict_members?: boolean };
    const missing = [
      !capabilities.can_delete_messages ? "delete messages" : null,
      !capabilities.can_restrict_members ? "restrict and ban members" : null
    ].filter((entry): entry is string => Boolean(entry));
    return missing.length ? `missing required rights: ${missing.join(", ")}.` : "ok";
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
  const moderation = moderationConfig(db);
  if (!moderation.enabled || moderation.targetChatId !== ctx.chat.id || ctx.chat.id === config.staffChatId) return;
  const content = getMessageContent(ctx.message).text;
  const chatState = db.getLanguageModerationChatState(ctx.chat.id);
  db.upsertLanguageModerationChatState(ctx.chat.id, {
    lastWarningMessageId: chatState?.last_warning_message_id ?? null,
    lastWarningAt: chatState?.last_warning_at ?? null,
    ordinaryMessagesSinceWarning: (chatState?.ordinary_messages_since_warning ?? 0) + 1,
    pendingWarningDueAt: chatState?.pending_warning_due_at ?? null,
    pendingWarningStartedAt: chatState?.pending_warning_started_at ?? null
  });
  if (!content || isCommandText(content) || classifyEnglishOnlyMessage(content, moderation.allowlist) !== "violation") return;

  const state = db.getLanguageModerationUserState(ctx.chat.id, ctx.from.id) ?? { current_strikes: 0, sanction_tier: 0, first_strike_at: null };
  if (!db.addLanguageModerationViolation({ chat_id: ctx.chat.id, user_telegram_id: ctx.from.id, message_id: ctx.message.message_id, username: usernameOf(ctx.from), cycle_tier: state.sanction_tier })) return;
  if (state.current_strikes === 0) {
    const currentChatState = db.getLanguageModerationChatState(ctx.chat.id);
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
        db.upsertLanguageModerationChatState(ctx.chat.id, { lastWarningMessageId: currentChatState?.last_warning_message_id ?? null, lastWarningAt: currentChatState?.last_warning_at ?? null, ordinaryMessagesSinceWarning: currentChatState?.ordinary_messages_since_warning ?? 0, pendingWarningStartedAt: startedAt.toISOString(), pendingWarningDueAt: dueAt.toISOString() });
        schedulePendingWarning(ctx.api, db, ctx.chat.id, 3_000);
      }
    } else {
      db.upsertLanguageModerationUserState({ chat_id: ctx.chat.id, user_telegram_id: ctx.from.id, username: usernameOf(ctx.from), current_strikes: 1, sanction_tier: state.sanction_tier, first_strike_at: currentTime.toISOString() });
      await setModerationReaction(ctx, "⚠️");
    }
    return;
  }
  if (state.current_strikes === 1) {
    db.upsertLanguageModerationUserState({ chat_id: ctx.chat.id, user_telegram_id: ctx.from.id, username: usernameOf(ctx.from), current_strikes: 2, sanction_tier: state.sanction_tier, first_strike_at: state.first_strike_at });
    await setModerationReaction(ctx, "⚠️");
    return;
  }
  const tier = Math.min(state.sanction_tier, 2);
  try {
    await setModerationReaction(ctx, "🚫");
    if (tier === 2) await ctx.api.banChatMember(ctx.chat.id, ctx.from.id);
    else await ctx.api.restrictChatMember(ctx.chat.id, ctx.from.id, { can_send_messages: false }, { until_date: Math.floor(now().getTime() / 1000) + (tier === 0 ? 86_400 : 604_800) });
    const nextTier = Math.min(3, state.sanction_tier + 1);
    db.upsertLanguageModerationUserState({ chat_id: ctx.chat.id, user_telegram_id: ctx.from.id, username: usernameOf(ctx.from), current_strikes: 0, sanction_tier: nextTier, first_strike_at: null });
    const cleanupJobId = db.createLanguageModerationCleanupJob({ staff_chat_id: config.staffChatId, chat_id: ctx.chat.id, user_telegram_id: ctx.from.id, username: usernameOf(ctx.from) ?? null, chat_title: ("title" in ctx.chat ? ctx.chat.title : null) ?? null, sanction_tier: nextTier, sanction_kind: tier === 0 ? "24-hour mute" : tier === 1 ? "7-day mute" : "permanent ban", cleanup_due_at: new Date(now().getTime() + 10_000).toISOString() });
    cleanupScheduler(ctx.api, db, cleanupJobId);
  } catch (error) {
    db.setSetting(moderationSettingKey("enabled"), "false");
    logger.error({ chatId: ctx.chat.id, userId: ctx.from.id, err: error }, "Language moderation sanction failed; moderation disabled");
  }
}

async function setModerationReaction(ctx: Context, emoji: "⚠️" | "🚫"): Promise<void> {
  if (!ctx.chat || !ctx.message) return;
  try {
    // Telegram supports these reactions, while the installed grammY type union lags them.
    await ctx.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: "emoji", emoji: emoji as never }]);
  } catch (error) { logger.warn({ chatId: ctx.chat.id, messageId: ctx.message.message_id, err: error }, "Could not set moderation reaction"); }
}

function schedulePendingWarning(api: BotApi, db: SupportDatabase, chatId: number, delayMs: number): void {
  if (pendingWarningTimers.has(chatId)) return;
  const timer = setTimeout(() => {
    pendingWarningTimers.delete(chatId);
    void processPendingWarning(api, db, chatId);
  }, delayMs);
  timer.unref();
  pendingWarningTimers.set(chatId, timer);
}

export async function processPendingWarning(api: BotApi, db: SupportDatabase, chatId: number): Promise<void> {
  const state = db.getLanguageModerationChatState(chatId);
  if (!state?.pending_warning_due_at || Date.parse(state.pending_warning_due_at) > Date.now()) return;
  const moderation = moderationConfig(db);
  if (!moderation.enabled || moderation.targetChatId !== chatId) return;
  const grouped = db.claimLanguageModerationFirstStrikes(chatId, new Date(Date.now() - moderation.lookbackMinutes * 60_000).toISOString());
  if (!grouped.length) return;
  for (const user of grouped) {
    try { await api.setMessageReaction(chatId, user.messageId, [{ type: "emoji", emoji: "⚠️" as never }]); } catch {}
  }
  if (state.last_warning_message_id) { try { await api.deleteMessage(chatId, state.last_warning_message_id); } catch {} }
  try {
    const warning = await api.sendMessage(chatId, moderation.warningText);
    db.upsertLanguageModerationChatState(chatId, { lastWarningMessageId: warning.message_id, lastWarningAt: new Date().toISOString(), ordinaryMessagesSinceWarning: 0, pendingWarningDueAt: null, pendingWarningStartedAt: null });
  } catch (error) {
    logger.warn({ chatId, err: error }, "Could not send pending language moderation warning");
  }
}

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

function isStaffChat(ctx: Context): boolean {
  return ctx.chat?.id === config.staffChatId;
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
