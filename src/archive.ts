import { GrammyError, HttpError, InputFile } from "grammy";
import type { Context } from "grammy";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import {
  SupportDatabase,
  type MessageSenderType,
  type TicketMessageRecord,
  type TicketWithUser
} from "./db.js";
import { formatDate, truncate } from "./format.js";
import { displayTelegramUser } from "./telegram.js";
import { logger } from "./logger.js";

const SUPPORT_LOGS_TOPIC_NAME = "📜 Support Logs";
const SUPPORT_LOGS_THREAD_SETTING = "support_logs_message_thread_id";

type BotApi = Context["api"];

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

type TopicVerification = "ok" | "closed" | "missing";

export async function initializeSupportLogsTopic(
  api: BotApi,
  db: SupportDatabase
): Promise<number> {
  const storedThreadId = parseStoredThreadId(db.getSetting(SUPPORT_LOGS_THREAD_SETTING));
  if (storedThreadId) {
    const verification = await verifyForumTopic(api, storedThreadId);
    if (verification === "ok") {
      return storedThreadId;
    }

    if (verification === "closed") {
      try {
        await api.reopenForumTopic(config.staffChatId, storedThreadId);
        return storedThreadId;
      } catch (error) {
        if (!isForumTopicUnavailable(error)) {
          throw error;
        }
      }
    }
  }

  const topic = await api.createForumTopic(config.staffChatId, SUPPORT_LOGS_TOPIC_NAME);
  db.setSetting(SUPPORT_LOGS_THREAD_SETTING, String(topic.message_thread_id));
  return topic.message_thread_id;
}

export async function archiveClosedTicketsPendingUpload(
  api: BotApi,
  db: SupportDatabase
): Promise<void> {
  const tickets = db.listClosedTicketsPendingArchive(config.staffChatId);
  for (const ticket of tickets) {
    await archiveTicketIfPossible(api, db, ticket.id);
  }
}

export async function archiveTicketIfPossible(
  api: BotApi,
  db: SupportDatabase,
  ticketId: number
): Promise<boolean> {
  const ticket = db.getTicketWithUser(ticketId);
  if (!ticket || ticket.status !== "CLOSED") {
    return false;
  }

  if (ticket.archived_at) {
    return true;
  }

  const messages = db.listMessagesChronological(ticket.id);
  if (!messages.length) {
    logger.warn({ ticketId: ticket.id }, "Closed ticket has no messages to archive");
    return false;
  }

  const transcript = buildTranscript(ticket, messages);
  const filename = `ticket-${ticket.id}-transcript.txt`;
  const tempFile = await writeTemporaryTranscript(filename, transcript);
  let summaryMessageId: number | null = null;

  try {
    const logsThreadId = await initializeSupportLogsTopic(api, db);
    const summary = await api.sendMessage(config.staffChatId, formatTicketClosedLog(ticket), {
      message_thread_id: logsThreadId
    });
    summaryMessageId = summary.message_id;

    const document = await api.sendDocument(
      config.staffChatId,
      new InputFile(tempFile.filePath, filename),
      {
        message_thread_id: logsThreadId
      }
    );

    db.markTicketArchivedAndDeleteMessages(ticket.id, summary.message_id, document.message_id);
    await removeTicketTopicAfterArchive(api, ticket);
    return true;
  } catch (error) {
    logger.error({ err: error, ticketId: ticket.id }, "Could not archive ticket transcript");
    if (summaryMessageId !== null) {
      await deleteMessageSafely(api, config.staffChatId, summaryMessageId);
    }
    await notifyTicketTopicArchiveFailure(api, ticket, describeError(error));
    return false;
  } finally {
    await fs.rm(tempFile.directory, { recursive: true, force: true });
  }
}

export async function logBanEvent(
  api: BotApi,
  db: SupportDatabase,
  input: BanLogInput
): Promise<void> {
  try {
    const logsThreadId = await initializeSupportLogsTopic(api, db);
    await api.sendMessage(config.staffChatId, formatBanLog(input), {
      message_thread_id: logsThreadId
    });
  } catch (error) {
    logger.error(
      { err: error, userTelegramId: input.userTelegramId, action: input.action },
      "Could not write ban event to support logs"
    );
  }
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

async function verifyForumTopic(api: BotApi, messageThreadId: number): Promise<TopicVerification> {
  try {
    await api.sendChatAction(config.staffChatId, "typing", {
      message_thread_id: messageThreadId
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
    ...messages.flatMap(formatTranscriptMessage)
  ].join("\n");
}

function formatTranscriptMessage(message: TicketMessageRecord): string[] {
  const lines = [
    `[${formatTranscriptTime(message.created_at)}] ${messageSenderType(message)} ${messageSenderName(message)}`,
    ""
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
    "Transcript attached below."
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
    ""
  ];

  if (input.reason) {
    lines.push("Reason:", input.reason, "");
  }

  lines.push(
    "Performed by:",
    actorLabel(input.performedBy),
    "",
    "Timestamp:",
    formatDate(new Date().toISOString())
  );

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
    return;
  } catch (error) {
    logger.warn({ err: error, ticketId: ticket.id }, "Could not delete archived ticket topic");
  }

  try {
    await api.closeForumTopic(ticket.staff_chat_id, ticket.message_thread_id);
  } catch (error) {
    logger.warn({ err: error, ticketId: ticket.id }, "Could not close archived ticket topic");
  }
}

async function notifyTicketTopicArchiveFailure(
  api: BotApi,
  ticket: TicketWithUser,
  error: string
): Promise<void> {
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
        message_thread_id: ticket.message_thread_id
      }
    );
  } catch (noticeError) {
    logger.warn({ err: noticeError, ticketId: ticket.id }, "Could not notify staff about archive failure");
  }
}

async function deleteMessageSafely(api: BotApi, chatId: number, messageId: number): Promise<void> {
  try {
    await api.deleteMessage(chatId, messageId);
  } catch (error) {
    logger.warn({ err: error, messageId }, "Could not delete incomplete support log summary");
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
    message.includes("not found")
  );
}

function isForumTopicClosed(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return message.includes("topic_closed") || message.includes("topic is closed");
}
