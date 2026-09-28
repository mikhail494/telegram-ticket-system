import { GrammyError, HttpError } from "grammy";
import type { Context, InlineKeyboard } from "grammy";
import type { Message, User } from "grammy/types";
import { archiveTicketIfPossible, logBanEvent, type ArchiveActor, type ArchiveStore } from "./archive.js";
import { type SupportDatabase, type TicketRecord, type TicketStatus, type TicketWithUser } from "./db.js";
import { normalizeTelegramDeliveryError, type NormalizedDeliveryError } from "./deliveryDiagnostics.js";
import { isForumTopicUnavailable } from "./forumTopicErrors.js";
import { inboundRoutingAttemptIdentity } from "./persistence/ticketsRepository.js";
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

export interface InteractiveStaffReplySource {
  chatId: number | null;
  messageId: number | null;
  operationKey: string;
}

export class InteractiveReplyNotResentError extends Error {
  constructor(readonly state: "PENDING" | "UNKNOWN_DELIVERY") {
    super("Delivery outcome is unknown; the reply was not resent automatically.");
  }
}

interface TicketRoutingServiceDependencies {
  db: TicketRoutingStore;
  api: BotApi;
  installation: InstallationService;
  staffTicketKeyboard(ticketId: number, status: TicketStatus): InlineKeyboard;
  userTicketKeyboard(ticketId: number): InlineKeyboard;
  bannedText: string;
  supportExpectedResponseTimeSettingKey: string;
  supportTicketReceivedTemplateSettingKey: string;
}

type TicketRoutingStore = Pick<
  SupportDatabase,
  | "banUser"
  | "beginTicketInboundRouting"
  | "claimTicketInboundRoutingOperation"
  | "closeOtherActiveTicketsForUserInStaffChat"
  | "closeTicketRecordIfOpen"
  | "createTicketOutboundDeliveryIntent"
  | "findActiveTicketForUser"
  | "getSetting"
  | "getTicketInboundRoutingOperation"
  | "getUser"
  | "listReadyTicketInboundRoutingOperationsForTicket"
  | "markTicketInboundRoutingCopyDelivered"
  | "markTicketInboundRoutingFailed"
  | "markTicketInboundRoutingInitialPostDelivered"
  | "markTicketInboundRoutingSummaryDelivered"
  | "markTicketInboundRoutingTopicCreated"
  | "markTicketInboundRoutingUnknown"
  | "markTicketInboundRoutingUpdateDelivered"
  | "markTicketOutboundDeliveryDelivered"
  | "markTicketOutboundDeliveryFailed"
  | "markTicketOutboundDeliveryUnknown"
  | "restartTicketInboundRoutingAfterUnavailableTopic"
  | "transitionTicketStatusIfCurrent"
  | "upsertUser"
> &
  ArchiveStore;

export class TicketRoutingService {
  constructor(private readonly dependencies: TicketRoutingServiceDependencies) {}

  async continueReconciledInbound(
    sourceChatId: number,
    sourceMessageId: number,
    staffChatId: number,
    operationIdentity: string
  ): Promise<void> {
    if (this.dependencies.installation.getStaffChatId() !== staffChatId) return;
    const operation = this.dependencies.db.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
    if (
      !operation ||
      operation.staff_chat_id !== staffChatId ||
      inboundRoutingAttemptIdentity(operation) !== operationIdentity
    )
      return;
    await this.resumeInboundRoutingOperation(this.dependencies.api, sourceChatId, sourceMessageId);
    await this.resumeReadyInboundTicketOperations(this.dependencies.api, operation.ticket_id, staffChatId);
    if (this.dependencies.installation.getStaffChatId() !== staffChatId) return;
    const ticket = this.dependencies.db.getTicketWithUser(operation.ticket_id);
    if (ticket?.staff_chat_id !== staffChatId) return;
    if (ticket.status === "CLOSED") await this.continueClosedTicketArchive(this.dependencies.api, ticket, staffChatId);
    else await this.refreshTicket(ticket.id, staffChatId);
  }

  async deliverAndRecordStaffTextReply(
    ticket: TicketWithUser,
    text: string,
    staffUser: User | undefined,
    source: InteractiveStaffReplySource
  ): Promise<number> {
    const message = {
      ticketId: ticket.id,
      direction: "STAFF_TO_USER",
      sourceChatId: source.chatId ?? ticket.staff_chat_id ?? this.requireStaffChatId(),
      sourceMessageId: source.messageId,
      deliveryChatId: ticket.user_telegram_id,
      fromTelegramId: staffUser?.id ?? null,
      fromUsername: usernameOf(staffUser),
      senderType: "STAFF",
      senderDisplayName: staffUser ? displayTelegramUser(staffUser) : "Support",
      senderUsername: usernameOf(staffUser),
      text,
      mediaType: null,
      filename: null,
      fileId: null,
    } as const;
    return this.deliverInteractiveStaffReply(source.operationKey, message, () =>
      this.dependencies.api
        .sendMessage(ticket.user_telegram_id, truncate(text.trim(), 3500))
        .then((sent) => sent.message_id)
    );
  }

  async handlePrivateUserMessage(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.chat || !ctx.message) return;

    if (!messageHasTextOrSupportedMedia(ctx.message)) {
      await ctx.reply("Please send your issue as text, photo, screenshot, or document.");
      return;
    }

    this.persistUserFromContext(ctx);
    const staffChatId = this.requireStaffChatId();
    const activeTicket = this.dependencies.db.findActiveTicketForUser(ctx.from.id, staffChatId);
    const acknowledgement = activeTicket ? undefined : this.supportAcknowledgement();
    if (!activeTicket && !acknowledgement) {
      logger.error({ userId: ctx.from.id }, "Support acknowledgement settings exceed Telegram's message limit");
      await ctx.reply("Sorry, support acknowledgement settings need attention. Please try again later.");
      return;
    }
    const content = getMessageContent(ctx.message);
    const started = this.dependencies.db.beginTicketInboundRouting({
      sourceChatId: ctx.chat.id,
      sourceMessageId: ctx.message.message_id,
      staffChatId,
      userTelegramId: ctx.from.id,
      fromUsername: usernameOf(ctx.from),
      fromFirstName: ctx.from.first_name,
      fromLastName: ctx.from.last_name ?? null,
      senderDisplayName: displayTelegramUser(ctx.from),
      senderUsername: usernameOf(ctx.from),
      text: content.text,
      mediaType: content.mediaType,
      filename: content.filename,
      fileId: content.fileId,
      shouldCopyOriginal: content.shouldCopyOriginal,
    });
    if (started.operation.staff_chat_id !== staffChatId) {
      logger.warn(
        { ticketId: started.operation.ticket_id, sourceChatId: ctx.chat.id, sourceMessageId: ctx.message.message_id },
        "Skipped inbound ticket routing after workspace changed"
      );
      return;
    }

    const outcome = await this.resumeInboundRoutingOperation(ctx.api, ctx.chat.id, ctx.message.message_id);
    if (outcome !== "COMPLETED")
      await this.resumeReadyInboundTicketOperations(ctx.api, started.ticket.id, staffChatId, {
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
      });
    if (outcome === "FAILED") {
      const failedOperation = this.dependencies.db.getTicketInboundRoutingOperation(
        ctx.chat.id,
        ctx.message.message_id
      );
      if (failedOperation?.kind === "FRESH_TICKET" && failedOperation.stage === "CREATE_TOPIC") {
        this.dependencies.db.closeTicketRecordIfOpen(failedOperation.ticket_id, staffChatId, systemActor());
        await ctx.reply("Sorry, we could not create a support topic. Please try again later.");
      } else {
        await ctx.reply("Sorry, we could not route your request to support. Please try again later.");
      }
      return;
    }
    if (outcome !== "COMPLETED") return;

    if (started.created && started.operation.kind === "FRESH_TICKET") {
      const freshAcknowledgement = acknowledgement ?? this.supportAcknowledgement();
      if (!freshAcknowledgement) {
        logger.error({ userId: ctx.from.id }, "Support acknowledgement settings exceed Telegram's message limit");
        await ctx.reply("Sorry, support acknowledgement settings need attention. Please try again later.");
        return;
      }
      await ctx.reply(freshAcknowledgement, { reply_markup: this.dependencies.userTicketKeyboard(started.ticket.id) });
    }
    await this.resumeReadyInboundTicketOperations(ctx.api, started.ticket.id, staffChatId);
  }

  async handleStaffGroupMessage(ctx: Context, canReply: () => boolean): Promise<void> {
    if (!ctx.message || !ctx.chat || !ctx.from || ctx.from.is_bot || hasSenderChat(ctx.message)) return;
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
    const sourceMessageId = ctx.message.message_id;
    try {
      if (content.mediaType) {
        const sourceChatId = ctx.chat.id;
        await this.deliverInteractiveStaffReply(
          `staff-message:${sourceChatId}:${sourceMessageId}`,
          {
            ticketId: ticket.id,
            direction: "STAFF_TO_USER",
            sourceChatId,
            sourceMessageId,
            deliveryChatId: ticket.user_telegram_id,
            fromTelegramId: ctx.from?.id ?? null,
            fromUsername: usernameOf(ctx.from),
            senderType: "STAFF",
            senderDisplayName: ctx.from ? displayTelegramUser(ctx.from) : "Support",
            senderUsername: usernameOf(ctx.from),
            text: content.text,
            mediaType: content.mediaType,
            filename: content.filename,
            fileId: content.fileId,
          },
          () => this.deliverStaffMediaReplyToUser(ctx.api, this.requireStaffChatId(), ticket, sourceMessageId)
        );
      } else {
        await this.deliverAndRecordStaffTextReply(ticket, content.text ?? "", ctx.from, {
          chatId: ctx.chat.id,
          messageId: sourceMessageId,
          operationKey: `staff-message:${ctx.chat.id}:${sourceMessageId}`,
        });
      }

      if (ticket.status === "OPEN") {
        const transition = this.dependencies.db.transitionTicketStatusIfCurrent(
          ticket.id,
          ticket.staff_chat_id ?? this.requireStaffChatId(),
          "OPEN",
          "IN_PROGRESS"
        );
        if (transition.outcome === "APPLIED") await this.refreshTicket(ticket.id, ticket.staff_chat_id ?? undefined);
      }
    } catch (error) {
      logger.error({ err: error, ticketId: ticket.id }, "Could not deliver staff reply to user");
      const staffNotice =
        error instanceof InteractiveReplyNotResentError
          ? "Delivery outcome is unknown; the reply was not resent automatically."
          : `Could not deliver staff reply for ticket #${ticket.id} to user ${ticket.user_telegram_id}: ${describeError(error)}`;
      await this.sendStaffTopicNotice(ctx.api, this.requireStaffChatId(), ticket, staffNotice);
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

    const closed = this.dependencies.db.closeTicketRecordIfOpen(
      ticketId,
      staffChatId,
      options.closedBy ?? systemActor()
    );
    if (closed.outcome === "NOT_FOUND" || !closed.ticket) {
      return `Ticket #${ticketId} was not found in this staff chat.`;
    }

    if (closed.outcome === "IDEMPOTENT") {
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

    if (closed.outcome === "CONFLICT") {
      return `Ticket #${ticketId} changed before it could be closed. Refresh the ticket and try again.`;
    }

    const closedTicket = closed.ticket;
    await this.refreshTicket(ticketId, staffChatId);

    if (options.staffNotice) {
      await this.sendStaffTopicNotice(this.dependencies.api, staffChatId, closedTicket, options.staffNotice);
    }

    if (options.notifyUser) {
      await this.notifyUserOrStaff(
        this.dependencies.api,
        staffChatId,
        closedTicket.user_telegram_id,
        options.userText ?? CLOSED_TEXT,
        closedTicket.message_thread_id
      );
    }

    const archived = await archiveTicketIfPossible(this.dependencies.api, this.dependencies.db, staffChatId, ticketId, {
      onFailure: options.onArchiveFailure,
    });

    return archived
      ? `Ticket #${closedTicket?.id ?? ticketId} closed and archived.`
      : `Ticket #${closedTicket?.id ?? ticketId} closed. Transcript archive is pending retry.`;
  }

  async finalizeReconciledArchive(ticketId: number, staffChatId: number): Promise<boolean> {
    const activeStaffChatId = this.requireStaffChatId();
    if (activeStaffChatId !== staffChatId) {
      logger.warn(
        { ticketId, staffChatId, activeStaffChatId },
        "Skipped reconciled archive continuation after workspace changed"
      );
      return false;
    }
    return archiveTicketIfPossible(this.dependencies.api, this.dependencies.db, staffChatId, ticketId);
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
          reply_markup:
            ticket.status === "CLOSED" ? undefined : this.dependencies.staffTicketKeyboard(ticket.id, ticket.status),
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

  private supportAcknowledgement(): string | undefined {
    const acknowledgement = validateRenderedSupportAcknowledgement(
      this.dependencies.db.getSetting(this.dependencies.supportTicketReceivedTemplateSettingKey)?.trim() ||
        DEFAULT_SUPPORT_TICKET_RECEIVED_TEMPLATE,
      this.dependencies.db.getSetting(this.dependencies.supportExpectedResponseTimeSettingKey)?.trim() ||
        DEFAULT_SUPPORT_EXPECTED_RESPONSE_TIME
    );
    return acknowledgement.error ? undefined : acknowledgement.rendered;
  }

  private async resumeInboundRoutingOperation(
    api: BotApi,
    sourceChatId: number,
    sourceMessageId: number
  ): Promise<"COMPLETED" | "BLOCKED" | "FAILED"> {
    const outcome = await this.advanceInboundRoutingOperation(api, sourceChatId, sourceMessageId);
    const operation = this.dependencies.db.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
    if (operation?.state === "DELIVERED" || operation?.state === "CANCELLED") {
      const ticket = this.dependencies.db.getTicketWithUser(operation.ticket_id);
      if (ticket?.status === "CLOSED") await this.continueClosedTicketArchive(api, ticket, operation.staff_chat_id);
    }
    return outcome;
  }

  private async advanceInboundRoutingOperation(
    api: BotApi,
    sourceChatId: number,
    sourceMessageId: number
  ): Promise<"COMPLETED" | "BLOCKED" | "FAILED"> {
    let topicReplacementAttempts = 0;
    for (let step = 0; step < 8; step += 1) {
      const operation = this.dependencies.db.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
      if (!operation || operation.staff_chat_id !== this.dependencies.installation.getStaffChatId()) return "BLOCKED";
      if (operation.state === "DELIVERED") return "COMPLETED";
      if (
        operation.state === "PENDING" ||
        operation.state === "UNKNOWN_DELIVERY" ||
        operation.state === "RETRY_REQUIRED" ||
        operation.state === "CANCELLED" ||
        operation.stage === "WAITING_FOR_TOPIC"
      ) {
        return "BLOCKED";
      }

      const claim = this.dependencies.db.claimTicketInboundRoutingOperation(
        sourceChatId,
        sourceMessageId,
        operation.staff_chat_id,
        operation.stage
      );
      if (!claim?.claimed) {
        if (
          claim?.operation.state === "READY" &&
          (claim.operation.stage !== operation.stage || claim.operation.attempt !== operation.attempt)
        )
          continue;
        return claim?.operation.state === "DELIVERED" ? "COMPLETED" : "BLOCKED";
      }

      const ticket = this.dependencies.db.getTicketWithUser(claim.operation.ticket_id);
      // The synchronous transactional claim checked current ticket/workspace eligibility.
      if (!ticket) throw new Error("Claimed inbound routing ticket disappeared.");

      try {
        if (claim.operation.stage === "CREATE_TOPIC") {
          const topic = await api.createForumTopic(
            claim.operation.staff_chat_id,
            topicName(ticket.id, {
              id: claim.operation.user_telegram_id,
              username: claim.operation.from_username ?? undefined,
            })
          );
          if (
            !this.dependencies.db.markTicketInboundRoutingTopicCreated(
              sourceChatId,
              sourceMessageId,
              claim.operation.staff_chat_id,
              topic.message_thread_id
            )
          )
            throw new Error("Inbound ticket topic creation could not be finalized.");
          continue;
        }

        if (claim.operation.stage === "SEND_SUMMARY") {
          if (ticket.message_thread_id === null) return "BLOCKED";
          const summary = await api.sendMessage(claim.operation.staff_chat_id, formatPinnedTicketSummary(ticket), {
            message_thread_id: ticket.message_thread_id,
            reply_markup: this.dependencies.staffTicketKeyboard(ticket.id, ticket.status),
          });
          if (
            !this.dependencies.db.markTicketInboundRoutingSummaryDelivered(
              sourceChatId,
              sourceMessageId,
              claim.operation.staff_chat_id,
              summary.message_id
            )
          )
            throw new Error("Inbound ticket summary could not be finalized.");
          if (this.dependencies.installation.getStaffChatId() === claim.operation.staff_chat_id)
            await this.pinMessageSafely(api, summary.chat.id, summary.message_id, ticket.id);
          continue;
        }

        if (claim.operation.stage === "SEND_INITIAL_POST") {
          if (ticket.message_thread_id === null) return "BLOCKED";
          const post = await api.sendMessage(
            claim.operation.staff_chat_id,
            formatTicketPost(ticket, claim.operation.text),
            { message_thread_id: ticket.message_thread_id }
          );
          if (
            !this.dependencies.db.markTicketInboundRoutingInitialPostDelivered(
              sourceChatId,
              sourceMessageId,
              claim.operation.staff_chat_id,
              post.message_id
            )
          )
            throw new Error("Inbound ticket initial post could not be finalized.");
          continue;
        }

        if (claim.operation.stage === "SEND_UPDATE") {
          if (ticket.message_thread_id === null) return "BLOCKED";
          const update = await api.sendMessage(
            claim.operation.staff_chat_id,
            formatTicketUpdate(
              {
                username: claim.operation.from_username,
                first_name: claim.operation.from_first_name,
                last_name: claim.operation.from_last_name,
              },
              claim.operation.text,
              claim.operation.media_type,
              claim.operation.filename
            ),
            { message_thread_id: ticket.message_thread_id }
          );
          if (
            !this.dependencies.db.markTicketInboundRoutingUpdateDelivered(
              sourceChatId,
              sourceMessageId,
              claim.operation.staff_chat_id,
              update.message_id
            )
          )
            throw new Error("Inbound ticket update could not be finalized.");
          const completedTicket = this.dependencies.db.getTicketWithUser(ticket.id);
          if (
            completedTicket &&
            completedTicket.status !== "CLOSED" &&
            this.dependencies.installation.getStaffChatId() === claim.operation.staff_chat_id
          ) {
            await this.refreshTicket(ticket.id, claim.operation.staff_chat_id);
          }
          continue;
        }

        if (claim.operation.stage === "COPY_ORIGINAL") {
          const copied = await api.copyMessage(claim.operation.staff_chat_id, sourceChatId, sourceMessageId, {
            message_thread_id: claim.operation.topic_thread_id!,
          });
          if (
            !this.dependencies.db.markTicketInboundRoutingCopyDelivered(
              sourceChatId,
              sourceMessageId,
              claim.operation.staff_chat_id,
              copied.message_id
            )
          )
            throw new Error("Inbound original copy could not be finalized.");
          continue;
        }

        return "BLOCKED";
      } catch (error) {
        const restarted =
          error instanceof GrammyError &&
          isForumTopicUnavailable(error) &&
          topicReplacementAttempts < 1 &&
          this.dependencies.db.restartTicketInboundRoutingAfterUnavailableTopic(
            sourceChatId,
            sourceMessageId,
            claim.operation.staff_chat_id
          );
        if (restarted) {
          topicReplacementAttempts += 1;
          logger.warn(
            { ticketId: claim.operation.ticket_id, stage: claim.operation.stage },
            "Restarting inbound ticket routing after confirmed unavailable forum topic"
          );
          if (restarted.state === "CANCELLED") {
            return "BLOCKED";
          }
          continue;
        }

        const diagnostic = normalizeTelegramDeliveryError(error);
        if (error instanceof GrammyError) {
          this.dependencies.db.markTicketInboundRoutingFailed(
            sourceChatId,
            sourceMessageId,
            claim.operation.staff_chat_id,
            diagnostic.category,
            diagnostic.description
          );
          logger.warn(
            { ticketId: claim.operation.ticket_id, stage: claim.operation.stage, category: diagnostic.category },
            "Inbound ticket routing failed before Telegram delivery"
          );
          return "FAILED";
        }
        this.dependencies.db.markTicketInboundRoutingUnknown(
          sourceChatId,
          sourceMessageId,
          claim.operation.staff_chat_id,
          "Telegram delivery outcome could not be confirmed."
        );
        logger.warn(
          { ticketId: claim.operation.ticket_id, stage: claim.operation.stage, category: diagnostic.category },
          "Inbound ticket routing has an unknown Telegram delivery outcome"
        );
        return "BLOCKED";
      }
    }

    return "BLOCKED";
  }

  private async resumeReadyInboundTicketOperations(
    api: BotApi,
    ticketId: number,
    staffChatId: number,
    blockedSource?: { chatId: number; messageId: number }
  ): Promise<void> {
    while (this.dependencies.installation.getStaffChatId() === staffChatId) {
      const operations = this.dependencies.db
        .listReadyTicketInboundRoutingOperationsForTicket(ticketId, staffChatId)
        .filter(
          (operation) =>
            operation.source_chat_id !== blockedSource?.chatId ||
            operation.source_message_id !== blockedSource?.messageId
        );
      if (operations.length === 0) return;
      for (const operation of operations) {
        if (this.dependencies.installation.getStaffChatId() !== staffChatId) return;
        await this.resumeInboundRoutingOperation(api, operation.source_chat_id, operation.source_message_id);
        const current = this.dependencies.db.getTicketInboundRoutingOperation(
          operation.source_chat_id,
          operation.source_message_id
        );
        if (
          current?.state === operation.state &&
          current.stage === operation.stage &&
          current.attempt === operation.attempt
        ) {
          logger.warn(
            { ticketId, stage: current.stage, attempt: current.attempt },
            "Stopped ready inbound routing drain without durable progress"
          );
          return;
        }
      }
    }
  }

  private async continueClosedTicketArchive(api: BotApi, ticket: TicketWithUser, staffChatId: number): Promise<void> {
    if (
      this.dependencies.installation.getStaffChatId() !== staffChatId ||
      ticket.staff_chat_id !== staffChatId ||
      this.dependencies.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id)
    )
      return;
    try {
      await archiveTicketIfPossible(api, this.dependencies.db, staffChatId, ticket.id);
    } catch (error) {
      logger.error({ err: error, ticketId: ticket.id }, "Could not continue archive after inbound routing delivery");
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

  private async deliverInteractiveStaffReply(
    operationKey: string,
    message: Parameters<SupportDatabase["addMessage"]>[0],
    send: () => Promise<number>
  ): Promise<number> {
    const intent = this.dependencies.db.createTicketOutboundDeliveryIntent({ ...message, operationKey });
    if (!intent.created) {
      if (intent.delivery.state === "DELIVERED" && intent.delivery.delivery_message_id !== null)
        return intent.delivery.delivery_message_id;
      if (intent.delivery.state === "PENDING" || intent.delivery.state === "UNKNOWN_DELIVERY") {
        throw new InteractiveReplyNotResentError(intent.delivery.state);
      }
      throw new Error(`Interactive reply ${intent.delivery.state}; it will not be resent automatically.`);
    }

    try {
      const deliveryMessageId = await send();
      const finalized = this.dependencies.db.markTicketOutboundDeliveryDelivered(operationKey, deliveryMessageId);
      if (finalized === null) throw new Error("Interactive reply delivery state changed before finalization");
      logger.info(
        { ticketId: message.ticketId, operationKey, state: "DELIVERED" },
        "Interactive staff reply delivered"
      );
      return finalized;
    } catch (error) {
      const diagnostic = normalizeTelegramDeliveryError(error);
      if (error instanceof GrammyError) {
        this.dependencies.db.markTicketOutboundDeliveryFailed(
          operationKey,
          diagnostic.category,
          diagnostic.description
        );
        logger.warn(
          { ticketId: message.ticketId, operationKey, state: "FAILED", category: diagnostic.category },
          "Interactive staff reply failed before Telegram delivery"
        );
      } else {
        this.dependencies.db.markTicketOutboundDeliveryUnknown(
          operationKey,
          "Telegram delivery outcome could not be confirmed."
        );
        logger.warn(
          { ticketId: message.ticketId, operationKey, state: "UNKNOWN_DELIVERY", category: diagnostic.category },
          "Interactive staff reply has an unknown Telegram delivery outcome"
        );
      }
      throw error;
    }
  }

  private async pinMessageSafely(api: BotApi, chatId: number, messageId: number, ticketId: number): Promise<void> {
    try {
      await api.pinChatMessage(chatId, messageId, { disable_notification: true });
    } catch (error) {
      logger.warn({ err: error, ticketId }, "Could not pin ticket summary");
    }
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

function hasSenderChat(message: NonNullable<Context["message"]>): boolean {
  return "sender_chat" in message && Boolean(message.sender_chat);
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
