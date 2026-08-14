import type {
  BannedUserRecord,
  TicketMessageRecord,
  TicketRecord,
  TicketStatus,
  TicketWithUser
} from "./db.js";
import { displayTelegramUser } from "./telegram.js";

export const START_TEXT =
  "Hi! Please describe your issue in one message. Include your AgentOn UID, wallet address, quest link, screenshots or transaction hash if relevant.";

export const DEFAULT_SUPPORT_EXPECTED_RESPONSE_TIME = "1-7 business days";
export const SUPPORT_RESPONSE_TIME_PLACEHOLDER = "{{response_time}}";
export const DEFAULT_SUPPORT_TICKET_RECEIVED_TEMPLATE = [
  "Thanks, your request has been received.",
  "",
  `Expected response time: ${SUPPORT_RESPONSE_TIME_PLACEHOLDER}.`,
  "",
  "You can continue sending messages in this chat until your ticket is closed."
].join("\n");

export function formatTicketReceived(template: string, expectedResponseTime: string): string {
  return template.replaceAll(SUPPORT_RESPONSE_TIME_PLACEHOLDER, expectedResponseTime);
}

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
    "Write in this topic to answer the user."
  ].join("\n");
}

export function formatPinnedTicketSummary(ticket: TicketWithUser): string {
  const lines = [
    `Ticket #${ticket.id}`,
    "",
    "User:",
    displayTelegramUser(ticket),
    "",
    "Telegram ID:",
    String(ticket.user_telegram_id),
    "",
    "Created:",
    formatDate(ticket.created_at),
    "",
    "Status:",
    ticket.status
  ];
  if (ticket.follow_up_state !== "NONE") {
    lines.push("", "Follow-up:", formatFollowUpState(ticket.follow_up_state));
  }
  if (ticket.escalation_target !== "NONE") {
    lines.push("", "Escalation:", formatEscalationTarget(ticket.escalation_target));
  }
  if (ticket.follow_up_state !== "NONE" && ticket.follow_up_updated_at) {
    lines.push("", "Last staff reply:", formatDate(ticket.follow_up_updated_at));
  }
  return lines.join("\n");
}

export function formatFollowUpState(value: TicketWithUser["follow_up_state"]): string {
  return ({ NONE: "None", WAITING_USER: "Waiting for user", WAITING_DEVS: "Waiting for developers", WAITING_QUEST_OWNER: "Waiting for quest owner", MONITORING: "Monitoring" } as const)[value];
}

export function formatEscalationTarget(value: TicketWithUser["escalation_target"]): string {
  return ({ NONE: "None", DEVS: "Development", PAYMENTS: "Payments", SECURITY: "Security", QUEST_OWNER: "Quest owner", SUPPORT: "Support" } as const)[value];
}

export function formatTicketUpdate(
  user: { username?: string | null; first_name?: string | null; last_name?: string | null },
  message?: string | null,
  mediaType?: string | null,
  filename?: string | null
): string {
  const lines = [displayTelegramUser(user), ""];
  const text = message?.trim();

  if (text) {
    lines.push(truncate(text, 2600));
  }

  if (mediaType) {
    if (text) {
      lines.push("");
    }
    lines.push(formatAttachment(mediaType, filename));
  }

  if (!text && !mediaType) {
    lines.push(NO_TEXT);
  }

  return lines.join("\n");
}

function formatAttachment(mediaType: string, filename?: string | null): string {
  if (mediaType === "document" && filename) {
    return `Attachment: document: ${filename}`;
  }

  return `Attachment: ${mediaType}`;
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

export function formatWhois(ticket: TicketWithUser, ban?: BannedUserRecord): string {
  const lines = [
    `Ticket ID: ${ticket.id}`,
    `Username: ${ticket.username ? `@${ticket.username}` : "none"}`,
    `Telegram ID: ${ticket.user_telegram_id}`,
    `Status: ${ticket.status}`,
    `Created: ${formatDate(ticket.created_at)}`,
    `Ban status: ${ban ? "BANNED" : "not banned"}`
  ];

  if (ban) {
    lines.push(`Ban reason: ${ban.reason}`, `Banned at: ${formatDate(ban.created_at)}`);
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
