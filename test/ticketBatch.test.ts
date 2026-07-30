import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import {
  TicketBatchValidationError,
  buildAnswerPackagePreview,
  buildTicketBatchExportSnapshot,
  cleanupTicketBatchZip,
  createTicketBatchZip,
  getTicketSnapshotToken,
  parseAndValidateAnswerPackage
} from "../src/ticketBatch.js";
import { createBotHarness, type BotHarness } from "./helpers/botHarness.js";

const harnesses: BotHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses) {
    harness.cleanup();
  }
  harnesses.length = 0;
});

function createHarness(): BotHarness {
  const harness = createBotHarness();
  harnesses.push(harness);
  return harness;
}

describe("ticket batch export contract", () => {
  it("exports all and only active tickets in ticket/message order without mutating tickets", async () => {
    const harness = createHarness();
    const second = harness.seedTicket({ user: { id: 124, username: "second" }, messageThreadId: 5001 });
    const first = harness.seedTicket({ user: { id: 123, username: "first" }, messageThreadId: 5000 });
    const closed = harness.seedTicket({ user: { id: 125 }, messageThreadId: 5002, status: "CLOSED" });
    harness.db.addMessage({ ticketId: second.id, direction: "USER_TO_STAFF", text: "later ticket" });
    harness.db.addMessage({ ticketId: first.id, direction: "USER_TO_STAFF", text: "<raw>& text" });
    harness.db.addMessage({ ticketId: first.id, direction: "SYSTEM", text: "system row" });

    const before = harness.db.getTicket(first.id);
    const snapshot = buildTicketBatchExportSnapshot({
      exportId: "export_test",
      createdAt: "2026-07-30T00:00:00.000Z",
      staffChatId: -100900,
      tickets: harness.db.listActiveTicketsForStaffChat(-100900).map((ticket) => ({
        ticket,
        messages: harness.db.listMessagesChronological(ticket.id)
      }))
    });

    assert.deepEqual(snapshot.records.map((record) => record.ticket.id), [second.id, first.id]);
    assert.equal(snapshot.records.some((record) => record.ticket.id === closed.id), false);
    const firstTicketRecord = snapshot.records.find((record) => record.ticket.id === first.id);
    assert.equal(firstTicketRecord?.messages[0]?.text, "<raw>& text");
    assert.equal(firstTicketRecord?.messages[1]?.direction, "SYSTEM");
    assert.deepEqual(harness.db.getTicket(first.id), before);

    const zip = await createTicketBatchZip(snapshot);
    try {
      const entries = unzipSync(await (await import("node:fs/promises")).readFile(zip.filePath));
      assert.deepEqual(Object.keys(entries).sort(), ["manifest.json", "tickets.jsonl"]);
      assert.equal(JSON.parse(strFromU8(entries["manifest.json"] ?? new Uint8Array())).ticket_count, 2);
      assert.match(strFromU8(entries["tickets.jsonl"] ?? new Uint8Array()), /<raw>& text/);
    } finally {
      await cleanupTicketBatchZip(zip);
    }
  });

  it("creates stable snapshots that change for messages and material ticket state", () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const first = getTicketSnapshotToken(ticket, harness.db.listMessagesChronological(ticket.id));
    const unchanged = getTicketSnapshotToken(ticket, harness.db.listMessagesChronological(ticket.id));
    assert.equal(first, unchanged);

    harness.db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", text: "new evidence" });
    const afterMessage = getTicketSnapshotToken(
      harness.db.getTicketWithUser(ticket.id)!,
      harness.db.listMessagesChronological(ticket.id)
    );
    assert.notEqual(first, afterMessage);

    harness.db.updateTicketStatus(ticket.id, "IN_PROGRESS");
    const afterStatus = getTicketSnapshotToken(
      harness.db.getTicketWithUser(ticket.id)!,
      harness.db.listMessagesChronological(ticket.id)
    );
    assert.notEqual(afterMessage, afterStatus);
  });

  it("exports Quick Reply rows with a null source message id", () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.db.addMessage({
      ticketId: ticket.id,
      direction: "STAFF_TO_USER",
      sourceMessageId: null,
      text: "Quick Reply",
      senderType: "STAFF"
    });
    const snapshot = buildTicketBatchExportSnapshot({
      exportId: "export_null_source",
      createdAt: "2026-07-30T00:00:00.000Z",
      staffChatId: -100900,
      tickets: [{ ticket: harness.db.getTicketWithUser(ticket.id)!, messages: harness.db.listMessagesChronological(ticket.id) }]
    });
    assert.equal(snapshot.records[0]?.messages[0]?.source_message_id, null);
  });

  it("cleans up generated temporary ZIP files", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const snapshot = buildTicketBatchExportSnapshot({
      exportId: "export_cleanup",
      createdAt: "2026-07-30T00:00:00.000Z",
      staffChatId: -100900,
      tickets: [{ ticket, messages: [] }]
    });
    const zip = await createTicketBatchZip(snapshot);
    await access(zip.filePath);
    await cleanupTicketBatchZip(zip);
    await assert.rejects(() => access(zip.filePath));
  });
});

describe("ticket answer package validation and preview", () => {
  const exported = [
    { ticketId: 1, snapshotToken: "sha256:first" },
    { ticketId: 2, snapshotToken: "sha256:second" },
    { ticketId: 3, snapshotToken: "sha256:third" }
  ];

  function answerPackage(answers: unknown): string {
    return JSON.stringify({
      schema: "telegram_ticket_answer_package",
      version: 1,
      export_id: "export_answers",
      answer_package_id: "answers_1",
      created_at: "2026-07-30T00:00:00.000Z",
      answers
    });
  }

  it("rejects malformed, unsupported, duplicate, missing, extra, and invalid action packages", () => {
    const valid = [
      { ticket_id: 1, snapshot_token: "sha256:first", action: "reply_keep_open", reply_text: "Hello" },
      { ticket_id: 2, snapshot_token: "sha256:second", action: "no_action", reply_text: null },
      { ticket_id: 3, snapshot_token: "sha256:third", action: "no_action", reply_text: null }
    ];
    for (const payload of [
      "{",
      JSON.stringify({ schema: "wrong", version: 1, export_id: "export_answers", answer_package_id: "a", created_at: "2026-07-30T00:00:00.000Z", answers: valid }),
      answerPackage([valid[0], valid[0]]),
      answerPackage([valid[0]]),
      answerPackage([...valid, { ticket_id: 3, snapshot_token: "x", action: "no_action", reply_text: null }]),
      answerPackage([{ ticket_id: 1, snapshot_token: "sha256:first", action: "no_action", reply_text: "not allowed" }, valid[1], valid[2]]),
      answerPackage([{ ticket_id: 1, snapshot_token: "sha256:first", action: "reply_and_close", reply_text: "" }, valid[1], valid[2]]),
      answerPackage([{ ticket_id: 1, snapshot_token: "sha256:first", action: "reply_keep_open", reply_text: "x".repeat(3501) }, valid[1], valid[2]])
    ]) {
      assert.throws(() => parseAndValidateAnswerPackage(payload, "export_answers", exported), TicketBatchValidationError);
    }
  });

  it("builds an advisory preview with ready, stale, and inactive classifications", () => {
    const parsed = parseAndValidateAnswerPackage(
      answerPackage([
        { ticket_id: 1, snapshot_token: "sha256:first", action: "reply_keep_open", reply_text: "Hello" },
        { ticket_id: 2, snapshot_token: "sha256:second", action: "reply_and_close", reply_text: "Close it" },
        { ticket_id: 3, snapshot_token: "sha256:third", action: "no_action", reply_text: null }
      ]),
      "export_answers",
      exported
    );
    const preview = buildAnswerPackagePreview(parsed, exported, (ticketId) =>
      ticketId === 1
        ? { status: "OPEN", snapshotToken: "sha256:first" }
        : ticketId === 2
          ? { status: "CLOSED", snapshotToken: "sha256:second" }
          : { status: "OPEN", snapshotToken: "sha256:changed" }
    );

    assert.deepEqual(preview.lines, ["#1 - reply, keep open", "#2 - inactive/closed", "#3 - stale/changed"]);
    assert.equal(preview.totals.readyReplyKeepOpen, 1);
    assert.equal(preview.totals.inactiveClosed, 1);
    assert.equal(preview.totals.staleChanged, 1);
  });
});

describe("persistent answer package state machine", () => {
  function createPackage(harness: BotHarness, id = "answers_state") {
    const ticket = harness.seedTicket();
    harness.db.createTicketBatchExport({ exportId: `export_${id}`, staffChatId: -100900, createdAt: "2026-07-30T00:00:00.000Z", selectionMode: "all_active", ticketCount: 1, items: [{ ticketId: ticket.id, snapshotToken: "sha256:ticket" }] });
    return { ticket, packageRecord: harness.db.createTicketBatchAnswerPackage({ answerPackageId: id, exportId: `export_${id}`, staffChatId: -100900, packageHash: `sha256:${id}`, packageCreatedAt: "2026-07-30T00:00:00.000Z", items: [{ ticket_id: ticket.id, snapshot_token: "sha256:ticket", action: "no_action", reply_text: null }] }) };
  }

  it("cancels only PENDING packages without deleting persisted rows", () => {
    const harness = createHarness();
    const { packageRecord: pending } = createPackage(harness, "pending");
    assert.equal(harness.db.cancelTicketBatchAnswerPackage(pending.answer_package_id, -100900), true);
    assert.equal(harness.db.getTicketBatchAnswerPackage(pending.answer_package_id, -100900)?.status, "CANCELLED");
    assert.equal(harness.db.listTicketBatchAnswerItems(pending.answer_package_id).length, 1);
    assert.equal(harness.db.claimTicketBatchAnswerPackage(pending.answer_package_id, -100900)?.status, "CANCELLED");
  });

  it("allows exactly one deterministic package claim and blocks applying/completed cancellation", () => {
    const harness = createHarness();
    const { packageRecord } = createPackage(harness, "claim");
    assert.equal(harness.db.claimTicketBatchAnswerPackage(packageRecord.answer_package_id, -100900)?.status, "APPLYING");
    assert.equal(harness.db.claimTicketBatchAnswerPackage(packageRecord.answer_package_id, -100900)?.status, "APPLYING");
    assert.equal(harness.db.cancelTicketBatchAnswerPackage(packageRecord.answer_package_id, -100900), false);
    const item = harness.db.listTicketBatchAnswerItems(packageRecord.answer_package_id)[0]!;
    harness.db.updateTicketBatchAnswerItem(packageRecord.answer_package_id, item.ticket_id, "COMPLETED", { applied: true });
    assert.equal(harness.db.finalizeTicketBatchAnswerPackage(packageRecord.answer_package_id, -100900)?.status, "COMPLETED");
    assert.equal(harness.db.cancelTicketBatchAnswerPackage(packageRecord.answer_package_id, -100900), false);
  });

  it("keeps unresolved delivery states PARTIAL and terminal states COMPLETED", () => {
    const harness = createHarness();
    const { packageRecord, ticket } = createPackage(harness, "aggregate");
    harness.db.updateTicketBatchAnswerItem(packageRecord.answer_package_id, ticket.id, "UNKNOWN_DELIVERY", { lastError: "manual review" });
    assert.equal(harness.db.finalizeTicketBatchAnswerPackage(packageRecord.answer_package_id, -100900)?.status, "PARTIAL");
    harness.db.updateTicketBatchAnswerItem(packageRecord.answer_package_id, ticket.id, "STALE", { applied: true });
    assert.equal(harness.db.finalizeTicketBatchAnswerPackage(packageRecord.answer_package_id, -100900)?.status, "COMPLETED");
  });
});
