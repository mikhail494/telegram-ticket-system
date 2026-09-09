import { GrammyError, HttpError, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { User } from "grammy/types";
import type { ArchiveActor } from "./archive.js";
import {
  formatDeliveryFailureCategory,
  normalizeTelegramDeliveryError,
  type NormalizedDeliveryError,
} from "./deliveryDiagnostics.js";
import { type SupportDatabase, type TicketBatchAnswerItemRecord, type TicketWithUser } from "./db.js";
import { formatEscalationTarget, formatFollowUpState, truncate } from "./format.js";
import { InstallationService } from "./installation.js";
import { type BackgroundTaskTracker } from "./lifecycle.js";
import { logger } from "./logger.js";
import { getTicketSnapshotToken } from "./ticketBatch.js";

const STAFF_OPERATION_NO_RETRY_AT = "9999-12-31T23:59:59.999Z";

class TicketBatchRecoveryWorkspaceChangedError extends Error {}

export class TicketBatchStaffOperationError extends Error {
  constructor(
    readonly diagnostic: NormalizedDeliveryError,
    readonly retryAt: string | null
  ) {
    super(diagnostic.category);
  }
}

export class TicketBatchExportInProgressError extends Error {
  constructor() {
    super("Ticket batch export is already running for this staff chat.");
  }
}

type TicketBatchItem = ReturnType<SupportDatabase["listTicketBatchAnswerItems"]>[number];

interface TicketBatchCloseOptions {
  notifyUser: boolean;
  staffNotice: string;
  closedBy: ArchiveActor;
  onArchiveFailure: (diagnostic: NormalizedDeliveryError) => void;
}

export interface TicketBatchRuntimeDependencies {
  db: SupportDatabase;
  api: Context["api"];
  installation: InstallationService;
  backgroundTasks: BackgroundTaskTracker;
  runStaffChatOperation<T>(operation: () => Promise<T>, chatId?: number): Promise<T>;
  deliverUserReply(ticket: TicketWithUser, text: string, staffUser: User | undefined): Promise<number>;
  closeTicket(ticketId: number, options: TicketBatchCloseOptions, staffChatId?: number): Promise<void>;
  staffActor(staffUser: User | undefined): ArchiveActor;
  refreshTicket(ticketId: number, staffChatId?: number): Promise<void>;
  now?: () => Date;
  createRecoveryTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearRecoveryTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class TicketBatchRuntime {
  private readonly runningExports = new Set<number>();
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryTimerAt: number | undefined;
  private recoveryQueue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly dependencies: TicketBatchRuntimeDependencies) {}

  private get db(): SupportDatabase {
    return this.dependencies.db;
  }

  private get api(): Context["api"] {
    return this.dependencies.api;
  }

  private get installation(): InstallationService {
    return this.dependencies.installation;
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private requireStaffChatId(): number {
    return this.installation.requireStaffChatId();
  }

  private ensureRecoveryWorkspace(staffChatId: number): void {
    if (this.requireStaffChatId() === staffChatId) return;
    this.scheduleRecovery(this.now().toISOString());
    throw new TicketBatchRecoveryWorkspaceChangedError();
  }

  private ensureRecoveryWorkspaceIfNeeded(staffChatId: number | undefined): void {
    if (staffChatId !== undefined) this.ensureRecoveryWorkspace(staffChatId);
  }

  private async awaitRecoveryOperation<T>(
    recoveryStaffChatId: number | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    if (recoveryStaffChatId === undefined) return operation();
    this.ensureRecoveryWorkspace(recoveryStaffChatId);
    try {
      const result = await operation();
      this.ensureRecoveryWorkspace(recoveryStaffChatId);
      return result;
    } catch (error) {
      this.ensureRecoveryWorkspace(recoveryStaffChatId);
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.recoveryTimer) (this.dependencies.clearRecoveryTimer ?? clearTimeout)(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryTimerAt = undefined;
  }

  async runExport<T>(staffChatId: number, operation: () => Promise<T>): Promise<T> {
    if (this.runningExports.has(staffChatId)) throw new TicketBatchExportInProgressError();
    this.runningExports.add(staffChatId);
    try {
      return await operation();
    } finally {
      this.runningExports.delete(staffChatId);
    }
  }

  scheduleRecoveryForStaffOperation(error: unknown): { category: string; retryAt: string | null } {
    const failure = this.batchStaffFailure(error);
    this.scheduleRecovery(failure.retryAt);
    return failure;
  }

  async applyAnswerPackage(answerPackageId: string, staffUser: User | undefined): Promise<string> {
    const packageRecord = this.db.getTicketBatchAnswerPackage(answerPackageId, this.requireStaffChatId());
    if (!packageRecord) return "Answer package not found.";
    const exportItems = this.db.listTicketBatchExportItems(packageRecord.export_id);
    const exportTokens = new Map(exportItems.map((item) => [item.ticket_id, item.snapshot_token]));
    const items = this.db.listTicketBatchAnswerItems(answerPackageId);
    const totals = {
      keep: 0,
      close: 0,
      silentClose: 0,
      noAction: 0,
      stale: 0,
      inactive: 0,
      unknown: 0,
      replySent: 0,
      staffSync: 0,
      skipped: 0,
      permanentFailures: [] as Array<{ ticketId: number; category: string }>,
      temporaryFailures: [] as Array<{ ticketId: number; category: string; retryAfter: number | null }>,
    };

    for (const item of items) {
      if (["COMPLETED", "NO_ACTION", "STALE", "INACTIVE"].includes(item.state)) {
        totals.skipped += 1;
        continue;
      }
      if (item.action === "silent_close" && item.state === "APPLYING") {
        const continuation = await this.resumeSilentClose(item, staffUser);
        if (continuation === "COMPLETED") totals.silentClose += 1;
        else if (continuation === "STALE") totals.stale += 1;
        else if (continuation === "INACTIVE") totals.inactive += 1;
        continue;
      }
      if (item.state === "UNKNOWN_DELIVERY" || item.state === "APPLYING") {
        this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "UNKNOWN_DELIVERY", {
          lastError: "Delivery outcome requires manual review.",
        });
        totals.unknown += 1;
        continue;
      }
      const ticket = this.db.getTicketWithUser(item.ticket_id);
      if (item.state === "STAFF_SYNC_PENDING") {
        if (!ticket || ticket.staff_chat_id !== this.requireStaffChatId()) {
          this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "INACTIVE", { applied: true });
          totals.inactive += 1;
          continue;
        }
        if (ticket.status === "CLOSED" && item.action === "reply_and_close" && this.isConfirmedReply(item)) {
          this.db.recordTicketBatchTopicEcho(answerPackageId, item.ticket_id, "NOT_REQUIRED", {
            lastError: "Staff topic echo is no longer available after ticket closure.",
          });
          const continuation = await this.resumeReplyAndClosePostDelivery(item, staffUser);
          if (continuation === "COMPLETED") totals.close += 1;
          else if (continuation === "INACTIVE") totals.inactive += 1;
          else totals.replySent += 1;
          continue;
        }
        if (ticket.status === "CLOSED") {
          this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "INACTIVE", { applied: true });
          totals.inactive += 1;
          continue;
        }
        try {
          await this.sendTopicEcho(ticket, item);
          await this.dependencies.refreshTicket(ticket.id);
          if (item.action === "no_action") {
            this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "NO_ACTION", { applied: true });
            totals.noAction += 1;
          } else if (item.action === "reply_and_close") {
            const continuation = await this.resumeReplyAndClosePostDelivery(item, staffUser);
            if (continuation === "COMPLETED") totals.close += 1;
            else if (continuation === "INACTIVE") totals.inactive += 1;
            else totals.replySent += 1;
          } else {
            this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "COMPLETED", { applied: true });
            totals.keep += 1;
          }
        } catch (error) {
          this.recordTopicEchoFailure(answerPackageId, item.ticket_id, error);
          totals.staffSync += 1;
        }
        continue;
      }
      if (item.state === "REPLY_SENT" && item.action === "reply_and_close") {
        if (!ticket || ticket.staff_chat_id !== this.requireStaffChatId()) {
          this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "INACTIVE", { applied: true });
          totals.inactive += 1;
          continue;
        }
        if (item.topic_echo_state !== "SENT" && ticket.status === "CLOSED") {
          this.db.recordTicketBatchTopicEcho(answerPackageId, item.ticket_id, "NOT_REQUIRED", {
            lastError: "Staff topic echo is no longer available after ticket closure.",
          });
        } else if (item.topic_echo_state !== "SENT") {
          try {
            await this.sendTopicEcho(ticket, item);
          } catch (error) {
            this.recordTopicEchoFailure(answerPackageId, item.ticket_id, error);
            totals.staffSync += 1;
            continue;
          }
        }
        const continuation = await this.resumeReplyAndClosePostDelivery(item, staffUser);
        if (continuation === "COMPLETED") totals.close += 1;
        else if (continuation === "INACTIVE") totals.inactive += 1;
        else totals.replySent += 1;
        continue;
      }
      const expectedToken = exportTokens.get(item.ticket_id);
      if (!ticket || ticket.staff_chat_id !== this.requireStaffChatId() || ticket.status === "CLOSED") {
        this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "INACTIVE", { applied: true });
        totals.inactive += 1;
        continue;
      }
      if (
        !expectedToken ||
        item.snapshot_token !== expectedToken ||
        getTicketSnapshotToken(ticket, this.db.listMessagesChronological(ticket.id)) !== expectedToken
      ) {
        this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "STALE", { applied: true });
        totals.stale += 1;
        continue;
      }
      if (!this.db.claimTicketBatchAnswerItem(answerPackageId, item.ticket_id)) {
        totals.skipped += 1;
        continue;
      }
      if (item.action === "silent_close") {
        const continuation = await this.resumeSilentClose(item, staffUser);
        if (continuation === "COMPLETED") totals.silentClose += 1;
        else if (continuation === "STALE") totals.stale += 1;
        else if (continuation === "INACTIVE") totals.inactive += 1;
        continue;
      }
      if (item.action === "no_action") {
        try {
          if (this.hasFollowUpContext(item)) this.persistFollowUp(ticket, item);
          await this.sendTopicEcho(ticket, item);
          await this.dependencies.refreshTicket(ticket.id);
          this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "NO_ACTION", { applied: true });
          totals.noAction += 1;
        } catch (error) {
          this.recordTopicEchoFailure(answerPackageId, item.ticket_id, error);
          this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "STAFF_SYNC_PENDING", {
            lastError: "Staff topic echo pending retry.",
          });
          totals.staffSync += 1;
        }
        continue;
      }
      let deliveryMessageId: number;
      try {
        deliveryMessageId = await this.dependencies.deliverUserReply(ticket, item.reply_text ?? "", staffUser);
      } catch (error) {
        const diagnostic = normalizeTelegramDeliveryError(error);
        const state = diagnostic.permanence === "UNKNOWN_DELIVERY" ? "UNKNOWN_DELIVERY" : "FAILED";
        this.db.recordTicketBatchDeliveryFailure(answerPackageId, item.ticket_id, state, diagnostic);
        this.db.recordTicketBatchTopicEcho(answerPackageId, item.ticket_id, "NOT_REQUIRED");
        logger.warn(
          {
            answerPackageId,
            ticketId: item.ticket_id,
            category: diagnostic.category,
            permanence: diagnostic.permanence,
            method: diagnostic.method,
            telegramErrorCode: diagnostic.telegramErrorCode,
            retryAfterSeconds: diagnostic.retryAfterSeconds,
          },
          "Ticket batch user delivery failed"
        );
        const failedItem = this.db
          .listTicketBatchAnswerItems(answerPackageId)
          .find((candidate) => candidate.ticket_id === item.ticket_id);
        if (failedItem) {
          try {
            await this.sendDeliveryFailureEvent(ticket, failedItem, diagnostic);
          } catch {
            logger.warn(
              { answerPackageId, ticketId: item.ticket_id, category: diagnostic.category },
              "Could not post ticket batch delivery failure event"
            );
          }
        }
        if (diagnostic.permanence === "PERMANENT") {
          totals.permanentFailures.push({ ticketId: item.ticket_id, category: diagnostic.category });
        } else if (diagnostic.permanence === "TEMPORARY") {
          totals.temporaryFailures.push({
            ticketId: item.ticket_id,
            category: diagnostic.category,
            retryAfter: diagnostic.retryAfterSeconds,
          });
        } else {
          totals.unknown += 1;
        }
        continue;
      }
      let postDeliveryStage = "FOLLOW_UP_PERSISTENCE";
      try {
        this.persistFollowUp(ticket, item);
        this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "REPLY_SENT", {
          deliveryMessageId,
          applied: true,
        });
        postDeliveryStage = "STAFF_TOPIC_ECHO";
        try {
          await this.sendTopicEcho(ticket, item);
        } catch (error) {
          this.recordTopicEchoFailure(answerPackageId, item.ticket_id, error);
          this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "STAFF_SYNC_PENDING", {
            deliveryMessageId,
            lastError: "Staff topic echo pending retry.",
          });
          totals.staffSync += 1;
          continue;
        }
        if (item.action === "reply_keep_open") {
          postDeliveryStage = "STAFF_SUMMARY_REFRESH";
          this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "COMPLETED", {
            deliveryMessageId,
            applied: true,
          });
          await this.dependencies.refreshTicket(ticket.id);
          totals.keep += 1;
          continue;
        }
        postDeliveryStage = "REPLY_AND_CLOSE_CONTINUATION";
        const continuation = await this.resumeReplyAndClosePostDelivery(item, staffUser);
        if (continuation === "COMPLETED") totals.close += 1;
        else if (continuation === "INACTIVE") totals.inactive += 1;
        else totals.replySent += 1;
      } catch (error) {
        const diagnostic = normalizeTelegramDeliveryError(error);
        this.db.updateTicketBatchAnswerItem(answerPackageId, item.ticket_id, "REPLY_SENT", {
          deliveryMessageId,
          lastError: "Reply sent; follow-up, staff sync, or close/archive pending.",
        });
        logger.warn(
          {
            answerPackageId,
            ticketId: item.ticket_id,
            stage: postDeliveryStage,
            category: diagnostic.category,
            method: diagnostic.method,
            telegramErrorCode: diagnostic.telegramErrorCode,
            httpStatus: diagnostic.httpStatus,
          },
          "Ticket batch post-delivery apply step remains pending"
        );
        totals.replySent += 1;
      }
    }
    this.db.finalizeTicketBatchAnswerPackage(answerPackageId, this.requireStaffChatId());
    return this.buildSummary(answerPackageId);
  }

  private async resumeSilentClose(
    item: TicketBatchAnswerItemRecord,
    staffUser: User | undefined,
    recoveryStaffChatId?: number
  ): Promise<"COMPLETED" | "PENDING" | "STALE" | "INACTIVE"> {
    this.ensureRecoveryWorkspaceIfNeeded(recoveryStaffChatId);
    const staffChatId = recoveryStaffChatId ?? this.requireStaffChatId();
    const persistedItem = this.db
      .listTicketBatchAnswerItems(item.answer_package_id)
      .find((candidate) => candidate.ticket_id === item.ticket_id);
    if (!persistedItem || persistedItem.action !== "silent_close") return "INACTIVE";
    const ticket = this.db.getTicketWithUser(item.ticket_id);
    if (!ticket || ticket.staff_chat_id !== staffChatId) {
      this.db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "INACTIVE", { applied: true });
      return "INACTIVE";
    }
    if (
      ticket.status !== "CLOSED" &&
      getTicketSnapshotToken(ticket, this.db.listMessagesChronological(ticket.id)) !== persistedItem.snapshot_token
    ) {
      this.db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "STALE", { applied: true });
      return "STALE";
    }
    this.db.recordTicketBatchTopicEcho(item.answer_package_id, item.ticket_id, "NOT_REQUIRED");
    this.db.recordTicketBatchFailureEvent(item.answer_package_id, item.ticket_id, "NOT_REQUIRED");
    let archiveFailure: NormalizedDeliveryError | undefined;
    try {
      await this.awaitRecoveryOperation(recoveryStaffChatId, () =>
        this.dependencies.closeTicket(
          ticket.id,
          {
            notifyUser: false,
            staffNotice: "Ticket silently closed by batch answer.",
            closedBy: this.dependencies.staffActor(staffUser),
            onArchiveFailure: (diagnostic) => {
              archiveFailure = diagnostic;
            },
          },
          staffChatId
        )
      );
    } catch (error) {
      if (error instanceof TicketBatchRecoveryWorkspaceChangedError) throw error;
      const diagnostic = normalizeTelegramDeliveryError(error);
      const retryAt = this.continuationRetryAt(diagnostic, error);
      this.db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "APPLYING", {
        lastError: "Silent ticket close or archive remains pending.",
      });
      this.db.setTicketBatchPostDeliveryRetry(item.answer_package_id, item.ticket_id, retryAt, diagnostic.category);
      if (retryAt !== STAFF_OPERATION_NO_RETRY_AT) this.scheduleRecovery(retryAt);
      logger.warn(
        { answerPackageId: item.answer_package_id, ticketId: item.ticket_id, category: diagnostic.category },
        "Silent batch ticket closure remains pending"
      );
      return "PENDING";
    }
    const reconciledTicket = this.db.getTicketWithUser(item.ticket_id);
    if (reconciledTicket?.status === "CLOSED" && reconciledTicket.archived_at !== null) {
      this.db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "COMPLETED", { applied: true });
      this.db.setTicketBatchPostDeliveryRetry(item.answer_package_id, item.ticket_id, null, null);
      return "COMPLETED";
    }
    this.db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "APPLYING", {
      lastError: "Silent ticket close completed; transcript archive pending.",
    });
    const retryAt = archiveFailure
      ? this.continuationRetryAt(archiveFailure)
      : new Date(this.now().getTime() + 60_000).toISOString();
    this.db.setTicketBatchPostDeliveryRetry(
      item.answer_package_id,
      item.ticket_id,
      retryAt,
      archiveFailure?.category ?? "ARCHIVE"
    );
    if (retryAt !== STAFF_OPERATION_NO_RETRY_AT) this.scheduleRecovery(retryAt);
    return "PENDING";
  }

  private async resumeReplyAndClosePostDelivery(
    item: TicketBatchAnswerItemRecord,
    staffUser: User | undefined,
    recoveryStaffChatId?: number
  ): Promise<"COMPLETED" | "PENDING" | "INACTIVE"> {
    this.ensureRecoveryWorkspaceIfNeeded(recoveryStaffChatId);
    const staffChatId = recoveryStaffChatId ?? this.requireStaffChatId();
    const persistedItem = this.db
      .listTicketBatchAnswerItems(item.answer_package_id)
      .find((candidate) => candidate.ticket_id === item.ticket_id);
    if (!persistedItem || persistedItem.action !== "reply_and_close") return "INACTIVE";
    if (!this.isConfirmedReply(persistedItem)) {
      logger.warn(
        { answerPackageId: item.answer_package_id, ticketId: item.ticket_id, stage: "USER_REPLY_DELIVERY" },
        "Refused reply-and-close continuation without confirmed user delivery"
      );
      return "PENDING";
    }
    const ticket = this.db.getTicketWithUser(item.ticket_id);
    if (!ticket || ticket.staff_chat_id !== staffChatId) {
      this.db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "INACTIVE", { applied: true });
      return "INACTIVE";
    }
    const echoResolved =
      persistedItem.topic_echo_state === "SENT" ||
      (persistedItem.topic_echo_state === "NOT_REQUIRED" && ticket.status === "CLOSED");
    if (!echoResolved) return "PENDING";
    let archiveFailure: NormalizedDeliveryError | undefined;
    try {
      await this.awaitRecoveryOperation(recoveryStaffChatId, () =>
        this.dependencies.closeTicket(
          ticket.id,
          {
            notifyUser: true,
            staffNotice: "Ticket closed by batch answer.",
            closedBy: this.dependencies.staffActor(staffUser),
            onArchiveFailure: (diagnostic) => {
              archiveFailure = diagnostic;
            },
          },
          staffChatId
        )
      );
    } catch (error) {
      if (error instanceof TicketBatchRecoveryWorkspaceChangedError) throw error;
      const diagnostic = normalizeTelegramDeliveryError(error);
      const retryAt = this.continuationRetryAt(diagnostic, error);
      this.db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "REPLY_SENT", {
        lastError: "Reply sent; ticket close or archive pending.",
      });
      this.db.setTicketBatchPostDeliveryRetry(item.answer_package_id, item.ticket_id, retryAt, diagnostic.category);
      if (retryAt !== STAFF_OPERATION_NO_RETRY_AT) this.scheduleRecovery(retryAt);
      logger.warn(
        {
          answerPackageId: item.answer_package_id,
          ticketId: item.ticket_id,
          stage: "TICKET_CLOSE_OR_ARCHIVE",
          category: diagnostic.category,
          method: diagnostic.method,
          telegramErrorCode: diagnostic.telegramErrorCode,
          httpStatus: diagnostic.httpStatus,
        },
        "Reply-and-close post-delivery continuation remains pending"
      );
      return "PENDING";
    }
    const reconciledTicket = this.db.getTicketWithUser(item.ticket_id);
    if (reconciledTicket?.status === "CLOSED" && reconciledTicket.archived_at !== null) {
      this.db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "COMPLETED", { applied: true });
      this.db.setTicketBatchPostDeliveryRetry(item.answer_package_id, item.ticket_id, null, null);
      return "COMPLETED";
    }
    const pendingStage = reconciledTicket?.status === "CLOSED" ? "ARCHIVE" : "SQLITE_CLOSE";
    this.db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "REPLY_SENT", {
      lastError:
        pendingStage === "ARCHIVE" ? "Reply sent; transcript archive pending." : "Reply sent; ticket closure pending.",
    });
    const retryAt = archiveFailure
      ? this.continuationRetryAt(archiveFailure)
      : new Date(this.now().getTime() + 60_000).toISOString();
    this.db.setTicketBatchPostDeliveryRetry(
      item.answer_package_id,
      item.ticket_id,
      retryAt,
      archiveFailure?.category ?? pendingStage
    );
    if (retryAt !== STAFF_OPERATION_NO_RETRY_AT) this.scheduleRecovery(retryAt);
    logger.warn(
      {
        answerPackageId: item.answer_package_id,
        ticketId: item.ticket_id,
        stage: pendingStage,
        category: archiveFailure?.category,
        method: archiveFailure?.method,
        telegramErrorCode: archiveFailure?.telegramErrorCode,
        httpStatus: archiveFailure?.httpStatus,
        retryAfterSeconds: archiveFailure?.retryAfterSeconds,
      },
      "Reply-and-close post-delivery continuation remains pending"
    );
    return "PENDING";
  }

  private continuationRetryAt(diagnostic: NormalizedDeliveryError, error?: unknown): string {
    if (error instanceof TicketBatchStaffOperationError && error.retryAt !== null) return error.retryAt;
    if (diagnostic.category === "RATE_LIMITED") {
      return new Date(this.now().getTime() + (diagnostic.retryAfterSeconds ?? 1) * 1_000 + 250).toISOString();
    }
    if (
      diagnostic.permanence === "TEMPORARY" ||
      (error !== undefined && !(error instanceof GrammyError) && !(error instanceof HttpError))
    ) {
      return new Date(this.now().getTime() + 60_000).toISOString();
    }
    return STAFF_OPERATION_NO_RETRY_AT;
  }

  private batchStaffFailure(error: unknown): { category: string; retryAt: string | null } {
    if (error instanceof TicketBatchStaffOperationError) {
      return { category: error.diagnostic.category, retryAt: error.retryAt };
    }
    return { category: normalizeTelegramDeliveryError(error).category, retryAt: null };
  }

  private staffNextRetryAt(error: unknown): string | null {
    if (error instanceof TicketBatchStaffOperationError) {
      return error.diagnostic.permanence === "TEMPORARY" ? error.retryAt : STAFF_OPERATION_NO_RETRY_AT;
    }
    return STAFF_OPERATION_NO_RETRY_AT;
  }

  private recordTopicEchoFailure(answerPackageId: string, ticketId: number, error: unknown): void {
    const diagnostic =
      error instanceof TicketBatchStaffOperationError ? error.diagnostic : normalizeTelegramDeliveryError(error);
    const retryAt = diagnostic.permanence === "TEMPORARY" ? this.staffNextRetryAt(error) : null;
    this.db.recordTicketBatchTopicEcho(
      answerPackageId,
      ticketId,
      diagnostic.permanence === "TEMPORARY" ? "FAILED" : "TERMINAL_FAILED",
      {
        lastError: diagnostic.category,
        nextRetryAt: retryAt,
        incrementAttempt: true,
        diagnostic,
      }
    );
    if (retryAt !== null) this.scheduleRecovery(retryAt);
    logger.warn(
      {
        answerPackageId,
        ticketId,
        category: diagnostic.category,
        method: diagnostic.method,
        telegramErrorCode: diagnostic.telegramErrorCode,
        httpStatus: diagnostic.httpStatus,
        description: diagnostic.description,
      },
      "Ticket batch staff topic event failed"
    );
  }

  private persistFollowUp(ticket: TicketWithUser, item: TicketBatchItem): void {
    this.db.setTicketFollowUpContext(ticket.id, {
      followUpState: item.follow_up_state,
      internalNote: item.internal_note,
      escalationTarget: item.escalation_target,
      sourceAnswerPackageId: item.answer_package_id,
    });
    if (item.follow_up_state === "WAITING_USER") this.db.updateTicketStatus(ticket.id, "WAITING_USER");
    else if (item.follow_up_state !== "NONE" && ticket.status !== "CLOSED")
      this.db.updateTicketStatus(ticket.id, "IN_PROGRESS");
    else if (item.action !== "no_action" && ticket.status === "OPEN")
      this.db.updateTicketStatus(ticket.id, "IN_PROGRESS");
  }

  private hasFollowUpContext(item: TicketBatchItem): boolean {
    return item.follow_up_state !== "NONE" || item.internal_note !== null || item.escalation_target !== "NONE";
  }

  private isConfirmedReply(item: TicketBatchItem): boolean {
    return (
      (item.action === "reply_keep_open" || item.action === "reply_and_close") &&
      item.delivery_message_id !== null &&
      item.delivery_error_category === null &&
      item.delivery_error_permanence === null &&
      item.delivery_failure_event_state !== "SENT"
    );
  }

  private async sendTopicEcho(
    ticket: TicketWithUser,
    item: TicketBatchItem,
    recoveryStaffChatId?: number
  ): Promise<void> {
    this.ensureRecoveryWorkspaceIfNeeded(recoveryStaffChatId);
    const staffChatId = recoveryStaffChatId ?? this.requireStaffChatId();
    if (["SENT", "NOT_REQUIRED", "TERMINAL_FAILED"].includes(item.topic_echo_state)) return;
    if (item.action === "silent_close") {
      this.db.recordTicketBatchTopicEcho(item.answer_package_id, item.ticket_id, "NOT_REQUIRED");
      return;
    }
    if (ticket.staff_chat_id !== staffChatId || ticket.message_thread_id === null) {
      throw new Error("Ticket topic is unavailable for batch echo.");
    }
    const hasContext = this.hasFollowUpContext(item);
    if (item.action === "no_action" && !hasContext) {
      this.db.recordTicketBatchTopicEcho(item.answer_package_id, item.ticket_id, "NOT_REQUIRED");
      return;
    }
    const persistedItem =
      this.db
        .listTicketBatchAnswerItems(item.answer_package_id)
        .find((candidate) => candidate.ticket_id === item.ticket_id) ?? item;
    if (item.action !== "no_action" && !this.isConfirmedReply(persistedItem)) {
      this.db.recordTicketBatchTopicEcho(item.answer_package_id, item.ticket_id, "NOT_REQUIRED", {
        lastError: "Success echo is not applicable after an unconfirmed user delivery.",
      });
      logger.warn(
        { answerPackageId: item.answer_package_id, ticketId: item.ticket_id },
        "Skipped contradictory ticket batch success echo"
      );
      return;
    }
    const lines = [
      item.action === "no_action" ? "ℹ️ Batch follow-up updated — no user message sent" : "✅ Batch reply sent to user",
    ];
    if (item.action !== "no_action" && item.reply_text) lines.push("", item.reply_text);
    if (item.follow_up_state !== "NONE") lines.push("", `Follow-up: ${formatFollowUpState(item.follow_up_state)}`);
    if (item.escalation_target !== "NONE") lines.push(`Escalation: ${formatEscalationTarget(item.escalation_target)}`);
    if (item.internal_note) lines.push(`Internal note: ${item.internal_note}`);
    const threadId = ticket.message_thread_id;
    const echoed = await this.awaitRecoveryOperation(recoveryStaffChatId, () =>
      this.dependencies.runStaffChatOperation(
        () => this.api.sendMessage(staffChatId, truncate(lines.join("\n"), 3500), { message_thread_id: threadId }),
        staffChatId
      )
    );
    this.db.recordTicketBatchTopicEcho(item.answer_package_id, item.ticket_id, "SENT", {
      chatId: staffChatId,
      threadId,
      messageId: echoed.message_id,
    });
  }

  private async sendDeliveryFailureEvent(
    ticket: TicketWithUser,
    item: TicketBatchItem,
    diagnostic: NormalizedDeliveryError,
    recoveryStaffChatId?: number
  ): Promise<void> {
    this.ensureRecoveryWorkspaceIfNeeded(recoveryStaffChatId);
    const staffChatId = recoveryStaffChatId ?? this.requireStaffChatId();
    if (item.delivery_failure_event_state === "SENT") return;
    if (
      item.action === "no_action" ||
      item.action === "silent_close" ||
      item.delivery_message_id !== null ||
      item.delivery_error_category === null
    ) {
      this.db.recordTicketBatchFailureEvent(item.answer_package_id, item.ticket_id, "NOT_REQUIRED");
      return;
    }
    if (ticket.staff_chat_id !== staffChatId || ticket.message_thread_id === null) {
      throw new Error("Ticket topic is unavailable for batch delivery failure event.");
    }
    const lines = [
      diagnostic.permanence === "UNKNOWN_DELIVERY"
        ? "⚠️ Batch delivery outcome is unknown"
        : "⚠️ Batch reply was not delivered",
      "",
      `Category: ${formatDeliveryFailureCategory(diagnostic.category)}`,
    ];
    if (diagnostic.telegramErrorCode !== null) lines.push(`Telegram code: ${diagnostic.telegramErrorCode}`);
    if (diagnostic.retryAfterSeconds !== null) lines.push(`Retry after: ${diagnostic.retryAfterSeconds}s`);
    lines.push("Action: Ticket remains open");
    lines.push(
      diagnostic.category === "USER_BLOCKED_BOT" || diagnostic.category === "USER_DEACTIVATED"
        ? "Next step: Contact is not possible until the user restores bot access."
        : diagnostic.category === "CHAT_UNAVAILABLE"
          ? "Next step: Verify that the user can receive bot messages before a controlled retry."
          : diagnostic.permanence === "PERMANENT"
            ? "Next step: Manual review required before a controlled retry."
            : diagnostic.permanence === "TEMPORARY"
              ? "Next step: Prepare a controlled retry later."
              : "Next step: Do not resend automatically; manual review required."
    );
    const threadId = ticket.message_thread_id;
    try {
      const sent = await this.awaitRecoveryOperation(recoveryStaffChatId, () =>
        this.dependencies.runStaffChatOperation(
          () => this.api.sendMessage(staffChatId, lines.join("\n"), { message_thread_id: threadId }),
          staffChatId
        )
      );
      this.db.recordTicketBatchFailureEvent(item.answer_package_id, item.ticket_id, "SENT", sent.message_id, {
        incrementAttempt: true,
      });
    } catch (error) {
      if (error instanceof TicketBatchRecoveryWorkspaceChangedError) throw error;
      const failure = this.batchStaffFailure(error);
      this.db.recordTicketBatchFailureEvent(item.answer_package_id, item.ticket_id, "FAILED", null, {
        nextRetryAt: this.staffNextRetryAt(error),
        incrementAttempt: true,
      });
      this.scheduleRecovery(failure.retryAt);
      throw error;
    }
  }

  private buildSummary(answerPackageId: string): string {
    const items = this.db.listTicketBatchAnswerItems(answerPackageId);
    const delivered = items.filter((item) => item.delivery_message_id !== null).length;
    const noAction = items.filter((item) => item.action === "no_action").length;
    const silentCloseItems = items.filter(
      (item) => item.action === "silent_close" && (item.state === "APPLYING" || item.state === "COMPLETED")
    );
    const permanent = items.filter((item) => item.delivery_error_permanence === "PERMANENT");
    const temporary = items.filter((item) => item.delivery_error_permanence === "TEMPORARY");
    const unknown = items.filter(
      (item) => item.delivery_error_permanence === "UNKNOWN_DELIVERY" || item.state === "UNKNOWN_DELIVERY"
    ).length;
    const requiresStaffTopicEvent = (item: TicketBatchItem): boolean =>
      item.action === "no_action" ? this.hasFollowUpContext(item) : this.isConfirmedReply(item);
    const staffPending = items.filter(
      (item) =>
        (item.topic_echo_state === "PENDING" || item.topic_echo_state === "FAILED") && requiresStaffTopicEvent(item)
    ).length;
    const terminalStaffFailures = items.filter(
      (item) => item.topic_echo_state === "TERMINAL_FAILED" && requiresStaffTopicEvent(item)
    );
    const closeItems = [
      ...items.filter((item) => item.action === "reply_and_close" && this.isConfirmedReply(item)),
      ...silentCloseItems,
    ];
    const closeTickets = closeItems.map((item) => ({ item, ticket: this.db.getTicketWithUser(item.ticket_id) }));
    const ticketsClosed = closeTickets.filter(({ ticket }) => ticket?.status === "CLOSED").length;
    const silentClosed = silentCloseItems.filter(
      (item) => this.db.getTicket(item.ticket_id)?.status === "CLOSED"
    ).length;
    const ticketClosuresPending = closeItems.length - ticketsClosed;
    const archivesCompleted = closeTickets.filter(
      ({ ticket }) => ticket?.archived_at !== null && ticket?.archived_at !== undefined
    ).length;
    const archivesPending = closeItems.length - archivesCompleted;
    const topicClosuresUnconfirmed = archivesCompleted;
    const hasIssues =
      permanent.length ||
      temporary.length ||
      unknown ||
      staffPending ||
      terminalStaffFailures.length ||
      ticketClosuresPending ||
      archivesPending;
    return [
      hasIssues ? "Ticket batch applied with issues." : "Answer package applied.",
      "",
      `Delivered replies: ${delivered}`,
      `No action: ${noAction}`,
      `Silent closed: ${silentClosed}`,
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
      ...(permanent.length || temporary.length || unknown
        ? [
            "",
            "User delivery failures:",
            ...[
              ...permanent,
              ...temporary,
              ...items.filter(
                (item) => item.delivery_error_permanence === "UNKNOWN_DELIVERY" || item.state === "UNKNOWN_DELIVERY"
              ),
            ].map((item) => `- #${item.ticket_id} — ${item.delivery_error_category ?? "UNKNOWN"}`),
          ]
        : []),
      ...(terminalStaffFailures.length
        ? [
            "",
            "Staff sync failures:",
            ...terminalStaffFailures.map(
              (item) =>
                `- #${item.ticket_id} — ${item.topic_echo_error_category ?? item.topic_echo_last_error ?? "UNKNOWN"}`
            ),
          ]
        : []),
    ].join("\n");
  }

  recoverPendingStaffOperations(answerPackageId?: string): Promise<void> {
    const queued = this.recoveryQueue.then(() => this.runRecovery(answerPackageId));
    this.recoveryQueue = queued.catch(() => undefined);
    return queued;
  }

  private async runRecovery(answerPackageId?: string): Promise<void> {
    if (this.stopped) return;
    const staffChatId = this.requireStaffChatId();
    try {
      await this.runRecoveryForWorkspace(answerPackageId, staffChatId);
    } catch (error) {
      if (error instanceof TicketBatchRecoveryWorkspaceChangedError) return;
      throw error;
    }
  }

  private async runRecoveryForWorkspace(answerPackageId: string | undefined, staffChatId: number): Promise<void> {
    this.ensureRecoveryWorkspace(staffChatId);
    const at = this.now().toISOString();
    const packagesToFinalize = new Set<string>();
    const packagesToRefresh = new Set<string>();
    const matchesPackage = (item: { answer_package_id: string }): boolean =>
      answerPackageId === undefined || item.answer_package_id === answerPackageId;
    for (const item of this.db.listInvalidTicketBatchSuccessEchoes(staffChatId, 20).filter(matchesPackage)) {
      this.ensureRecoveryWorkspace(staffChatId);
      this.db.recordTicketBatchTopicEcho(item.answer_package_id, item.ticket_id, "NOT_REQUIRED", {
        lastError: "Success echo is not applicable after an unconfirmed user delivery.",
      });
      logger.warn(
        { answerPackageId: item.answer_package_id, ticketId: item.ticket_id },
        "Skipped invalid ticket batch success-echo recovery candidate"
      );
    }
    for (const item of this.db
      .listClosedTicketBatchReplyAndClosePendingEchoes(staffChatId, 20)
      .filter(matchesPackage)) {
      this.ensureRecoveryWorkspace(staffChatId);
      this.db.recordTicketBatchTopicEcho(item.answer_package_id, item.ticket_id, "NOT_REQUIRED", {
        lastError: "Staff topic echo is no longer available after ticket closure.",
      });
      packagesToFinalize.add(item.answer_package_id);
    }
    for (const item of this.db.listPendingTicketBatchFailureEvents(staffChatId, at, 20).filter(matchesPackage)) {
      this.ensureRecoveryWorkspace(staffChatId);
      const ticket = this.db.getTicketWithUser(item.ticket_id);
      if (!ticket || ticket.staff_chat_id !== staffChatId || ticket.status === "CLOSED") {
        if (ticket?.status === "CLOSED")
          this.db.recordTicketBatchFailureEvent(item.answer_package_id, item.ticket_id, "NOT_REQUIRED");
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
        occurredAt: item.delivery_failed_at ?? at,
      };
      try {
        await this.awaitRecoveryOperation(staffChatId, () =>
          this.sendDeliveryFailureEvent(ticket, item, diagnostic, staffChatId)
        );
      } catch (error) {
        if (error instanceof TicketBatchRecoveryWorkspaceChangedError) throw error;
        this.scheduleRecovery(this.batchStaffFailure(error).retryAt);
      }
    }
    for (const item of this.db.listPendingTicketBatchTopicEchoes(staffChatId, at, 20).filter(matchesPackage)) {
      this.ensureRecoveryWorkspace(staffChatId);
      const ticket = this.db.getTicketWithUser(item.ticket_id);
      if (!ticket || ticket.staff_chat_id !== staffChatId || ticket.status === "CLOSED") continue;
      try {
        await this.awaitRecoveryOperation(staffChatId, () => this.sendTopicEcho(ticket, item, staffChatId));
        if (item.action === "no_action")
          this.db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "NO_ACTION", { applied: true });
        else if (item.state === "STAFF_SYNC_PENDING" && item.action === "reply_keep_open") {
          this.db.updateTicketBatchAnswerItem(item.answer_package_id, item.ticket_id, "COMPLETED", { applied: true });
        }
        packagesToFinalize.add(item.answer_package_id);
        packagesToRefresh.add(item.answer_package_id);
      } catch (error) {
        if (error instanceof TicketBatchRecoveryWorkspaceChangedError) throw error;
        this.recordTopicEchoFailure(item.answer_package_id, item.ticket_id, error);
      }
    }
    const continuations = this.db
      .listPendingTicketBatchReplyAndCloseContinuations(staffChatId, at, 20)
      .filter(matchesPackage);
    for (const item of continuations) {
      this.ensureRecoveryWorkspace(staffChatId);
      const result = await this.awaitRecoveryOperation(staffChatId, () =>
        this.resumeReplyAndClosePostDelivery(item, undefined, staffChatId)
      );
      packagesToFinalize.add(item.answer_package_id);
      if (result !== "PENDING") packagesToRefresh.add(item.answer_package_id);
    }
    const silentClosures = this.db
      .listPendingTicketBatchSilentCloseContinuations(staffChatId, at, 20)
      .filter(matchesPackage);
    for (const item of silentClosures) {
      this.ensureRecoveryWorkspace(staffChatId);
      const result = await this.awaitRecoveryOperation(staffChatId, () =>
        this.resumeSilentClose(item, undefined, staffChatId)
      );
      packagesToFinalize.add(item.answer_package_id);
      if (result !== "PENDING") packagesToRefresh.add(item.answer_package_id);
    }
    this.ensureRecoveryWorkspace(staffChatId);
    for (const packageId of packagesToFinalize) this.db.finalizeTicketBatchAnswerPackage(packageId, staffChatId);
    for (const packageId of packagesToRefresh) {
      this.db.queueTicketBatchFinalSummaryRefresh(packageId, staffChatId, this.buildSummary(packageId));
    }
    if (continuations.length === 20 || silentClosures.length === 20) {
      this.scheduleRecovery(new Date(this.now().getTime() + 250).toISOString());
    }
    await this.awaitRecoveryOperation(staffChatId, () => this.recoverFinalSummaries(answerPackageId, staffChatId));
    this.scheduleRecovery(this.db.getNextTicketBatchStaffRetryAt(staffChatId) ?? null);
  }

  private async recoverFinalSummaries(answerPackageId: string | undefined, staffChatId: number): Promise<void> {
    const summaries = this.db
      .listPendingTicketBatchFinalSummaries(staffChatId, this.now().toISOString(), 20)
      .filter((item) => answerPackageId === undefined || item.answer_package_id === answerPackageId);
    for (const item of summaries) {
      this.ensureRecoveryWorkspace(staffChatId);
      const text = this.buildSummary(item.answer_package_id);
      this.db.queueTicketBatchFinalSummary(item.answer_package_id, staffChatId, {
        text,
        chatId: item.final_summary_chat_id ?? staffChatId,
        originChatId: item.final_summary_origin_chat_id,
        originMessageId: item.final_summary_origin_message_id,
      });
      this.db.recordTicketBatchFinalSummaryAttempt(item.answer_package_id, staffChatId);
      try {
        if (item.final_summary_origin_chat_id !== null && item.final_summary_origin_message_id !== null) {
          const originChatId = item.final_summary_origin_chat_id;
          const originMessageId = item.final_summary_origin_message_id;
          await this.awaitRecoveryOperation(staffChatId, () =>
            this.dependencies.runStaffChatOperation(
              () =>
                this.api.editMessageText(originChatId, originMessageId, text, {
                  reply_markup:
                    originChatId > 0 ? new InlineKeyboard().text("Back to dashboard", "dashboard:home") : undefined,
                }),
              originChatId
            )
          );
          this.db.recordTicketBatchFinalSummarySent(item.answer_package_id, staffChatId, originMessageId);
        } else {
          const destinationChatId = item.final_summary_chat_id ?? staffChatId;
          const sent = await this.awaitRecoveryOperation(staffChatId, () =>
            this.dependencies.runStaffChatOperation(
              () =>
                this.api.sendMessage(destinationChatId, text, {
                  reply_markup:
                    destinationChatId > 0
                      ? new InlineKeyboard().text("Back to dashboard", "dashboard:home")
                      : undefined,
                }),
              destinationChatId
            )
          );
          this.db.recordTicketBatchFinalSummarySent(item.answer_package_id, staffChatId, sent.message_id);
        }
      } catch (error) {
        if (error instanceof TicketBatchRecoveryWorkspaceChangedError) throw error;
        const failure = this.batchStaffFailure(error);
        if (failure.retryAt !== null) {
          this.db.recordTicketBatchFinalSummaryFailure(
            item.answer_package_id,
            staffChatId,
            "FAILED",
            failure.category,
            failure.retryAt
          );
          this.scheduleRecovery(failure.retryAt);
        } else if (item.final_summary_origin_message_id !== null) {
          this.db.queueTicketBatchFinalSummary(item.answer_package_id, staffChatId, {
            text,
            chatId: item.final_summary_chat_id ?? staffChatId,
          });
          const fallbackAt = this.now().toISOString();
          this.db.recordTicketBatchFinalSummaryFailure(
            item.answer_package_id,
            staffChatId,
            "FAILED",
            failure.category,
            fallbackAt
          );
          this.scheduleRecovery(fallbackAt);
        } else {
          this.db.recordTicketBatchFinalSummaryFailure(
            item.answer_package_id,
            staffChatId,
            "UNKNOWN_DELIVERY",
            failure.category,
            null
          );
        }
        logger.warn(
          { answerPackageId: item.answer_package_id, category: failure.category },
          "Ticket batch final summary remains pending"
        );
      }
    }
  }

  private scheduleRecovery(nextRetryAt: string | null): void {
    if (this.stopped || !nextRetryAt) return;
    const target = new Date(nextRetryAt).getTime();
    if (!Number.isFinite(target)) return;
    if (this.recoveryTimer && this.recoveryTimerAt !== undefined && this.recoveryTimerAt <= target) return;
    if (this.recoveryTimer) (this.dependencies.clearRecoveryTimer ?? clearTimeout)(this.recoveryTimer);
    const delay = Math.max(250, Math.min(2_147_000_000, target - this.now().getTime()));
    this.recoveryTimerAt = target;
    this.recoveryTimer = (this.dependencies.createRecoveryTimer ?? setTimeout)(() => {
      this.recoveryTimer = undefined;
      this.recoveryTimerAt = undefined;
      const accepted = this.dependencies.backgroundTasks.run(async () => {
        try {
          await this.recoverPendingStaffOperations();
        } catch (error) {
          logger.warn(
            { category: normalizeTelegramDeliveryError(error).category },
            "Ticket batch staff recovery failed"
          );
        }
      });
      if (!accepted) {
        logger.debug({ operation: "ticket_batch_staff_recovery" }, "Background work was dropped during shutdown");
      }
    }, delay);
    this.recoveryTimer.unref();
  }
}
