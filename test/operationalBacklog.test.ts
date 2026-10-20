import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SupportDatabase } from "../src/db.js";
import { backlogAgeSeconds } from "../src/operationalBacklog.js";
import {
  OPERATIONAL_BACKLOG_SQL,
  OperationalBacklogRepository,
} from "../src/persistence/operationalBacklogRepository.js";

const AT = "2026-10-20T12:00:00.000Z";
const STAFF = -100900;
const OLD = "2026-10-20T10:00:00.000Z";
const FUTURE = "2026-10-20T13:00:00.000Z";

function fileFixture<T>(
  seed: (db: SupportDatabase) => T,
  mutate: (sql: Database.Database, value: T) => void,
  verify: (db: SupportDatabase, value: T) => void
): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "operational-backlog-"));
  const filename = path.join(directory, "support.db");
  try {
    const initial = new SupportDatabase(filename);
    let value: T;
    try {
      activate(initial);
      value = seed(initial);
    } finally {
      initial.close();
    }
    const sql = new Database(filename);
    try {
      mutate(sql, value);
    } finally {
      sql.close();
    }
    const reopened = new SupportDatabase(filename);
    try {
      verify(reopened, value);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function ticket(db: SupportDatabase, user: number, staffChatId = STAFF): number {
  db.upsertUser({ telegramId: user });
  const id = db.createTicket(user, staffChatId).id;
  db.updateTicketForumTopic(id, staffChatId, 5000 + user);
  return id;
}

function batch(
  db: SupportDatabase,
  id: string,
  user: number,
  action: "reply_keep_open" | "reply_and_close" | "silent_close" | "no_action" = "reply_keep_open",
  staffChatId = STAFF
): number {
  const ticketId = ticket(db, user, staffChatId);
  db.createTicketBatchExport({
    exportId: id,
    staffChatId,
    createdAt: OLD,
    selectionMode: "all_active",
    ticketCount: 1,
    items: [{ ticketId, snapshotToken: "sha256:test" }],
  });
  db.createTicketBatchAnswerPackage({
    answerPackageId: id,
    exportId: id,
    staffChatId,
    packageHash: `sha256:${id}`,
    sourceChatId: staffChatId,
    sourceMessageId: user,
    packageCreatedAt: OLD,
    items: [
      {
        ticket_id: ticketId,
        snapshot_token: "sha256:test",
        action,
        reply_text: action.startsWith("reply") ? "Reply" : null,
      },
    ],
  });
  return ticketId;
}

function activate(db: SupportDatabase, chatId = STAFF): void {
  const workspace = db.upsertWorkspace({ telegramChatId: chatId });
  db.setInstallationState({ active_workspace_id: workspace.id });
}

test("backlog observation distinguishes no workspace, empty queues, and review-only inbound work", () => {
  const db = new SupportDatabase(":memory:");
  try {
    assert.equal(db.observeOperationalBacklog(AT), null);
    activate(db);
    const empty = db.observeOperationalBacklog(AT)!;
    assert.equal(empty.staffChatId, STAFF);
    assert.deepEqual(empty.deliveryReview, { count: 0, oldestAgeSeconds: 0 });
    assert.equal(empty.unknownDeliveryCount, 0);
    assert.deepEqual(empty.batchRecovery, { count: 0, oldestOverdueSeconds: 0 });
    assert.deepEqual(empty.moderationCleanup, { count: 0, oldestOverdueSeconds: 0 });
    assert.deepEqual(empty.archiveRecovery, { count: 0, oldestAgeSeconds: 0 });
    db.upsertUser({ telegramId: 10 });
    db.beginTicketInboundRouting({
      userTelegramId: 10,
      staffChatId: STAFF,
      sourceChatId: 10,
      sourceMessageId: 1,
      senderDisplayName: "Customer",
      text: "Customer content",
      mediaType: null,
      fileId: null,
      filename: null,
      shouldCopyOriginal: false,
    });
    const observed = db.observeOperationalBacklog(AT)!;
    assert.equal(observed.deliveryReview.count, 1);
    assert.equal(observed.unknownDeliveryCount, 0);
  } finally {
    db.close();
  }
});

test("review states, reconciled audits, actual unknown operations and Batch dedup stay distinct and workspace scoped", () => {
  fileFixture(
    (db) => {
      for (const [index, state] of ["READY", "FAILED", "RETRY_REQUIRED", "UNKNOWN_DELIVERY"].entries()) {
        db.upsertUser({ telegramId: 20 + index });
        db.beginTicketInboundRouting({
          userTelegramId: 20 + index,
          staffChatId: STAFF,
          sourceChatId: 20 + index,
          sourceMessageId: 1,
          senderDisplayName: "Customer",
          text: state,
          shouldCopyOriginal: false,
        });
      }
      const interactive = ticket(db, 30);
      db.createTicketOutboundDeliveryIntent({
        operationKey: "staff-message:test",
        ticketId: interactive,
        direction: "STAFF_TO_USER",
        text: "Reply",
      });
      db.markTicketOutboundDeliveryUnknown("staff-message:test", "Ambiguous");
      const archived = ticket(db, 31);
      db.claimTicketArchiveSummary(archived, 500);
      db.markTicketArchiveUnknown(archived, "Ambiguous");
      const document = ticket(db, 33);
      db.claimTicketArchiveSummary(document, 500);
      db.markTicketArchiveSummarySent(document, 501);
      db.claimTicketArchiveDocument(document);
      db.markTicketArchiveUnknown(document, "Ambiguous document");
      const pending = ticket(db, 34);
      db.createTicketOutboundDeliveryIntent({
        operationKey: "staff-message:pending",
        ticketId: pending,
        direction: "STAFF_TO_USER",
        text: "Reply",
      });
      const audited = ticket(db, 35);
      db.createTicketOutboundDeliveryIntent({
        operationKey: "staff-message:audited",
        ticketId: audited,
        direction: "STAFF_TO_USER",
        text: "Reply",
      });
      db.markTicketOutboundDeliveryUnknown("staff-message:audited", "Ambiguous");
      const auditedCase = db
        .listUnknownDeliveryReconciliations(STAFF)
        .find((item) => item.operationIdentity === "staff-message:audited")!;
      db.reconcileUnknownDelivery({
        staffChatId: STAFF,
        caseToken: auditedCase.caseToken,
        action: "CONFIRMED_FAILED",
        note: "Verified",
        reconciledBy: 1,
      });
      const batchId = batch(db, "unknown-batch", 32);
      db.updateTicketBatchAnswerItem("unknown-batch", batchId, "UNKNOWN_DELIVERY");
      db.createTicketOutboundDeliveryIntent({
        operationKey: `ticket-batch:unknown-batch:${batchId}`,
        ticketId: batchId,
        direction: "STAFF_TO_USER",
        text: "Reply",
      });
      db.markTicketOutboundDeliveryUnknown(`ticket-batch:unknown-batch:${batchId}`, "Ambiguous");
      const other = ticket(db, 40, -100901);
      db.createTicketOutboundDeliveryIntent({
        operationKey: "staff-message:other",
        ticketId: other,
        direction: "STAFF_TO_USER",
        text: "Reply",
      });
      db.markTicketOutboundDeliveryUnknown("staff-message:other", "Ambiguous");
      return { interactive };
    },
    (sql) => {
      for (const [index, state] of ["READY", "FAILED", "RETRY_REQUIRED", "UNKNOWN_DELIVERY"].entries()) {
        sql
          .prepare("UPDATE ticket_inbound_routing_operations SET state = ?, updated_at = ? WHERE source_chat_id = ?")
          .run(state, OLD, 20 + index);
      }
      sql.prepare("UPDATE ticket_outbound_deliveries SET updated_at = ?").run(OLD);
      sql
        .prepare(
          "UPDATE ticket_outbound_deliveries SET state = 'UNKNOWN_DELIVERY' WHERE operation_key = 'staff-message:audited'"
        )
        .run();
      sql.prepare("UPDATE ticket_archive_deliveries SET updated_at = ?").run(OLD);
      sql.prepare("UPDATE ticket_batch_answer_items SET updated_at = ?, topic_echo_state = 'NOT_REQUIRED'").run(OLD);
      sql.prepare("UPDATE ticket_batch_answer_packages SET final_summary_state = 'UNKNOWN_DELIVERY'").run();
      sql.prepare("UPDATE ticket_batch_exports SET delivery_state = 'UNKNOWN_DELIVERY'").run();
    },
    (db) => {
      let result = db.observeOperationalBacklog(AT)!;
      assert.equal(result.deliveryReview.count, 8);
      assert.equal(result.deliveryReview.count, db.countUnknownDeliveryReconciliations(STAFF));
      assert.equal(result.deliveryReview.oldestAgeSeconds, 7200);
      assert.equal(result.unknownDeliveryCount, 6); // Five logical review operations + one final summary, not two Batch reply rows.
      assert.equal(result.batchExportUnknownDeliveryCount, 1);
      const record = db.listUnknownDeliveryReconciliations(STAFF).find((r) => r.kind === "INTERACTIVE")!;
      db.reconcileUnknownDelivery({
        staffChatId: STAFF,
        caseToken: record.caseToken,
        action: "CONFIRMED_FAILED",
        note: "Verified",
        reconciledBy: 1,
      });
      result = db.observeOperationalBacklog(AT)!;
      assert.equal(result.deliveryReview.count, 7);
      assert.equal(result.unknownDeliveryCount, 5);
      activate(db, -100901);
      result = db.observeOperationalBacklog(AT)!;
      assert.equal(result.deliveryReview.count, 1);
      assert.equal(result.unknownDeliveryCount, 1);
      db.setInstallationState({ active_workspace_id: null });
      assert.equal(db.observeOperationalBacklog(AT), null);
    }
  );
});

test("Batch counts all runnable families once and excludes future, blocked, terminal and moved-workspace work", () => {
  fileFixture(
    (db) => {
      const ids = {
        echo: batch(db, "echo", 100),
        failure: batch(db, "failure", 101),
        closed: batch(db, "closed", 102),
        invalid: batch(db, "invalid", 103),
        close: batch(db, "close", 104, "reply_and_close"),
        silent: batch(db, "silent", 105, "silent_close"),
        nullDate: batch(db, "null-date", 106, "no_action"),
        future: batch(db, "future", 107),
        terminal: batch(db, "terminal", 108),
        blocked: batch(db, "blocked", 109, "reply_and_close"),
        moved: batch(db, "moved", 110),
      };
      for (const id of Object.values(ids))
        db.addMessage({
          ticketId: id,
          direction: "USER_TO_STAFF",
          sourceChatId: 1,
          sourceMessageId: id,
          text: "Message",
        });
      db.claimTicketArchiveSummary(ids.blocked, 500);
      db.markTicketArchiveUnknown(ids.blocked, "Ambiguous");
      return ids;
    },
    (sql, ids) => {
      sql
        .prepare("UPDATE ticket_batch_answer_packages SET status = 'PARTIAL', final_summary_state = 'NOT_PENDING'")
        .run();
      sql
        .prepare(
          "UPDATE ticket_batch_answer_items SET state = 'STAFF_SYNC_PENDING', delivery_message_id = 99, topic_echo_state = 'PENDING', topic_echo_next_retry_at = ?, updated_at = ?"
        )
        .run(OLD, OLD);
      sql
        .prepare(
          "UPDATE ticket_batch_answer_items SET delivery_message_id = NULL, delivery_error_category = 'USER_BLOCKED_BOT', delivery_error_permanence = 'PERMANENT', delivery_failure_event_state = 'FAILED', delivery_failure_event_next_retry_at = ? WHERE answer_package_id = 'failure'"
        )
        .run(OLD);
      sql
        .prepare("UPDATE tickets SET status = 'CLOSED', closed_at = ? WHERE id IN (?, ?, ?)")
        .run(OLD, ids.closed, ids.silent, ids.blocked);
      sql
        .prepare(
          "UPDATE ticket_batch_answer_items SET topic_echo_next_retry_at = ? WHERE answer_package_id IN ('closed', 'future')"
        )
        .run(FUTURE);
      sql
        .prepare("UPDATE ticket_batch_answer_items SET delivery_message_id = NULL WHERE answer_package_id = 'invalid'")
        .run();
      sql
        .prepare("UPDATE ticket_batch_answer_items SET topic_echo_state = 'SENT' WHERE answer_package_id = 'close'")
        .run();
      sql
        .prepare(
          "UPDATE ticket_batch_answer_items SET state = 'APPLYING', topic_echo_state = 'NOT_REQUIRED', delivery_message_id = NULL WHERE answer_package_id = 'silent'"
        )
        .run();
      sql
        .prepare(
          "UPDATE ticket_batch_answer_items SET topic_echo_next_retry_at = NULL, follow_up_state = 'WAITING_DEVS' WHERE answer_package_id = 'null-date'"
        )
        .run();
      sql
        .prepare(
          "UPDATE ticket_batch_answer_items SET topic_echo_state = 'TERMINAL_FAILED', topic_echo_next_retry_at = NULL WHERE answer_package_id = 'terminal'"
        )
        .run();
      sql
        .prepare(
          "UPDATE ticket_batch_answer_items SET topic_echo_state = 'NOT_REQUIRED' WHERE answer_package_id = 'blocked'"
        )
        .run();
      sql.prepare("UPDATE tickets SET staff_chat_id = -100901 WHERE id = ?").run(ids.moved);
      sql
        .prepare(
          "UPDATE ticket_batch_answer_packages SET final_summary_state = 'PENDING', final_summary_next_retry_at = ? WHERE answer_package_id = 'echo'"
        )
        .run(OLD);
    },
    (db) => {
      const observed = db.observeOperationalBacklog(AT)!;
      assert.equal(observed.batchRecovery.count, 8);
      assert.equal(observed.batchRecovery.oldestOverdueSeconds, 7200);
      assert.equal(db.listPendingTicketBatchReplyAndCloseContinuations(STAFF, AT).length, 2); // Operational count additionally excludes the blocked archive.
      assert.equal(db.listPendingTicketBatchSilentCloseContinuations(STAFF, AT).length, 1);
      assert.equal(observed.unknownDeliveryCount, 1);
    }
  );
});

test("moderation due time, not job age or future scheduling, determines overdue work", () => {
  fileFixture(
    (db) => {
      for (let index = 0; index < 6; index += 1)
        db.createLanguageModerationCleanupJob({
          staff_chat_id: index === 5 ? -100901 : STAFF,
          chat_id: -100800,
          user_telegram_id: 10 + index,
          username: null,
          chat_title: null,
          sanction_tier: 0,
          sanction_kind: "mute_24h",
          violation_cycle_id: `cycle-${index}`,
          cleanup_due_at: index === 3 ? FUTURE : OLD,
        });
    },
    (sql) => {
      sql.prepare("UPDATE language_moderation_cleanup_jobs SET state = 'CLEANING' WHERE id = 2").run();
      sql.prepare("UPDATE language_moderation_cleanup_jobs SET state = 'LOG_PENDING' WHERE id = 3").run();
      sql.prepare("UPDATE language_moderation_cleanup_jobs SET state = 'COMPLETED' WHERE id = 5").run();
    },
    (db) =>
      assert.deepEqual(db.observeOperationalBacklog(AT)!.moderationCleanup, { count: 3, oldestOverdueSeconds: 7200 })
  );
});

test("archive eligibility excludes live claims, unresolved inbound/outbound, operator rejection and missing history", () => {
  fileFixture(
    (db) => {
      const ids: number[] = [];
      for (let index = 0; index < 12; index += 1) {
        const id = ticket(db, 200 + index);
        ids.push(id);
        if (index !== 9)
          db.addMessage({
            ticketId: id,
            direction: "USER_TO_STAFF",
            sourceChatId: 200 + index,
            sourceMessageId: 1,
            text: "Message",
          });
      }
      for (const index of [1, 2, 3, 4, 5, 6]) db.claimTicketArchiveSummary(ids[index]!, 500);
      db.claimTicketArchiveSummary(ids[10]!, 500);
      db.markTicketArchiveUnknown(ids[10]!, "Ambiguous archive");
      const rejected = db.listUnknownDeliveryReconciliations(STAFF).find((item) => item.ticketId === ids[10])!;
      db.reconcileUnknownDelivery({
        staffChatId: STAFF,
        caseToken: rejected.caseToken,
        action: "CONFIRMED_FAILED",
        note: "Verified not delivered",
        reconciledBy: 1,
      });
      db.createTicketOutboundDeliveryIntent({
        operationKey: "staff-message:pending",
        ticketId: ids[7]!,
        direction: "STAFF_TO_USER",
        text: "Reply",
      });
      db.beginTicketInboundRouting({
        userTelegramId: 208,
        staffChatId: STAFF,
        sourceChatId: 208,
        sourceMessageId: 2,
        senderDisplayName: "Customer",
        shouldCopyOriginal: false,
      });
      return ids;
    },
    (sql, ids) => {
      sql.prepare("UPDATE tickets SET status = 'CLOSED', closed_at = ?").run(OLD);
      sql.prepare("UPDATE tickets SET archived_at = ? WHERE id = ?").run(OLD, ids[11]);
      sql.prepare("UPDATE ticket_archive_deliveries SET failure_category = NULL WHERE ticket_id = ?").run(ids[10]);
      for (const [index, state] of [
        [1, "SUMMARY_SENT"],
        [2, "DELIVERED"],
        [3, "FAILED"],
        [4, "SUMMARY_PENDING"],
        [5, "DOCUMENT_PENDING"],
        [6, "UNKNOWN_DELIVERY"],
      ] as const)
        sql
          .prepare(
            "UPDATE ticket_archive_deliveries SET state = ?, summary_message_id = 10, document_message_id = 11 WHERE ticket_id = ?"
          )
          .run(state, ids[index]);
    },
    (db) => assert.deepEqual(db.observeOperationalBacklog(AT)!.archiveRecovery, { count: 4, oldestAgeSeconds: 7200 })
  );
});

test("age math clamps future/absent timestamps and all operational SQL is read-only with indexed probes", () => {
  assert.equal(backlogAgeSeconds(AT, OLD), 7200);
  assert.equal(backlogAgeSeconds(AT, FUTURE), 0);
  assert.equal(backlogAgeSeconds(AT, null), 0);
  assert.equal(backlogAgeSeconds(AT, "invalid"), 0);
  fileFixture(
    () => undefined,
    (sql) => {
      sql.pragma("query_only = ON");
      assert.equal(new OperationalBacklogRepository(sql).observe(STAFF, AT).deliveryReview.count, 0);
      for (const [name, query] of Object.entries(OPERATIONAL_BACKLOG_SQL)) {
        assert.equal(sql.prepare(query).reader, true);
        const plan = sql.prepare(`EXPLAIN QUERY PLAN ${query}`).all({ staffChatId: STAFF, at: AT }) as Array<{
          detail: string;
        }>;
        const details = plan.map((row) => row.detail).join("\n");
        assert.doesNotMatch(
          details,
          /SCAN (messages|ticket_outbound_deliveries|ticket_inbound_routing_operations|language_moderation_cleanup_jobs)\b/,
          name
        );
        assert.doesNotMatch(details, /\bSCAN (?:t|d|i|p|m|a|r|audit)\b/, name);
        assert.match(details, /USING (?:COVERING )?INDEX|USING INTEGER PRIMARY KEY/, name);
      }
    },
    () => undefined
  );
});

test("null retries are runnable without invented overdue ages and terminal/future retries stay excluded", () => {
  fileFixture(
    (db) => {
      batch(db, "null-retry", 400, "no_action");
      batch(db, "sentinel", 401);
      batch(db, "future-summary", 402);
    },
    (sql) => {
      sql.prepare("UPDATE ticket_batch_answer_items SET topic_echo_state = 'NOT_REQUIRED'").run();
      sql
        .prepare(
          "UPDATE ticket_batch_answer_items SET topic_echo_state = 'PENDING', follow_up_state = 'WAITING_DEVS', topic_echo_next_retry_at = NULL, updated_at = ? WHERE answer_package_id = 'null-retry'"
        )
        .run(OLD);
      sql
        .prepare(
          "UPDATE ticket_batch_answer_items SET delivery_error_category = 'NETWORK_ERROR', delivery_failure_event_state = 'FAILED', delivery_failure_event_next_retry_at = '9999-12-31T23:59:59.999Z' WHERE answer_package_id = 'sentinel'"
        )
        .run();
      sql
        .prepare(
          "UPDATE ticket_batch_answer_packages SET final_summary_state = 'FAILED', final_summary_next_retry_at = ? WHERE answer_package_id = 'future-summary'"
        )
        .run(FUTURE);
      sql
        .prepare(
          "UPDATE ticket_batch_answer_packages SET final_summary_state = 'PENDING', final_summary_next_retry_at = NULL WHERE answer_package_id = 'null-retry'"
        )
        .run();
    },
    (db) => assert.deepEqual(db.observeOperationalBacklog(AT)!.batchRecovery, { count: 2, oldestOverdueSeconds: 0 })
  );
});

test("a Batch outbound UNKNOWN is measured even before its answer item becomes reviewable", () => {
  fileFixture(
    (db) => {
      const id = batch(db, "orphan", 420);
      db.claimTicketBatchAnswerItem("orphan", id);
      db.createTicketOutboundDeliveryIntent({
        operationKey: `ticket-batch:orphan:${id}`,
        ticketId: id,
        direction: "STAFF_TO_USER",
        text: "Reply",
      });
      db.markTicketOutboundDeliveryUnknown(`ticket-batch:orphan:${id}`, "Ambiguous");
    },
    () => undefined,
    (db) => {
      const observed = db.observeOperationalBacklog(AT)!;
      assert.equal(observed.deliveryReview.count, 0);
      assert.equal(observed.unknownDeliveryCount, 1);
    }
  );
});

test("an operational query failure is isolated from database construction and readiness", () => {
  fileFixture(
    () => undefined,
    (sql) => {
      sql.exec("DROP TABLE ticket_archive_deliveries");
    },
    (db) => {
      assert.equal(db.ping(), true);
      assert.throws(() => db.observeOperationalBacklog(AT), /no such table/);
      assert.equal(db.ping(), true);
    }
  );
});

test("future last-state updates and a missing closure timestamp report count without a fictitious age", () => {
  fileFixture(
    (db) => {
      const id = ticket(db, 500);
      db.addMessage({
        ticketId: id,
        direction: "USER_TO_STAFF",
        sourceChatId: 500,
        sourceMessageId: 1,
        text: "Message",
      });
      const inbound = ticket(db, 501);
      db.createTicketOutboundDeliveryIntent({
        operationKey: "staff-message:future",
        ticketId: inbound,
        direction: "STAFF_TO_USER",
        text: "Reply",
      });
      db.markTicketOutboundDeliveryUnknown("staff-message:future", "Ambiguous");
      return id;
    },
    (sql, id) => {
      sql.prepare("UPDATE tickets SET status = 'CLOSED', closed_at = NULL WHERE id = ?").run(id);
      sql.prepare("UPDATE ticket_outbound_deliveries SET updated_at = ?").run(FUTURE);
    },
    (db) => {
      const observed = db.observeOperationalBacklog(AT)!;
      assert.deepEqual(observed.archiveRecovery, { count: 1, oldestAgeSeconds: 0 });
      assert.deepEqual(observed.deliveryReview, { count: 1, oldestAgeSeconds: 0 });
    }
  );
});

test("missing-ticket Batch items remain observable when recovery can resolve them locally", () => {
  fileFixture(
    (db) => ({ invalid: batch(db, "missing-invalid", 600), silent: batch(db, "missing-silent", 601, "silent_close") }),
    (sql, ids) => {
      sql.prepare("UPDATE ticket_batch_answer_packages SET status = 'PARTIAL'").run();
      sql
        .prepare(
          "UPDATE ticket_batch_answer_items SET state = 'APPLYING', topic_echo_state = 'NOT_REQUIRED', topic_echo_next_retry_at = ? WHERE answer_package_id = 'missing-silent'"
        )
        .run(OLD);
      sql.prepare("DELETE FROM tickets WHERE id IN (?, ?)").run(ids.invalid, ids.silent);
    },
    (db) => {
      assert.equal(db.listInvalidTicketBatchSuccessEchoes(STAFF).length, 1);
      assert.equal(db.listPendingTicketBatchSilentCloseContinuations(STAFF, AT).length, 1);
      assert.deepEqual(db.observeOperationalBacklog(AT)!.batchRecovery, { count: 2, oldestOverdueSeconds: 7200 });
    }
  );
});
