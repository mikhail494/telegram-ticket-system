import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import {
  TicketBatchValidationError,
  buildAnswerPackagePreview,
  buildAnswerPackageInstructions,
  buildTicketBatchPreviewPages,
  buildTicketBatchExportSnapshot,
  cleanupTicketBatchZip,
  createTicketBatchZip,
  getTicketSnapshotToken,
  parseAndValidateAnswerPackage
} from "../src/ticketBatch.js";
import { TEST_STAFF_CHAT_ID, createBotHarness, type BotHarness } from "./helpers/botHarness.js";

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
  it("accepts version 2 answers with staff-only follow-up context", () => {
    const exported = [{ ticket_id: 1, snapshot_token: "sha256:ticket" }];
    const parsed = parseAndValidateAnswerPackage(JSON.stringify({
      schema: "telegram_ticket_answer_package",
      version: 2,
      export_id: "export_follow_up",
      answer_package_id: "answers_follow_up",
      created_at: "2026-07-31T00:00:00.000Z",
      answers: [{
        ticket_id: 1,
        snapshot_token: "sha256:ticket",
        action: "reply_keep_open",
        reply_text: "We are investigating this.",
        follow_up_state: "WAITING_DEVS",
        internal_note: "Check the withdrawal service.",
        escalation_target: "PAYMENTS"
      }]
    }), "export_follow_up", exported);

    assert.equal(parsed.version, 2);
    assert.equal(parsed.answers[0]?.follow_up_state, "WAITING_DEVS");
    assert.equal(parsed.answers[0]?.internal_note, "Check the withdrawal service.");
    assert.equal(parsed.answers[0]?.escalation_target, "PAYMENTS");
  });

  it("includes current follow-up and staff-only history in exported ticket records", () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.db.setTicketFollowUpContext(ticket.id, {
      followUpState: "WAITING_DEVS",
      internalNote: "Investigate the payment provider.",
      escalationTarget: "PAYMENTS",
      sourceAnswerPackageId: "answers_history"
    });
    const current = harness.db.getTicketWithUser(ticket.id)!;
    const snapshot = buildTicketBatchExportSnapshot({
      exportId: "export_history",
      createdAt: "2026-07-31T00:00:00.000Z",
      staffChatId: TEST_STAFF_CHAT_ID,
      tickets: [{ ticket: current, messages: [], followUpHistory: harness.db.listTicketFollowUpHistory(ticket.id) }]
    });

    assert.equal(snapshot.manifest.tickets[0]?.follow_up_state, "WAITING_DEVS");
    assert.equal(snapshot.manifest.tickets[0]?.escalation_target, "PAYMENTS");
    assert.equal(snapshot.records[0]?.ticket.internal_note, "Investigate the payment provider.");
    assert.equal(snapshot.records[0]?.follow_up_history[0]?.source_answer_package_id, "answers_history");
  });

  it("includes only normalized delivery-failure context in a later export", () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const snapshot = buildTicketBatchExportSnapshot({
      exportId: "export_delivery_context",
      createdAt: "2026-08-01T00:00:00.000Z",
      staffChatId: TEST_STAFF_CHAT_ID,
      tickets: [{
        ticket,
        messages: [],
        deliveryFailure: {
          category: "RATE_LIMITED",
          permanence: "TEMPORARY",
          occurred_at: "2026-08-01T00:00:00.000Z",
          retry_after_seconds: 39,
          staff_failure_event_posted: true
        }
      }]
    });

    assert.deepEqual(snapshot.records[0]?.batch_delivery_failure, {
      category: "RATE_LIMITED",
      permanence: "TEMPORARY",
      occurred_at: "2026-08-01T00:00:00.000Z",
      retry_after_seconds: 39,
      staff_failure_event_posted: true
    });
  });

  it("includes terminal staff-sync context without implying another user reply", () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const snapshot = buildTicketBatchExportSnapshot({
      exportId: "export_staff_sync_context",
      createdAt: "2026-08-01T00:00:00.000Z",
      staffChatId: TEST_STAFF_CHAT_ID,
      tickets: [{
        ticket,
        messages: [],
        staffSync: {
          state: "TERMINAL_FAILED",
          delivered: false,
          terminal_failure_category: "TELEGRAM_BAD_REQUEST",
          intended_follow_up_state: "WAITING_DEVS",
          intended_escalation_target: "DEVS",
          internal_context_available: true
        }
      }]
    });

    assert.deepEqual(snapshot.records[0]?.batch_staff_sync, {
      state: "TERMINAL_FAILED",
      delivered: false,
      terminal_failure_category: "TELEGRAM_BAD_REQUEST",
      intended_follow_up_state: "WAITING_DEVS",
      intended_escalation_target: "DEVS",
      internal_context_available: true
    });
  });
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
      assert.deepEqual(Object.keys(entries).sort(), [
        "ANSWER_PACKAGE_INSTRUCTIONS.md",
        "answer-package.schema.json",
        "manifest.json",
        "media-index.json",
        "tickets.jsonl",
        "tickets.md"
      ]);
      const manifest = JSON.parse(strFromU8(entries["manifest.json"] ?? new Uint8Array()));
      assert.equal(manifest.schema, "agenton-ticket-export");
      assert.equal(manifest.version, 2);
      assert.equal(manifest.ticket_count, 2);
      assert.match(strFromU8(entries["tickets.jsonl"] ?? new Uint8Array()), /<raw>& text/);
      assert.match(strFromU8(entries["tickets.md"] ?? new Uint8Array()), /<raw>& text/);
      assert.equal(JSON.parse(strFromU8(entries["media-index.json"] ?? new Uint8Array())).length, 0);
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

  it("embeds every supported media attachment with deterministic metadata and verified bytes", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const media = ["photo", "document", "video", "animation", "audio", "voice", "video_note", "sticker"] as const;
    const contents = new Map<string, Uint8Array>();
    for (const [index, mediaType] of media.entries()) {
      const fileId = `media-${mediaType}`;
      contents.set(fileId, new Uint8Array([index + 1, index + 11, index + 21]));
      harness.db.addMessage({
        ticketId: ticket.id,
        direction: "USER_TO_STAFF",
        sourceChatId: ticket.user_telegram_id,
        sourceMessageId: 100 + index,
        text: `${mediaType} caption`,
        mediaType,
        filename: mediaType === "document" ? "../../CON?.pdf" : null,
        fileId
      });
    }
    const hydratedTicket = harness.db.getTicketWithUser(ticket.id)!;
    const snapshot = buildTicketBatchExportSnapshot({
      exportId: "export_media",
      createdAt: "2026-07-30T00:00:00.000Z",
      staffChatId: -100900,
      tickets: [{ ticket: hydratedTicket, messages: harness.db.listMessagesChronological(ticket.id) }]
    });

    const zip = await createTicketBatchZip(snapshot, async (source) => ({
      bytes: contents.get(source.fileId ?? "") ?? new Uint8Array(),
      telegramFilePath: `files/${source.mediaType}`
    }));
    try {
      const entries = unzipSync(await readFile(zip.filePath));
      const manifest = JSON.parse(strFromU8(entries["manifest.json"]!));
      const mediaIndex = JSON.parse(strFromU8(entries["media-index.json"]!)) as Array<{ archive_path: string; sha256: string; byte_length: number; media_type: string; disk_path?: string }>;
      const record = JSON.parse(strFromU8(entries["tickets.jsonl"]!).trim()) as { messages: Array<{ caption: string | null; media_type: string; attachments: Array<{ archive_path: string }> }> };

      assert.equal(manifest.attachment_count, media.length);
      assert.equal(manifest.embedded_attachment_count, media.length);
      assert.equal(manifest.failed_attachment_count, 0);
      assert.equal(mediaIndex.length, media.length);
      assert.equal(record.messages.length, media.length);
      assert.match(strFromU8(entries["tickets.md"]!), /document caption/);
      for (const [index, item] of mediaIndex.entries()) {
        assert.match(item.archive_path, new RegExp(`^attachments/ticket-${ticket.id}/message-\\d+/[A-Za-z0-9][A-Za-z0-9._ -]*$`));
        assert.equal("disk_path" in item, false);
        assert.equal(item.media_type, media[index]);
        const bytes = entries[item.archive_path];
        assert.ok(bytes);
        assert.equal(bytes.byteLength, item.byte_length);
        assert.equal(`sha256:${(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}`, item.sha256);
        assert.equal(record.messages[index]?.caption, `${media[index]} caption`);
        assert.equal(record.messages[index]?.attachments[0]?.archive_path, item.archive_path);
      }
    } finally {
      await cleanupTicketBatchZip(zip);
    }
  });

  it("keeps a known oversized Telegram attachment as unavailable while embedding the rest", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.db.addMessage({
      ticketId: ticket.id,
      direction: "USER_TO_STAFF",
      sourceChatId: ticket.user_telegram_id,
      sourceMessageId: 100,
      mediaType: "document",
      filename: "small.pdf",
      fileId: "small"
    });
    harness.db.addMessage({
      ticketId: ticket.id,
      direction: "USER_TO_STAFF",
      sourceChatId: ticket.user_telegram_id,
      sourceMessageId: 101,
      mediaType: "video",
      filename: "evidence.mp4",
      fileId: "large"
    });
    const snapshot = buildTicketBatchExportSnapshot({
      exportId: "export_mixed_media",
      createdAt: "2026-08-14T00:00:00.000Z",
      staffChatId: -100900,
      tickets: [{ ticket: harness.db.getTicketWithUser(ticket.id)!, messages: harness.db.listMessagesChronological(ticket.id) }]
    });

    const zip = await createTicketBatchZip(snapshot, async (source) => source.fileId === "large"
      ? {
          unavailable: true,
          failureCategory: "TELEGRAM_FILE_TOO_LARGE",
          failureReason: "Attachment exceeds the hosted Telegram Bot API download limit."
        }
      : { bytes: new Uint8Array([1, 2, 3]), telegramFilePath: "files/small.pdf" });
    try {
      const entries = unzipSync(await readFile(zip.filePath));
      const manifest = JSON.parse(strFromU8(entries["manifest.json"]!));
      const mediaIndex = JSON.parse(strFromU8(entries["media-index.json"]!)) as Array<Record<string, unknown>>;
      const record = JSON.parse(strFromU8(entries["tickets.jsonl"]!).trim()) as { messages: Array<{ attachments: Array<Record<string, unknown>> }> };
      const unavailable = mediaIndex.find((attachment) => attachment.embedded === false);

      assert.equal(manifest.attachment_count, 2);
      assert.equal(manifest.embedded_attachment_count, 1);
      assert.equal(manifest.failed_attachment_count, 1);
      assert.equal(mediaIndex.length, 2);
      assert.deepEqual(unavailable, {
        ticket_id: ticket.id,
        database_message_id: harness.db.listMessagesChronological(ticket.id)[1]!.id,
        source_telegram_message_id: 101,
        timestamp: harness.db.listMessagesChronological(ticket.id)[1]!.created_at,
        direction: "USER_TO_STAFF",
        media_type: "video",
        mime_type: null,
        original_filename: "evidence.mp4",
        embedded: false,
        failure_category: "TELEGRAM_FILE_TOO_LARGE",
        failure_reason: "Attachment exceeds the hosted Telegram Bot API download limit."
      });
      assert.equal(record.messages[1]?.attachments[0]?.embedded, false);
      assert.equal(record.messages[1]?.attachments[0]?.failure_category, "TELEGRAM_FILE_TOO_LARGE");
      assert.equal(Object.values(entries).some((value) => value.byteLength === 0), false);
      assert.equal(Object.keys(entries).some((name) => name.includes("evidence.mp4")), false);
      assert.match(strFromU8(entries["tickets.md"]!), /Video: evidence\.mp4\n  Status: unavailable\n  Reason: exceeds the hosted Telegram Bot API download limit/);
    } finally {
      await cleanupTicketBatchZip(zip);
    }
  });

  it("keeps unexpected attachment download failures strict", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", mediaType: "document", fileId: "file" });
    const snapshot = buildTicketBatchExportSnapshot({
      exportId: "export_strict_media",
      createdAt: "2026-08-14T00:00:00.000Z",
      staffChatId: -100900,
      tickets: [{ ticket: harness.db.getTicketWithUser(ticket.id)!, messages: harness.db.listMessagesChronological(ticket.id) }]
    });

    await assert.rejects(() => createTicketBatchZip(snapshot, async () => {
      throw new Error("network failed");
    }));
  });

  it("keeps empty attachment downloads strict", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", mediaType: "document", fileId: "file" });
    const snapshot = buildTicketBatchExportSnapshot({
      exportId: "export_empty_media",
      createdAt: "2026-08-14T00:00:00.000Z",
      staffChatId: -100900,
      tickets: [{ ticket: harness.db.getTicketWithUser(ticket.id)!, messages: harness.db.listMessagesChronological(ticket.id) }]
    });

    await assert.rejects(() => createTicketBatchZip(snapshot, async () => ({
      bytes: new Uint8Array(),
      telegramFilePath: "files/empty.pdf"
    })));
  });

  it("instructs assistants to request only material unavailable-attachment review", () => {
    const instructions = buildAnswerPackageInstructions("export_attachment_guidance");

    assert.match(instructions, /Do not invent or hallucinate unavailable attachment contents/);
    assert.match(instructions, /ask the human operator to inspect it in Telegram/);
    assert.match(instructions, /explicit operator instructions.*take precedence/i);
    assert.match(instructions, /Do not ask for manual review when the remaining ticket context is sufficient/);
    assert.match(instructions, /short professional response and .*reply_and_close/);
    assert.doesNotMatch(instructions, /ChatGPT|Codex|OpenAI|Anthropic|Claude/i);
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

    assert.deepEqual(preview.entries.map((entry) => [entry.ticketId, entry.classification, entry.action]), [
      [1, "ready", "reply_keep_open"],
      [2, "inactive/closed", "reply_and_close"],
      [3, "stale/changed", "no_action"]
    ]);
    assert.equal(preview.totals.readyReplyKeepOpen, 1);
    assert.equal(preview.totals.inactiveClosed, 1);
    assert.equal(preview.totals.staleChanged, 1);
    const pages = buildTicketBatchPreviewPages("export_answers", preview);
    assert.equal(pages.length, 1);
    assert.match(pages[0]!, /Reply:\nHello/);
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
