import Database from "better-sqlite3";
import { now, senderTypeForDirection, ticketStatuses } from "./helpers.js";
import type {
  AddMessageInput,
  ApplyTicketBatchFollowUpInput,
  BannedUserRecord,
  BanUserInput,
  BeginTicketInboundRoutingInput,
  BeginTicketInboundRoutingResult,
  CloseTicketInput,
  TicketInboundRoutingClaim,
  TicketInboundRoutingOperationRecord,
  TicketInboundRoutingStage,
  ReconcileUnknownDeliveryInput,
  TicketEscalationTarget,
  TicketFollowUpHistoryRecord,
  TicketFollowUpState,
  TicketRecord,
  TicketStatus,
  TicketWithUser,
  TicketMessageRecord,
  UserInput,
  UserRecord,
  CreateTicketOutboundDeliveryIntentInput,
  TicketArchiveDeliveryClaim,
  TicketArchiveDeliveryRecord,
  TicketOutboundDeliveryRecord,
  TicketTransitionResult,
} from "./types.js";
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
        updatedAt: timestamp,
      });
  }

  getUser(telegramId: number): UserRecord | undefined {
    return this.db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) as UserRecord | undefined;
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

  beginTicketInboundRouting(input: BeginTicketInboundRoutingInput): BeginTicketInboundRoutingResult {
    const tx = this.db.transaction(() => {
      const existing = this.getTicketInboundRoutingOperation(input.sourceChatId, input.sourceMessageId);
      if (existing) {
        const ticket = this.getTicket(existing.ticket_id);
        if (!ticket) throw new Error("Inbound ticket routing operation references a missing ticket.");
        return { created: false, ticket, operation: existing };
      }

      let ticket = this.findActiveTicketForUser(input.userTelegramId, input.staffChatId);
      let kind: TicketInboundRoutingOperationRecord["kind"];
      let stage: TicketInboundRoutingStage;
      if (ticket) {
        kind = "EXISTING_TICKET";
        stage = ticket.message_thread_id === null ? "WAITING_FOR_TOPIC" : "SEND_UPDATE";
      } else {
        let createdTicket = false;
        try {
          ticket = this.createTicket(input.userTelegramId, input.staffChatId);
          createdTicket = true;
        } catch (error) {
          if (!isUniqueConstraint(error)) throw error;
          ticket = this.findActiveTicketForUser(input.userTelegramId, input.staffChatId);
          if (!ticket) throw error;
        }
        if (createdTicket) {
          kind = "FRESH_TICKET";
          stage = "CREATE_TOPIC";
        } else {
          // Another source won ticket creation; provisioning ownership is checked below.
          kind = "EXISTING_TICKET";
          stage = ticket.message_thread_id === null ? "WAITING_FOR_TOPIC" : "SEND_UPDATE";
        }
      }

      if (stage === "WAITING_FOR_TOPIC" && !this.hasInboundTopicProvisioningOwner(ticket.id, input.staffChatId)) {
        stage = "CREATE_TOPIC";
      }
      this.insertTicketInboundRoutingOperation(input, ticket, kind, stage);
      return {
        created: true,
        ticket,
        operation: this.getTicketInboundRoutingOperation(input.sourceChatId, input.sourceMessageId)!,
      };
    });

    return tx();
  }

  getTicketInboundRoutingOperation(
    sourceChatId: number,
    sourceMessageId: number
  ): TicketInboundRoutingOperationRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM ticket_inbound_routing_operations WHERE source_chat_id = ? AND source_message_id = ?`)
      .get(sourceChatId, sourceMessageId) as TicketInboundRoutingOperationRecord | undefined;
  }

  claimTicketInboundRoutingOperation(
    sourceChatId: number,
    sourceMessageId: number,
    staffChatId: number,
    stage: TicketInboundRoutingStage
  ): TicketInboundRoutingClaim | undefined {
    const tx = this.db.transaction(() => {
      const operation = this.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
      if (!operation || operation.staff_chat_id !== staffChatId || operation.stage !== stage) {
        return operation ? { claimed: false, operation } : undefined;
      }
      if (operation.state !== "READY" && operation.state !== "FAILED") return { claimed: false, operation };

      const ticket = this.getTicket(operation.ticket_id);
      if (
        !ticket ||
        ticket.staff_chat_id !== staffChatId ||
        (ticket.status === "CLOSED" && (stage !== "COPY_ORIGINAL" || operation.state === "FAILED"))
      ) {
        this.cancelUnsentInboundOperation(operation, ticket?.staff_chat_id === staffChatId);
        return { claimed: false, operation: this.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId)! };
      }
      if (
        ticket.message_thread_id !== null &&
        (stage === "CREATE_TOPIC" || ticket.message_thread_id !== operation.topic_thread_id) &&
        stage !== "WAITING_FOR_TOPIC" &&
        stage !== "DONE"
      ) {
        this.db
          .prepare(
            `UPDATE ticket_inbound_routing_operations
           SET stage = CASE WHEN should_copy_original = 1 AND delivery_message_id IS NOT NULL
                            THEN 'COPY_ORIGINAL' ELSE 'SEND_UPDATE' END,
               state = 'READY', topic_thread_id = ?, attempt = attempt + 1,
               failure_category = NULL, failure_description = NULL, updated_at = ?
           WHERE source_chat_id = ? AND source_message_id = ? AND state IN ('READY', 'FAILED') AND stage = ?`
          )
          .run(ticket.message_thread_id, now(), sourceChatId, sourceMessageId, stage);
        return { claimed: false, operation: this.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId)! };
      }
      if (
        stage === "WAITING_FOR_TOPIC" ||
        stage === "DONE" ||
        (stage === "COPY_ORIGINAL" && (!operation.should_copy_original || operation.delivery_message_id === null)) ||
        (stage !== "CREATE_TOPIC" &&
          (ticket.message_thread_id === null || ticket.message_thread_id !== operation.topic_thread_id))
      )
        return { claimed: false, operation };

      const result = this.db
        .prepare(
          `
          UPDATE ticket_inbound_routing_operations
          SET attempt = attempt + CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END,
              state = 'PENDING', failure_category = NULL, failure_description = NULL, updated_at = ?
          WHERE source_chat_id = ?
            AND source_message_id = ?
            AND staff_chat_id = ?
            AND stage = ?
            AND state IN ('READY', 'FAILED')
            AND (
              ? != 'CREATE_TOPIC'
              OR NOT EXISTS (
                SELECT 1
                FROM ticket_inbound_routing_operations AS competing
                WHERE competing.ticket_id = ?
                  AND competing.staff_chat_id = ?
                  AND competing.stage = 'CREATE_TOPIC'
                  AND competing.state NOT IN ('DELIVERED', 'CANCELLED')
                  AND NOT (
                    competing.source_chat_id = ?
                    AND competing.source_message_id = ?
                  )
              )
            )
          `
        )
        .run(
          now(),
          sourceChatId,
          sourceMessageId,
          staffChatId,
          stage,
          stage,
          operation.ticket_id,
          staffChatId,
          sourceChatId,
          sourceMessageId
        );
      const claimed = this.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
      if (!claimed) throw new Error("Inbound ticket routing operation disappeared during claim.");
      return { claimed: result.changes === 1, operation: claimed };
    });

    return tx();
  }

  markTicketInboundRoutingTopicCreated(
    sourceChatId: number,
    sourceMessageId: number,
    staffChatId: number,
    messageThreadId: number
  ): boolean {
    const tx = this.db.transaction(() => {
      const operation = this.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
      if (
        !operation ||
        operation.staff_chat_id !== staffChatId ||
        operation.stage !== "CREATE_TOPIC" ||
        operation.state !== "PENDING"
      )
        return false;
      const ticket = this.getTicket(operation.ticket_id);
      if (!ticket || ticket.staff_chat_id !== staffChatId) return false;
      if (ticket.message_thread_id !== null && ticket.message_thread_id !== messageThreadId) return false;

      if (ticket.message_thread_id === null) {
        const updatedTicket = this.db
          .prepare(
            `UPDATE tickets SET message_thread_id = ?, updated_at = ? WHERE id = ? AND staff_chat_id = ? AND message_thread_id IS NULL`
          )
          .run(messageThreadId, now(), ticket.id, staffChatId);
        if (updatedTicket.changes !== 1) return false;
      }

      const updatedOperation = this.db
        .prepare(
          `
          UPDATE ticket_inbound_routing_operations
          SET stage = 'SEND_SUMMARY', state = 'READY', topic_thread_id = ?, updated_at = ?
          WHERE source_chat_id = ? AND source_message_id = ? AND staff_chat_id = ?
            AND stage = 'CREATE_TOPIC' AND state = 'PENDING'
        `
        )
        .run(messageThreadId, now(), sourceChatId, sourceMessageId, staffChatId);
      if (updatedOperation.changes !== 1) {
        throw new Error("Inbound ticket topic creation state changed before finalization.");
      }

      this.db
        .prepare(
          `
          UPDATE ticket_inbound_routing_operations
          SET stage = CASE WHEN should_copy_original = 1 AND delivery_message_id IS NOT NULL
                          THEN 'COPY_ORIGINAL' ELSE 'SEND_UPDATE' END,
              state = 'READY', topic_thread_id = ?,
              failure_category = NULL, failure_description = NULL, updated_at = ?
          WHERE ticket_id = ?
            AND staff_chat_id = ?
            AND stage IN ('WAITING_FOR_TOPIC', 'CREATE_TOPIC')
            AND state IN ('READY', 'FAILED')
        `
        )
        .run(messageThreadId, now(), ticket.id, staffChatId);
      if (ticket.status === "CLOSED") this.cancelUnsentInboundForClosedTicket(ticket.id, staffChatId);
      return true;
    });

    return tx();
  }

  markTicketInboundRoutingSummaryDelivered(
    sourceChatId: number,
    sourceMessageId: number,
    staffChatId: number,
    summaryMessageId: number
  ): boolean {
    const tx = this.db.transaction(() => {
      const operation = this.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
      if (
        !operation ||
        operation.staff_chat_id !== staffChatId ||
        operation.stage !== "SEND_SUMMARY" ||
        operation.state !== "PENDING"
      )
        return false;
      const ticket = this.getTicket(operation.ticket_id);
      if (!ticket || ticket.staff_chat_id !== staffChatId) return false;
      if (ticket.staff_message_id !== null && ticket.staff_message_id !== summaryMessageId) return false;

      if (ticket.staff_message_id === null) {
        const updatedTicket = this.db
          .prepare(
            `UPDATE tickets SET staff_message_id = ?, updated_at = ? WHERE id = ? AND staff_chat_id = ? AND staff_message_id IS NULL`
          )
          .run(summaryMessageId, now(), ticket.id, staffChatId);
        if (updatedTicket.changes !== 1) return false;
      }

      const updatedOperation = this.db
        .prepare(
          `
          UPDATE ticket_inbound_routing_operations
          SET stage = CASE WHEN should_copy_original = 1 AND delivery_message_id IS NOT NULL
                          THEN 'COPY_ORIGINAL' ELSE 'SEND_INITIAL_POST' END,
              state = 'READY', summary_message_id = ?, updated_at = ?
          WHERE source_chat_id = ? AND source_message_id = ? AND staff_chat_id = ?
            AND stage = 'SEND_SUMMARY' AND state = 'PENDING'
        `
        )
        .run(summaryMessageId, now(), sourceChatId, sourceMessageId, staffChatId);
      if (updatedOperation.changes !== 1) {
        throw new Error("Inbound ticket summary state changed before finalization.");
      }
      if (ticket.status === "CLOSED") this.cancelUnsentInboundForClosedTicket(ticket.id, staffChatId);
      return true;
    });

    return tx();
  }

  markTicketInboundRoutingInitialPostDelivered(
    sourceChatId: number,
    sourceMessageId: number,
    staffChatId: number,
    deliveryMessageId: number
  ): boolean {
    return this.finalizeTicketInboundRoutingDelivery(
      sourceChatId,
      sourceMessageId,
      staffChatId,
      "SEND_INITIAL_POST",
      deliveryMessageId
    );
  }

  markTicketInboundRoutingUpdateDelivered(
    sourceChatId: number,
    sourceMessageId: number,
    staffChatId: number,
    deliveryMessageId: number
  ): boolean {
    return this.finalizeTicketInboundRoutingDelivery(
      sourceChatId,
      sourceMessageId,
      staffChatId,
      "SEND_UPDATE",
      deliveryMessageId,
      true
    );
  }

  markTicketInboundRoutingFailed(
    sourceChatId: number,
    sourceMessageId: number,
    staffChatId: number,
    failureCategory: TicketInboundRoutingOperationRecord["failure_category"],
    failureDescription: string | null
  ): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `
        UPDATE ticket_inbound_routing_operations
        SET state = 'FAILED', failure_category = ?, failure_description = ?, updated_at = ?
        WHERE source_chat_id = ? AND source_message_id = ? AND staff_chat_id = ? AND state = 'PENDING'
      `
        )
        .run(failureCategory, failureDescription, now(), sourceChatId, sourceMessageId, staffChatId);
      const operation = this.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
      const ticket = operation ? this.getTicket(operation.ticket_id) : undefined;
      if (result.changes === 1 && ticket?.staff_chat_id === staffChatId && ticket.status === "CLOSED")
        this.cancelUnsentInboundForClosedTicket(ticket.id, staffChatId);
      return result.changes === 1;
    })();
  }

  markTicketInboundRoutingCopyDelivered(
    sourceChatId: number,
    sourceMessageId: number,
    staffChatId: number,
    messageId: number
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE ticket_inbound_routing_operations
      SET stage = 'DONE', state = 'DELIVERED', copied_message_id = ?, updated_at = ?
      WHERE source_chat_id = ? AND source_message_id = ? AND staff_chat_id = ?
        AND stage = 'COPY_ORIGINAL' AND state = 'PENDING'
        AND EXISTS (SELECT 1 FROM tickets WHERE id = ticket_id AND staff_chat_id = ?)`
        )
        .run(messageId, now(), sourceChatId, sourceMessageId, staffChatId, staffChatId).changes === 1
    );
  }

  markTicketInboundRoutingUnknown(
    sourceChatId: number,
    sourceMessageId: number,
    staffChatId: number,
    failureDescription: string
  ): boolean {
    const result = this.db
      .prepare(
        `
        UPDATE ticket_inbound_routing_operations
        SET state = 'UNKNOWN_DELIVERY', failure_category = 'UNKNOWN_TELEGRAM_ERROR', failure_description = ?, updated_at = ?
        WHERE source_chat_id = ? AND source_message_id = ? AND staff_chat_id = ? AND state = 'PENDING'
      `
      )
      .run(failureDescription, now(), sourceChatId, sourceMessageId, staffChatId);
    return result.changes === 1;
  }

  markPendingTicketInboundRoutingOperationsUnknown(): number {
    const timestamp = now();
    const result = this.db
      .prepare(
        `
        UPDATE ticket_inbound_routing_operations
        SET state = 'UNKNOWN_DELIVERY', failure_category = 'UNKNOWN_TELEGRAM_ERROR',
            failure_description = 'Interrupted before inbound ticket routing was finalized.', updated_at = ?
        WHERE state = 'PENDING'
      `
      )
      .run(timestamp);
    return result.changes;
  }

  reconcileInboundRouting(
    operation: TicketInboundRoutingOperationRecord,
    input: ReconcileUnknownDeliveryInput
  ): boolean {
    const ticket = this.getTicket(operation.ticket_id);
    if (!ticket || ticket.staff_chat_id !== input.staffChatId || operation.staff_chat_id !== input.staffChatId)
      return false;
    if (input.action === "CONFIRMED_FAILED") {
      const changed = this.db
        .prepare(
          `UPDATE ticket_inbound_routing_operations
        SET state = 'RETRY_REQUIRED', failure_category = 'OPERATOR_CONFIRMED_NOT_DELIVERED', failure_description = ?, updated_at = ?
        WHERE source_chat_id = ? AND source_message_id = ? AND stage = ? AND attempt = ? AND state = 'UNKNOWN_DELIVERY'`
        )
        .run(
          input.note,
          now(),
          operation.source_chat_id,
          operation.source_message_id,
          operation.stage,
          operation.attempt
        ).changes;
      if (changed === 1 && ticket.status === "CLOSED") this.cancelUnsentInboundOperation(operation, true);
      return changed === 1;
    }
    if (
      operation.stage === "CREATE_TOPIC" &&
      this.db
        .prepare(
          `SELECT 1 FROM tickets
      WHERE staff_chat_id = ? AND message_thread_id = ? AND id != ? LIMIT 1`
        )
        .get(input.staffChatId, input.telegramMessageId, operation.ticket_id)
    )
      return false;
    // Within the caller's transaction, reuse the normal stage finalizers. No Telegram call occurs here.
    const changed = this.db
      .prepare(
        `UPDATE ticket_inbound_routing_operations SET state = 'PENDING',
      failure_category = NULL, failure_description = NULL
      WHERE source_chat_id = ? AND source_message_id = ? AND stage = ? AND attempt = ? AND state = 'UNKNOWN_DELIVERY'`
      )
      .run(operation.source_chat_id, operation.source_message_id, operation.stage, operation.attempt).changes;
    if (changed !== 1) return false;
    const args = [
      operation.source_chat_id,
      operation.source_message_id,
      input.staffChatId,
      input.telegramMessageId!,
    ] as const;
    switch (operation.stage) {
      case "CREATE_TOPIC":
        return this.markTicketInboundRoutingTopicCreated(...args);
      case "SEND_SUMMARY":
        return this.markTicketInboundRoutingSummaryDelivered(...args);
      case "SEND_INITIAL_POST":
        return this.markTicketInboundRoutingInitialPostDelivered(...args);
      case "SEND_UPDATE":
        return this.markTicketInboundRoutingUpdateDelivered(...args);
      case "COPY_ORIGINAL":
        return this.markTicketInboundRoutingCopyDelivered(...args);
      default:
        return false;
    }
  }

  requestInboundRoutingRetry(
    operation: TicketInboundRoutingOperationRecord
  ): TicketInboundRoutingOperationRecord | undefined {
    const ticket = this.getTicket(operation.ticket_id);
    if (
      !ticket ||
      ticket.staff_chat_id !== operation.staff_chat_id ||
      (ticket.status === "CLOSED" && operation.stage !== "COPY_ORIGINAL")
    )
      return undefined;
    const changed = this.db
      .prepare(
        `UPDATE ticket_inbound_routing_operations
      SET state = 'READY', attempt = attempt + 1, failure_category = NULL, failure_description = NULL, updated_at = ?
      WHERE source_chat_id = ? AND source_message_id = ? AND stage = ? AND attempt = ? AND state = 'RETRY_REQUIRED'`
      )
      .run(now(), operation.source_chat_id, operation.source_message_id, operation.stage, operation.attempt).changes;
    return changed === 1
      ? this.getTicketInboundRoutingOperation(operation.source_chat_id, operation.source_message_id)
      : undefined;
  }

  restartTicketInboundRoutingAfterUnavailableTopic(
    sourceChatId: number,
    sourceMessageId: number,
    staffChatId: number
  ): TicketInboundRoutingOperationRecord | undefined {
    const tx = this.db.transaction(() => {
      const operation = this.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
      if (
        !operation ||
        operation.staff_chat_id !== staffChatId ||
        operation.state !== "PENDING" ||
        !["SEND_SUMMARY", "SEND_INITIAL_POST", "SEND_UPDATE", "COPY_ORIGINAL"].includes(operation.stage)
      )
        return undefined;
      const ticket = this.getTicket(operation.ticket_id);
      if (!ticket || ticket.staff_chat_id !== staffChatId) return undefined;
      if (operation.topic_thread_id === null) return undefined;

      if (ticket.status === "CLOSED") {
        // Only a confirmed topic rejection reaches this method. Keep the received
        // content in the transcript, but do not provision a new topic for a closed ticket.
        this.db
          .prepare(
            `UPDATE ticket_inbound_routing_operations SET state = 'CANCELLED',
           failure_description = 'Routing cancelled after confirmed topic rejection on a closed ticket.', updated_at = ?
           WHERE source_chat_id = ? AND source_message_id = ? AND staff_chat_id = ? AND state = 'PENDING'`
          )
          .run(now(), sourceChatId, sourceMessageId, staffChatId);
        this.recordInboundContent(operation, operation.delivery_message_id);
        return this.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
      }

      // A different source may already have replaced the rejected topic. This call
      // represents a confirmed rejection, so a new attempt can use the current mapping.
      if (ticket.message_thread_id !== operation.topic_thread_id) {
        this.db
          .prepare(
            `UPDATE ticket_inbound_routing_operations
             SET stage = ?, state = 'READY', attempt = attempt + 1, topic_thread_id = ?,
                 summary_message_id = NULL, failure_category = NULL, failure_description = NULL, updated_at = ?
             WHERE source_chat_id = ? AND source_message_id = ? AND staff_chat_id = ? AND state = 'PENDING'`
          )
          .run(
            ticket.message_thread_id === null
              ? "WAITING_FOR_TOPIC"
              : operation.delivery_message_id !== null && operation.should_copy_original
                ? "COPY_ORIGINAL"
                : "SEND_UPDATE",
            ticket.message_thread_id,
            now(),
            sourceChatId,
            sourceMessageId,
            staffChatId
          );
        return this.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
      }

      const resetTicket = this.db
        .prepare(
          `
          UPDATE tickets
          SET message_thread_id = NULL, staff_message_id = NULL, updated_at = ?
          WHERE id = ? AND staff_chat_id = ? AND status != 'CLOSED' AND message_thread_id = ?
        `
        )
        .run(now(), ticket.id, staffChatId, operation.topic_thread_id);
      if (resetTicket.changes !== 1) return undefined;

      const resetOperation = this.db
        .prepare(
          `
          UPDATE ticket_inbound_routing_operations
          SET kind = 'FRESH_TICKET', stage = 'CREATE_TOPIC', state = 'READY', attempt = attempt + 1,
              topic_thread_id = NULL, summary_message_id = NULL,
              failure_category = NULL, failure_description = NULL, updated_at = ?
          WHERE source_chat_id = ? AND source_message_id = ? AND staff_chat_id = ? AND state = 'PENDING'
        `
        )
        .run(now(), sourceChatId, sourceMessageId, staffChatId);
      if (resetOperation.changes !== 1) return undefined;
      return this.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
    });

    return tx();
  }

  listReadyTicketInboundRoutingOperationsForTicket(
    ticketId: number,
    staffChatId: number,
    limit = 20
  ): TicketInboundRoutingOperationRecord[] {
    return this.db
      .prepare(
        `
        SELECT * FROM ticket_inbound_routing_operations
        WHERE ticket_id = ? AND staff_chat_id = ? AND state = 'READY' AND stage IN ('SEND_UPDATE', 'COPY_ORIGINAL')
        ORDER BY created_at ASC, source_chat_id ASC, source_message_id ASC
        LIMIT ?
      `
      )
      .all(ticketId, staffChatId, limit) as TicketInboundRoutingOperationRecord[];
  }

  private hasInboundTopicProvisioningOwner(ticketId: number, staffChatId: number): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM ticket_inbound_routing_operations
       WHERE ticket_id = ? AND staff_chat_id = ? AND stage = 'CREATE_TOPIC'
         AND state NOT IN ('DELIVERED', 'CANCELLED') LIMIT 1`
        )
        .get(ticketId, staffChatId)
    );
  }

  getTicket(ticketId: number): TicketRecord | undefined {
    return this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId) as TicketRecord | undefined;
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

  closeOtherActiveTicketsForUserInStaffChat(userTelegramId: number, staffChatId: number, keepTicketId: number): number {
    return this.db.transaction(() => {
      const closing = this.db
        .prepare(
          `SELECT id FROM tickets WHERE user_telegram_id = ? AND staff_chat_id = ?
      AND id != ? AND status != 'CLOSED'`
        )
        .all(userTelegramId, staffChatId, keepTicketId) as { id: number }[];
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

      for (const ticket of closing) this.cancelUnsentInboundForClosedTicket(ticket.id, staffChatId);
      return result.changes;
    })();
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

    return this.db.transaction(() => {
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

      const ticket = this.getTicket(ticketId);
      if (ticket?.status === "CLOSED" && ticket.staff_chat_id !== null)
        this.cancelUnsentInboundForClosedTicket(ticketId, ticket.staff_chat_id);
      return ticket;
    })();
  }

  transitionTicketStatusIfCurrent(
    ticketId: number,
    staffChatId: number,
    expectedStatus: TicketStatus,
    nextStatus: TicketStatus
  ): TicketTransitionResult {
    if (!ticketStatuses.includes(nextStatus)) throw new Error(`Unsupported ticket status: ${nextStatus}`);

    const tx = this.db.transaction(() => {
      const ticket = this.getTicket(ticketId);
      if (!ticket || ticket.staff_chat_id !== staffChatId) return { outcome: "NOT_FOUND", ticket: undefined } as const;
      if (ticket.status === nextStatus) return { outcome: "IDEMPOTENT", ticket } as const;
      if (ticket.status === "CLOSED" || ticket.status !== expectedStatus)
        return { outcome: "CONFLICT", ticket } as const;

      const timestamp = now();
      const result = this.db
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
          WHERE id = ? AND staff_chat_id = ? AND status = ?
        `
        )
        .run(
          nextStatus,
          timestamp,
          nextStatus,
          nextStatus === "CLOSED" ? timestamp : null,
          nextStatus,
          nextStatus,
          nextStatus,
          nextStatus,
          nextStatus,
          nextStatus,
          nextStatus,
          nextStatus === "CLOSED" ? timestamp : null,
          nextStatus,
          ticketId,
          staffChatId,
          expectedStatus
        );
      const updated = this.getTicket(ticketId);
      if (result.changes !== 1 || !updated) return { outcome: "CONFLICT", ticket: updated } as const;
      if (nextStatus === "CLOSED") this.cancelUnsentInboundForClosedTicket(ticketId, staffChatId);
      return { outcome: "APPLIED", ticket: updated } as const;
    });

    return tx();
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
    return this.db.transaction(() => {
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
        .run(timestamp, timestamp, input.type, input.displayName, input.username ?? null, timestamp, ticketId);

      const ticket = this.getTicket(ticketId);
      if (ticket && ticket.staff_chat_id !== null)
        this.cancelUnsentInboundForClosedTicket(ticketId, ticket.staff_chat_id);
      return ticket;
    })();
  }

  closeTicketRecordIfOpen(ticketId: number, staffChatId: number, input: CloseTicketInput): TicketTransitionResult {
    const tx = this.db.transaction(() => {
      const ticket = this.getTicket(ticketId);
      if (!ticket || ticket.staff_chat_id !== staffChatId) return { outcome: "NOT_FOUND", ticket: undefined } as const;
      if (ticket.status === "CLOSED") return { outcome: "IDEMPOTENT", ticket } as const;

      const timestamp = now();
      const result = this.db
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
          WHERE id = ? AND staff_chat_id = ? AND status != 'CLOSED'
        `
        )
        .run(
          timestamp,
          timestamp,
          input.type,
          input.displayName,
          input.username ?? null,
          timestamp,
          ticketId,
          staffChatId
        );
      const updated = this.getTicket(ticketId);
      if (result.changes !== 1 || !updated) return { outcome: "CONFLICT", ticket: updated } as const;
      this.cancelUnsentInboundForClosedTicket(ticketId, staffChatId);
      return { outcome: "APPLIED", ticket: updated } as const;
    });

    return tx();
  }

  markTicketArchivedAndDeleteMessages(ticketId: number, logsMessageId: number, transcriptMessageId: number): void {
    const tx = this.db.transaction(() =>
      this.markTicketArchivedAndDeleteMessagesInTransaction(ticketId, logsMessageId, transcriptMessageId)
    );

    tx();
  }

  createTicketOutboundDeliveryIntent(input: CreateTicketOutboundDeliveryIntentInput): {
    created: boolean;
    delivery: TicketOutboundDeliveryRecord;
  } {
    const tx = this.db.transaction(() => {
      const existing = this.getTicketOutboundDelivery(input.operationKey);
      if (existing) return { created: false, delivery: existing };

      const legacyDeliveryMessageId = this.findProvenLegacyStaffDelivery(input);
      const created = this.insertTicketOutboundDelivery(input, legacyDeliveryMessageId);
      const delivery = this.getTicketOutboundDelivery(input.operationKey);
      if (!delivery) throw new Error("Could not load ticket outbound delivery intent");
      return { created: created && legacyDeliveryMessageId === null, delivery };
    });

    return tx();
  }

  getTicketOutboundDelivery(operationKey: string): TicketOutboundDeliveryRecord | undefined {
    return this.db.prepare("SELECT * FROM ticket_outbound_deliveries WHERE operation_key = ?").get(operationKey) as
      TicketOutboundDeliveryRecord | undefined;
  }

  markTicketOutboundDeliveryDelivered(operationKey: string, deliveryMessageId: number): number | null {
    const tx = this.db.transaction(() => {
      const delivery = this.getTicketOutboundDelivery(operationKey);
      if (!delivery) throw new Error("Ticket outbound delivery intent was not found");
      if (delivery.state === "DELIVERED") return delivery.delivery_message_id;
      if (delivery.state !== "PENDING") return null;
      this.db
        .prepare(
          `UPDATE ticket_outbound_deliveries
           SET state = 'DELIVERED', delivery_message_id = ?, failure_category = NULL, failure_description = NULL, updated_at = ?
           WHERE operation_key = ? AND state = 'PENDING'`
        )
        .run(deliveryMessageId, now(), operationKey);
      this.addMessage({
        ticketId: delivery.ticket_id,
        direction: "STAFF_TO_USER",
        sourceChatId: delivery.source_chat_id,
        sourceMessageId: delivery.source_message_id,
        deliveryChatId: delivery.delivery_chat_id,
        deliveryMessageId,
        fromTelegramId: delivery.from_telegram_id,
        fromUsername: delivery.from_username,
        senderType: delivery.sender_type,
        senderDisplayName: delivery.sender_display_name,
        senderUsername: delivery.sender_username,
        text: delivery.text,
        mediaType: delivery.media_type,
        filename: delivery.filename,
        fileId: delivery.file_id,
      });
      return deliveryMessageId;
    });
    return tx();
  }

  markTicketOutboundDeliveryFailed(
    operationKey: string,
    failureCategory: string,
    failureDescription: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE ticket_outbound_deliveries
         SET state = 'FAILED', failure_category = ?, failure_description = ?, updated_at = ?
         WHERE operation_key = ? AND state = 'PENDING'`
      )
      .run(failureCategory, failureDescription, now(), operationKey);
  }

  markTicketOutboundDeliveryUnknown(operationKey: string, failureDescription: string | null): void {
    this.db
      .prepare(
        `UPDATE ticket_outbound_deliveries
         SET state = 'UNKNOWN_DELIVERY', failure_description = ?, updated_at = ?
         WHERE operation_key = ? AND state = 'PENDING'`
      )
      .run(failureDescription, now(), operationKey);
  }

  markPendingTicketOutboundDeliveriesUnknown(): number {
    return this.db
      .prepare(
        `UPDATE ticket_outbound_deliveries
         SET state = 'UNKNOWN_DELIVERY', failure_description = 'Process ended while Telegram delivery outcome was pending.', updated_at = ?
         WHERE state = 'PENDING'`
      )
      .run(now()).changes;
  }

  hasUnresolvedTicketOutboundDeliveries(ticketId: number): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM ticket_outbound_deliveries WHERE ticket_id = ? AND state IN ('PENDING', 'UNKNOWN_DELIVERY') LIMIT 1"
        )
        .get(ticketId)
    );
  }

  hasUnresolvedTicketInboundRoutingOperations(ticketId: number): boolean {
    return Boolean(
      this.db
        .prepare(
          `
          SELECT 1
          FROM ticket_inbound_routing_operations
          WHERE ticket_id = ? AND state NOT IN ('DELIVERED', 'CANCELLED')
          LIMIT 1
        `
        )
        .get(ticketId)
    );
  }

  getTicketArchiveDelivery(ticketId: number): TicketArchiveDeliveryRecord | undefined {
    return this.db.prepare("SELECT * FROM ticket_archive_deliveries WHERE ticket_id = ?").get(ticketId) as
      TicketArchiveDeliveryRecord | undefined;
  }

  claimTicketArchiveSummary(ticketId: number, logsThreadId: number): TicketArchiveDeliveryClaim {
    const timestamp = now();
    const inserted = this.db
      .prepare(
        `INSERT INTO ticket_archive_deliveries (ticket_id, state, logs_thread_id, created_at, updated_at)
         VALUES (?, 'SUMMARY_PENDING', ?, ?, ?)
         ON CONFLICT(ticket_id) DO NOTHING`
      )
      .run(ticketId, logsThreadId, timestamp, timestamp);
    if (inserted.changes === 1) return { claimed: true, delivery: this.getTicketArchiveDelivery(ticketId)! };

    const retried = this.db
      .prepare(
        `UPDATE ticket_archive_deliveries
         SET state = 'SUMMARY_PENDING', logs_thread_id = ?, failure_category = NULL, failure_description = NULL, updated_at = ?
         WHERE ticket_id = ? AND state = 'FAILED' AND summary_message_id IS NULL`
      )
      .run(logsThreadId, timestamp, ticketId);
    return { claimed: retried.changes === 1, delivery: this.getTicketArchiveDelivery(ticketId)! };
  }

  markTicketArchiveSummarySent(ticketId: number, messageId: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE ticket_archive_deliveries
         SET state = 'SUMMARY_SENT', summary_message_id = ?, failure_category = NULL, failure_description = NULL, updated_at = ?
         WHERE ticket_id = ? AND state = 'SUMMARY_PENDING'`
        )
        .run(messageId, now(), ticketId).changes === 1
    );
  }

  claimTicketArchiveDocument(ticketId: number): TicketArchiveDeliveryClaim | undefined {
    const updated = this.db
      .prepare(
        `UPDATE ticket_archive_deliveries SET state = 'DOCUMENT_PENDING', updated_at = ?
         WHERE ticket_id = ? AND state = 'SUMMARY_SENT'`
      )
      .run(now(), ticketId);
    const delivery = this.getTicketArchiveDelivery(ticketId);
    return delivery ? { claimed: updated.changes === 1, delivery } : undefined;
  }

  markTicketArchiveDocumentDelivered(ticketId: number, messageId: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE ticket_archive_deliveries
         SET state = 'DELIVERED', document_message_id = ?, failure_category = NULL, failure_description = NULL, updated_at = ?
         WHERE ticket_id = ? AND state = 'DOCUMENT_PENDING'`
        )
        .run(messageId, now(), ticketId).changes === 1
    );
  }

  restageTicketArchiveForReplacementTopic(ticketId: number, logsThreadId: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE ticket_archive_deliveries
           SET state = 'FAILED', logs_thread_id = ?, summary_message_id = NULL, document_message_id = NULL,
               failure_category = NULL, failure_description = NULL, updated_at = ?
           WHERE ticket_id = ? AND state = 'SUMMARY_SENT'`
        )
        .run(logsThreadId, now(), ticketId).changes === 1
    );
  }

  markTicketArchiveFailed(ticketId: number, failureCategory: string, failureDescription: string | null): void {
    this.db
      .prepare(
        `UPDATE ticket_archive_deliveries
         SET state = CASE WHEN summary_message_id IS NULL THEN 'FAILED' ELSE 'SUMMARY_SENT' END,
             failure_category = ?, failure_description = ?, updated_at = ?
         WHERE ticket_id = ? AND state IN ('SUMMARY_PENDING', 'DOCUMENT_PENDING')`
      )
      .run(failureCategory, failureDescription, now(), ticketId);
  }

  markTicketArchiveUnknown(ticketId: number, failureDescription: string | null): void {
    this.db
      .prepare(
        `UPDATE ticket_archive_deliveries
         SET state = 'UNKNOWN_DELIVERY', failure_description = ?, updated_at = ?
         WHERE ticket_id = ? AND state IN ('SUMMARY_PENDING', 'DOCUMENT_PENDING')`
      )
      .run(failureDescription, now(), ticketId);
  }

  markPendingTicketArchiveDeliveriesUnknown(): number {
    return this.db
      .prepare(
        `UPDATE ticket_archive_deliveries
         SET state = 'UNKNOWN_DELIVERY', failure_description = 'Process ended while Support Logs delivery outcome was pending.', updated_at = ?
         WHERE state IN ('SUMMARY_PENDING', 'DOCUMENT_PENDING')`
      )
      .run(now()).changes;
  }

  finalizeTicketArchiveDelivery(ticketId: number): boolean {
    const tx = this.db.transaction(() => {
      const delivery = this.getTicketArchiveDelivery(ticketId);
      if (
        !delivery ||
        delivery.state !== "DELIVERED" ||
        delivery.summary_message_id === null ||
        delivery.document_message_id === null
      )
        return false;
      this.markTicketArchivedAndDeleteMessagesInTransaction(
        ticketId,
        delivery.summary_message_id,
        delivery.document_message_id
      );
      this.db.prepare("DELETE FROM ticket_outbound_deliveries WHERE ticket_id = ?").run(ticketId);
      this.db.prepare("DELETE FROM ticket_archive_deliveries WHERE ticket_id = ?").run(ticketId);
      return true;
    });
    return tx();
  }

  private markTicketArchivedAndDeleteMessagesInTransaction(
    ticketId: number,
    logsMessageId: number,
    transcriptMessageId: number
  ): void {
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
  }

  private findProvenLegacyStaffDelivery(input: CreateTicketOutboundDeliveryIntentInput): number | null {
    if (
      !input.operationKey.startsWith("staff-message:") ||
      input.direction !== "STAFF_TO_USER" ||
      input.sourceChatId === null ||
      input.sourceChatId === undefined ||
      input.sourceMessageId === null ||
      input.sourceMessageId === undefined
    )
      return null;

    const row = this.db
      .prepare(
        `SELECT delivery_message_id
         FROM messages
         WHERE ticket_id = ?
           AND direction = 'STAFF_TO_USER'
           AND source_chat_id = ?
           AND source_message_id = ?
           AND delivery_message_id IS NOT NULL
         ORDER BY id ASC
         LIMIT 1`
      )
      .get(input.ticketId, input.sourceChatId, input.sourceMessageId) as { delivery_message_id: number } | undefined;
    return row?.delivery_message_id ?? null;
  }

  private insertTicketOutboundDelivery(
    input: CreateTicketOutboundDeliveryIntentInput,
    legacyDeliveryMessageId: number | null
  ): boolean {
    const timestamp = now();
    return (
      this.db
        .prepare(
          `INSERT INTO ticket_outbound_deliveries (
            operation_key, ticket_id, state, source_chat_id, source_message_id, delivery_chat_id,
            delivery_message_id, from_telegram_id, from_username, sender_type, sender_display_name, sender_username,
            text, media_type, filename, file_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(operation_key) DO NOTHING`
        )
        .run(
          input.operationKey,
          input.ticketId,
          legacyDeliveryMessageId === null ? "PENDING" : "DELIVERED",
          input.sourceChatId ?? null,
          input.sourceMessageId ?? null,
          input.deliveryChatId ?? null,
          legacyDeliveryMessageId,
          input.fromTelegramId ?? null,
          input.fromUsername ?? null,
          input.senderType ?? senderTypeForDirection(input.direction),
          input.senderDisplayName ?? null,
          input.senderUsername ?? input.fromUsername ?? null,
          input.text ?? null,
          input.mediaType ?? null,
          input.filename ?? null,
          input.fileId ?? null,
          timestamp,
          timestamp
        ).changes === 1
    );
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
          createdAt: now(),
        });

      this.db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(now(), message.ticketId);

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
          AND NOT EXISTS (
            SELECT 1 FROM ticket_outbound_deliveries
            WHERE ticket_outbound_deliveries.ticket_id = tickets.id
              AND ticket_outbound_deliveries.state IN ('PENDING', 'UNKNOWN_DELIVERY')
          )
          AND NOT EXISTS (
            SELECT 1 FROM ticket_archive_deliveries
            WHERE ticket_archive_deliveries.ticket_id = tickets.id
              AND ticket_archive_deliveries.state = 'UNKNOWN_DELIVERY'
          )
          AND NOT EXISTS (
            SELECT 1 FROM delivery_reconciliation_audit
            WHERE delivery_reconciliation_audit.ticket_id = tickets.id
              AND delivery_reconciliation_audit.staff_chat_id = tickets.staff_chat_id
              AND delivery_reconciliation_audit.delivery_kind IN ('ARCHIVE_SUMMARY', 'ARCHIVE_DOCUMENT')
              AND delivery_reconciliation_audit.action = 'CONFIRMED_FAILED'
          )
          AND EXISTS (
            SELECT 1 FROM messages WHERE messages.ticket_id = tickets.id
          )
        ORDER BY tickets.closed_at ASC, tickets.id ASC
        LIMIT ?
      `
      )
      .all(staffChatId, limit) as TicketWithUser[];
  }

  setTicketFollowUpContext(
    ticketId: number,
    input: {
      followUpState: TicketFollowUpState;
      internalNote: string | null;
      escalationTarget: TicketEscalationTarget;
      sourceAnswerPackageId?: string | null;
    }
  ): TicketRecord | undefined {
    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tickets SET follow_up_state = ?, internal_note = ?, escalation_target = ?, follow_up_updated_at = ?, follow_up_source_answer_package_id = ?, updated_at = ? WHERE id = ?`
        )
        .run(
          input.followUpState,
          input.internalNote,
          input.escalationTarget,
          timestamp,
          input.sourceAnswerPackageId ?? null,
          timestamp,
          ticketId
        );
      this.db
        .prepare(
          `INSERT INTO ticket_follow_up_history (ticket_id, follow_up_state, internal_note, escalation_target, source_answer_package_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          ticketId,
          input.followUpState,
          input.internalNote,
          input.escalationTarget,
          input.sourceAnswerPackageId ?? null,
          timestamp
        );
    });
    tx();
    return this.getTicket(ticketId);
  }

  applyTicketBatchFollowUpIfCurrent(
    ticketId: number,
    staffChatId: number,
    expectedStatus: TicketStatus,
    input: ApplyTicketBatchFollowUpInput
  ): TicketTransitionResult {
    const tx = this.db.transaction(() => {
      const ticket = this.getTicket(ticketId);
      if (!ticket || ticket.staff_chat_id !== staffChatId) return { outcome: "NOT_FOUND", ticket: undefined } as const;

      const alreadyApplied =
        ticket.status === input.nextStatus &&
        ticket.follow_up_state === input.followUpState &&
        ticket.internal_note === input.internalNote &&
        ticket.escalation_target === input.escalationTarget &&
        ticket.follow_up_source_answer_package_id === input.sourceAnswerPackageId;
      if (alreadyApplied) return { outcome: "IDEMPOTENT", ticket } as const;
      if (ticket.status !== expectedStatus) return { outcome: "CONFLICT", ticket } as const;
      const expected = input.expectedFollowUp;
      if (
        expected &&
        (ticket.follow_up_state !== expected.follow_up_state ||
          ticket.internal_note !== expected.internal_note ||
          ticket.escalation_target !== expected.escalation_target ||
          ticket.follow_up_updated_at !== expected.follow_up_updated_at ||
          ticket.follow_up_source_answer_package_id !== expected.follow_up_source_answer_package_id)
      )
        return { outcome: "CONFLICT", ticket } as const;

      const timestamp = now();
      const result = this.db
        .prepare(
          `UPDATE tickets
           SET status = ?, follow_up_state = ?, internal_note = ?, escalation_target = ?,
               follow_up_updated_at = ?, follow_up_source_answer_package_id = ?, updated_at = ?
           WHERE id = ? AND staff_chat_id = ? AND status = ?`
        )
        .run(
          input.nextStatus,
          input.followUpState,
          input.internalNote,
          input.escalationTarget,
          timestamp,
          input.sourceAnswerPackageId,
          timestamp,
          ticketId,
          staffChatId,
          expectedStatus
        );
      const updated = this.getTicket(ticketId);
      if (result.changes !== 1 || !updated) return { outcome: "CONFLICT", ticket: updated } as const;
      this.db
        .prepare(
          `INSERT INTO ticket_follow_up_history
             (ticket_id, follow_up_state, internal_note, escalation_target, source_answer_package_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          ticketId,
          input.followUpState,
          input.internalNote,
          input.escalationTarget,
          input.sourceAnswerPackageId,
          timestamp
        );
      return { outcome: "APPLIED", ticket: updated } as const;
    });

    return tx();
  }

  clearWaitingUserFollowUp(ticketId: number): TicketRecord | undefined {
    const ticket = this.getTicket(ticketId);
    if (!ticket || ticket.follow_up_state !== "WAITING_USER") return ticket;
    return this.setTicketFollowUpContext(ticketId, {
      followUpState: "NONE",
      internalNote: null,
      escalationTarget: "NONE",
      sourceAnswerPackageId: ticket.follow_up_source_answer_package_id,
    });
  }

  listTicketFollowUpHistory(ticketId: number): TicketFollowUpHistoryRecord[] {
    return this.db
      .prepare("SELECT * FROM ticket_follow_up_history WHERE ticket_id = ? ORDER BY id ASC")
      .all(ticketId) as TicketFollowUpHistoryRecord[];
  }

  getBannedUser(userTelegramId: number): BannedUserRecord | undefined {
    return this.db.prepare("SELECT * FROM banned_users WHERE user_telegram_id = ?").get(userTelegramId) as
      BannedUserRecord | undefined;
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
        createdAt: now(),
      });
  }

  unbanUser(userTelegramId: number): boolean {
    const result = this.db.prepare("DELETE FROM banned_users WHERE user_telegram_id = ?").run(userTelegramId);

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

  private insertTicketInboundRoutingOperation(
    input: BeginTicketInboundRoutingInput,
    ticket: TicketRecord,
    kind: TicketInboundRoutingOperationRecord["kind"],
    stage: TicketInboundRoutingStage
  ): void {
    const timestamp = now();
    this.db
      .prepare(
        `
        INSERT INTO ticket_inbound_routing_operations (
          source_chat_id, source_message_id, ticket_id, staff_chat_id, kind, stage, state,
          user_telegram_id, from_username, from_first_name, from_last_name, sender_display_name, sender_username,
          text, media_type, filename, file_id, should_copy_original, topic_thread_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        input.sourceChatId,
        input.sourceMessageId,
        ticket.id,
        input.staffChatId,
        kind,
        stage,
        input.userTelegramId,
        input.fromUsername ?? null,
        input.fromFirstName ?? null,
        input.fromLastName ?? null,
        input.senderDisplayName,
        input.senderUsername ?? null,
        input.text ?? null,
        input.mediaType ?? null,
        input.filename ?? null,
        input.fileId ?? null,
        input.shouldCopyOriginal ? 1 : 0,
        ticket.message_thread_id,
        timestamp,
        timestamp
      );
  }

  private cancelUnsentInboundForClosedTicket(ticketId: number, staffChatId: number): void {
    const operations = this.db
      .prepare(
        `SELECT * FROM ticket_inbound_routing_operations
      WHERE ticket_id = ? AND staff_chat_id = ? AND state IN ('READY', 'FAILED', 'RETRY_REQUIRED')
        AND (stage != 'COPY_ORIGINAL' OR state IN ('FAILED', 'RETRY_REQUIRED'))`
      )
      .all(ticketId, staffChatId) as TicketInboundRoutingOperationRecord[];
    for (const operation of operations) this.cancelUnsentInboundOperation(operation, true);
  }

  private cancelUnsentInboundOperation(
    operation: TicketInboundRoutingOperationRecord,
    preserveTranscript: boolean
  ): void {
    const result = this.db
      .prepare(
        `UPDATE ticket_inbound_routing_operations
      SET state = 'CANCELLED', failure_description = 'Unsent routing cancelled: ticket closed or workspace changed.', updated_at = ?
      WHERE source_chat_id = ? AND source_message_id = ? AND state IN ('READY', 'FAILED', 'RETRY_REQUIRED')`
      )
      .run(now(), operation.source_chat_id, operation.source_message_id);
    // Retain received customer content for the archive without claiming staff delivery.
    if (result.changes === 1 && preserveTranscript) this.recordInboundContent(operation, null);
  }

  private recordInboundContent(operation: TicketInboundRoutingOperationRecord, deliveryMessageId: number | null): void {
    const exists = this.db
      .prepare(
        `SELECT 1 FROM messages WHERE ticket_id = ? AND direction = 'USER_TO_STAFF'
      AND source_chat_id = ? AND source_message_id = ?`
      )
      .get(operation.ticket_id, operation.source_chat_id, operation.source_message_id);
    if (!exists)
      this.addMessage({
        ticketId: operation.ticket_id,
        direction: "USER_TO_STAFF",
        sourceChatId: operation.source_chat_id,
        sourceMessageId: operation.source_message_id,
        deliveryChatId: operation.staff_chat_id,
        deliveryMessageId,
        fromTelegramId: operation.user_telegram_id,
        fromUsername: operation.from_username,
        senderType: "USER",
        senderDisplayName: operation.sender_display_name,
        senderUsername: operation.sender_username,
        text: operation.text,
        mediaType: operation.media_type,
        filename: operation.filename,
        fileId: operation.file_id,
      });
  }

  private finalizeTicketInboundRoutingDelivery(
    sourceChatId: number,
    sourceMessageId: number,
    staffChatId: number,
    stage: "SEND_INITIAL_POST" | "SEND_UPDATE",
    deliveryMessageId: number,
    clearWaitingUserFollowUp = false
  ): boolean {
    const tx = this.db.transaction(() => {
      const operation = this.getTicketInboundRoutingOperation(sourceChatId, sourceMessageId);
      if (
        !operation ||
        operation.staff_chat_id !== staffChatId ||
        operation.stage !== stage ||
        operation.state !== "PENDING"
      )
        return false;
      const ticket = this.getTicket(operation.ticket_id);
      if (!ticket || ticket.staff_chat_id !== staffChatId) return false;

      this.recordInboundContent(operation, deliveryMessageId);

      const timestamp = now();
      if (clearWaitingUserFollowUp && ticket.status === "WAITING_USER") {
        this.db
          .prepare(
            `
            UPDATE tickets
            SET status = 'IN_PROGRESS', follow_up_state = 'NONE', internal_note = NULL, escalation_target = 'NONE',
                follow_up_updated_at = ?, follow_up_source_answer_package_id = NULL, updated_at = ?
            WHERE id = ? AND staff_chat_id = ? AND status = 'WAITING_USER'
          `
          )
          .run(timestamp, timestamp, ticket.id, staffChatId);
        this.db
          .prepare(
            `
            INSERT INTO ticket_follow_up_history (
              ticket_id, follow_up_state, internal_note, escalation_target, source_answer_package_id, created_at
            ) VALUES (?, 'NONE', NULL, 'NONE', ?, ?)
          `
          )
          .run(ticket.id, ticket.follow_up_source_answer_package_id, timestamp);
      } else {
        this.db
          .prepare("UPDATE tickets SET updated_at = ? WHERE id = ? AND staff_chat_id = ?")
          .run(timestamp, ticket.id, staffChatId);
      }

      const updatedOperation = this.db
        .prepare(
          `
          UPDATE ticket_inbound_routing_operations
          SET stage = CASE WHEN should_copy_original = 1 THEN 'COPY_ORIGINAL' ELSE 'DONE' END,
              state = CASE WHEN should_copy_original = 1 THEN 'READY' ELSE 'DELIVERED' END,
              delivery_message_id = ?, updated_at = ?
          WHERE source_chat_id = ? AND source_message_id = ? AND staff_chat_id = ?
            AND stage = ? AND state = 'PENDING'
        `
        )
        .run(deliveryMessageId, timestamp, sourceChatId, sourceMessageId, staffChatId, stage);
      if (updatedOperation.changes !== 1) {
        throw new Error("Inbound ticket delivery state changed before finalization.");
      }
      return true;
    });

    return tx();
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    ["SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"].includes((error as { code: string }).code)
  );
}

export function inboundRoutingAttemptIdentity(operation: TicketInboundRoutingOperationRecord): string {
  return `inbound:${operation.source_chat_id}:${operation.source_message_id}:${operation.stage}:${operation.attempt}`;
}
