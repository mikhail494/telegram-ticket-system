import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { Permission } from "./installation.js";
import { logger } from "./logger.js";
import { InteractiveReplyNotResentError, type TicketRoutingService } from "./ticketRouting.js";
import type { TicketWithUser, SupportDatabase } from "./db.js";
import type { QuickRepliesRegistry } from "./quickReplies.js";
import { TELEGRAM_CALLBACK_DATA_MAX_BYTES } from "./telegram.js";

type QuickRepliesTicketRouting = Pick<
  TicketRoutingService,
  "deliverAndRecordStaffTextReply" | "sendStaffTopicNotice" | "refreshTicket"
>;

export interface QuickRepliesTelegramDependencies {
  db: Pick<SupportDatabase, "getTicketWithUser" | "transitionTicketStatusIfCurrent">;
  registry: QuickRepliesRegistry;
  ticketRouting: QuickRepliesTicketRouting;
  requireStaffChatId(): number;
  isStaffChat(ctx: Context): boolean;
  hasApplicationPermission(ctx: Context, permission: Permission): boolean;
  parseTicketId(value: string): number | null;
  describeError(error: unknown): string;
}

interface QuickRepliesCallbackTarget {
  ticket: TicketWithUser;
  messageChatId: number;
  messageId: number;
  messageThreadId: number;
}

export function createQuickRepliesTelegramSurface(dependencies: QuickRepliesTelegramDependencies) {
  const {
    db,
    registry,
    ticketRouting,
    requireStaffChatId,
    isStaffChat,
    hasApplicationPermission,
    parseTicketId,
    describeError,
  } = dependencies;

  function quickRepliesCategoryKeyboard(ticketId: number): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    for (const category of registry.listCategories()) {
      keyboard.text(category.title, quickRepliesCategoryCallbackData(ticketId, category.id)).row();
    }

    return keyboard.text("Cancel", quickRepliesCancelCallbackData(ticketId));
  }

  function quickRepliesTemplateKeyboard(ticketId: number, categoryId: string, page: number): InlineKeyboard {
    const templates = registry.listTemplates(categoryId);
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
        show_alert: true,
      });
      return null;
    }
    if (!hasApplicationPermission(ctx, "REPLY_TO_TICKETS")) {
      await ctx.answerCallbackQuery({ text: "Your application role does not allow ticket replies.", show_alert: true });
      return null;
    }

    const ticketId = parseTicketId(rawTicketId ?? "");
    if (!ticketId) {
      await ctx.answerCallbackQuery({ text: "Invalid ticket." });
      return null;
    }

    const ticket = db.getTicketWithUser(ticketId);
    if (!ticket || ticket.staff_chat_id !== requireStaffChatId()) {
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
      callbackMessage && "message_thread_id" in callbackMessage ? callbackMessage.message_thread_id : undefined;

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
      messageThreadId: ticketMessageThreadId,
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
          show_alert: true,
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
    const callbackId = ctx.callbackQuery?.id;
    if (!callbackId) return;
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
        await ctx.api.sendMessage(requireStaffChatId(), "Quick replies\nChoose a category:", {
          message_thread_id: target.messageThreadId,
          reply_markup: quickRepliesCategoryKeyboard(target.ticket.id),
        });
      });
      return;
    }

    if (action === "cancel") {
      await runQuickRepliesCallbackOperation(ctx, "Quick replies closed.", async () => {
        await ctx.api.editMessageReplyMarkup(target.messageChatId, target.messageId, {
          reply_markup: undefined,
        });
      });
      return;
    }

    if (action === "back") {
      await runQuickRepliesCallbackOperation(ctx, "Quick replies opened.", async () => {
        await ctx.api.editMessageText(target.messageChatId, target.messageId, "Quick replies\nChoose a category:", {
          reply_markup: quickRepliesCategoryKeyboard(target.ticket.id),
        });
      });
      return;
    }

    if (action === "template") {
      const template = registry.findTemplate(rawResourceId ?? "");
      if (!template) {
        await ctx.answerCallbackQuery({ text: "Quick Replies template not found." });
        return;
      }

      try {
        await ticketRouting.deliverAndRecordStaffTextReply(target.ticket, template.text, ctx.from, {
          chatId: target.messageChatId,
          messageId: target.messageId,
          operationKey: `quick-reply:${callbackId}`,
        });
      } catch (error) {
        logger.error({ err: error, ticketId: target.ticket.id }, "Could not deliver Quick Reply to user");
        const outcomeUnknown = error instanceof InteractiveReplyNotResentError;
        await ticketRouting.sendStaffTopicNotice(
          ctx.api,
          requireStaffChatId(),
          target.ticket,
          outcomeUnknown
            ? "Delivery outcome is unknown; the reply was not resent automatically."
            : `Could not send quick reply for ticket #${target.ticket.id} to user ${target.ticket.user_telegram_id}: ${describeError(error)}`
        );
        await ctx.answerCallbackQuery({
          text: outcomeUnknown
            ? "Delivery outcome is unknown; the reply was not resent automatically."
            : "Could not send quick reply.",
          show_alert: true,
        });
        return;
      }

      if (target.ticket.status === "OPEN") {
        try {
          const transition = db.transitionTicketStatusIfCurrent(
            target.ticket.id,
            requireStaffChatId(),
            "OPEN",
            "IN_PROGRESS"
          );
          if (transition.outcome === "APPLIED") await ticketRouting.refreshTicket(target.ticket.id);
        } catch (error) {
          logger.warn({ err: error, ticketId: target.ticket.id }, "Could not refresh ticket after Quick Reply");
        }
      }

      try {
        await ctx.api.editMessageText(target.messageChatId, target.messageId, `Quick reply sent\n${template.title}`, {
          reply_markup: undefined,
        });
      } catch (error) {
        logger.warn({ err: error, ticketId: target.ticket.id }, "Could not clean up Quick Replies menu");
      }

      await ctx.answerCallbackQuery({ text: "Quick reply sent." });
      return;
    }

    const category = registry.findCategory(rawResourceId ?? "");
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
          reply_markup: quickRepliesTemplateKeyboard(target.ticket.id, category.id, page),
        }
      );
    });
  }

  return { handleCallback: handleQuickRepliesCallback };
}

export function quickRepliesOpenCallbackData(ticketId: number): string {
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

function parseQuickRepliesPage(value: string | undefined): number | null {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }

  const page = Number(value);
  return Number.isSafeInteger(page) ? page : null;
}
