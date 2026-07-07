import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import type { CommandContext, Context } from "grammy";
import type { Message } from "grammy/types";
import { config } from "./config.js";
import { SupportDatabase, type TicketRecord, type TicketStatus } from "./db.js";
import {
  CLOSED_TEXT,
  RECEIVED_TEXT,
  START_TEXT,
  formatStatus,
  formatTicketDetails,
  formatTicketPost,
  formatTicketUpdate,
  formatUserTicketList,
  truncate
} from "./format.js";
import { logger } from "./logger.js";
import { getMessageContent, isCommandText, usernameOf } from "./telegram.js";

const STAFF_ONLY_TEXT = "This command is only available in the staff group.";

type BotApi = Context["api"];

export function createBot(db: SupportDatabase): Bot<Context> {
  const bot = new Bot<Context>(config.botToken);

  bot.command("start", async (ctx) => {
    if (!isPrivateChat(ctx)) {
      return;
    }

    persistUserFromContext(db, ctx);
    await ctx.reply(START_TEXT);
  });

  bot.command("chatid", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    await ctx.reply(`Chat ID: ${ctx.chat.id}`);
  });

  bot.command("status", async (ctx) => {
    if (!isPrivateChat(ctx) || !ctx.from) {
      return;
    }

    persistUserFromContext(db, ctx);
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

    const sent = await ctx.reply(formatTicketDetails(ticket, db.listMessages(ticketId, 8)), {
      reply_markup: ticket.status === "CLOSED" ? undefined : ticketKeyboard(ticket.id),
      reply_parameters: ctx.msg ? { message_id: ctx.msg.message_id } : undefined
    });
    db.linkStaffMessage(ticket.id, sent.chat.id, sent.message_id, "staff_lookup");
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

    const result = await closeTicket(db, ctx.api, ticketId, ctx.msg?.message_id);
    await ctx.reply(result, {
      reply_parameters: ctx.msg ? { message_id: ctx.msg.message_id } : undefined
    });
  });

  bot.on("callback_query:data", async (ctx) => {
    if (!isStaffChat(ctx)) {
      await ctx.answerCallbackQuery({
        text: "Staff only.",
        show_alert: true
      });
      return;
    }

    const data = ctx.callbackQuery.data;
    const [namespace, action, rawTicketId, rawStatus] = data.split(":");
    if (namespace !== "ticket") {
      return;
    }

    const ticketId = Number(rawTicketId);
    if (!Number.isInteger(ticketId)) {
      await ctx.answerCallbackQuery({ text: "Invalid ticket." });
      return;
    }

    if (action === "close") {
      const ticket = db.getTicket(ticketId);
      if (!ticket || ticket.staff_chat_id !== config.staffChatId) {
        await ctx.answerCallbackQuery({ text: "Ticket not found in this staff chat." });
        return;
      }

      const result = await closeTicket(
        db,
        ctx.api,
        ticketId,
        ctx.callbackQuery.message?.message_id
      );
      await ctx.answerCallbackQuery({ text: result });
      return;
    }

    if (action === "status" && isTicketStatus(rawStatus)) {
      const currentTicket = db.getTicket(ticketId);
      if (!currentTicket) {
        await ctx.answerCallbackQuery({ text: "Ticket not found." });
        return;
      }

      if (currentTicket.staff_chat_id !== config.staffChatId) {
        await ctx.answerCallbackQuery({ text: "Ticket not found in this staff chat." });
        return;
      }

      if (currentTicket.status === "CLOSED") {
        await ctx.answerCallbackQuery({ text: "Ticket is already closed." });
        return;
      }

      const ticket = db.updateTicketStatus(ticketId, rawStatus);
      if (!ticket) {
        await ctx.answerCallbackQuery({ text: "Ticket not found." });
        return;
      }

      await refreshStaffTicketMessage(db, ctx.api, ticketId);
      await ctx.answerCallbackQuery({ text: `Marked ${formatStatus(rawStatus)}.` });
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
        ctx.msg?.message_id
      );
    }
  });

  return bot;
}

export async function setBotCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Start support" },
    { command: "chatid", description: "Show this chat id" },
    { command: "status", description: "Show your latest ticket status" },
    { command: "mytickets", description: "Show your recent tickets" }
  ]);
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

  const ticket = db.createTicket(ctx.from.id, config.staffChatId);
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

  const staffMessageId = await ensureStaffTicketMessage(db, ctx.api, ticket.id);
  if (!staffMessageId) {
    db.updateTicketStatus(ticket.id, "CLOSED");
    await ctx.reply("Sorry, we could not route your request to support. Please try again later.");
    return;
  }

  db.closeOtherActiveTicketsForUserInStaffChat(ctx.from.id, config.staffChatId, ticket.id);
  await maybeCopyOriginalMessageToStaff(db, ctx, ticket.id, staffMessageId, content.shouldCopyOriginal);
  await ctx.reply(RECEIVED_TEXT);
}

async function appendToExistingTicket(
  db: SupportDatabase,
  ctx: Context,
  activeTicket: TicketRecord
): Promise<void> {
  if (!ctx.from || !ctx.chat || !ctx.message) {
    return;
  }

  if (
    activeTicket.staff_chat_id !== config.staffChatId ||
    activeTicket.staff_message_id === null
  ) {
    logger.warn(
      { ticketId: activeTicket.id, staffChatId: activeTicket.staff_chat_id },
      "Active ticket is not attached to the current staff chat"
    );
    db.updateTicketStatus(activeTicket.id, "CLOSED");
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
        reply_parameters: { message_id: activeTicket.staff_message_id }
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
    await maybeCopyOriginalMessageToStaff(
      db,
      ctx,
      activeTicket.id,
      sent.message_id,
      content.shouldCopyOriginal
    );
    await refreshStaffTicketMessage(db, ctx.api, activeTicket.id);
    db.closeOtherActiveTicketsForUserInStaffChat(ctx.from.id, config.staffChatId, activeTicket.id);
  } catch (error) {
    if (isReplyMessageNotFound(error)) {
      logger.warn(
        { err: error, ticketId: activeTicket.id, staffMessageId: activeTicket.staff_message_id },
        "Staff ticket message is missing; creating a fresh ticket"
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
    `We added your message to your existing ticket #${activeTicket.id}. Our support team will get back to you soon.`
  );
}

async function handleStaffGroupMessage(db: SupportDatabase, ctx: Context): Promise<void> {
  if (!ctx.message || !ctx.chat) {
    return;
  }

  const repliedMessageId = ctx.message.reply_to_message?.message_id;
  if (!repliedMessageId) {
    return;
  }

  const link = db.findTicketByStaffMessage(ctx.chat.id, repliedMessageId);
  if (!link) {
    return;
  }

  const ticket = db.getTicketWithUser(link.ticket_id);
  if (!ticket || ticket.staff_chat_id !== ctx.chat.id) {
    await ctx.reply("This ticket no longer exists.", {
      reply_parameters: { message_id: ctx.message.message_id }
    });
    return;
  }

  db.linkStaffMessage(ticket.id, ctx.chat.id, ctx.message.message_id, "staff_reply");

  if (ticket.status === "CLOSED") {
    const sent = await ctx.reply(
      `Ticket #${ticket.id} is closed. The reply was not sent to the user.`,
      {
        reply_parameters: { message_id: ctx.message.message_id }
      }
    );
    db.linkStaffMessage(ticket.id, sent.chat.id, sent.message_id, "closed_reply_notice");
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

    const sent = await ctx.reply(`Reply sent to user for ticket #${ticket.id}.`, {
      reply_parameters: { message_id: ctx.message.message_id }
    });
    db.linkStaffMessage(ticket.id, sent.chat.id, sent.message_id, "delivery_receipt");
  } catch (error) {
    logger.error({ err: error, ticketId: ticket.id }, "Could not deliver staff reply to user");
    await notifyStaff(
      ctx.api,
      `Could not deliver staff reply for ticket #${ticket.id} to user ${ticket.user_telegram_id}: ${describeError(error)}`,
      ctx.message.message_id
    );
  }
}

async function ensureStaffTicketMessage(
  db: SupportDatabase,
  api: BotApi,
  ticketId: number
): Promise<number | null> {
  const existing = db.getTicket(ticketId);
  if (!existing || existing.staff_chat_id !== config.staffChatId) {
    return null;
  }

  if (existing.staff_message_id) {
    return existing.staff_message_id;
  }

  const ticket = db.getTicketWithUser(ticketId);
  if (!ticket || ticket.staff_chat_id !== config.staffChatId) {
    return null;
  }

  const firstMessage = db.getFirstUserMessage(ticketId);

  try {
    const sent = await api.sendMessage(config.staffChatId, formatTicketPost(ticket, firstMessage?.text), {
      reply_markup: ticketKeyboard(ticket.id)
    });
    db.updateTicketStaffMessage(ticket.id, sent.chat.id, sent.message_id);
    db.linkStaffMessage(ticket.id, sent.chat.id, sent.message_id, "ticket");
    return sent.message_id;
  } catch (error) {
    logger.error({ err: error, ticketId }, "Could not send ticket to staff chat");
    return null;
  }
}

async function maybeCopyOriginalMessageToStaff(
  db: SupportDatabase,
  ctx: Context,
  ticketId: number,
  replyToMessageId: number,
  shouldCopyOriginal: boolean
): Promise<void> {
  if (!shouldCopyOriginal || !ctx.chat || !ctx.message) {
    return;
  }

  try {
    const copied = await ctx.api.copyMessage(config.staffChatId, ctx.chat.id, ctx.message.message_id, {
      reply_parameters: { message_id: replyToMessageId }
    });
    db.linkStaffMessage(ticketId, config.staffChatId, copied.message_id, "user_original_copy");
  } catch (error) {
    logger.error({ err: error, ticketId }, "Could not copy original user message to staff chat");
    await notifyStaff(
      ctx.api,
      `Ticket #${ticketId} was created, but the attachment could not be copied: ${describeError(error)}`,
      replyToMessageId
    );
  }
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

  const firstMessage = db.getFirstUserMessage(ticketId);

  try {
    await api.editMessageText(
      ticket.staff_chat_id,
      ticket.staff_message_id,
      formatTicketPost(ticket, firstMessage?.text),
      {
        reply_markup: ticket.status === "CLOSED" ? undefined : ticketKeyboard(ticket.id)
      }
    );
  } catch (error) {
    if (error instanceof GrammyError && error.description.includes("message is not modified")) {
      return;
    }

    logger.warn({ err: error, ticketId }, "Could not refresh staff ticket message");
  }
}

async function closeTicket(
  db: SupportDatabase,
  api: BotApi,
  ticketId: number,
  replyToMessageId?: number
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

  try {
    const sent = await api.sendMessage(ticket.user_telegram_id, CLOSED_TEXT);
    db.addMessage({
      ticketId,
      direction: "SYSTEM",
      deliveryChatId: ticket.user_telegram_id,
      deliveryMessageId: sent.message_id,
      text: CLOSED_TEXT
    });
  } catch (error) {
    logger.error({ err: error, ticketId }, "Could not notify user about closed ticket");
    await notifyStaff(
      api,
      `Ticket #${ticketId} was closed, but the user ${ticket.user_telegram_id} could not be notified: ${describeError(error)}`,
      replyToMessageId ?? ticket.staff_message_id ?? undefined
    );
  }

  return `Ticket #${closedTicket?.id ?? ticketId} closed.`;
}

function ticketKeyboard(ticketId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Close ticket", `ticket:close:${ticketId}`)
    .row()
    .text("Mark waiting user", `ticket:status:${ticketId}:WAITING_USER`)
    .row()
    .text("Mark in progress", `ticket:status:${ticketId}:IN_PROGRESS`);
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
  const raw = ctx.match.trim();
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function notifyStaff(api: BotApi, text: string, replyToMessageId?: number): Promise<void> {
  try {
    await api.sendMessage(config.staffChatId, truncate(text, 3500), {
      reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined
    });
  } catch (error) {
    logger.error({ err: error }, "Could not send log message to staff chat");
  }
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

function isReplyMessageNotFound(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return (
    message.includes("message to be replied not found") ||
    message.includes("reply message not found") ||
    message.includes("replied message not found")
  );
}

function messageHasTextOrSupportedMedia(message: Message | undefined): boolean {
  if (!message) {
    return false;
  }

  const content = getMessageContent(message);
  return Boolean(content.text || content.mediaType);
}
