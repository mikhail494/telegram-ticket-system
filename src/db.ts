import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type TicketStatus = "OPEN" | "WAITING_USER" | "IN_PROGRESS" | "CLOSED";
export type MessageDirection = "USER_TO_STAFF" | "STAFF_TO_USER" | "SYSTEM";
export type MessageSenderType = "USER" | "STAFF" | "SYSTEM";

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
  message_thread_id: number | null;
  staff_message_id: number | null;
  logs_message_id: number | null;
  transcript_message_id: number | null;
  archived_at: string | null;
  closed_by_type: MessageSenderType | null;
  closed_by_display_name: string | null;
  closed_by_username: string | null;
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
  sender_type: MessageSenderType | null;
  sender_display_name: string | null;
  sender_username: string | null;
  text: string | null;
  media_type: string | null;
  filename: string | null;
  file_id: string | null;
  created_at: string;
}

export interface BannedUserRecord {
  user_telegram_id: number;
  username: string | null;
  reason: string;
  banned_by: number | null;
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
  senderType?: MessageSenderType | null;
  senderDisplayName?: string | null;
  senderUsername?: string | null;
  text?: string | null;
  mediaType?: string | null;
  filename?: string | null;
  fileId?: string | null;
}

export interface BanUserInput {
  userTelegramId: number;
  username?: string | null;
  reason: string;
  bannedBy?: number | null;
}

export interface CloseTicketInput {
  type: MessageSenderType;
  displayName: string;
  username?: string | null;
}

interface TableColumnInfo {
  name: string;
}

interface Migration {
  id: number;
  name: string;
  up: () => void;
}

const TICKET_STATUSES: TicketStatus[] = ["OPEN", "WAITING_USER", "IN_PROGRESS", "CLOSED"];

function now(): string {
  return new Date().toISOString();
}

function senderTypeForDirection(direction: MessageDirection): MessageSenderType {
  if (direction === "USER_TO_STAFF") {
    return "USER";
  }

  if (direction === "STAFF_TO_USER") {
    return "STAFF";
  }

  return "SYSTEM";
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

  findTicketByStaffThread(staffChatId: number, messageThreadId: number): TicketWithUser | undefined {
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
        WHERE tickets.staff_chat_id = ? AND tickets.message_thread_id = ?
        ORDER BY tickets.id DESC
        LIMIT 1
      `
      )
      .get(staffChatId, messageThreadId) as TicketWithUser | undefined;
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

  updateTicketForumTopic(ticketId: number, staffChatId: number, messageThreadId: number): void {
    this.db
      .prepare(
        `
        UPDATE tickets
        SET staff_chat_id = ?, message_thread_id = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(staffChatId, messageThreadId, now(), ticketId);
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
            closed_at = CASE WHEN ? = 'CLOSED' THEN COALESCE(closed_at, ?) ELSE NULL END,
            closed_by_type = CASE WHEN ? = 'CLOSED' THEN closed_by_type ELSE NULL END,
            closed_by_display_name = CASE WHEN ? = 'CLOSED' THEN closed_by_display_name ELSE NULL END,
            closed_by_username = CASE WHEN ? = 'CLOSED' THEN closed_by_username ELSE NULL END
        WHERE id = ?
      `
      )
      .run(
        status,
        timestamp,
        status,
        status === "CLOSED" ? timestamp : null,
        status,
        status,
        status,
        ticketId
      );

    return this.getTicket(ticketId);
  }

  closeTicketRecord(ticketId: number, input: CloseTicketInput): TicketRecord | undefined {
    const timestamp = now();
    this.db
      .prepare(
        `
        UPDATE tickets
        SET status = 'CLOSED',
            updated_at = ?,
            closed_at = COALESCE(closed_at, ?),
            closed_by_type = ?,
            closed_by_display_name = ?,
            closed_by_username = ?
        WHERE id = ?
      `
      )
      .run(
        timestamp,
        timestamp,
        input.type,
        input.displayName,
        input.username ?? null,
        ticketId
      );

    return this.getTicket(ticketId);
  }

  markTicketArchivedAndDeleteMessages(
    ticketId: number,
    logsMessageId: number,
    transcriptMessageId: number
  ): void {
    const tx = this.db.transaction(() => {
      const timestamp = now();
      this.db
        .prepare(
          `
          UPDATE tickets
          SET logs_message_id = ?,
              transcript_message_id = ?,
              archived_at = ?,
              updated_at = ?
          WHERE id = ?
        `
        )
        .run(logsMessageId, transcriptMessageId, timestamp, timestamp, ticketId);

      this.db.prepare("DELETE FROM messages WHERE ticket_id = ?").run(ticketId);
    });

    tx();
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
            sender_type,
            sender_display_name,
            sender_username,
            text,
            media_type,
            filename,
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
            @senderType,
            @senderDisplayName,
            @senderUsername,
            @text,
            @mediaType,
            @filename,
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
          senderType: message.senderType ?? senderTypeForDirection(message.direction),
          senderDisplayName: message.senderDisplayName ?? null,
          senderUsername: message.senderUsername ?? message.fromUsername ?? null,
          text: message.text ?? null,
          mediaType: message.mediaType ?? null,
          filename: message.filename ?? null,
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

  listMessagesChronological(ticketId: number): TicketMessageRecord[] {
    return this.db
      .prepare(
        `
        SELECT * FROM messages
        WHERE ticket_id = ?
        ORDER BY created_at ASC, id ASC
      `
      )
      .all(ticketId) as TicketMessageRecord[];
  }

  deleteMessagesForTicket(ticketId: number): number {
    const result = this.db.prepare("DELETE FROM messages WHERE ticket_id = ?").run(ticketId);
    return result.changes;
  }

  listClosedTicketsPendingArchive(staffChatId: number, limit = 1000): TicketWithUser[] {
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
        WHERE tickets.staff_chat_id = ?
          AND tickets.status = 'CLOSED'
          AND tickets.archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM messages WHERE messages.ticket_id = tickets.id
          )
        ORDER BY tickets.closed_at ASC, tickets.id ASC
        LIMIT ?
      `
      )
      .all(staffChatId, limit) as TicketWithUser[];
  }

  getSetting(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;

    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `
      )
      .run(key, value, now());
  }

  getBannedUser(userTelegramId: number): BannedUserRecord | undefined {
    return this.db
      .prepare("SELECT * FROM banned_users WHERE user_telegram_id = ?")
      .get(userTelegramId) as BannedUserRecord | undefined;
  }

  banUser(input: BanUserInput): void {
    this.db
      .prepare(
        `
        INSERT INTO banned_users (user_telegram_id, username, reason, banned_by, created_at)
        VALUES (@userTelegramId, @username, @reason, @bannedBy, @createdAt)
        ON CONFLICT(user_telegram_id) DO UPDATE SET
          username = excluded.username,
          reason = excluded.reason,
          banned_by = excluded.banned_by,
          created_at = excluded.created_at
      `
      )
      .run({
        userTelegramId: input.userTelegramId,
        username: input.username ?? null,
        reason: input.reason,
        bannedBy: input.bannedBy ?? null,
        createdAt: now()
      });
  }

  unbanUser(userTelegramId: number): boolean {
    const result = this.db
      .prepare("DELETE FROM banned_users WHERE user_telegram_id = ?")
      .run(userTelegramId);

    return result.changes > 0;
  }

  listBannedUsers(limit = 50): BannedUserRecord[] {
    return this.db
      .prepare(
        `
        SELECT * FROM banned_users
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(limit) as BannedUserRecord[];
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const migrations: Migration[] = [
      {
        id: 1,
        name: "create_core_tables",
        up: () => {
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
              message_thread_id INTEGER,
              staff_message_id INTEGER,
              logs_message_id INTEGER,
              transcript_message_id INTEGER,
              archived_at TEXT,
              closed_by_type TEXT CHECK(closed_by_type IN ('USER', 'STAFF', 'SYSTEM')),
              closed_by_display_name TEXT,
              closed_by_username TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              closed_at TEXT,
              FOREIGN KEY(user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
            );

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
              sender_type TEXT CHECK(sender_type IN ('USER', 'STAFF', 'SYSTEM')),
              sender_display_name TEXT,
              sender_username TEXT,
              text TEXT,
              media_type TEXT,
              filename TEXT,
              file_id TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
          `);
        }
      },
      {
        id: 2,
        name: "ensure_ticket_topic_columns",
        up: () => {
          this.addColumnIfMissing("tickets", "staff_chat_id", "INTEGER");
          this.addColumnIfMissing("tickets", "message_thread_id", "INTEGER");
          this.addColumnIfMissing("tickets", "staff_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "closed_at", "TEXT");
          this.addColumnIfMissing("tickets", "logs_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "transcript_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "archived_at", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_type", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_display_name", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_username", "TEXT");
        }
      },
      {
        id: 3,
        name: "create_banned_users",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS banned_users (
              user_telegram_id INTEGER PRIMARY KEY,
              username TEXT,
              reason TEXT NOT NULL,
              banned_by INTEGER,
              created_at TEXT NOT NULL
            );
          `);
        }
      },
      {
        id: 4,
        name: "create_indexes",
        up: () => {
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_tickets_user_status
              ON tickets(user_telegram_id, status);

            CREATE INDEX IF NOT EXISTS idx_tickets_user_staff_status
              ON tickets(user_telegram_id, staff_chat_id, status);

            CREATE INDEX IF NOT EXISTS idx_tickets_staff_thread
              ON tickets(staff_chat_id, message_thread_id);

            CREATE INDEX IF NOT EXISTS idx_tickets_staff_message
              ON tickets(staff_chat_id, staff_message_id);

            CREATE INDEX IF NOT EXISTS idx_messages_ticket_created
              ON messages(ticket_id, created_at);
          `);
        }
      },
      {
        id: 5,
        name: "enforce_single_active_ticket_per_staff_chat",
        up: () => {
          const timestamp = now();
          this.db
            .prepare(
              `
              UPDATE tickets
              SET status = 'CLOSED',
                  updated_at = ?,
                  closed_at = COALESCE(closed_at, ?)
              WHERE status != 'CLOSED'
                AND id NOT IN (
                  SELECT MAX(id)
                  FROM tickets
                  WHERE status != 'CLOSED'
                  GROUP BY user_telegram_id, staff_chat_id
                )
            `
            )
            .run(timestamp, timestamp);

          this.db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_ticket_user_staff
              ON tickets(user_telegram_id, staff_chat_id)
              WHERE status != 'CLOSED';
          `);
        }
      },
      {
        id: 6,
        name: "harden_existing_forum_topic_schema",
        up: () => {
          const timestamp = now();
          this.db
            .prepare(
              `
              UPDATE tickets
              SET status = 'CLOSED',
                  updated_at = ?,
                  closed_at = COALESCE(closed_at, ?)
              WHERE status != 'CLOSED'
                AND (staff_chat_id IS NULL OR message_thread_id IS NULL)
            `
            )
            .run(timestamp, timestamp);

          if (this.hasTable("staff_message_links")) {
            this.db.exec(`
              DELETE FROM staff_message_links
              WHERE id NOT IN (
                SELECT MIN(id)
                FROM staff_message_links
                GROUP BY staff_chat_id, staff_message_id
              );

              CREATE UNIQUE INDEX IF NOT EXISTS uniq_staff_message_links_staff_message
                ON staff_message_links(staff_chat_id, staff_message_id);
            `);
          }
        }
      },
      {
        id: 7,
        name: "add_archive_settings_and_transcript_columns",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
          `);

          this.addColumnIfMissing("tickets", "logs_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "transcript_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "archived_at", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_type", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_display_name", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_username", "TEXT");

          this.addColumnIfMissing("messages", "sender_type", "TEXT");
          this.addColumnIfMissing("messages", "sender_display_name", "TEXT");
          this.addColumnIfMissing("messages", "sender_username", "TEXT");
          this.addColumnIfMissing("messages", "filename", "TEXT");

          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_tickets_archive_pending
              ON tickets(staff_chat_id, status, archived_at);
          `);
        }
      }
    ];

    for (const migration of migrations) {
      if (this.hasMigration(migration.id)) {
        continue;
      }

      const applyMigration = this.db.transaction(() => {
        migration.up();
        this.db
          .prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.id, migration.name, now());
      });

      applyMigration();
    }
  }

  private hasMigration(id: number): boolean {
    const row = this.db
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(id) as { id: number } | undefined;

    return Boolean(row);
  }

  private hasColumn(tableName: "tickets" | "messages", columnName: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as TableColumnInfo[];
    return rows.some((row) => row.name === columnName);
  }

  private hasTable(tableName: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { name: string } | undefined;

    return Boolean(row);
  }

  private addColumnIfMissing(
    tableName: "tickets" | "messages",
    columnName: string,
    columnDefinition: string
  ): void {
    if (this.hasColumn(tableName, columnName)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
  }
}
