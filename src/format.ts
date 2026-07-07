import type { TicketMessageRecord, TicketRecord, TicketStatus, TicketWithUser } from "./db.js";
import { displayTelegramUser } from "./telegram.js";

export const START_TEXT =
  "Hi! Please describe your issue in one message. Include your AgentOn UID, wallet address, quest link, screenshots or transaction hash if relevant.";

export const RECEIVED_TEXT =
  "Thanks, your request has been received. Our support team will get back to you soon.";

export const CLOSED_TEXT =
  "Your ticket has been closed. If you still need help, send a new message.";

const NO_TEXT = "No text. Attachment only.";

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatTicketPost(ticket: TicketWithUser, initialMessage?: string | null): string {
  const message = truncate(initialMessage?.trim() || NO_TEXT, 2600);

  return [
    `New ticket #${ticket.id}`,
    `From: ${displayTelegramUser(ticket)}`,
    `User ID: ${ticket.user_telegram_id}`,
    `Status: ${ticket.status}`,
    `Message: ${message}`,
    "",
    "Reply to this message to answer the user."
  ].join("\n");
}

export function formatTicketUpdate(
  ticket: TicketRecord,
  user: { username?: string | null; first_name?: string | null; last_name?: string | null },
  message?: string | null
): string {
  return [
    `New message for ticket #${ticket.id}`,
    `From: ${displayTelegramUser(user)}`,
    `User ID: ${ticket.user_telegram_id}`,
    `Status: ${ticket.status}`,
    `Message: ${truncate(message?.trim() || NO_TEXT, 2600)}`,
    "",
    "Reply to this message to answer the user."
  ].join("\n");
}

export function formatTicketDetails(ticket: TicketWithUser, messages: TicketMessageRecord[]): string {
  const lines = [
    `Ticket #${ticket.id}`,
    `From: ${displayTelegramUser(ticket)}`,
    `User ID: ${ticket.user_telegram_id}`,
    `Status: ${ticket.status}`,
    `Created: ${formatDate(ticket.created_at)}`,
    `Updated: ${formatDate(ticket.updated_at)}`
  ];

  if (ticket.closed_at) {
    lines.push(`Closed: ${formatDate(ticket.closed_at)}`);
  }

  if (messages.length) {
    lines.push("", "Recent messages:");
    for (const message of [...messages].reverse()) {
      const author = message.direction === "USER_TO_STAFF" ? "User" : "Staff";
      const body = truncate(message.text?.trim() || message.media_type || NO_TEXT, 500);
      lines.push(`- ${formatDate(message.created_at)} ${author}: ${body}`);
    }
  }

  return lines.join("\n");
}

export function formatUserTicketList(tickets: TicketRecord[]): string {
  if (!tickets.length) {
    return "You do not have any tickets yet. Send a message here to create one.";
  }

  return [
    "Your latest tickets:",
    ...tickets.map((ticket) => `#${ticket.id} - ${ticket.status} - ${formatDate(ticket.created_at)}`)
  ].join("\n");
}

export function formatStatus(status: TicketStatus): string {
  return status.replace("_", " ");
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}
