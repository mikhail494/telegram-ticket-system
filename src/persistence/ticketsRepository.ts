import Database from "better-sqlite3";
import { now, senderTypeForDirection, ticketStatuses } from "./helpers.js";
import type { AddMessageInput, BannedUserRecord, BanUserInput, CloseTicketInput, TicketEscalationTarget, TicketFollowUpHistoryRecord, TicketFollowUpState, TicketRecord, TicketStatus, TicketWithUser, TicketMessageRecord, UserInput, UserRecord } from "./types.js";
export class TicketRepository {
  constructor(private readonly db: Database.Database) {}
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
            closed_at = COALESCE(closed_at, ?),
            follow_up_state = 'NONE',
            internal_note = NULL,
            escalation_target = 'NONE',
            follow_up_updated_at = ?,
            follow_up_source_answer_package_id = NULL
        WHERE user_telegram_id = ?
          AND staff_chat_id = ?
          AND id != ?
          AND status != 'CLOSED'
      `
      )
      .run(timestamp, timestamp, timestamp, userTelegramId, staffChatId, keepTicketId);

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
    if (!ticketStatuses.includes(status)) {
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
            closed_by_username = CASE WHEN ? = 'CLOSED' THEN closed_by_username ELSE NULL END,
            follow_up_state = CASE WHEN ? = 'CLOSED' THEN 'NONE' ELSE follow_up_state END,
            internal_note = CASE WHEN ? = 'CLOSED' THEN NULL ELSE internal_note END,
            escalation_target = CASE WHEN ? = 'CLOSED' THEN 'NONE' ELSE escalation_target END,
            follow_up_updated_at = CASE WHEN ? = 'CLOSED' THEN ? ELSE follow_up_updated_at END,
            follow_up_source_answer_package_id = CASE WHEN ? = 'CLOSED' THEN NULL ELSE follow_up_source_answer_package_id END
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
        status,
        status,
        status,
        status,
        status === "CLOSED" ? timestamp : null,
        status,
        ticketId
      );

    return this.getTicket(ticketId);
  }

  listActiveTicketsForStaffChat(staffChatId: number): TicketWithUser[] {
    return this.db
      .prepare(
        `
        SELECT tickets.*, users.username, users.first_name, users.last_name
        FROM tickets
        JOIN users ON users.telegram_id = tickets.user_telegram_id
        WHERE tickets.staff_chat_id = ?
          AND tickets.status IN ('OPEN', 'IN_PROGRESS', 'WAITING_USER')
        ORDER BY tickets.id ASC
      `
      )
      .all(staffChatId) as TicketWithUser[];
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
            closed_by_username = ?,
            follow_up_state = 'NONE',
            internal_note = NULL,
            escalation_target = 'NONE',
            follow_up_updated_at = ?,
            follow_up_source_answer_package_id = NULL
        WHERE id = ?
      `
      )
      .run(
        timestamp,
        timestamp,
        input.type,
        input.displayName,
        input.username ?? null,
        timestamp,
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

  setTicketFollowUpContext(ticketId: number, input: { followUpState: TicketFollowUpState; internalNote: string | null; escalationTarget: TicketEscalationTarget; sourceAnswerPackageId?: string | null }): TicketRecord | undefined {
    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE tickets SET follow_up_state = ?, internal_note = ?, escalation_target = ?, follow_up_updated_at = ?, follow_up_source_answer_package_id = ?, updated_at = ? WHERE id = ?`)
        .run(input.followUpState, input.internalNote, input.escalationTarget, timestamp, input.sourceAnswerPackageId ?? null, timestamp, ticketId);
      this.db.prepare(`INSERT INTO ticket_follow_up_history (ticket_id, follow_up_state, internal_note, escalation_target, source_answer_package_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(ticketId, input.followUpState, input.internalNote, input.escalationTarget, input.sourceAnswerPackageId ?? null, timestamp);
    });
    tx();
    return this.getTicket(ticketId);
  }

  clearWaitingUserFollowUp(ticketId: number): TicketRecord | undefined {
    const ticket = this.getTicket(ticketId);
    if (!ticket || ticket.follow_up_state !== "WAITING_USER") return ticket;
    return this.setTicketFollowUpContext(ticketId, { followUpState: "NONE", internalNote: null, escalationTarget: "NONE", sourceAnswerPackageId: ticket.follow_up_source_answer_package_id });
  }

  listTicketFollowUpHistory(ticketId: number): TicketFollowUpHistoryRecord[] {
    return this.db.prepare("SELECT * FROM ticket_follow_up_history WHERE ticket_id = ? ORDER BY id ASC").all(ticketId) as TicketFollowUpHistoryRecord[];
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


}
