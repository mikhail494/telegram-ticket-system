import { GrammyError, InputFile } from "grammy";
import type { Context } from "grammy";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SupportDatabase, type MessageSenderType, type TicketMessageRecord, type TicketWithUser } from "./db.js";
import { formatDate, truncate } from "./format.js";
import { displayTelegramUser } from "./telegram.js";
import { logger } from "./logger.js";
import { normalizeTelegramDeliveryError, type NormalizedDeliveryError } from "./deliveryDiagnostics.js";
import { isForumTopicClosed, isForumTopicUnavailable } from "./forumTopicErrors.js";
import { runBoundedRecoveryPass, type StartupRecoveryBudget } from "./startup.js";

const SUPPORT_LOGS_TOPIC_NAME = "📜 Support Logs";
const SUPPORT_LOGS_THREAD_SETTING_PREFIX = "support_logs_message_thread_id";

type BotApi = Context["api"];

interface ArchiveAttemptOptions {
  onFailure?: (diagnostic: NormalizedDeliveryError) => void;
  topicReplacementAttempted?: boolean;
  topicReopenAttempted?: boolean;
}

export interface ArchiveRecoveryResult {
  processed: number;
  hasMore: boolean;
}

export interface ArchiveRecoveryOptions {
  budget?: StartupRecoveryBudget;
}

export interface ArchiveActor {
  type: MessageSenderType;
  displayName: string;
  username: string | null;
  telegramId: number | null;
}

export interface BanLogInput {
  action: "BANNED" | "UNBANNED";
  userTelegramId: number;
  username: string | null;
  reason?: string | null;
  performedBy: ArchiveActor;
}

export interface ModerationLogInput {
  userTelegramId: number;
  username: string | null;
  publicChatId: number;
  publicChatTitle: string | null;
  publicChatUsername?: string | null;
  messageThreadIds?: readonly number[];
  sanctionTier: number;
  sanctionKind: string;
  timestamp: string;
}

type TopicVerification = "ok" | "closed" | "missing";
type SupportLogsTopicState = "reachable" | "reopened" | "created";

export interface SupportLogsTopicInfo {
  threadId: number;
  previousThreadId: number | null;
  state: SupportLogsTopicState;
}

export async function initializeSupportLogsTopic(
  api: BotApi,
  db: SupportDatabase,
  staffChatId: number
): Promise<number> {
  const topic = await getSupportLogsTopicInfo(api, db, staffChatId);
  return topic.threadId;
}

export async function getSupportLogsTopicInfo(
  api: BotApi,
  db: SupportDatabase,
  staffChatId: number
): Promise<SupportLogsTopicInfo> {
  const settingKey = supportLogsThreadSettingKey(staffChatId);
  const storedThreadId = parseStoredThreadId(db.getSetting(settingKey));
  const storedTicketTopic = storedThreadId ? db.findTicketByStaffThread(staffChatId, storedThreadId) : undefined;

  if (storedThreadId && !storedTicketTopic) {
    const verification = await verifyForumTopic(api, staffChatId, storedThreadId);
    if (verification === "ok") {
      return {
        threadId: storedThreadId,
        previousThreadId: null,
        state: "reachable",
      };
    }

    if (verification === "closed") {
      try {
        await api.reopenForumTopic(staffChatId, storedThreadId);
        return {
          threadId: storedThreadId,
          previousThreadId: null,
          state: "reopened",
        };
      } catch (error) {
        if (!isForumTopicUnavailable(error)) {
          throw error;
        }
      }
    }
  }

  const topic = await api.createForumTopic(staffChatId, SUPPORT_LOGS_TOPIC_NAME);
  db.setSetting(settingKey, String(topic.message_thread_id));
  return {
    threadId: topic.message_thread_id,
    previousThreadId: storedThreadId ?? null,
    state: "created",
  };
}

export function setSupportLogsTopicOverride(db: SupportDatabase, staffChatId: number, messageThreadId: number): void {
  db.setSetting(supportLogsThreadSettingKey(staffChatId), String(messageThreadId));
}

async function recreateSupportLogsTopic(api: BotApi, db: SupportDatabase, staffChatId: number): Promise<number> {
  const topic = await api.createForumTopic(staffChatId, SUPPORT_LOGS_TOPIC_NAME);
  db.setSetting(supportLogsThreadSettingKey(staffChatId), String(topic.message_thread_id));
  return topic.message_thread_id;
}

export async function archiveClosedTicketsPendingUpload(
  api: BotApi,
  db: SupportDatabase,
  staffChatId: number,
  options: ArchiveRecoveryOptions = {}
): Promise<ArchiveRecoveryResult> {
  const limit = options.budget ? Math.max(1, options.budget.remainingItemCapacity() + 1) : 1_000;
  const tickets = db.listClosedTicketsPendingArchive(staffChatId, limit);
  const hasAdditionalCandidate = options.budget !== undefined && tickets.length === limit;
  const candidates = hasAdditionalCandidate ? tickets.slice(0, -1) : tickets;

  if (!options.budget) {
    for (const ticket of candidates) {
      await archiveTicketIfPossible(api, db, staffChatId, ticket.id);
    }
    return { processed: candidates.length, hasMore: false };
  }

  const result = await runBoundedRecoveryPass(candidates, options.budget, async (ticket) => {
    await archiveTicketIfPossible(api, db, staffChatId, ticket.id);
  });
  return {
    ...result,
    hasMore: result.hasMore || hasAdditionalCandidate || db.listClosedTicketsPendingArchive(staffChatId, 1).length > 0,
  };
}

export async function archiveTicketIfPossible(
  api: BotApi,
  db: SupportDatabase,
  staffChatId: number,
  ticketId: number,
  options: ArchiveAttemptOptions = {}
): Promise<boolean> {
  const ticket = db.getTicketWithUser(ticketId);
  if (!ticket || ticket.status !== "CLOSED") {
    return false;
  }

  if (ticket.archived_at) {
    return true;
  }

  if (db.hasUnresolvedTicketOutboundDeliveries(ticket.id)) {
    logger.warn({ ticketId: ticket.id }, "Ticket archive is blocked by an unresolved interactive delivery");
    return false;
  }

  let delivery = db.getTicketArchiveDelivery(ticket.id);
  if (delivery?.state === "UNKNOWN_DELIVERY") {
    reportUnknownArchiveDelivery(options, delivery);
    logger.warn({ ticketId: ticket.id, state: delivery.state }, "Ticket archive requires manual reconciliation");
    return false;
  }

  if (delivery?.state === "DELIVERED") {
    const finalized = db.finalizeTicketArchiveDelivery(ticket.id);
    if (finalized) await removeTicketTopicAfterArchive(api, ticket);
    return finalized;
  }

  const messages = db.listMessagesChronological(ticket.id);
  if (!messages.length) {
    logger.warn({ ticketId: ticket.id }, "Closed ticket has no messages to archive");
    return false;
  }

  if (!delivery || delivery.state === "FAILED") {
    let logsThreadId = await initializeSupportLogsTopic(api, db, staffChatId);
    const summaryClaim = db.claimTicketArchiveSummary(ticket.id, logsThreadId);
    delivery = summaryClaim.delivery;
    if (summaryClaim.claimed) {
      try {
        const summary = await api.sendMessage(staffChatId, formatTicketClosedLog(ticket), {
          message_thread_id: logsThreadId,
        });
        if (!db.markTicketArchiveSummarySent(ticket.id, summary.message_id)) {
          logger.error(
            { ticketId: ticket.id, state: "SUMMARY_PENDING" },
            "Could not persist Support Logs summary delivery"
          );
          return false;
        }
        logger.info({ ticketId: ticket.id, state: "SUMMARY_SENT" }, "Support Logs archive summary delivered");
      } catch (error) {
        if (isAmbiguousTelegramOutcome(error)) {
          db.markTicketArchiveUnknown(ticket.id, "Support Logs summary delivery outcome could not be confirmed.");
          reportUnknownArchiveDelivery(options, undefined, error);
          logger.warn({ ticketId: ticket.id, state: "UNKNOWN_DELIVERY" }, "Support Logs summary outcome is unknown");
          return false;
        }
        const diagnostic = normalizeTelegramDeliveryError(error);
        db.markTicketArchiveFailed(ticket.id, diagnostic.category, diagnostic.description);
        if (isForumTopicUnavailable(error)) {
          logsThreadId = await recreateSupportLogsTopic(api, db, staffChatId);
          const replacementClaim = db.claimTicketArchiveSummary(ticket.id, logsThreadId);
          if (!replacementClaim.claimed) return false;
          try {
            const summary = await api.sendMessage(staffChatId, formatTicketClosedLog(ticket), {
              message_thread_id: logsThreadId,
            });
            if (!db.markTicketArchiveSummarySent(ticket.id, summary.message_id)) {
              logger.error(
                { ticketId: ticket.id, state: "SUMMARY_PENDING" },
                "Could not persist replacement Support Logs summary delivery"
              );
              return false;
            }
            logger.info({ ticketId: ticket.id, state: "SUMMARY_SENT" }, "Replacement Support Logs summary delivered");
          } catch (retryError) {
            return await recordArchiveFailure(api, db, ticket, retryError, options);
          }
        } else {
          return await recordArchiveFailure(api, db, ticket, error, options);
        }
      }
    }
  }

  delivery = db.getTicketArchiveDelivery(ticket.id);
  if (!delivery) return false;
  if (delivery.state === "UNKNOWN_DELIVERY") {
    reportUnknownArchiveDelivery(options, delivery);
    return false;
  }
  if (delivery.state === "DOCUMENT_PENDING" || delivery.state === "SUMMARY_PENDING") return false;
  if (delivery.state === "DELIVERED") {
    const finalized = db.finalizeTicketArchiveDelivery(ticket.id);
    if (finalized) await removeTicketTopicAfterArchive(api, ticket);
    return finalized;
  }

  const transcript = buildTranscript(ticket, messages);
  const filename = `ticket-${ticket.id}-transcript.txt`;
  const tempFile = await writeTemporaryTranscript(filename, transcript);
  try {
    const documentClaim = db.claimTicketArchiveDocument(ticket.id);
    if (!documentClaim?.claimed) return false;
    const logsThreadId = documentClaim.delivery.logs_thread_id;
    if (logsThreadId === null) throw new Error("Support Logs archive delivery has no topic");
    try {
      const document = await api.sendDocument(staffChatId, new InputFile(tempFile.filePath, filename), {
        message_thread_id: logsThreadId,
      });
      if (!db.markTicketArchiveDocumentDelivered(ticket.id, document.message_id)) {
        logger.error(
          { ticketId: ticket.id, state: "DOCUMENT_PENDING" },
          "Could not persist Support Logs document delivery"
        );
        return false;
      }
      logger.info({ ticketId: ticket.id, state: "DELIVERED" }, "Support Logs archive document delivered");
    } catch (error) {
      if (isAmbiguousTelegramOutcome(error)) {
        db.markTicketArchiveUnknown(ticket.id, "Support Logs transcript delivery outcome could not be confirmed.");
        reportUnknownArchiveDelivery(options, undefined, error);
        logger.warn({ ticketId: ticket.id, state: "UNKNOWN_DELIVERY" }, "Support Logs document outcome is unknown");
        return false;
      }
      if (isForumTopicClosed(error)) {
        const diagnostic = normalizeTelegramDeliveryError(error);
        db.markTicketArchiveFailed(ticket.id, diagnostic.category, diagnostic.description);
        if (options.topicReopenAttempted) return false;
        try {
          await api.reopenForumTopic(staffChatId, logsThreadId);
        } catch (reopenError) {
          if (!isForumTopicUnavailable(reopenError)) {
            const reopenDiagnostic = normalizeTelegramDeliveryError(reopenError);
            options.onFailure?.(reopenDiagnostic);
            logger.error(
              { ticketId: ticket.id, stage: "SUPPORT_LOGS_TOPIC", category: reopenDiagnostic.category },
              "Could not reopen Support Logs topic after a confirmed transcript delivery failure"
            );
            return false;
          }
          return await replaceSupportLogsTopicAfterDocumentFailure(api, db, staffChatId, ticket, ticketId, options);
        }
        logger.info({ ticketId: ticket.id, logsThreadId }, "Reopened Support Logs topic for transcript delivery");
        return await archiveTicketIfPossible(api, db, staffChatId, ticketId, {
          ...options,
          topicReopenAttempted: true,
        });
      }
      if (!isForumTopicUnavailable(error)) return await recordArchiveFailure(api, db, ticket, error, options);
      const diagnostic = normalizeTelegramDeliveryError(error);
      db.markTicketArchiveFailed(ticket.id, diagnostic.category, diagnostic.description);
      return await replaceSupportLogsTopicAfterDocumentFailure(api, db, staffChatId, ticket, ticketId, options);
    }
    const finalized = db.finalizeTicketArchiveDelivery(ticket.id);
    if (finalized) await removeTicketTopicAfterArchive(api, ticket);
    return finalized;
  } finally {
    await fs.rm(tempFile.directory, { recursive: true, force: true });
  }
}

async function replaceSupportLogsTopicAfterDocumentFailure(
  api: BotApi,
  db: SupportDatabase,
  staffChatId: number,
  ticket: TicketWithUser,
  ticketId: number,
  options: ArchiveAttemptOptions
): Promise<boolean> {
  if (options.topicReplacementAttempted) return false;
  let replacementTopic: number;
  try {
    replacementTopic = await recreateSupportLogsTopic(api, db, staffChatId);
  } catch (replacementError) {
    const replacementDiagnostic = normalizeTelegramDeliveryError(replacementError);
    options.onFailure?.(replacementDiagnostic);
    logger.error(
      { ticketId: ticket.id, stage: "SUPPORT_LOGS_TOPIC", category: replacementDiagnostic.category },
      "Could not recreate Support Logs topic after a confirmed transcript delivery failure"
    );
    return false;
  }
  if (!db.restageTicketArchiveForReplacementTopic(ticket.id, replacementTopic)) return false;
  logger.info(
    { ticketId: ticket.id, logsThreadId: replacementTopic },
    "Restaged Support Logs archive for replacement topic"
  );
  return await archiveTicketIfPossible(api, db, staffChatId, ticketId, {
    ...options,
    topicReplacementAttempted: true,
  });
}

async function recordArchiveFailure(
  api: BotApi,
  db: SupportDatabase,
  ticket: TicketWithUser,
  error: unknown,
  options: ArchiveAttemptOptions
): Promise<false> {
  const diagnostic = normalizeTelegramDeliveryError(error);
  if (isAmbiguousTelegramOutcome(error)) {
    db.markTicketArchiveUnknown(ticket.id, "Support Logs delivery outcome could not be confirmed.");
    reportUnknownArchiveDelivery(options, undefined, error);
    logger.warn({ ticketId: ticket.id, state: "UNKNOWN_DELIVERY" }, "Support Logs archive outcome is unknown");
    return false;
  }
  db.markTicketArchiveFailed(ticket.id, diagnostic.category, diagnostic.description);
  options.onFailure?.(diagnostic);
  logger.error(
    { ticketId: ticket.id, stage: "TRANSCRIPT_ARCHIVE", category: diagnostic.category },
    "Could not archive ticket transcript"
  );
  await notifyTicketTopicArchiveFailure(api, ticket, diagnostic.category);
  return false;
}

function reportUnknownArchiveDelivery(
  options: ArchiveAttemptOptions,
  delivery?: {
    failure_category: NormalizedDeliveryError["category"] | null;
    failure_description: string | null;
    updated_at: string;
  },
  error?: unknown
): void {
  const normalized = error === undefined ? undefined : normalizeTelegramDeliveryError(error);
  options.onFailure?.({
    category: delivery?.failure_category ?? normalized?.category ?? "UNKNOWN_TELEGRAM_ERROR",
    permanence: "UNKNOWN_DELIVERY",
    method: normalized?.method ?? null,
    telegramErrorCode: normalized?.telegramErrorCode ?? null,
    httpStatus: normalized?.httpStatus ?? null,
    retryAfterSeconds: normalized?.retryAfterSeconds ?? null,
    description: delivery?.failure_description ?? normalized?.description ?? null,
    occurredAt: normalized?.occurredAt ?? delivery?.updated_at ?? new Date().toISOString(),
  });
}

function isAmbiguousTelegramOutcome(error: unknown): boolean {
  return !(error instanceof GrammyError);
}

export async function logBanEvent(
  api: BotApi,
  db: SupportDatabase,
  staffChatId: number,
  input: BanLogInput
): Promise<void> {
  try {
    const logsThreadId = await initializeSupportLogsTopic(api, db, staffChatId);
    await api.sendMessage(staffChatId, formatBanLog(input), {
      message_thread_id: logsThreadId,
    });
  } catch (error) {
    logger.error(
      { err: error, userTelegramId: input.userTelegramId, action: input.action },
      "Could not write ban event to support logs"
    );
  }
}

export async function logModerationSanction(
  api: BotApi,
  db: SupportDatabase,
  staffChatId: number,
  input: ModerationLogInput
): Promise<void> {
  const topicId = await initializeSupportLogsTopic(api, db, staffChatId);
  await api.sendMessage(
    staffChatId,
    [
      "Public moderation sanction",
      `User ID: ${input.userTelegramId}`,
      `Username: ${input.username ? `@${input.username}` : "none"}`,
      `Public chat ID: ${input.publicChatId}`,
      `Public chat: ${input.publicChatTitle ?? "unknown"}`,
      `Public username: ${input.publicChatUsername ? `@${input.publicChatUsername}` : "none"}`,
      `Topic threads: ${input.messageThreadIds?.length ? input.messageThreadIds.join(", ") : "none"}`,
      `Sanction tier: ${input.sanctionTier}`,
      `Sanction: ${input.sanctionKind}`,
      `UTC: ${input.timestamp}`,
      "Reason: English-only rule",
    ].join("\n"),
    { message_thread_id: topicId }
  );
}

function actorLabel(actor: ArchiveActor): string {
  if (actor.type === "SYSTEM") {
    return "system";
  }

  if (actor.type === "USER") {
    return "user";
  }

  return actor.username ? `@${actor.username}` : actor.displayName;
}

function userLabel(user: { username?: string | null; telegram_id?: number; id?: number }): string {
  if (user.username) {
    return `@${user.username}`;
  }

  const id = user.telegram_id ?? user.id;
  return id ? `user_${id}` : "unknown";
}

async function verifyForumTopic(api: BotApi, staffChatId: number, messageThreadId: number): Promise<TopicVerification> {
  try {
    await api.sendChatAction(staffChatId, "typing", {
      message_thread_id: messageThreadId,
    });
    return "ok";
  } catch (error) {
    if (isForumTopicClosed(error)) {
      return "closed";
    }

    if (isForumTopicUnavailable(error)) {
      return "missing";
    }

    throw error;
  }
}

function parseStoredThreadId(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function supportLogsThreadSettingKey(staffChatId: number): string {
  return `${SUPPORT_LOGS_THREAD_SETTING_PREFIX}:${staffChatId}`;
}

function buildTranscript(ticket: TicketWithUser, messages: TicketMessageRecord[]): string {
  return [
    `Ticket #${ticket.id}`,
    "",
    "Username:",
    userLabel(ticket),
    "",
    "Telegram ID:",
    String(ticket.user_telegram_id),
    "",
    "Created:",
    formatDate(ticket.created_at),
    "",
    "Closed:",
    formatDate(ticket.closed_at ?? ticket.updated_at),
    "",
    "Closed by:",
    closedByLabel(ticket),
    "",
    "Final status:",
    ticket.status,
    "",
    "====================================================",
    "",
    ...messages.flatMap(formatTranscriptMessage),
  ].join("\n");
}

function formatTranscriptMessage(message: TicketMessageRecord): string[] {
  const lines = [
    `[${formatTranscriptTime(message.created_at)}] ${messageSenderType(message)} ${messageSenderName(message)}`,
    "",
  ];

  const text = message.text?.trim();
  if (text) {
    lines.push(text, "");
  }

  if (message.media_type) {
    lines.push(formatAttachment(message), "");
  }

  if (!text && !message.media_type) {
    lines.push("No text.", "");
  }

  return lines;
}

function messageSenderType(message: TicketMessageRecord): MessageSenderType {
  if (message.sender_type) {
    return message.sender_type;
  }

  if (message.direction === "USER_TO_STAFF") {
    return "USER";
  }

  if (message.direction === "STAFF_TO_USER") {
    return "STAFF";
  }

  return "SYSTEM";
}

function messageSenderName(message: TicketMessageRecord): string {
  if (message.sender_username) {
    return `@${message.sender_username}`;
  }

  if (message.sender_display_name) {
    return message.sender_display_name;
  }

  if (message.from_username) {
    return `@${message.from_username}`;
  }

  return "";
}

function formatAttachment(message: TicketMessageRecord): string {
  if (message.media_type === "document" && message.filename) {
    return `Attachment: document: ${message.filename}`;
  }

  return `Attachment: ${message.media_type}`;
}

function closedByLabel(ticket: TicketWithUser): string {
  if (ticket.closed_by_type === "USER") {
    return "user";
  }

  if (ticket.closed_by_type === "SYSTEM") {
    return "system";
  }

  if (ticket.closed_by_username) {
    return `@${ticket.closed_by_username}`;
  }

  return ticket.closed_by_display_name ?? "system";
}

function formatTicketClosedLog(ticket: TicketWithUser): string {
  return [
    `Ticket #${ticket.id} closed`,
    "",
    "User:",
    displayTelegramUser(ticket),
    "",
    "Telegram ID:",
    String(ticket.user_telegram_id),
    "",
    "Closed by:",
    closedByLabel(ticket),
    "",
    "Final status:",
    ticket.status,
    "",
    "Transcript attached below.",
  ].join("\n");
}

function formatBanLog(input: BanLogInput): string {
  const lines = [
    "User:",
    input.username ? `@${input.username}` : `user_${input.userTelegramId}`,
    "",
    "Telegram ID:",
    String(input.userTelegramId),
    "",
    "Action:",
    input.action,
    "",
  ];

  if (input.reason) {
    lines.push("Reason:", input.reason, "");
  }

  lines.push("Performed by:", actorLabel(input.performedBy), "", "Timestamp:", formatDate(new Date().toISOString()));

  return lines.join("\n");
}

async function writeTemporaryTranscript(
  filename: string,
  content: string
): Promise<{ directory: string; filePath: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-ticket-transcript-"));
  const filePath = path.join(directory, filename);
  await fs.writeFile(filePath, content, "utf8");
  return { directory, filePath };
}

async function removeTicketTopicAfterArchive(api: BotApi, ticket: TicketWithUser): Promise<void> {
  if (!ticket.staff_chat_id || !ticket.message_thread_id) {
    return;
  }

  try {
    await api.deleteForumTopic(ticket.staff_chat_id, ticket.message_thread_id);
    logger.info(
      {
        ticketId: ticket.id,
        topicId: ticket.message_thread_id,
        method: "deleteForumTopic",
        outcome: "SUCCESS",
      },
      "Archived ticket topic cleanup completed"
    );
    return;
  } catch (error) {
    const diagnostic = normalizeTelegramDeliveryError(error);
    if (isResolvedTopicCleanupError(diagnostic.description)) {
      logger.info(
        {
          ticketId: ticket.id,
          topicId: ticket.message_thread_id,
          method: "deleteForumTopic",
          outcome: "TERMINAL_SUCCESS",
          category: diagnostic.category,
          telegramErrorCode: diagnostic.telegramErrorCode,
        },
        "Archived ticket topic was already unavailable"
      );
      return;
    }
    logger.warn(
      {
        ticketId: ticket.id,
        topicId: ticket.message_thread_id,
        method: "deleteForumTopic",
        outcome: "FAILED",
        category: diagnostic.category,
        telegramErrorCode: diagnostic.telegramErrorCode,
        httpStatus: diagnostic.httpStatus,
        description: diagnostic.description,
      },
      "Could not delete archived ticket topic"
    );
  }

  try {
    await api.closeForumTopic(ticket.staff_chat_id, ticket.message_thread_id);
    logger.info(
      {
        ticketId: ticket.id,
        topicId: ticket.message_thread_id,
        method: "closeForumTopic",
        outcome: "SUCCESS",
      },
      "Archived ticket topic cleanup completed"
    );
  } catch (error) {
    const diagnostic = normalizeTelegramDeliveryError(error);
    if (isResolvedTopicCleanupError(diagnostic.description)) {
      logger.info(
        {
          ticketId: ticket.id,
          topicId: ticket.message_thread_id,
          method: "closeForumTopic",
          outcome: "TERMINAL_SUCCESS",
          category: diagnostic.category,
          telegramErrorCode: diagnostic.telegramErrorCode,
        },
        "Archived ticket topic was already closed or unavailable"
      );
      return;
    }
    logger.warn(
      {
        ticketId: ticket.id,
        topicId: ticket.message_thread_id,
        method: "closeForumTopic",
        outcome: "FAILED",
        category: diagnostic.category,
        telegramErrorCode: diagnostic.telegramErrorCode,
        httpStatus: diagnostic.httpStatus,
        description: diagnostic.description,
      },
      "Could not close archived ticket topic"
    );
  }
}

function isResolvedTopicCleanupError(description: string | null): boolean {
  if (!description) return false;
  const normalized = description.toLowerCase();
  return (
    normalized.includes("message thread not found") ||
    normalized.includes("topic not found") ||
    normalized.includes("topic is closed") ||
    normalized.includes("topic was closed") ||
    normalized.includes("already closed") ||
    normalized.includes("message is not modified")
  );
}

async function notifyTicketTopicArchiveFailure(api: BotApi, ticket: TicketWithUser, error: string): Promise<void> {
  if (!ticket.staff_chat_id || !ticket.message_thread_id) {
    return;
  }

  try {
    await api.sendMessage(
      ticket.staff_chat_id,
      truncate(
        `Ticket #${ticket.id} was closed, but transcript upload failed. Stored messages were retained for retry. Error: ${error}`,
        3500
      ),
      {
        message_thread_id: ticket.message_thread_id,
      }
    );
  } catch (noticeError) {
    const diagnostic = normalizeTelegramDeliveryError(noticeError);
    logger.warn(
      {
        ticketId: ticket.id,
        stage: "ARCHIVE_FAILURE_NOTICE",
        category: diagnostic.category,
        method: diagnostic.method,
        telegramErrorCode: diagnostic.telegramErrorCode,
        httpStatus: diagnostic.httpStatus,
      },
      "Could not notify staff about archive failure"
    );
  }
}

function formatTranscriptTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
