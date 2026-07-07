import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type TicketStatus = "OPEN" | "WAITING_USER" | "IN_PROGRESS" | "CLOSED";
export type MessageDirection = "USER_TO_STAFF" | "STAFF_TO_USER" | "SYSTEM";

export interface UserRecord {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketRecord {
  id: number;
  user_telegram_id: number;
  status: TicketStatus;
  staff_chat_id: number | null;
  staff_message_id: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface TicketWithUser extends TicketRecord {
  username: string | null;
  first_name: string | null;
  last_name: string | null;
}

export interface TicketMessageRecord {
  id: number;
  ticket_id: number;
  direction: MessageDirection;
  source_chat_id: number | null;
  source_message_id: number | null;
  delivery_chat_id: number | null;
  delivery_message_id: number | null;
  from_telegram_id: number | null;
  from_username: string | null;
  text: string | null;
  media_type: string | null;
  file_id: string | null;
  created_at: string;
}

export interface StaffMessageLink {
  id: number;
  ticket_id: number;
  staff_chat_id: number;
  staff_message_id: number;
  kind: string;
  created_at: string;
}

export interface UserInput {
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface AddMessageInput {
  ticketId: number;
  direction: MessageDirection;
  sourceChatId?: number | null;
  sourceMessageId?: number | null;
  deliveryChatId?: number | null;
  deliveryMessageId?: number | null;
  fromTelegramId?: number | null;
  fromUsername?: string | null;
  text?: string | null;
  mediaType?: string | null;
  fileId?: string | null;
}

const TICKET_STATUSES: TicketStatus[] = ["OPEN", "WAITING_USER", "IN_PROGRESS", "CLOSED"];

function now(): string {
  return new Date().toISOString();
}

function normalizeDatabasePath(databaseUrl: string): string {
  const value = databaseUrl.trim();

  if (value === ":memory:") {
    return value;
  }

  if (value.startsWith("file://")) {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    return process.platform === "win32" && /^\/[A-Za-z]:/.test(pathname)
      ? pathname.slice(1)
      : pathname;
  }

  if (value.startsWith("file:")) {
    return value.slice("file:".length);
  }

  if (value.startsWith("sqlite://")) {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    return process.platform === "win32" && /^\/[A-Za-z]:/.test(pathname)
      ? pathname.slice(1)
      : pathname;
  }

  return value;
}

function ensureDirectoryForDatabase(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  const directory = path.dirname(databasePath);
  if (directory && directory !== ".") {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export class SupportDatabase {
  private readonly db: Database.Database;

  constructor(databaseUrl: string) {
    const databasePath = normalizeDatabasePath(databaseUrl);
    ensureDirectoryForDatabase(databasePath);

    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  upsertUser(user: UserInput): void {
    const timestamp = now();
    this.db
      .prepare(
        `
        INSERT INTO users (telegram_id, username, first_name, last_name, created_at, updated_at)
        VALUES (@telegramId, @username, @firstName, @lastName, @createdAt, @updatedAt)
        ON CONFLICT(telegram_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          updated_at = excluded.updated_at
      `
      )
      .run({
        telegramId: user.telegramId,
        username: user.username ?? null,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        createdAt: timestamp,
        updatedAt: timestamp
      });
  }

  getUser(telegramId: number): UserRecord | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE telegram_id = ?")
      .get(telegramId) as UserRecord | undefined;
  }

  createTicket(userTelegramId: number, staffChatId: number): TicketRecord {
    const timestamp = now();
    const result = this.db
      .prepare(
        `
        INSERT INTO tickets (user_telegram_id, status, staff_chat_id, created_at, updated_at)
        VALUES (?, 'OPEN', ?, ?, ?)
      `
      )
      .run(userTelegramId, staffChatId, timestamp, timestamp);

    return this.getTicket(Number(result.lastInsertRowid))!;
  }

  getTicket(ticketId: number): TicketRecord | undefined {
    return this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId) as
      | TicketRecord
      | undefined;
  }

  getTicketWithUser(ticketId: number): TicketWithUser | undefined {
    return this.db
      .prepare(
        `
        SELECT
          tickets.*,
          users.username,
          users.first_name,
          users.last_name
        FROM tickets
        JOIN users ON users.telegram_id = tickets.user_telegram_id
        WHERE tickets.id = ?
      `
      )
      .get(ticketId) as TicketWithUser | undefined;
  }

  findActiveTicketForUser(userTelegramId: number, staffChatId: number): TicketRecord | undefined {
    return this.db
      .prepare(
        `
        SELECT * FROM tickets
        WHERE user_telegram_id = ?
          AND staff_chat_id = ?
          AND staff_message_id IS NOT NULL
          AND status != 'CLOSED'
        ORDER BY id DESC
        LIMIT 1
      `
      )
      .get(userTelegramId, staffChatId) as TicketRecord | undefined;
  }

  getLatestTicketForUser(userTelegramId: number, staffChatId: number): TicketRecord | undefined {
    return this.db
      .prepare(
        `
        SELECT * FROM tickets
        WHERE user_telegram_id = ? AND staff_chat_id = ?
        ORDER BY id DESC
        LIMIT 1
      `
      )
      .get(userTelegramId, staffChatId) as TicketRecord | undefined;
  }

  listTicketsForUser(userTelegramId: number, staffChatId: number, limit = 10): TicketRecord[] {
    return this.db
      .prepare(
        `
        SELECT * FROM tickets
        WHERE user_telegram_id = ? AND staff_chat_id = ?
        ORDER BY id DESC
        LIMIT ?
      `
      )
      .all(userTelegramId, staffChatId, limit) as TicketRecord[];
  }

  closeOtherActiveTicketsForUserInStaffChat(
    userTelegramId: number,
    staffChatId: number,
    keepTicketId: number
  ): number {
    const timestamp = now();
    const result = this.db
      .prepare(
        `
        UPDATE tickets
        SET status = 'CLOSED',
            updated_at = ?,
            closed_at = COALESCE(closed_at, ?)
        WHERE user_telegram_id = ?
          AND staff_chat_id = ?
          AND id != ?
          AND status != 'CLOSED'
      `
      )
      .run(timestamp, timestamp, userTelegramId, staffChatId, keepTicketId);

    return result.changes;
  }

  updateTicketStaffMessage(ticketId: number, staffChatId: number, staffMessageId: number): void {
    this.db
      .prepare(
        `
        UPDATE tickets
        SET staff_chat_id = ?, staff_message_id = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(staffChatId, staffMessageId, now(), ticketId);
  }

  updateTicketStatus(ticketId: number, status: TicketStatus): TicketRecord | undefined {
    if (!TICKET_STATUSES.includes(status)) {
      throw new Error(`Unsupported ticket status: ${status}`);
    }

    const timestamp = now();
    this.db
      .prepare(
        `
        UPDATE tickets
        SET status = ?,
            updated_at = ?,
            closed_at = CASE WHEN ? = 'CLOSED' THEN ? ELSE NULL END
        WHERE id = ?
      `
      )
      .run(status, timestamp, status, status === "CLOSED" ? timestamp : null, ticketId);

    return this.getTicket(ticketId);
  }

  addMessage(input: AddMessageInput): number {
    const tx = this.db.transaction((message: AddMessageInput) => {
      const result = this.db
        .prepare(
          `
          INSERT INTO messages (
            ticket_id,
            direction,
            source_chat_id,
            source_message_id,
            delivery_chat_id,
            delivery_message_id,
            from_telegram_id,
            from_username,
            text,
            media_type,
            file_id,
            created_at
          )
          VALUES (
            @ticketId,
            @direction,
            @sourceChatId,
            @sourceMessageId,
            @deliveryChatId,
            @deliveryMessageId,
            @fromTelegramId,
            @fromUsername,
            @text,
            @mediaType,
            @fileId,
            @createdAt
          )
        `
        )
        .run({
          ticketId: message.ticketId,
          direction: message.direction,
          sourceChatId: message.sourceChatId ?? null,
          sourceMessageId: message.sourceMessageId ?? null,
          deliveryChatId: message.deliveryChatId ?? null,
          deliveryMessageId: message.deliveryMessageId ?? null,
          fromTelegramId: message.fromTelegramId ?? null,
          fromUsername: message.fromUsername ?? null,
          text: message.text ?? null,
          mediaType: message.mediaType ?? null,
          fileId: message.fileId ?? null,
          createdAt: now()
        });

      this.db
        .prepare("UPDATE tickets SET updated_at = ? WHERE id = ?")
        .run(now(), message.ticketId);

      return Number(result.lastInsertRowid);
    });

    return tx(input);
  }

  getFirstUserMessage(ticketId: number): TicketMessageRecord | undefined {
    return this.db
      .prepare(
        `
        SELECT * FROM messages
        WHERE ticket_id = ? AND direction = 'USER_TO_STAFF'
        ORDER BY id ASC
        LIMIT 1
      `
      )
      .get(ticketId) as TicketMessageRecord | undefined;
  }

  listMessages(ticketId: number, limit = 10): TicketMessageRecord[] {
    return this.db
      .prepare(
        `
        SELECT * FROM messages
        WHERE ticket_id = ?
        ORDER BY id DESC
        LIMIT ?
      `
      )
      .all(ticketId, limit) as TicketMessageRecord[];
  }

  linkStaffMessage(
    ticketId: number,
    staffChatId: number,
    staffMessageId: number,
    kind: string
  ): void {
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO staff_message_links (
          ticket_id,
          staff_chat_id,
          staff_message_id,
          kind,
          created_at
        )
        VALUES (?, ?, ?, ?, ?)
      `
      )
      .run(ticketId, staffChatId, staffMessageId, kind, now());
  }

  findTicketByStaffMessage(
    staffChatId: number,
    staffMessageId: number
  ): StaffMessageLink | undefined {
    return this.db
      .prepare(
        `
        SELECT * FROM staff_message_links
        WHERE staff_chat_id = ? AND staff_message_id = ?
      `
      )
      .get(staffChatId, staffMessageId) as StaffMessageLink | undefined;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_telegram_id INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('OPEN', 'WAITING_USER', 'IN_PROGRESS', 'CLOSED')),
        staff_chat_id INTEGER,
        staff_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        FOREIGN KEY(user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_user_status
        ON tickets(user_telegram_id, status);

      CREATE INDEX IF NOT EXISTS idx_tickets_user_staff_status
        ON tickets(user_telegram_id, staff_chat_id, status);

      CREATE INDEX IF NOT EXISTS idx_tickets_staff_message
        ON tickets(staff_chat_id, staff_message_id);

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('USER_TO_STAFF', 'STAFF_TO_USER', 'SYSTEM')),
        source_chat_id INTEGER,
        source_message_id INTEGER,
        delivery_chat_id INTEGER,
        delivery_message_id INTEGER,
        from_telegram_id INTEGER,
        from_username TEXT,
        text TEXT,
        media_type TEXT,
        file_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_ticket_created
        ON messages(ticket_id, created_at);

      CREATE TABLE IF NOT EXISTS staff_message_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        staff_chat_id INTEGER NOT NULL,
        staff_message_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(staff_chat_id, staff_message_id),
        FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_staff_message_links_ticket
        ON staff_message_links(ticket_id);
    `);
  }
}
