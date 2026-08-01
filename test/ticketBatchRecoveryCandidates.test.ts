import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { SupportDatabase } from "../src/db.js";
import type { NormalizedDeliveryError } from "../src/deliveryDiagnostics.js";
import { TEST_STAFF_CHAT_ID, createBotHarness, type BotHarness } from "./helpers/botHarness.js";

const temporaryDirectories: string[] = [];
const harnesses: BotHarness[] = [];
const staffChatId = -100900;
const permanentFailure: NormalizedDeliveryError = {
  category: "USER_BLOCKED_BOT", permanence: "PERMANENT", method: "sendMessage",
  telegramErrorCode: 403, httpStatus: null, retryAfterSeconds: null,
  description: "Forbidden: bot was blocked by the user", occurredAt: "2026-08-01T08:00:00.000Z"
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  for (const harness of harnesses) harness.cleanup();
  harnesses.length = 0;
});

function createHarness(): BotHarness {
  const harness = createBotHarness();
  harnesses.push(harness);
  return harness;
}

function createPackage(db: SupportDatabase, id: string, ticketId: number, action: "reply_keep_open" | "reply_and_close" | "no_action", options: { internalNote?: string | null } = {}): void {
  const exportId = `export_${id}`;
  db.createTicketBatchExport({ exportId, staffChatId, createdAt: "2026-08-01T00:00:00.000Z", selectionMode: "all_active", ticketCount: 1, items: [{ ticketId, snapshotToken: `token_${id}` }] });
  db.createTicketBatchAnswerPackage({
    answerPackageId: id, exportId, staffChatId, packageHash: `hash_${id}`, packageCreatedAt: "2026-08-01T00:00:00.000Z",
    items: [{ ticket_id: ticketId, snapshot_token: `token_${id}`, action, reply_text: action === "no_action" ? null : "Reply", internal_note: options.internalNote ?? null }]
  });
}

function createTicket(db: SupportDatabase, telegramId: number): number {
  db.upsertUser({ telegramId, username: null, firstName: `User${telegramId}`, lastName: null });
  const ticket = db.createTicket(telegramId, staffChatId);
  db.updateTicketForumTopic(ticket.id, staffChatId, telegramId + 10_000);
  return ticket.id;
}

describe("ticket batch staff-recovery candidates", () => {
  it("excludes failed or unknown user delivery from success echoes while retaining valid staff-only candidates", () => {
    const db = new SupportDatabase(":memory:");
    const permanentTicket = createTicket(db, 98);
    createPackage(db, "permanent", permanentTicket, "reply_and_close");
    db.recordTicketBatchDeliveryFailure("permanent", permanentTicket, "FAILED", permanentFailure);
    db.recordTicketBatchFailureEvent("permanent", permanentTicket, "SENT", 700);

    const temporaryTicket = createTicket(db, 99);
    createPackage(db, "temporary", temporaryTicket, "reply_keep_open");
    db.recordTicketBatchDeliveryFailure("temporary", temporaryTicket, "FAILED", { ...permanentFailure, category: "RATE_LIMITED", permanence: "TEMPORARY", telegramErrorCode: 429, retryAfterSeconds: 30 });
    db.recordTicketBatchFailureEvent("temporary", temporaryTicket, "PENDING");

    const unknownTicket = createTicket(db, 100);
    createPackage(db, "unknown", unknownTicket, "reply_keep_open");
    db.recordTicketBatchDeliveryFailure("unknown", unknownTicket, "UNKNOWN_DELIVERY", { ...permanentFailure, category: "NETWORK_TIMEOUT", permanence: "UNKNOWN_DELIVERY", telegramErrorCode: null, description: null });

    const confirmedTicket = createTicket(db, 101);
    createPackage(db, "confirmed", confirmedTicket, "reply_keep_open");
    db.updateTicketBatchAnswerItem("confirmed", confirmedTicket, "STAFF_SYNC_PENDING", { deliveryMessageId: 701 });
    db.recordTicketBatchTopicEcho("confirmed", confirmedTicket, "FAILED");

    const followUpTicket = createTicket(db, 102);
    createPackage(db, "followup", followUpTicket, "no_action", { internalNote: "internal follow-up" });
    const plainTicket = createTicket(db, 103);
    createPackage(db, "plain", plainTicket, "no_action");

    const audit = db.getTicketBatchRecoveryAudit(staffChatId, "2026-08-01T09:00:00.000Z");
    const echoes = db.listPendingTicketBatchTopicEchoes(staffChatId, "2026-08-01T09:00:00.000Z");

    assert.deepEqual(echoes.map((item) => item.ticket_id).sort((a, b) => a - b), [confirmedTicket, followUpTicket].sort((a, b) => a - b));
    assert.equal(audit.successTopicEchoes, 1);
    assert.equal(audit.noActionFollowUpEvents, 1);
    assert.equal(audit.failureEvents, 1);
    assert.equal(audit.invalidSuccessEchoes, 3);
    assert.equal(audit.userFacingCandidates, 0);
    db.close();
  });

  it("migration 16 normalizes a legacy failed delivery with a stale pending success echo", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-ticket-batch-recovery-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "support.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE tickets (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE ticket_batch_answer_packages (
        answer_package_id TEXT PRIMARY KEY, export_id TEXT NOT NULL, staff_chat_id INTEGER NOT NULL, package_hash TEXT NOT NULL,
        source_chat_id INTEGER, source_message_id INTEGER, package_created_at TEXT NOT NULL, imported_at TEXT NOT NULL,
        status TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
        preview_token TEXT, preview_chat_id INTEGER, preview_message_id INTEGER, preview_page INTEGER,
        summary_delivery_state TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED', summary_delivery_error TEXT, summary_delivery_attempted_at TEXT
      );
      CREATE TABLE ticket_batch_answer_items (
        answer_package_id TEXT NOT NULL, ticket_id INTEGER NOT NULL, snapshot_token TEXT NOT NULL, action TEXT NOT NULL,
        reply_text TEXT, state TEXT NOT NULL, delivery_message_id INTEGER, applied_at TEXT, last_error TEXT, updated_at TEXT NOT NULL,
        follow_up_state TEXT NOT NULL DEFAULT 'NONE', internal_note TEXT, escalation_target TEXT NOT NULL DEFAULT 'NONE',
        topic_echo_chat_id INTEGER, topic_echo_thread_id INTEGER, topic_echo_message_id INTEGER, topic_echo_state TEXT NOT NULL DEFAULT 'PENDING', topic_echo_last_error TEXT,
        delivery_error_category TEXT, delivery_error_permanence TEXT, delivery_error_code INTEGER, delivery_http_status INTEGER,
        delivery_error_method TEXT, delivery_retry_after_seconds INTEGER, delivery_error_description TEXT, delivery_failed_at TEXT,
        delivery_attempt_count INTEGER NOT NULL DEFAULT 0, delivery_failure_event_state TEXT NOT NULL DEFAULT 'NOT_REQUIRED', delivery_failure_event_message_id INTEGER,
        PRIMARY KEY(answer_package_id, ticket_id)
      );
    `);
    const timestamp = "2026-08-01T08:00:00.000Z";
    const migration = legacy.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)");
    for (let id = 1; id <= 15; id += 1) migration.run(id, `migration_${id}`, timestamp);
    legacy.prepare("INSERT INTO ticket_batch_answer_packages VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'PARTIAL', ?, NULL, ?, NULL, NULL, NULL, NULL, 'FAILED', 'RATE_LIMITED', ?)")
      .run("legacy", "export", staffChatId, "hash", timestamp, timestamp, timestamp, timestamp, timestamp);
    legacy.prepare("INSERT INTO ticket_batch_answer_items VALUES (?, 98, 'token', 'reply_and_close', 'Reply', 'FAILED', NULL, NULL, 'USER_BLOCKED_BOT', ?, 'NONE', NULL, 'NONE', NULL, NULL, NULL, 'PENDING', NULL, 'USER_BLOCKED_BOT', 'PERMANENT', 403, NULL, 'sendMessage', NULL, 'Forbidden', ?, 1, 'SENT', 701)")
      .run("legacy", timestamp, timestamp);
    legacy.prepare("INSERT INTO tickets (id, status) VALUES (98, 'OPEN')").run();
    legacy.close();

    const upgraded = new SupportDatabase(databasePath);
    const audit = upgraded.getTicketBatchRecoveryAudit(staffChatId, "2026-08-01T09:00:00.000Z");
    upgraded.close();
    const inspected = new Database(databasePath, { readonly: true });
    try {
      const item = inspected.prepare("SELECT state, delivery_message_id, topic_echo_state, topic_echo_message_id, delivery_error_category, delivery_error_permanence, delivery_failure_event_state, delivery_failure_event_message_id FROM ticket_batch_answer_items WHERE answer_package_id='legacy' AND ticket_id=98").get() as Record<string, unknown>;
      const packageStatus = inspected.prepare("SELECT status FROM ticket_batch_answer_packages WHERE answer_package_id='legacy'").get() as { status: string };
      assert.equal(item.topic_echo_state, "NOT_REQUIRED");
      assert.equal(item.delivery_message_id, null);
      assert.equal(item.delivery_error_category, "USER_BLOCKED_BOT");
      assert.equal(item.delivery_error_permanence, "PERMANENT");
      assert.equal(item.delivery_failure_event_state, "SENT");
      assert.equal(item.delivery_failure_event_message_id, 701);
      assert.equal(packageStatus.status, "PARTIAL");
      assert.equal(audit.invalidSuccessEchoes, 0);
      assert.equal(audit.successTopicEchoes, 0);
    } finally {
      inspected.close();
    }
  });

  it("normalizes a contradictory echo during recovery while delivering another valid staff-only echo", async () => {
    const harness = createHarness();
    const failedTicket = harness.seedTicket({ user: { id: 98 }, messageThreadId: 8098 });
    const deliveredTicket = harness.seedTicket({ user: { id: 99 }, messageThreadId: 8099 });

    createPackage(harness.db, "failed_recovery", failedTicket.id, "reply_and_close");
    harness.db.recordTicketBatchDeliveryFailure("failed_recovery", failedTicket.id, "FAILED", permanentFailure);
    harness.db.recordTicketBatchFailureEvent("failed_recovery", failedTicket.id, "SENT", 700);

    createPackage(harness.db, "confirmed_recovery", deliveredTicket.id, "reply_keep_open");
    harness.db.updateTicketBatchAnswerItem("confirmed_recovery", deliveredTicket.id, "STAFF_SYNC_PENDING", { deliveryMessageId: 701 });
    harness.db.recordTicketBatchTopicEcho("confirmed_recovery", deliveredTicket.id, "FAILED");
    harness.db.queueTicketBatchFinalSummary("failed_recovery", TEST_STAFF_CHAT_ID, {
      text: "stale summary",
      chatId: TEST_STAFF_CHAT_ID
    });

    await harness.bot.recoverPendingTicketBatchStaffOperations();

    const failedItem = harness.db.listTicketBatchAnswerItems("failed_recovery")[0];
    assert.equal(failedItem?.topic_echo_state, "NOT_REQUIRED");
    assert.equal(failedItem?.delivery_failure_event_state, "SENT");
    assert.equal(harness.findApiCalls("sendMessage").some((call) =>
      call.payload.chat_id === TEST_STAFF_CHAT_ID
      && call.payload.message_thread_id === failedTicket.message_thread_id
      && String(call.payload.text).includes("Batch reply sent to user")
    ), false);
    assert.equal(harness.findApiCalls("sendMessage").filter((call) =>
      call.payload.chat_id === TEST_STAFF_CHAT_ID
      && call.payload.message_thread_id === deliveredTicket.message_thread_id
      && String(call.payload.text).includes("Batch reply sent to user")
    ).length, 1);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === failedTicket.user_telegram_id), false);
    const summary = harness.findApiCalls("sendMessage").find((call) =>
      call.payload.chat_id === TEST_STAFF_CHAT_ID
      && call.payload.message_thread_id === undefined
      && String(call.payload.text).includes("Ticket batch applied with issues.")
    );
    assert.ok(summary);
    assert.match(String(summary.payload.text), /Staff sync pending: 0/);
    assert.match(String(summary.payload.text), new RegExp(`#${failedTicket.id} .* USER_BLOCKED_BOT`));
  });

  it("keeps a terminal no_action staff failure out of recovery while reporting it separately", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ user: { id: 108 }, messageThreadId: 8108 });
    createPackage(harness.db, "terminal_staff_failure", ticket.id, "no_action", { internalNote: "reviewed" });
    harness.db.updateTicketBatchAnswerItem("terminal_staff_failure", ticket.id, "STAFF_SYNC_PENDING", { applied: true });
    harness.db.recordTicketBatchTopicEcho("terminal_staff_failure", ticket.id, "TERMINAL_FAILED", {
      lastError: "TELEGRAM_BAD_REQUEST",
      diagnostic: {
        category: "TELEGRAM_BAD_REQUEST", permanence: "PERMANENT", method: "sendMessage",
        telegramErrorCode: 400, httpStatus: 400, retryAfterSeconds: null,
        description: null, occurredAt: "2026-08-01T08:00:00.000Z"
      }
    });
    harness.db.queueTicketBatchFinalSummary("terminal_staff_failure", TEST_STAFF_CHAT_ID, {
      text: "stale summary", chatId: TEST_STAFF_CHAT_ID
    });

    await harness.bot.recoverPendingTicketBatchStaffOperations();

    assert.equal(harness.findApiCalls("sendMessage").some((call) =>
      call.payload.message_thread_id === ticket.message_thread_id
    ), false);
    const summary = harness.findApiCalls("sendMessage").find((call) =>
      call.payload.chat_id === TEST_STAFF_CHAT_ID && String(call.payload.text).includes("Staff sync terminal failures: 1")
    );
    assert.ok(summary);
    assert.match(String(summary.payload.text), /No action: 1/);
    assert.match(String(summary.payload.text), new RegExp(`#${ticket.id} .* TELEGRAM_BAD_REQUEST`));
    assert.equal(harness.db.listTicketBatchAnswerItems("terminal_staff_failure")[0]?.state, "STAFF_SYNC_PENDING");
  });
});
