import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import type { CommandContext, Context } from "grammy";
import type { Message } from "grammy/types";
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
import { getMessageContent, isCommandText, usernameOf } from "./telegram.js";

const STAFF_ONLY_TEXT = "This command is only available for staff.";
const BANNED_TEXT = "You are currently restricted from opening support tickets.";
const DEFAULT_BAN_REASON = "No reason provided.";

type BotApi = Context["api"];

interface CloseTicketOptions {
  notifyUser?: boolean;
  userText?: string;
  staffNotice?: string;
  closeTopic?: boolean;
}

interface BanCommand {
  userId: number;
  reason: string;
}

interface ErrorWithCode extends Error {
  code?: string;
}

export function createBot(db: SupportDatabase): Bot<Context> {
  const bot = new Bot<Context>(config.botToken);

  bot.command("start", async (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }

    persistUserFromContext(db, ctx);
    if (await replyIfBanned(db, ctx)) {
      return;
    }

    await ctx.reply(START_TEXT);
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
      closeTopic: true
    });
    await ctx.reply(result);
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

    await banUserById(db, ctx.api, command.userId, command.reason, ctx.from?.id ?? null);
    await ctx.reply(`User ${command.userId} has been banned.`);
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

    const removed = db.unbanUser(userId);
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

    await ctx.answerCallbackQuery({ text: "Unknown action." });
  });

  bot.on("message", async (ctx) => {
    if (isStaffChat(ctx)) {
      await handleStaffGroupMessage(db, ctx);
      return;
    }

    if (!isPrivateChat(ctx)) {
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
    { command: "mytickets", description: "Show your recent tickets" }
  ]);

  await bot.api.setMyCommands(
    [
      { command: "chatid", description: "Show this chat id" },
      { command: "ticket", description: "Show ticket details" },
      { command: "close", description: "Close a ticket" },
      { command: "ban", description: "Ban a user from support" },
      { command: "unban", description: "Unban a user" },
      { command: "bans", description: "List banned users" },
      { command: "whois", description: "Show ticket user details" }
    ],
    { scope: { type: "chat", chat_id: config.staffChatId } }
  );
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
    text: content.text,
    mediaType: content.mediaType,
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
    await ctx.reply("Sorry, we could not create a support topic. Please try again later.");
    return;
  }

  const ticketWithTopic = db.getTicketWithUser(ticket.id);
  if (!ticketWithTopic?.message_thread_id) {
    db.updateTicketStatus(ticket.id, "CLOSED");
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
    db.linkStaffMessage(ticket.id, summary.chat.id, summary.message_id, "ticket_summary");
    await pinMessageSafely(ctx.api, summary.chat.id, summary.message_id, ticket.id);

    const intro = await ctx.api.sendMessage(
      config.staffChatId,
      formatTicketPost(ticketWithTopic, content.text),
      {
        message_thread_id: messageThreadId
      }
    );
    db.linkStaffMessage(ticket.id, intro.chat.id, intro.message_id, "ticket_intro");
  } catch (error) {
    logger.error({ err: error, ticketId: ticket.id }, "Could not send ticket intro to staff topic");
    db.updateTicketStatus(ticket.id, "CLOSED");
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
      db.updateTicketStatus(activeTicket.id, "CLOSED");
    }
    await createFreshTicketFromUserMessage(db, ctx);
    return;
  }

  const content = getMessageContent(ctx.message);
  const ticket =
    activeTicket.status === "WAITING_USER"
      ? { ...activeTicket, status: "OPEN" as const }
      : activeTicket;

  try {
    const sent = await ctx.api.sendMessage(
      config.staffChatId,
      formatTicketUpdate(ticket, ctx.from, content.text),
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
      text: content.text,
      mediaType: content.mediaType,
      fileId: content.fileId
    });

    if (activeTicket.status === "WAITING_USER") {
      db.updateTicketStatus(activeTicket.id, "OPEN");
    }

    db.linkStaffMessage(activeTicket.id, sent.chat.id, sent.message_id, "user_update");

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
      db.updateTicketStatus(activeTicket.id, "CLOSED");
      await createFreshTicketFromUserMessage(db, ctx);
      return;
    }

    logger.error({ err: error, ticketId: activeTicket.id }, "Could not notify staff about user update");
    await ctx.reply("Sorry, we could not route your update to support. Please try again later.");
    return;
  }

  await ctx.reply(
    `We added your message to your existing ticket #${activeTicket.id}. Our support team will get back to you soon.`,
    {
      reply_markup: userTicketKeyboard(activeTicket.id)
    }
  );
}

async function handleStaffGroupMessage(db: SupportDatabase, ctx: Context): Promise<void> {
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

  db.linkStaffMessage(ticket.id, ctx.chat.id, ctx.message.message_id, "staff_topic_message");

  if (ticket.status === "CLOSED") {
    await sendStaffTopicNotice(ctx.api, ticket, `Ticket #${ticket.id} is closed. The reply was not sent to the user.`);
    return;
  }

  const content = getMessageContent(ctx.message);

  try {
    const delivered = await ctx.api.copyMessage(
      ticket.user_telegram_id,
      ctx.chat.id,
      ctx.message.message_id
    );

    db.addMessage({
      ticketId: ticket.id,
      direction: "STAFF_TO_USER",
      sourceChatId: ctx.chat.id,
      sourceMessageId: ctx.message.message_id,
      deliveryChatId: ticket.user_telegram_id,
      deliveryMessageId: delivered.message_id,
      fromTelegramId: ctx.from?.id ?? null,
      fromUsername: usernameOf(ctx.from),
      text: content.text,
      mediaType: content.mediaType,
      fileId: content.fileId
    });

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
    closeTopic: true
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
      closeTopic: true
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
    await banUserForTicket(db, ctx.api, ticket, ctx.from?.id ?? null, `Banned from ticket #${ticket.id}`);
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
  bannedBy: number | null
): Promise<void> {
  const user = db.getUser(userId);
  db.banUser({
    userTelegramId: userId,
    username: user?.username ?? null,
    reason,
    bannedBy
  });

  const activeTicket = db.findActiveTicketForUser(userId, config.staffChatId);
  let activeTicketWithUser: TicketWithUser | undefined;
  if (activeTicket) {
    const ticket = db.getTicketWithUser(activeTicket.id);
    if (ticket) {
      activeTicketWithUser = ticket;
      await closeTicket(db, api, ticket.id, {
        notifyUser: false,
        staffNotice: `User ${userId} was banned. Reason: ${reason}`,
        closeTopic: false
      });
      db.closeOtherActiveTicketsForUserInStaffChat(userId, config.staffChatId, ticket.id);
    }
  }

  await notifyUserOrStaff(api, userId, BANNED_TEXT, activeTicket?.message_thread_id ?? null);
  if (activeTicketWithUser) {
    await closeForumTopicSafely(api, activeTicketWithUser);
  }
}

async function banUserForTicket(
  db: SupportDatabase,
  api: BotApi,
  ticket: TicketWithUser,
  bannedBy: number | null,
  reason: string
): Promise<void> {
  db.banUser({
    userTelegramId: ticket.user_telegram_id,
    username: ticket.username,
    reason,
    bannedBy
  });

  db.updateTicketStatus(ticket.id, "CLOSED");
  db.closeOtherActiveTicketsForUserInStaffChat(ticket.user_telegram_id, config.staffChatId, ticket.id);
  await refreshStaffTicketMessage(db, api, ticket.id);
  await sendStaffTopicNotice(
    api,
    ticket,
    `User ${ticket.user_telegram_id} has been banned. Reason: ${reason}`
  );
  await notifyUserOrStaff(api, ticket.user_telegram_id, BANNED_TEXT, ticket.message_thread_id);
  await closeForumTopicSafely(api, ticket);
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
    return `Ticket #${ticketId} is already closed.`;
  }

  const closedTicket = db.updateTicketStatus(ticketId, "CLOSED");
  await refreshStaffTicketMessage(db, api, ticketId);

  if (options.staffNotice) {
    await sendStaffTopicNotice(api, ticket, options.staffNotice);
  }

  if (options.notifyUser) {
    await notifyUserOrStaff(api, ticket.user_telegram_id, options.userText ?? CLOSED_TEXT, ticket.message_thread_id);
  }

  if (options.closeTopic) {
    await closeForumTopicSafely(api, ticket);
  }

  return `Ticket #${closedTicket?.id ?? ticketId} closed.`;
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
    const copied = await ctx.api.copyMessage(config.staffChatId, ctx.chat.id, ctx.message.message_id, {
      message_thread_id: ticket.message_thread_id
    });
    db.linkStaffMessage(ticket.id, config.staffChatId, copied.message_id, "user_original_copy");
  } catch (error) {
    logger.error({ err: error, ticketId: ticket.id }, "Could not copy original user message to staff topic");
    await sendStaffTopicNotice(
      ctx.api,
      ticket,
      `Ticket #${ticket.id} was created, but the attachment could not be copied: ${describeError(error)}`
    );
  }
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
    .text("Ban user", `ticket:ban:${ticketId}`);
}

function userTicketKeyboard(ticketId: number): InlineKeyboard {
  return new InlineKeyboard().text("Close ticket", `user:close:${ticketId}`);
}

function topicName(ticketId: number, user: { id: number; username?: string }): string {
  const userLabel = user.username ? `@${user.username}` : `user_${user.id}`;
  return truncate(`#${ticketId} | ${userLabel}`, 128);
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
