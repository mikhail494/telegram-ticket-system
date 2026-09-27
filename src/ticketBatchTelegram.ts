import { randomUUID } from "node:crypto";
import { Bot, GrammyError, InlineKeyboard, InputFile } from "grammy";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { config } from "./config.js";
import type { SupportDatabase } from "./db.js";
import { logger } from "./logger.js";
import { normalizeTelegramDeliveryError, runReplaySafeTelegramEdit } from "./deliveryDiagnostics.js";
import type { InstallationService, Permission } from "./installation.js";
import type { PrivateControlPlane } from "./privateControlPlane.js";
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
  type TicketAnswerPackage,
  type TicketBatchAttachmentDownloadResult,
} from "./ticketBatch.js";
import { TELEGRAM_CALLBACK_DATA_MAX_BYTES } from "./telegram.js";
import { TicketBatchExportInProgressError, type TicketBatchRuntime } from "./ticketBatchRuntime.js";
import type { StaffChatOperationOptions } from "./staffChatDelivery.js";

export interface TicketBatchTelegramDependencies {
  bot: Bot<Context>;
  db: SupportDatabase;
  installation: InstallationService;
  ticketBatchRuntime: TicketBatchRuntime;
  fetchImpl: typeof fetch;
  runStaffChatOperation<T>(
    operation: () => Promise<T>,
    options: StaffChatOperationOptions,
    chatId?: number
  ): Promise<T>;
  requireStaffChatId(): number;
  isStaffChat(ctx: Context): boolean;
  isPrivateChat(ctx: Context): boolean;
  requirePermission(ctx: Context, permission: Permission): Promise<boolean>;
  requirePrivatePermission(ctx: Context, permission: Permission): Promise<boolean>;
  staffOnlyText: string;
  privateControlPlane: Pick<
    PrivateControlPlane,
    "renderScreen" | "refreshScreen" | "sendFreshScreen" | "retireScreens" | "showDashboard"
  >;
}

export function createTicketBatchTelegramSurface(dependencies: TicketBatchTelegramDependencies) {
  const {
    bot,
    db,
    installation,
    ticketBatchRuntime,
    fetchImpl,
    runStaffChatOperation,
    requireStaffChatId,
    isStaffChat,
    isPrivateChat,
    requirePermission,
    requirePrivatePermission,
    staffOnlyText: STAFF_ONLY_TEXT,
    privateControlPlane,
  } = dependencies;
  const renderPrivateScreen = privateControlPlane.renderScreen.bind(privateControlPlane);
  const refreshPrivateScreen = privateControlPlane.refreshScreen.bind(privateControlPlane);
  const sendFreshPrivateScreen = privateControlPlane.sendFreshScreen.bind(privateControlPlane);
  const retirePrivateScreens = privateControlPlane.retireScreens.bind(privateControlPlane);
  const showDashboard = privateControlPlane.showDashboard.bind(privateControlPlane);
  function privateBatchWorkflowSettingKey(userId: number): string {
    return `private_batch_export:${userId}`;
  }

  function getPendingPrivateBatchExport(userId: number): string | undefined {
    const exportId = db.getSetting(privateBatchWorkflowSettingKey(userId))?.trim();
    if (!exportId) return undefined;
    return db.getTicketBatchExport(exportId, requireStaffChatId())?.delivery_state === "DELIVERED"
      ? exportId
      : undefined;
  }

  function setPendingPrivateBatchExport(userId: number, exportId: string | undefined): void {
    db.setSetting(privateBatchWorkflowSettingKey(userId), exportId ?? "");
    installation.saveOnboardingStage(userId, exportId ? "BATCH_APPLY" : "WELCOME", exportId ? "ACTIVE" : "COMPLETED");
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
    return [
      "Waiting for answers",
      "",
      "Your ticket export is ready.",
      `Send the completed ticket-answers_${exportId}.json file here. Only a valid answer package for this export will continue.`,
      ...(notice ? ["", notice] : []),
    ].join("\n");
  }

  async function showPrivateBatchWaiting(
    ctx: Context,
    exportId: string,
    refresh = false,
    notice?: string
  ): Promise<void> {
    const render = refresh ? refreshPrivateScreen : renderPrivateScreen;
    await render(ctx, privateBatchWaitingText(exportId, notice), privateBatchWaitingKeyboard());
  }

  async function showPrivateBatchHelp(ctx: Context): Promise<void> {
    await renderPrivateScreen(
      ctx,
      [
        "Preparing batch answers",
        "",
        "1. Give your chosen AI assistant the product documentation, support policies, FAQ, tone guidance, and any other authoritative context it needs.",
        "2. Upload this ticket export ZIP to that assistant.",
        "3. Ask it to follow the instructions included in the archive and prepare the completed import file.",
        "4. Send the returned answer file here for preview and explicit approval.",
      ].join("\n"),
      new InlineKeyboard().text("Back", "batch-ui:continue")
    );
  }

  async function exportActiveTickets(ctx: Context, destinationChatId: number): Promise<string | undefined> {
    const staffChatId = requireStaffChatId();
    try {
      return await ticketBatchRuntime.runExport(staffChatId, async () => {
        let zip: Awaited<ReturnType<typeof createTicketBatchZip>> | undefined;
        let exportId: string | undefined;
        let deliveryAttempted = false;
        try {
          const tickets = db.listActiveTicketsForStaffChat(requireStaffChatId()).map((ticket) => ({
            ticket,
            messages: db.listMessagesChronological(ticket.id),
            followUpHistory: db.listTicketFollowUpHistory(ticket.id),
            deliveryFailure: db.getLatestTicketBatchDeliveryFailure(ticket.id, requireStaffChatId()),
            staffSync: db.getLatestTicketBatchStaffSyncContext(ticket.id, requireStaffChatId()),
          }));
          if (!tickets.length) {
            await ctx.reply("There are no active tickets to export.");
            return undefined;
          }

          exportId = `export_${randomUUID().replace(/-/g, "")}`;
          const createdAt = new Date().toISOString();
          const snapshot = buildTicketBatchExportSnapshot({
            exportId,
            createdAt,
            staffChatId: requireStaffChatId(),
            tickets,
          });
          zip = await createTicketBatchZip(
            snapshot,
            async (attachment): Promise<TicketBatchAttachmentDownloadResult> => {
              if (!attachment.fileId) {
                throw new TicketBatchValidationError(
                  `Ticket #${attachment.ticketId} message ${attachment.messageId} has no downloadable media reference.`
                );
              }
              let file;
              try {
                file = await ctx.api.getFile(attachment.fileId);
              } catch (error) {
                if (isHostedTelegramFileTooLargeError(error)) {
                  return {
                    unavailable: true,
                    failureCategory: "TELEGRAM_FILE_TOO_LARGE",
                    failureReason: "Attachment exceeds the hosted Telegram Bot API download limit.",
                  };
                }
                if (isUnavailableTelegramFileError(error)) {
                  return {
                    unavailable: true,
                    failureCategory: "TELEGRAM_FILE_UNAVAILABLE",
                    failureReason:
                      "Telegram could not retrieve this historical attachment with the current bot account. The stored file_id may belong to a previous bot identity or the file may no longer be available from Telegram.",
                  };
                }
                throw error;
              }
              if (!file.file_path) {
                throw new TicketBatchValidationError(
                  `Ticket #${attachment.ticketId} message ${attachment.messageId} attachment could not be retrieved.`
                );
              }
              const response = await fetchImpl(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
              if (!response.ok) {
                throw new TicketBatchValidationError(
                  `Ticket #${attachment.ticketId} message ${attachment.messageId} attachment could not be downloaded.`
                );
              }
              return { bytes: new Uint8Array(await response.arrayBuffer()), telegramFilePath: file.file_path };
            }
          );
          db.createTicketBatchExport({
            exportId,
            staffChatId: requireStaffChatId(),
            createdAt,
            selectionMode: "all_active",
            ticketCount: snapshot.records.length,
            items: snapshot.records.map((record) => ({
              ticketId: record.ticket.id,
              snapshotToken: record.snapshot_token,
            })),
            deliveryState: "PREPARING",
          });
          deliveryAttempted = true;
          const delivered = await ctx.api.sendDocument(destinationChatId, new InputFile(zip.filePath, zip.filename), {
            caption: formatTicketBatchExportCaption(exportId, zip),
          });
          try {
            db.markTicketBatchExportDelivered(exportId, requireStaffChatId(), delivered.message_id);
          } catch (error) {
            logger.error({ err: error, exportId }, "Ticket batch export delivery could not be persisted");
            try {
              db.markTicketBatchExportUnknownDelivery(
                exportId,
                requireStaffChatId(),
                "Export delivery outcome could not be confirmed."
              );
            } catch (persistenceError) {
              logger.warn(
                { err: persistenceError, exportId },
                "Could not persist unknown ticket batch export delivery state"
              );
            }
            await ctx.reply("Export delivery could not be confirmed. Do not upload an answer package for it.");
            return undefined;
          }
          return exportId;
        } catch (error) {
          logger.error({ err: error, exportId }, "Could not send ticket batch export");
          if (exportId) {
            try {
              if (deliveryAttempted && !(error instanceof GrammyError)) {
                db.markTicketBatchExportUnknownDelivery(
                  exportId,
                  requireStaffChatId(),
                  "Export delivery outcome could not be confirmed."
                );
              } else {
                db.markTicketBatchExportFailed(
                  exportId,
                  requireStaffChatId(),
                  "Export failed before confirmed delivery."
                );
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
        }
      });
    } catch (error) {
      if (!(error instanceof TicketBatchExportInProgressError)) throw error;
      await ctx.reply("An export is already running for this staff chat.");
      return undefined;
    }
  }

  function registerExportCommand(): void {
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
      if (!(await requirePermission(ctx, "BATCH_OPERATIONS"))) return;
      if (typeof ctx.message?.message_thread_id === "number") {
        await ctx.reply("Please run /exporttickets outside ticket topics.");
        return;
      }
      await exportActiveTickets(ctx, requireStaffChatId());
    });
  }

  async function handlePrivateWorkflowCallback(ctx: Context, data: string, namespace: string): Promise<void> {
    if (namespace === "batch-ui") {
      if (!(await requirePrivatePermission(ctx, "BATCH_OPERATIONS"))) {
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
        await renderPrivateScreen(
          ctx,
          "Abort this batch workflow? The export remains available in history, but this private answer-import flow will be cleared.",
          new InlineKeyboard()
            .text("Abort batch", "batch-ui:abort-confirm")
            .row()
            .text("Keep waiting", "batch-ui:continue")
        );
        return;
      }
      if (action === "abort-confirm") {
        setPendingPrivateBatchExport(ctx.from!.id, undefined);
        await showDashboard(ctx);
        return;
      }
      if (action === "recent") {
        const pending = db.getInstallationOperationalCounts().pendingBatchStaffOperations;
        await renderPrivateScreen(
          ctx,
          `Batch status\n\nPending staff synchronization: ${pending}`,
          new InlineKeyboard().text("Back", "dashboard:home")
        );
        return;
      }
      await showDashboard(ctx);
      return;
    }
  }

  async function handleTicketAnswerPackageUpload(ctx: Context, privateWorkflowExportId?: string): Promise<void> {
    const document = ctx.message && "document" in ctx.message ? ctx.message.document : undefined;
    if (!document || !ctx.chat) {
      return;
    }
    if (typeof document.file_size === "number" && document.file_size > 5 * 1024 * 1024) {
      if (privateWorkflowExportId && isPrivateChat(ctx)) {
        await showPrivateBatchWaiting(
          ctx,
          privateWorkflowExportId,
          true,
          "Ticket answer packages must be 5 MiB or smaller."
        );
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
      const exportRecord = db.getTicketBatchExport(exportId, requireStaffChatId());
      if (!exportRecord) {
        throw new TicketBatchValidationError("This answer package references an unknown export for this staff chat.");
      }
      if (privateWorkflowExportId && exportId !== privateWorkflowExportId) {
        throw new TicketBatchValidationError("This answer package belongs to a different export.");
      }
      if (exportRecord.delivery_state !== "DELIVERED") {
        throw new TicketBatchValidationError(
          "This answer package references an export whose delivery was not confirmed."
        );
      }
      const exportItems = db.listTicketBatchExportItems(exportId);
      const answerPackage = parseAndValidateAnswerPackage(raw, exportId, exportItems);
      const pages = buildTicketBatchPreviewPagesForAnswerPackage(answerPackage, exportItems);
      const packageHash = getAnswerPackageHash(answerPackage);
      const existingById = db.getTicketBatchAnswerPackage(answerPackage.answer_package_id, requireStaffChatId());
      const existingByHash = db.getTicketBatchAnswerPackageByHash(packageHash, requireStaffChatId());
      let persistedPackage = existingById;
      if (existingById && existingById.package_hash !== packageHash) {
        throw new TicketBatchValidationError("This answer_package_id was already imported with different content.");
      }
      if (!existingById && existingByHash) {
        throw new TicketBatchValidationError(
          "This answer package content was already imported under a different identity."
        );
      }
      if (persistedPackage && persistedPackage.status !== "PENDING") {
        throw new TicketBatchValidationError("This answer package is no longer previewable.");
      }
      if (!persistedPackage) {
        persistedPackage = db.createTicketBatchAnswerPackage({
          answerPackageId: answerPackage.answer_package_id,
          exportId,
          staffChatId: requireStaffChatId(),
          packageHash,
          sourceChatId: ctx.chat.id,
          sourceMessageId: ctx.message?.message_id ?? null,
          packageCreatedAt: answerPackage.created_at,
          items: answerPackage.answers,
        });
      }
      const previewToken = persistedPackage.preview_token ?? randomUUID().replace(/-/g, "");
      const previewPage = Math.min(Math.max(persistedPackage.preview_page ?? 0, 0), pages.length - 1);
      const text = formatTicketBatchPreviewPage(pages, previewPage);
      const keyboard = ticketBatchPreviewKeyboard(previewToken, previewPage, pages.length);
      if (persistedPackage.preview_chat_id !== null && persistedPackage.preview_message_id !== null) {
        await ctx.api.editMessageText(persistedPackage.preview_chat_id, persistedPackage.preview_message_id, text, {
          reply_markup: keyboard,
        });
        db.updateTicketBatchAnswerPackagePreviewPage(
          persistedPackage.answer_package_id,
          requireStaffChatId(),
          previewPage
        );
        if (isPrivateChat(ctx) && ctx.from) {
          setPendingPrivateBatchExport(ctx.from.id, undefined);
        }
        return;
      }
      const previewMessage =
        privateWorkflowExportId && isPrivateChat(ctx)
          ? await refreshPrivateScreen(ctx, text, keyboard)
          : await ctx.reply(text, { reply_markup: keyboard });
      if (
        !db.setTicketBatchAnswerPackagePreview(persistedPackage.answer_package_id, requireStaffChatId(), {
          token: previewToken,
          chatId: ctx.chat.id,
          messageId: previewMessage.message_id,
          page: previewPage,
        })
      ) {
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
      const message =
        error instanceof TicketBatchValidationError ? error.message : "Could not validate the ticket answer package.";
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
    const packageRecord = db.getTicketBatchAnswerPackageByPreviewToken(token, requireStaffChatId());
    if (
      !packageRecord ||
      packageRecord.preview_chat_id !== message.chat.id ||
      packageRecord.preview_message_id !== message.message_id
    ) {
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
        reply_markup: ticketBatchPreviewKeyboard(token, page, pages.length),
      });
      db.updateTicketBatchAnswerPackagePreviewPage(packageRecord.answer_package_id, requireStaffChatId(), page);
      await ctx.answerCallbackQuery();
      return;
    }
    if (action === "cancel") {
      const cancelled = db.cancelTicketBatchAnswerPackage(packageRecord.answer_package_id, requireStaffChatId());
      if (!cancelled) {
        await ctx.answerCallbackQuery({ text: "This package can no longer be cancelled." });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Ticket batch preview cancelled." });
      db.clearTicketBatchAnswerPackagePreview(packageRecord.answer_package_id, requireStaffChatId());
      await cleanupTicketBatchPreview(packageRecord, "Package cancelled.");
      if (isPrivateChat(ctx) && ctx.from) {
        setPendingPrivateBatchExport(ctx.from.id, packageRecord.export_id);
        await showPrivateBatchWaiting(
          ctx,
          packageRecord.export_id,
          true,
          "The preview was cancelled. You can send another answer file for this export."
        );
      }
      return;
    }

    const beforeClaim = db.getTicketBatchAnswerPackage(packageRecord.answer_package_id, requireStaffChatId());
    if (beforeClaim?.status === "APPLYING") {
      await ctx.answerCallbackQuery({ text: "Answer package is already being applied." });
      return;
    }
    if (beforeClaim?.status === "COMPLETED") {
      await ctx.answerCallbackQuery({ text: "Answer package is already completed." });
      return;
    }
    const claimed = db.claimTicketBatchAnswerPackage(packageRecord.answer_package_id, requireStaffChatId());
    if (!claimed) {
      const current = db.getTicketBatchAnswerPackage(packageRecord.answer_package_id, requireStaffChatId());
      await ctx.answerCallbackQuery({
        text:
          current?.status === "APPLYING"
            ? "Answer package is already being applied."
            : current?.status === "CANCELLED"
              ? "This package was cancelled."
              : "Answer package not found.",
      });
      return;
    }
    if (claimed.status === "CANCELLED") {
      await ctx.answerCallbackQuery({ text: "This package was cancelled." });
      return;
    }

    // Clear the active callback token immediately, but retain the message coordinates in final-summary state.
    db.clearTicketBatchAnswerPackagePreview(claimed.answer_package_id, requireStaffChatId());
    await ctx.answerCallbackQuery({ text: "Applying answer package..." });
    await neutralizeTicketBatchPreview(claimed, "Applying...");
    const summary = await ticketBatchRuntime.applyAnswerPackage(claimed.answer_package_id, ctx.from);
    db.queueTicketBatchFinalSummary(claimed.answer_package_id, requireStaffChatId(), {
      text: summary,
      chatId: ctx.chat?.id ?? requireStaffChatId(),
      originChatId: claimed.preview_chat_id,
      originMessageId: claimed.preview_message_id,
    });
    await ticketBatchRuntime.recoverPendingStaffOperations(claimed.answer_package_id);
  }

  function buildStoredTicketBatchPreviewPages(
    packageRecord: ReturnType<SupportDatabase["getTicketBatchAnswerPackage"]>
  ): string[] {
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
        escalation_target: item.escalation_target,
      })),
    };
    return buildTicketBatchPreviewPagesForAnswerPackage(
      answerPackage,
      db.listTicketBatchExportItems(packageRecord.export_id)
    );
  }

  function buildTicketBatchPreviewPagesForAnswerPackage(
    answerPackage: TicketAnswerPackage,
    exportItems: ReturnType<SupportDatabase["listTicketBatchExportItems"]>
  ): string[] {
    const preview = buildAnswerPackagePreview(answerPackage, exportItems, (ticketId) => {
      const ticket = db.getTicketWithUser(ticketId);
      if (!ticket || ticket.staff_chat_id !== requireStaffChatId()) return null;
      return {
        status: ticket.status,
        snapshotToken: getTicketSnapshotToken(ticket, db.listMessagesChronological(ticket.id)),
      };
    });
    return buildTicketBatchPreviewPages(answerPackage.export_id, preview);
  }

  async function cleanupTicketBatchPreview(
    packageRecord: NonNullable<ReturnType<SupportDatabase["getTicketBatchAnswerPackage"]>>,
    fallbackText: string
  ): Promise<boolean> {
    if (packageRecord.preview_chat_id === null || packageRecord.preview_message_id === null) {
      return true;
    }
    try {
      await bot.api.deleteMessage(packageRecord.preview_chat_id, packageRecord.preview_message_id);
      return true;
    } catch (error) {
      const diagnostic = normalizeTelegramDeliveryError(error);
      logger.warn(
        { answerPackageId: packageRecord.answer_package_id, category: diagnostic.category },
        "Could not delete ticket batch preview"
      );
      try {
        await bot.api.editMessageText(packageRecord.preview_chat_id, packageRecord.preview_message_id, fallbackText, {
          reply_markup: undefined,
        });
      } catch (editError) {
        const diagnostic = normalizeTelegramDeliveryError(editError);
        logger.warn(
          { answerPackageId: packageRecord.answer_package_id, category: diagnostic.category },
          "Could not neutralize ticket batch preview"
        );
      }
      return false;
    }
  }

  async function neutralizeTicketBatchPreview(
    packageRecord: NonNullable<ReturnType<SupportDatabase["getTicketBatchAnswerPackage"]>>,
    text: string
  ): Promise<void> {
    if (packageRecord.preview_chat_id === null || packageRecord.preview_message_id === null) return;
    const previewChatId = packageRecord.preview_chat_id;
    const previewMessageId = packageRecord.preview_message_id;
    try {
      await runStaffChatOperation(
        () =>
          runReplaySafeTelegramEdit(() =>
            bot.api.editMessageText(previewChatId, previewMessageId, text, { reply_markup: undefined })
          ),
        { replaySafety: "REPLAY_SAFE", operationName: "editMessageText" },
        previewChatId
      );
    } catch (error) {
      const failure = ticketBatchRuntime.scheduleRecoveryForStaffOperation(error);
      logger.warn(
        { answerPackageId: packageRecord.answer_package_id, category: failure.category },
        "Could not neutralize active ticket batch preview"
      );
    }
  }

  function ticketBatchCancelCallbackData(previewToken: string): string {
    const callbackData = `batch:cancel:${previewToken}`;
    const byteLength = Buffer.byteLength(callbackData, "utf8");
    if (byteLength > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
      throw new Error(
        `Ticket batch callback_data exceeds ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes (${byteLength} bytes).`
      );
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
      throw new Error(
        `Ticket batch callback_data exceeds ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes (${byteLength} bytes).`
      );
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
    return keyboard
      .row()
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
    zip: Pick<
      Awaited<ReturnType<typeof createTicketBatchZip>>,
      "ticketCount" | "messageCount" | "attachmentCount" | "embeddedAttachmentCount" | "failedAttachmentCount"
    >
  ): string {
    const attachments = zip.failedAttachmentCount
      ? `Attachments: ${zip.embeddedAttachmentCount} embedded, ${zip.failedAttachmentCount} unavailable`
      : `Attachments: ${zip.attachmentCount}`;
    return [
      "Ticket export ready",
      `Export: ${exportId}`,
      `Tickets: ${zip.ticketCount}`,
      `Messages: ${zip.messageCount}`,
      attachments,
      `Use the included instructions to prepare and return ticket-answers_${exportId}.json.`,
    ].join("\n");
  }

  function isHostedTelegramFileTooLargeError(error: unknown): error is GrammyError {
    return error instanceof GrammyError && error.error_code === 400 && /\bfile is too big\b/i.test(error.description);
  }

  function isUnavailableTelegramFileError(error: unknown): error is GrammyError {
    return (
      error instanceof GrammyError &&
      error.error_code === 400 &&
      /\bwrong file_id or the file is temporarily unavailable\b/i.test(error.description)
    );
  }

  return {
    registerExportCommand,
    getPendingPrivateBatchExport,
    showPrivateBatchWaiting,
    isTicketAnswerPackageDocument,
    handlePrivateWorkflowCallback,
    handleTicketAnswerPackageUpload,
    handleTicketBatchCallback,
  };
}
