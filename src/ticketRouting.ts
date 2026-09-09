import { GrammyError, HttpError } from "grammy";
import type { Context, InlineKeyboard } from "grammy";
import type { Message, User } from "grammy/types";
import { archiveTicketIfPossible, logBanEvent, type ArchiveActor } from "./archive.js";
import { type SupportDatabase, type TicketRecord, type TicketWithUser } from "./db.js";
import { normalizeTelegramDeliveryError, type NormalizedDeliveryError } from "./deliveryDiagnostics.js";
import {
  CLOSED_TEXT,
  DEFAULT_SUPPORT_EXPECTED_RESPONSE_TIME,
  DEFAULT_SUPPORT_TICKET_RECEIVED_TEMPLATE,
  formatPinnedTicketSummary,
  formatTicketPost,
  formatTicketUpdate,
  truncate,
  validateRenderedSupportAcknowledgement,
} from "./format.js";
import type { InstallationService } from "./installation.js";
import { logger } from "./logger.js";
import { displayTelegramUser, getMessageContent, isCommandText, usernameOf } from "./telegram.js";

type BotApi = Context["api"];

interface CloseTicketOptions {
  notifyUser?: boolean;
  userText?: string;
  staffNotice?: string;
  closedBy?: ArchiveActor;
  onArchiveFailure?: (diagnostic: NormalizedDeliveryError) => void;
}

interface StaffTextReplySource {
  chatId: number;
  messageId: number;
}

interface TicketRoutingServiceDependencies {
  db: SupportDatabase;
  api: BotApi;
  installation: InstallationService;
  staffTicketKeyboard(ticketId: number): InlineKeyboard;
  userTicketKeyboard(ticketId: number): InlineKeyboard;
  bannedText: string;
  supportExpectedResponseTimeSettingKey: string;
  supportTicketReceivedTemplateSettingKey: string;
}

export class TicketRoutingService {
  constructor(private readonly dependencies: TicketRoutingServiceDependencies) {}

  async deliverAndRecordStaffTextReply(
    ticket: TicketWithUser,
    text: string,
    staffUser: User | undefined,
    source?: StaffTextReplySource
  ): Promise<number> {
    const sent = await this.dependencies.api.sendMessage(ticket.user_telegram_id, truncate(text.trim(), 3500));

    this.dependencies.db.addMessage({
      ticketId: ticket.id,
      direction: "STAFF_TO_USER",
      sourceChatId: source?.chatId ?? ticket.staff_chat_id ?? this.requireStaffChatId(),
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
      fileId: null,
    });
    return sent.message_id;
  }

  async handlePrivateUserMessage(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.chat || !ctx.message) return;

    if (!messageHasTextOrSupportedMedia(ctx.message)) {
      await ctx.reply("Please send your issue as text, photo, screenshot, or document.");
      return;
    }

    this.persistUserFromContext(ctx);
    const activeTicket = this.dependencies.db.findActiveTicketForUser(ctx.from.id, this.requireStaffChatId());
    if (activeTicket) {
      await this.appendToExistingTicket(ctx, activeTicket);
      return;
    }

    await this.createFreshTicketFromUserMessage(ctx);
  }

  async handleStaffGroupMessage(ctx: Context, canReply: () => boolean): Promise<void> {
    if (!ctx.message || !ctx.chat) return;
    if ("text" in ctx.message && isCommandText(ctx.message.text)) return;

    const messageThreadId = ctx.message.message_thread_id;
    if (typeof messageThreadId !== "number") return;

    const ticket = this.dependencies.db.findTicketByStaffThread(ctx.chat.id, messageThreadId);
    if (!ticket) return;

    if (!canReply()) {
      await ctx.reply("Your application role does not allow ticket replies.", { message_thread_id: messageThreadId });
      return;
    }

    if (!messageHasTextOrSupportedMedia(ctx.message)) return;

    if (ticket.status === "CLOSED") {
      await this.sendStaffTopicNotice(
        ctx.api,
        this.requireStaffChatId(),
        ticket,
        `Ticket #${ticket.id} is closed. The reply was not sent to the user.`
      );
      return;
    }

    const content = getMessageContent(ctx.message);
    try {
      if (content.mediaType) {
        const delivered = await this.deliverStaffMediaReplyToUser(
          ctx.api,
          this.requireStaffChatId(),
          ticket,
          ctx.message.message_id
        );
        this.dependencies.db.addMessage({
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
          fileId: content.fileId,
        });
      } else {
        await this.deliverAndRecordStaffTextReply(ticket, content.text ?? "", ctx.from, {
          chatId: ctx.chat.id,
          messageId: ctx.message.message_id,
        });
      }

      if (ticket.status === "OPEN") {
        this.dependencies.db.updateTicketStatus(ticket.id, "IN_PROGRESS");
        await this.refreshTicket(ticket.id);
      }
    } catch (error) {
      logger.error({ err: error, ticketId: ticket.id }, "Could not deliver staff reply to user");
      await this.sendStaffTopicNotice(
        ctx.api,
        this.requireStaffChatId(),
        ticket,
        `Could not deliver staff reply for ticket #${ticket.id} to user ${ticket.user_telegram_id}: ${describeError(error)}`
      );
    }
  }

  async closeTicket(
    ticketId: number,
    options: CloseTicketOptions = {},
    staffChatId = this.requireStaffChatId()
  ): Promise<string> {
    const ticket = this.dependencies.db.getTicketWithUser(ticketId);
    if (!ticket || ticket.staff_chat_id !== staffChatId) {
      return `Ticket #${ticketId} was not found in this staff chat.`;
    }

    if (ticket.status === "CLOSED") {
      const archived = await archiveTicketIfPossible(
        this.dependencies.api,
        this.dependencies.db,
        staffChatId,
        ticketId,
        {
          onFailure: options.onArchiveFailure,
        }
      );
      return archived
        ? `Ticket #${ticketId} is already closed and archived.`
        : `Ticket #${ticketId} is already closed. Transcript archive is pending retry.`;
    }

    const closedTicket = this.dependencies.db.closeTicketRecord(ticketId, options.closedBy ?? systemActor());
    await this.refreshTicket(ticketId, staffChatId);

    if (options.staffNotice) {
      await this.sendStaffTopicNotice(this.dependencies.api, staffChatId, ticket, options.staffNotice);
    }

    if (options.notifyUser) {
      await this.notifyUserOrStaff(
        this.dependencies.api,
        staffChatId,
        ticket.user_telegram_id,
        options.userText ?? CLOSED_TEXT,
        ticket.message_thread_id
      );
    }

    const archived = await archiveTicketIfPossible(this.dependencies.api, this.dependencies.db, staffChatId, ticketId, {
      onFailure: options.onArchiveFailure,
    });

    return archived
      ? `Ticket #${closedTicket?.id ?? ticketId} closed and archived.`
      : `Ticket #${closedTicket?.id ?? ticketId} closed. Transcript archive is pending retry.`;
  }

  async refreshTicket(ticketId: number, staffChatId = this.requireStaffChatId()): Promise<void> {
    const ticket = this.dependencies.db.getTicketWithUser(ticketId);
    if (!ticket?.staff_chat_id || ticket.staff_chat_id !== staffChatId || !ticket.staff_message_id) return;

    try {
      await this.dependencies.api.editMessageText(
        ticket.staff_chat_id,
        ticket.staff_message_id,
        formatPinnedTicketSummary(ticket),
        {
          reply_markup: ticket.status === "CLOSED" ? undefined : this.dependencies.staffTicketKeyboard(ticket.id),
        }
      );
    } catch (error) {
      if (error instanceof GrammyError && error.description.includes("message is not modified")) return;
      logger.warn({ err: error, ticketId }, "Could not refresh staff ticket intro");
    }
  }

  async banUserById(userId: number, reason: string, actor: ArchiveActor): Promise<void> {
    const user = this.dependencies.db.getUser(userId);
    this.dependencies.db.banUser({
      userTelegramId: userId,
      username: user?.username ?? null,
      reason,
      bannedBy: actor.telegramId,
    });

    await logBanEvent(this.dependencies.api, this.dependencies.db, this.requireStaffChatId(), {
      action: "BANNED",
      userTelegramId: userId,
      username: user?.username ?? null,
      reason,
      performedBy: actor,
    });

    const activeTicket = this.dependencies.db.findActiveTicketForUser(userId, this.requireStaffChatId());
    if (activeTicket) {
      const ticket = this.dependencies.db.getTicketWithUser(activeTicket.id);
      if (ticket) {
        await this.closeTicket(ticket.id, {
          notifyUser: true,
          userText: this.dependencies.bannedText,
          staffNotice: `User ${userId} was banned. Reason: ${reason}`,
          closedBy: actor,
        });
        this.dependencies.db.closeOtherActiveTicketsForUserInStaffChat(userId, this.requireStaffChatId(), ticket.id);
        return;
      }
    }

    await this.notifyUserOrStaff(
      this.dependencies.api,
      this.requireStaffChatId(),
      userId,
      this.dependencies.bannedText,
      activeTicket?.message_thread_id ?? null
    );
  }

  async banUserForTicket(ticket: TicketWithUser, actor: ArchiveActor, reason: string): Promise<void> {
    this.dependencies.db.banUser({
      userTelegramId: ticket.user_telegram_id,
      username: ticket.username,
      reason,
      bannedBy: actor.telegramId,
    });

    await logBanEvent(this.dependencies.api, this.dependencies.db, this.requireStaffChatId(), {
      action: "BANNED",
      userTelegramId: ticket.user_telegram_id,
      username: ticket.username,
      reason,
      performedBy: actor,
    });

    await this.closeTicket(ticket.id, {
      notifyUser: true,
      userText: this.dependencies.bannedText,
      staffNotice: `User ${ticket.user_telegram_id} has been banned. Reason: ${reason}`,
      closedBy: actor,
    });
    this.dependencies.db.closeOtherActiveTicketsForUserInStaffChat(
      ticket.user_telegram_id,
      this.requireStaffChatId(),
      ticket.id
    );
  }

  async sendStaffTopicNotice(api: BotApi, staffChatId: number, ticket: TicketRecord, text: string): Promise<void> {
    if (!ticket.staff_chat_id || !ticket.message_thread_id) {
      await this.notifyStaff(api, staffChatId, text);
      return;
    }

    try {
      await api.sendMessage(ticket.staff_chat_id, truncate(text, 3500), {
        message_thread_id: ticket.message_thread_id,
      });
    } catch (error) {
      logger.error({ err: error, ticketId: ticket.id }, "Could not send staff topic notice");
    }
  }

  private requireStaffChatId(): number {
    return this.dependencies.installation.requireStaffChatId();
  }

  private async createFreshTicketFromUserMessage(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.chat || !ctx.message) return;

    const acknowledgement = validateRenderedSupportAcknowledgement(
      this.dependencies.db.getSetting(this.dependencies.supportTicketReceivedTemplateSettingKey)?.trim() ||
        DEFAULT_SUPPORT_TICKET_RECEIVED_TEMPLATE,
      this.dependencies.db.getSetting(this.dependencies.supportExpectedResponseTimeSettingKey)?.trim() ||
        DEFAULT_SUPPORT_EXPECTED_RESPONSE_TIME
    );
    if (acknowledgement.error) {
      logger.error({ userId: ctx.from.id }, "Support acknowledgement settings exceed Telegram's message limit");
      await ctx.reply("Sorry, support acknowledgement settings need attention. Please try again later.");
      return;
    }

    let ticket: TicketRecord;
    try {
      ticket = this.dependencies.db.createTicket(ctx.from.id, this.requireStaffChatId());
    } catch (error) {
      if (isSqliteConstraint(error)) {
        const activeTicket = this.dependencies.db.findActiveTicketForUser(ctx.from.id, this.requireStaffChatId());
        if (activeTicket) {
          await this.appendToExistingTicket(ctx, activeTicket);
          return;
        }
      }
      throw error;
    }

    const content = getMessageContent(ctx.message);
    this.dependencies.db.addMessage({
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
      fileId: content.fileId,
    });

    let messageThreadId: number;
    try {
      const topic = await ctx.api.createForumTopic(this.requireStaffChatId(), topicName(ticket.id, ctx.from));
      messageThreadId = topic.message_thread_id;
      this.dependencies.db.updateTicketForumTopic(ticket.id, this.requireStaffChatId(), messageThreadId);
    } catch (error) {
      logger.error({ err: error, ticketId: ticket.id }, "Could not create staff forum topic");
      this.dependencies.db.updateTicketStatus(ticket.id, "CLOSED");
      this.dependencies.db.deleteMessagesForTicket(ticket.id);
      await ctx.reply("Sorry, we could not create a support topic. Please try again later.");
      return;
    }

    const ticketWithTopic = this.dependencies.db.getTicketWithUser(ticket.id);
    if (!ticketWithTopic?.message_thread_id) {
      this.dependencies.db.updateTicketStatus(ticket.id, "CLOSED");
      this.dependencies.db.deleteMessagesForTicket(ticket.id);
      await ctx.reply("Sorry, we could not route your request to support. Please try again later.");
      return;
    }

    try {
      const summary = await ctx.api.sendMessage(this.requireStaffChatId(), formatPinnedTicketSummary(ticketWithTopic), {
        message_thread_id: messageThreadId,
        reply_markup: this.dependencies.staffTicketKeyboard(ticket.id),
      });
      this.dependencies.db.updateTicketStaffMessage(ticket.id, summary.chat.id, summary.message_id);
      await this.pinMessageSafely(ctx.api, summary.chat.id, summary.message_id, ticket.id);
      await ctx.api.sendMessage(this.requireStaffChatId(), formatTicketPost(ticketWithTopic, content.text), {
        message_thread_id: messageThreadId,
      });
    } catch (error) {
      logger.error({ err: error, ticketId: ticket.id }, "Could not send ticket intro to staff topic");
      this.dependencies.db.updateTicketStatus(ticket.id, "CLOSED");
      this.dependencies.db.deleteMessagesForTicket(ticket.id);
      await this.closeForumTopicSafely(ctx.api, ticketWithTopic);
      await ctx.reply("Sorry, we could not route your request to support. Please try again later.");
      return;
    }

    this.dependencies.db.closeOtherActiveTicketsForUserInStaffChat(ctx.from.id, this.requireStaffChatId(), ticket.id);
    await this.maybeCopyOriginalMessageToStaff(ctx, ticketWithTopic, content.shouldCopyOriginal);
    await ctx.reply(acknowledgement.rendered, { reply_markup: this.dependencies.userTicketKeyboard(ticket.id) });
  }

  private async appendToExistingTicket(ctx: Context, activeTicket: TicketRecord): Promise<void> {
    if (!ctx.from || !ctx.chat || !ctx.message) return;

    if (activeTicket.staff_chat_id !== this.requireStaffChatId() || activeTicket.message_thread_id === null) {
      const readyTicket = await this.waitForTicketTopic(activeTicket.id);
      if (readyTicket && readyTicket.status !== "CLOSED") {
        await this.appendToExistingTicket(ctx, readyTicket);
        return;
      }

      logger.warn({ ticketId: activeTicket.id }, "Active ticket topic was not created in time");
      if (readyTicket?.status !== "CLOSED") {
        this.dependencies.db.closeTicketRecord(activeTicket.id, systemActor());
        await archiveTicketIfPossible(ctx.api, this.dependencies.db, this.requireStaffChatId(), activeTicket.id);
      }
      await this.createFreshTicketFromUserMessage(ctx);
      return;
    }

    const content = getMessageContent(ctx.message);
    try {
      await ctx.api.sendMessage(
        this.requireStaffChatId(),
        formatTicketUpdate(ctx.from, content.text, content.mediaType, content.filename),
        { message_thread_id: activeTicket.message_thread_id }
      );
      this.dependencies.db.addMessage({
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
        fileId: content.fileId,
      });

      if (activeTicket.status === "WAITING_USER") {
        this.dependencies.db.clearWaitingUserFollowUp(activeTicket.id);
        this.dependencies.db.updateTicketStatus(activeTicket.id, "IN_PROGRESS");
      }

      const ticketWithUser = this.dependencies.db.getTicketWithUser(activeTicket.id);
      if (ticketWithUser) {
        await this.maybeCopyOriginalMessageToStaff(ctx, ticketWithUser, content.shouldCopyOriginal);
        await this.refreshTicket(activeTicket.id);
      }

      this.dependencies.db.closeOtherActiveTicketsForUserInStaffChat(
        ctx.from.id,
        this.requireStaffChatId(),
        activeTicket.id
      );
    } catch (error) {
      if (isForumTopicUnavailable(error)) {
        logger.warn(
          { err: error, ticketId: activeTicket.id, messageThreadId: activeTicket.message_thread_id },
          "Staff forum topic is unavailable; creating a fresh ticket"
        );
        this.dependencies.db.closeTicketRecord(activeTicket.id, systemActor());
        await archiveTicketIfPossible(ctx.api, this.dependencies.db, this.requireStaffChatId(), activeTicket.id);
        await this.createFreshTicketFromUserMessage(ctx);
        return;
      }

      logger.error({ err: error, ticketId: activeTicket.id }, "Could not notify staff about user update");
      await ctx.reply("Sorry, we could not route your update to support. Please try again later.");
    }
  }

  private async maybeCopyOriginalMessageToStaff(
    ctx: Context,
    ticket: TicketWithUser,
    shouldCopyOriginal: boolean
  ): Promise<void> {
    if (!shouldCopyOriginal || !ctx.chat || !ctx.message || !ticket.message_thread_id) return;

    try {
      await ctx.api.copyMessage(this.requireStaffChatId(), ctx.chat.id, ctx.message.message_id, {
        message_thread_id: ticket.message_thread_id,
      });
    } catch (error) {
      logger.error({ err: error, ticketId: ticket.id }, "Could not copy original user message to staff topic");
      await this.sendStaffTopicNotice(
        ctx.api,
        this.requireStaffChatId(),
        ticket,
        `Ticket #${ticket.id} was created, but the attachment could not be copied: ${describeError(error)}`
      );
    }
  }

  private async deliverStaffMediaReplyToUser(
    api: BotApi,
    staffChatId: number,
    ticket: TicketWithUser,
    sourceMessageId: number
  ): Promise<number> {
    const sourceChatId = ticket.staff_chat_id ?? staffChatId;
    const copied = await api.copyMessage(ticket.user_telegram_id, sourceChatId, sourceMessageId);
    return copied.message_id;
  }

  private async pinMessageSafely(api: BotApi, chatId: number, messageId: number, ticketId: number): Promise<void> {
    try {
      await api.pinChatMessage(chatId, messageId, { disable_notification: true });
    } catch (error) {
      logger.warn({ err: error, ticketId }, "Could not pin ticket summary");
    }
  }

  private async waitForTicketTopic(ticketId: number, attempts = 10): Promise<TicketRecord | undefined> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const ticket = this.dependencies.db.getTicket(ticketId);
      if (!ticket || ticket.status === "CLOSED" || ticket.message_thread_id !== null) return ticket;
      await sleep(250);
    }
    return this.dependencies.db.getTicket(ticketId);
  }

  private async notifyStaff(
    api: BotApi,
    staffChatId: number,
    text: string,
    messageThreadId?: number | null
  ): Promise<void> {
    try {
      await api.sendMessage(staffChatId, truncate(text, 3500), { message_thread_id: messageThreadId ?? undefined });
    } catch (error) {
      logger.error({ err: error }, "Could not send log message to staff chat");
    }
  }

  private async notifyUserOrStaff(
    api: BotApi,
    staffChatId: number,
    userTelegramId: number,
    text: string,
    messageThreadId?: number | null
  ): Promise<void> {
    try {
      await api.sendMessage(userTelegramId, text);
    } catch (error) {
      logger.error({ err: error, userTelegramId }, "Could not message user");
      await this.notifyStaff(
        api,
        staffChatId,
        `Could not message user ${userTelegramId}: ${describeError(error)}`,
        messageThreadId
      );
    }
  }

  private async closeForumTopicSafely(api: BotApi, ticket: TicketRecord): Promise<void> {
    if (!ticket.staff_chat_id || !ticket.message_thread_id) return;
    try {
      await api.closeForumTopic(ticket.staff_chat_id, ticket.message_thread_id);
    } catch (error) {
      logger.warn({ err: error, ticketId: ticket.id }, "Could not close forum topic");
    }
  }

  private persistUserFromContext(ctx: Context): void {
    if (!ctx.from) return;
    this.dependencies.db.upsertUser({
      telegramId: ctx.from.id,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      lastName: ctx.from.last_name ?? null,
    });
  }
}

function topicName(ticketId: number, user: { id: number; username?: string }): string {
  const userLabel = user.username ? `@${user.username}` : `user_${user.id}`;
  return truncate(`#${ticketId} | ${userLabel}`, 128);
}

function systemActor(): ArchiveActor {
  return { type: "SYSTEM", displayName: "system", username: null, telegramId: null };
}

function messageHasTextOrSupportedMedia(message: Message | undefined): boolean {
  if (!message) return false;
  const content = getMessageContent(message);
  return Boolean(content.text || content.mediaType);
}

function describeError(error: unknown): string {
  if (error instanceof GrammyError) return `${error.error_code}: ${error.description}`;
  if (error instanceof HttpError) return `HTTP error: ${error.message}`;
  if (error instanceof Error) return error.message;
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

interface ErrorWithCode extends Error {
  code?: string;
}

function isSqliteConstraint(error: unknown): error is ErrorWithCode {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as ErrorWithCode).code === "string" &&
    (error as ErrorWithCode).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
