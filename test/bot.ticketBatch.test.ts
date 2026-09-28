import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Update } from "grammy/types";
import { strFromU8, unzipSync } from "fflate";
import { getTicketSnapshotToken } from "../src/ticketBatch.js";
import { ANSWER_PACKAGE_MAX_BYTES } from "../src/ticketBatchResourceLimits.js";
import { InstallationService } from "../src/installation.js";
import { BackgroundTaskRegistry } from "../src/lifecycle.js";
import {
  TEST_STAFF_CHAT_ID,
  buildStaffDocumentUpdate,
  createBotHarness,
  type BotHarness,
  type BotHarnessOptions,
  type RecordedApiCall,
} from "./helpers/botHarness.js";

const harnesses: BotHarness[] = [];

afterEach(() => {
  for (const harness of harnesses) harness.cleanup();
  harnesses.length = 0;
});

function createHarness(options: BotHarnessOptions = {}): BotHarness {
  const harness = createBotHarness(options);
  harnesses.push(harness);
  return harness;
}

function exportCommand(messageThreadId?: number): Update {
  return {
    update_id: 1,
    message: {
      message_id: 7001,
      date: 1,
      from: { id: 42, is_bot: false, first_name: "Test Staff", username: "test_staff" },
      chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Test Staff Chat" },
      ...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }),
      text: "/exporttickets",
      entities: [{ offset: 0, length: 14, type: "bot_command" }],
    },
  };
}

function answerPackage(
  exportId: string,
  ticketId: number,
  token: string,
  action: "reply_keep_open" | "reply_and_close" | "silent_close" | "no_action" = "reply_keep_open"
): string {
  return JSON.stringify({
    schema: "telegram_ticket_answer_package",
    version: 1,
    export_id: exportId,
    answer_package_id: "answers_1",
    created_at: "2026-07-30T00:00:00.000Z",
    answers: [
      {
        ticket_id: ticketId,
        snapshot_token: token,
        action,
        reply_text: action === "no_action" || action === "silent_close" ? null : "A valid reply",
      },
    ],
  });
}

function multiAnswerPackage(
  exportId: string,
  answers: Array<{
    ticketId: number;
    token: string;
    action: "reply_keep_open" | "reply_and_close" | "silent_close" | "no_action";
    text?: string;
  }>
): string {
  return JSON.stringify({
    schema: "telegram_ticket_answer_package",
    version: 1,
    export_id: exportId,
    answer_package_id: "answers_1",
    created_at: "2026-07-30T00:00:00.000Z",
    answers: answers.map((answer) => ({
      ticket_id: answer.ticketId,
      snapshot_token: answer.token,
      action: answer.action,
      reply_text:
        answer.action === "no_action" || answer.action === "silent_close"
          ? null
          : (answer.text ?? `Reply for ${answer.ticketId}`),
    })),
  });
}

function callbackData(call: RecordedApiCall, label: string): string {
  const markup = call.payload.reply_markup;
  if (!markup || typeof markup !== "object" || !("inline_keyboard" in markup))
    throw new Error("Expected inline keyboard");
  const rows = markup.inline_keyboard;
  if (!Array.isArray(rows)) throw new Error("Expected keyboard rows");
  const buttons = rows
    .flat()
    .filter(
      (button): button is { callback_data: string } =>
        typeof button === "object" &&
        button !== null &&
        "callback_data" in button &&
        typeof button.callback_data === "string"
    );
  const button = buttons.find((candidate) => "text" in candidate && candidate.text === label);
  if (!button || typeof button.callback_data !== "string") throw new Error(`Expected ${label} callback data`);
  return button.callback_data;
}

function batchCallback(data: string, updateId: number, preview: RecordedApiCall): Update {
  if (typeof preview.responseMessageId !== "number") throw new Error("Expected preview response message ID");
  return {
    update_id: updateId,
    callback_query: {
      id: `batch-callback-${updateId}`,
      from: { id: 42, is_bot: false, first_name: "Test Staff", username: "test_staff" },
      chat_instance: "test-chat-instance",
      data,
      message: {
        message_id: preview.responseMessageId,
        date: 1,
        chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Test Staff Chat" },
        text: String(preview.payload.text),
      },
    },
  };
}

function exportIdFromHarness(harness: BotHarness): string {
  const caption = String(harness.findApiCalls("sendDocument")[0]?.payload.caption);
  const exportId = /^Export: (export_[a-z0-9]+)$/m.exec(caption)?.[1];
  if (!exportId) throw new Error("Expected a delivered ticket export.");
  return exportId;
}

describe("ticket batch Telegram workflow", () => {
  for (const closed of [false, true]) {
    it(`continues a full recovery chunk of ${closed ? "closed" : "open"} conflict items using the existing tracked timer`, async () => {
      const { TicketBatchRuntime } = await import("../src/ticketBatchRuntime.js");
      const harness = createHarness();
      const tickets = Array.from({ length: 21 }, (_, index) =>
        harness.seedTicket({ user: { id: 4000 + index }, messageThreadId: 9000 + index })
      );
      const items = tickets.map((ticket) => ({
        ticketId: ticket.id,
        snapshotToken: getTicketSnapshotToken(ticket, []),
      }));
      harness.db.createTicketBatchExport({
        exportId: "chunk_export",
        staffChatId: TEST_STAFF_CHAT_ID,
        createdAt: "2026-07-30T00:00:00.000Z",
        selectionMode: "all_active",
        ticketCount: 21,
        items,
      });
      harness.db.createTicketBatchAnswerPackage({
        answerPackageId: "chunk_answers",
        exportId: "chunk_export",
        staffChatId: TEST_STAFF_CHAT_ID,
        packageHash: "sha256:chunk",
        packageCreatedAt: "2026-07-30T00:00:00.000Z",
        items: items.map((item) => ({
          ticket_id: item.ticketId,
          snapshot_token: item.snapshotToken,
          action: "reply_keep_open",
          reply_text: "Already delivered",
        })),
      });
      harness.db.claimTicketBatchAnswerPackage("chunk_answers", TEST_STAFF_CHAT_ID);
      for (const ticket of tickets) {
        harness.db.claimTicketBatchAnswerItem("chunk_answers", ticket.id);
        harness.db.updateTicketBatchAnswerItem("chunk_answers", ticket.id, "REPLY_SENT", {
          deliveryMessageId: 8000 + ticket.id,
          lastError: "FOLLOW_UP_NOT_APPLIED_CONCURRENT_CHANGE",
        });
        if (closed)
          harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, {
            type: "STAFF",
            displayName: "Other operator",
          });
      }
      harness.db.finalizeTicketBatchAnswerPackage("chunk_answers", TEST_STAFF_CHAT_ID);
      assert.equal(
        harness.db.listTicketBatchAnswerItems("chunk_answers").filter((item) => item.state === "REPLY_SENT").length,
        21
      );
      assert.equal(
        (closed
          ? harness.db.listClosedTicketBatchPendingReplyEchoes(TEST_STAFF_CHAT_ID)
          : harness.db.listPendingTicketBatchTopicEchoes(TEST_STAFF_CHAT_ID, new Date().toISOString())
        ).length,
        20
      );
      const tasks = new BackgroundTaskRegistry();
      assert.equal(new InstallationService(harness.db).requireStaffChatId(), TEST_STAFF_CHAT_ID);
      const timers: Array<{ callback: () => void; delay: number; unref(): void }> = [];
      const runtime = new TicketBatchRuntime({
        db: harness.db,
        api: harness.bot.api,
        installation: new InstallationService(harness.db),
        backgroundTasks: tasks,
        runStaffChatOperation: (operation) => operation(),
        deliverUserReply: async () => assert.fail("Recovery must not resend a customer reply"),
        closeTicket: async () => assert.fail("Keep-open recovery must not close a ticket"),
        staffActor: () => ({ type: "SYSTEM", displayName: "System", telegramId: null, username: null }),
        refreshTicket: async () => undefined,
        createRecoveryTimer: (callback, delay) => {
          const timer = { callback, delay, unref: () => undefined };
          timers.push(timer);
          return timer as unknown as ReturnType<typeof setTimeout>;
        },
        clearRecoveryTimer: () => undefined,
      });
      try {
        await runtime.recoverPendingStaffOperations();
        assert.equal(
          harness.db
            .listTicketBatchAnswerItems("chunk_answers")
            .filter((item) => ["COMPLETED", "INACTIVE"].includes(item.state)).length,
          20
        );
        assert.equal(timers.length, 1);
        assert.equal(timers[0]!.delay, 250);
        timers[0]!.callback();
        await tasks.drain();
        assert.equal(
          harness.db
            .listTicketBatchAnswerItems("chunk_answers")
            .filter((item) => ["COMPLETED", "INACTIVE"].includes(item.state)).length,
          21
        );
        assert.equal(harness.db.getTicketBatchAnswerPackage("chunk_answers", TEST_STAFF_CHAT_ID)?.status, "COMPLETED");
        assert.equal(tasks.snapshot().completedTotal, 1);
        assert.equal(tasks.snapshot().failedTotal, 0);
        assert.equal(timers.length, 1);
        assert.equal(harness.findApiCalls("sendMessage").filter((call) => Number(call.payload.chat_id) > 0).length, 0);
      } finally {
        runtime.stop();
      }
    });
  }

  for (const persisted of [false, true]) {
    it(`keeps post-send persistence ${persisted ? "confirmation" : "failure"} truthful during Batch recovery`, async () => {
      const harness = createHarness();
      const ticket = harness.seedTicket();
      const token = getTicketSnapshotToken(ticket, []);
      harness.db.createTicketBatchExport({
        exportId: "export_db_failure",
        staffChatId: TEST_STAFF_CHAT_ID,
        createdAt: "2026-07-30T00:00:00.000Z",
        selectionMode: "all_active",
        ticketCount: 1,
        items: [{ ticketId: ticket.id, snapshotToken: token }],
      });
      harness.setDownloadResponse(answerPackage("export_db_failure", ticket.id, token));
      await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_db_failure.json" }));
      const preview = harness
        .findApiCalls("sendMessage")
        .find((call) => String(call.payload.text).includes("Ticket answer package preview"))!;
      const persist = harness.db.applyTicketBatchFollowUpIfCurrent.bind(harness.db);
      harness.db.applyTicketBatchFollowUpIfCurrent = (...args) => {
        harness.db.applyTicketBatchFollowUpIfCurrent = persist;
        if (persisted) persist(...args);
        throw new Error("Injected follow-up database failure");
      };
      await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 8802, preview));
      await harness.bot.recoverPendingTicketBatchStaffOperations();
      const item = harness.db.listTicketBatchAnswerItems("answers_1")[0]!;
      assert.equal(item.state, "COMPLETED");
      assert.equal(item.topic_echo_state, "SENT");
      assert.equal(item.topic_echo_error_category, null);
      assert.equal(
        harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
        1
      );
      const echo = harness
        .findApiCalls("sendMessage")
        .find((call) => String(call.payload.text).includes("Batch reply sent to user"))!;
      assert.equal(harness.db.listTicketFollowUpHistory(ticket.id).length, persisted ? 1 : 0);
      if (persisted) {
        assert.equal(item.last_error, null);
        assert.doesNotMatch(String(echo.payload.text), /not applied/);
      } else {
        assert.equal(item.last_error, "FOLLOW_UP_NOT_APPLIED_PERSISTENCE_FAILURE");
        assert.match(String(echo.payload.text), /not applied.*persistence/i);
        assert.equal(harness.db.getTicket(ticket.id)?.status, ticket.status);
      }
    });
  }

  for (const echoSent of [false, true]) {
    it(`finishes file-backed REPLY_SENT recovery ${echoSent ? "after" : "before"} the conflict echo without replaying the user reply`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "batch-conflict-restart-"));
      const databasePath = `file:${path.join(directory, "support.db")}`;
      let harness: BotHarness | undefined;
      try {
        harness = createBotHarness({ databasePath });
        const ticket = harness.seedTicket();
        const token = getTicketSnapshotToken(ticket, []);
        harness.db.createTicketBatchExport({
          exportId: "restart_export",
          staffChatId: TEST_STAFF_CHAT_ID,
          createdAt: "2026-07-30T00:00:00.000Z",
          selectionMode: "all_active",
          ticketCount: 1,
          items: [{ ticketId: ticket.id, snapshotToken: token }],
        });
        harness.db.createTicketBatchAnswerPackage({
          answerPackageId: "restart_answers",
          exportId: "restart_export",
          staffChatId: TEST_STAFF_CHAT_ID,
          packageHash: "sha256:restart",
          packageCreatedAt: "2026-07-30T00:00:00.000Z",
          items: [
            { ticket_id: ticket.id, snapshot_token: token, action: "reply_keep_open", reply_text: "Already delivered" },
          ],
        });
        harness.db.claimTicketBatchAnswerPackage("restart_answers", TEST_STAFF_CHAT_ID);
        harness.db.claimTicketBatchAnswerItem("restart_answers", ticket.id);
        harness.db.createTicketOutboundDeliveryIntent({
          operationKey: `ticket-batch:restart_answers:${ticket.id}`,
          ticketId: ticket.id,
          direction: "STAFF_TO_USER",
          sourceChatId: TEST_STAFF_CHAT_ID,
          deliveryChatId: ticket.user_telegram_id,
          text: "Already delivered",
        });
        harness.db.markTicketOutboundDeliveryDelivered(`ticket-batch:restart_answers:${ticket.id}`, 701);
        harness.db.updateTicketBatchAnswerItem("restart_answers", ticket.id, "REPLY_SENT", {
          deliveryMessageId: 701,
          lastError: "FOLLOW_UP_NOT_APPLIED_CONCURRENT_CHANGE",
        });
        if (echoSent) harness.db.recordTicketBatchTopicEcho("restart_answers", ticket.id, "SENT", { messageId: 702 });
        harness.db.finalizeTicketBatchAnswerPackage("restart_answers", TEST_STAFF_CHAT_ID);
        harness.cleanup();
        harness = createBotHarness({ databasePath });
        await harness.bot.recoverPendingTicketBatchStaffOperations();
        await harness.bot.recoverPendingTicketBatchStaffOperations();
        const item = harness.db.listTicketBatchAnswerItems("restart_answers")[0]!;
        assert.equal(item.state, "COMPLETED");
        assert.equal(item.delivery_message_id, 701);
        assert.equal(item.last_error, "FOLLOW_UP_NOT_APPLIED_CONCURRENT_CHANGE");
        assert.equal(item.topic_echo_state, "SENT");
        assert.equal(
          harness.db.getTicketBatchAnswerPackage("restart_answers", TEST_STAFF_CHAT_ID)?.status,
          "COMPLETED"
        );
        assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
        assert.equal(
          harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
          0
        );
        const echoes = harness
          .findApiCalls("sendMessage")
          .filter((call) => String(call.payload.text).includes("Batch reply sent to user"));
        assert.equal(echoes.length, echoSent ? 0 : 1);
        if (!echoSent) assert.match(String(echoes[0]!.payload.text), /not applied.*concurrent/i);
        assert.equal(harness.db.getNextTicketBatchStaffRetryAt(TEST_STAFF_CHAT_ID), undefined);
      } finally {
        harness?.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  for (const scenario of ["keep-open", "same-status", "reply-and-close", "closed"] as const) {
    it(`resolves a proven Batch reply after concurrent operator change (${scenario}) without replay or false follow-up claims`, async () => {
      const harness = createHarness();
      const ticket = harness.seedTicket();
      const token = getTicketSnapshotToken(ticket, []);
      harness.db.createTicketBatchExport({
        exportId: "export_conflict",
        staffChatId: TEST_STAFF_CHAT_ID,
        createdAt: "2026-07-30T00:00:00.000Z",
        selectionMode: "all_active",
        ticketCount: 1,
        items: [{ ticketId: ticket.id, snapshotToken: token }],
      });
      harness.setDownloadResponse(
        JSON.stringify({
          schema: "telegram_ticket_answer_package",
          version: 2,
          export_id: "export_conflict",
          answer_package_id: "answers_conflict",
          created_at: "2026-07-31T00:00:00.000Z",
          answers: [
            {
              ticket_id: ticket.id,
              snapshot_token: token,
              action: scenario === "reply-and-close" ? "reply_and_close" : "reply_keep_open",
              reply_text: "Proven customer reply",
              follow_up_state: scenario === "reply-and-close" ? "NONE" : "WAITING_DEVS",
              internal_note: "Batch requested note",
              escalation_target: "PAYMENTS",
            },
          ],
        })
      );
      await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_conflict.json" }));
      const preview = harness
        .findApiCalls("sendMessage")
        .find((call) => String(call.payload.text).includes("Ticket answer package preview"))!;
      assert.ok(preview);
      let signalEntered!: () => void;
      let releaseDelivery!: () => void;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      harness.bot.api.config.use(async (previous, method, payload, signal) => {
        if (
          method === "sendMessage" &&
          "chat_id" in payload &&
          payload.chat_id === ticket.user_telegram_id &&
          "text" in payload &&
          payload.text === "Proven customer reply"
        ) {
          signalEntered();
          await release;
        }
        return previous(method, payload, signal);
      });
      const apply = harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 8801, preview));
      await entered;
      if (scenario === "closed")
        harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, {
          type: "STAFF",
          displayName: "Other operator",
        });
      else if (scenario !== "same-status")
        harness.db.transitionTicketStatusIfCurrent(ticket.id, TEST_STAFF_CHAT_ID, ticket.status, "WAITING_USER");
      if (scenario !== "closed")
        harness.db.setTicketFollowUpContext(ticket.id, {
          followUpState: "WAITING_USER",
          internalNote: "New operator context",
          escalationTarget: "SUPPORT",
        });
      releaseDelivery();
      await apply;
      await harness.bot.recoverPendingTicketBatchStaffOperations();
      await harness.bot.recoverPendingTicketBatchStaffOperations();
      const item = harness.db.listTicketBatchAnswerItems("answers_conflict")[0]!;
      assert.equal(item.state, scenario === "closed" ? "INACTIVE" : "COMPLETED");
      assert.equal(item.topic_echo_state, scenario === "closed" ? "NOT_REQUIRED" : "SENT");
      assert.equal(item.topic_echo_error_category, null);
      assert.equal(item.delivery_error_permanence, null);
      assert.equal(item.topic_echo_next_retry_at, null);
      assert.match(item.last_error ?? "", /FOLLOW_UP_NOT_APPLIED/);
      assert.equal(harness.db.getTicketBatchAnswerPackage("answers_conflict", TEST_STAFF_CHAT_ID)?.status, "COMPLETED");
      assert.equal(
        harness
          .findApiCalls("sendMessage")
          .filter(
            (call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "Proven customer reply"
          ).length,
        1
      );
      const echoes = harness
        .findApiCalls("sendMessage")
        .filter(
          (call) =>
            call.payload.chat_id === TEST_STAFF_CHAT_ID &&
            String(call.payload.text).includes("Batch reply sent to user")
        );
      assert.equal(echoes.length, scenario === "closed" ? 0 : 1);
      if (scenario !== "closed") {
        assert.match(String(echoes[0]!.payload.text), /not applied.*concurrent/i);
        assert.doesNotMatch(
          String(echoes[0]!.payload.text),
          /Follow-up: Waiting for developers|Internal note: Batch requested note/
        );
      }
      assert.equal(
        harness.db
          .listTicketFollowUpHistory(ticket.id)
          .filter((entry) => entry.source_answer_package_id === "answers_conflict").length,
        0
      );
      assert.equal(
        harness.db.getTicket(ticket.id)?.status,
        scenario === "reply-and-close" || scenario === "closed"
          ? "CLOSED"
          : scenario === "same-status"
            ? ticket.status
            : "WAITING_USER"
      );
      if (scenario === "reply-and-close") assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
      else
        assert.equal(
          harness.db.getTicket(ticket.id)?.internal_note,
          scenario === "closed" ? null : "New operator context"
        );
      assert.ok(
        harness
          .findApiCalls("editMessageText")
          .some((call) => String(call.payload.text).includes("Follow-up not applied after concurrent change: 1"))
      );
    });
  }

  it("silently closes and archives a ticket without any user delivery", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ user: { id: 2801 }, messageThreadId: 72801 });
    harness.db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", text: "No further help needed." });
    const token = getTicketSnapshotToken(
      harness.db.getTicketWithUser(ticket.id)!,
      harness.db.listMessagesChronological(ticket.id)
    );
    harness.db.createTicketBatchExport({
      exportId: "export_silent_close",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_silent_close", ticket.id, token, "silent_close"));

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_silent_close.json" }));
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    assert.match(String(preview.payload.text), /Silent close/);
    assert.match(String(preview.payload.text), /no user message will be sent/i);

    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 2801, preview));

    const item = harness.db.listTicketBatchAnswerItems("answers_1")[0];
    assert.equal(harness.db.getTicket(ticket.id)?.status, "CLOSED");
    assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
    assert.equal(item?.state, "COMPLETED");
    assert.equal(item?.delivery_message_id, null);
    assert.equal(item?.delivery_error_category, null);
    assert.equal(item?.delivery_error_permanence, null);
    assert.equal(item?.delivery_attempt_count, 0);
    assert.equal(item?.delivery_failure_event_state, "NOT_REQUIRED");
    assert.equal(item?.topic_echo_state, "NOT_REQUIRED");
    assert.equal(item?.follow_up_state, "NONE");
    assert.equal(
      harness.db.listMessagesChronological(ticket.id).some((message) => message.direction === "STAFF_TO_USER"),
      false
    );
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === ticket.user_telegram_id),
      false
    );
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some(
          (call) =>
            call.payload.chat_id === TEST_STAFF_CHAT_ID &&
            call.payload.message_thread_id === ticket.message_thread_id &&
            String(call.payload.text).includes("silently closed by batch answer")
        ),
      true
    );
    assert.equal(harness.countApiCalls("sendDocument"), 1);
  });

  it("marks a claimed silent close stale when user activity arrives before recovery", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ user: { id: 2804 }, messageThreadId: 72804 });
    harness.db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", text: "Original request." });
    const token = getTicketSnapshotToken(
      harness.db.getTicketWithUser(ticket.id)!,
      harness.db.listMessagesChronological(ticket.id)
    );
    harness.db.createTicketBatchExport({
      exportId: "export_silent_stale",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.db.createTicketBatchAnswerPackage({
      answerPackageId: "silent_stale",
      exportId: "export_silent_stale",
      staffChatId: TEST_STAFF_CHAT_ID,
      packageHash: "sha256:silent_stale",
      packageCreatedAt: "2026-07-30T00:00:00.000Z",
      items: [{ ticket_id: ticket.id, snapshot_token: token, action: "silent_close", reply_text: null }],
    });
    harness.db.claimTicketBatchAnswerPackage("silent_stale", TEST_STAFF_CHAT_ID);
    harness.db.claimTicketBatchAnswerItem("silent_stale", ticket.id);
    harness.db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", text: "A new follow-up arrived." });

    await harness.bot.recoverPendingTicketBatchStaffOperations();

    assert.equal(harness.db.listTicketBatchAnswerItems("silent_stale")[0]?.state, "STALE");
    assert.equal(harness.db.getTicket(ticket.id)?.status, "OPEN");
    assert.equal(harness.db.getTicket(ticket.id)?.archived_at, null);
    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === ticket.user_telegram_id),
      false
    );
    assert.equal(
      harness.db.listMessagesChronological(ticket.id).some((message) => message.direction === "STAFF_TO_USER"),
      false
    );
  });

  it("keeps a silent close awaiting archive recovery without creating user delivery state", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ user: { id: 2803 }, messageThreadId: 72803 });
    harness.db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", text: "Archive this without replying." });
    const token = getTicketSnapshotToken(
      harness.db.getTicketWithUser(ticket.id)!,
      harness.db.listMessagesChronological(ticket.id)
    );
    harness.db.createTicketBatchExport({
      exportId: "export_silent_archive_retry",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_silent_archive_retry", ticket.id, token, "silent_close"));
    harness.setApiResponseOverride("sendDocument", () => ({
      ok: false,
      error_code: 500,
      description: "Archive unavailable",
    }));

    await harness.bot.handleUpdate(
      buildStaffDocumentUpdate({ fileName: "ticket-answers_export_silent_archive_retry.json" })
    );
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 2803, preview));

    const pending = harness.db.listTicketBatchAnswerItems("answers_1")[0];
    assert.equal(harness.db.getTicket(ticket.id)?.status, "CLOSED");
    assert.equal(harness.db.getTicket(ticket.id)?.archived_at, null);
    assert.equal(pending?.state, "APPLYING");
    assert.equal(pending?.delivery_message_id, null);
    assert.equal(pending?.delivery_attempt_count, 0);
    assert.equal(pending?.delivery_error_category, null);
    assert.equal(pending?.delivery_failure_event_state, "NOT_REQUIRED");
    assert.ok(pending?.topic_echo_next_retry_at);
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === ticket.user_telegram_id),
      false
    );
    assert.equal(
      harness.db.listMessagesChronological(ticket.id).some((message) => message.direction === "STAFF_TO_USER"),
      false
    );

    harness.clearApiCalls();
    harness.clearApiOverrides();
    await harness.bot.recoverPendingTicketBatchStaffOperations();
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "APPLYING");
    assert.equal(harness.countApiCalls("sendDocument"), 0);

    harness.db.setTicketBatchPostDeliveryRetry("answers_1", ticket.id, "2020-01-01T00:00:00.000Z", null);
    await harness.bot.recoverPendingTicketBatchStaffOperations();

    const completed = harness.db.listTicketBatchAnswerItems("answers_1")[0];
    assert.equal(completed?.state, "COMPLETED");
    assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === ticket.user_telegram_id),
      false
    );
    assert.equal(
      harness.db.listMessagesChronological(ticket.id).some((message) => message.direction === "STAFF_TO_USER"),
      false
    );
  });

  it("recovers an already closed silent-close item without user delivery", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ user: { id: 2802 }, messageThreadId: 72802 });
    harness.db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", text: "This ticket is obsolete." });
    const token = getTicketSnapshotToken(
      harness.db.getTicketWithUser(ticket.id)!,
      harness.db.listMessagesChronological(ticket.id)
    );
    harness.db.createTicketBatchExport({
      exportId: "export_silent_recovery",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.db.createTicketBatchAnswerPackage({
      answerPackageId: "silent_recovery",
      exportId: "export_silent_recovery",
      staffChatId: TEST_STAFF_CHAT_ID,
      packageHash: "sha256:silent_recovery",
      packageCreatedAt: "2026-07-30T00:00:00.000Z",
      items: [{ ticket_id: ticket.id, snapshot_token: token, action: "silent_close", reply_text: null }],
    });
    harness.db.claimTicketBatchAnswerPackage("silent_recovery", TEST_STAFF_CHAT_ID);
    harness.db.claimTicketBatchAnswerItem("silent_recovery", ticket.id);
    harness.db.closeTicketRecord(ticket.id, {
      type: "STAFF",
      displayName: "Synthetic Staff",
      username: "synthetic_staff",
    });
    harness.clearApiCalls();

    await harness.bot.recoverPendingTicketBatchStaffOperations();

    const item = harness.db.listTicketBatchAnswerItems("silent_recovery")[0];
    assert.equal(item?.state, "COMPLETED");
    assert.equal(item?.delivery_message_id, null);
    assert.equal(item?.delivery_error_category, null);
    assert.equal(item?.delivery_error_permanence, null);
    assert.equal(item?.topic_echo_state, "NOT_REQUIRED");
    assert.equal(harness.db.getTicketBatchAnswerPackage("silent_recovery", TEST_STAFF_CHAT_ID)?.status, "COMPLETED");
    assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === ticket.user_telegram_id),
      false
    );
    assert.equal(
      harness.db.listMessagesChronological(ticket.id).some((message) => message.direction === "STAFF_TO_USER"),
      false
    );
    assert.equal(harness.countApiCalls("sendDocument"), 1);
    assert.equal(harness.countApiCalls("deleteForumTopic"), 1);

    harness.clearApiCalls();
    await harness.bot.recoverPendingTicketBatchStaffOperations();
    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === ticket.user_telegram_id),
      false
    );
  });

  it("leaves an orphan archive unknown for manual Batch reconciliation without retry scheduling", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ user: { id: 2805 }, messageThreadId: 72805 });
    harness.db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", text: "Keep the archive durable." });
    const token = getTicketSnapshotToken(
      harness.db.getTicketWithUser(ticket.id)!,
      harness.db.listMessagesChronological(ticket.id)
    );
    harness.db.createTicketBatchExport({
      exportId: "export_silent_unknown_archive",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.db.createTicketBatchAnswerPackage({
      answerPackageId: "silent_unknown_archive",
      exportId: "export_silent_unknown_archive",
      staffChatId: TEST_STAFF_CHAT_ID,
      packageHash: "sha256:silent_unknown_archive",
      packageCreatedAt: "2026-07-30T00:00:00.000Z",
      items: [{ ticket_id: ticket.id, snapshot_token: token, action: "silent_close", reply_text: null }],
    });
    harness.db.claimTicketBatchAnswerPackage("silent_unknown_archive", TEST_STAFF_CHAT_ID);
    harness.db.claimTicketBatchAnswerItem("silent_unknown_archive", ticket.id);
    harness.db.closeTicketRecord(ticket.id, {
      type: "STAFF",
      displayName: "Synthetic Staff",
      username: "synthetic_staff",
    });
    assert.equal(harness.db.claimTicketArchiveSummary(ticket.id, 8000).claimed, true);
    assert.equal(harness.db.markPendingTicketArchiveDeliveriesUnknown(), 1);
    harness.clearApiCalls();

    await harness.bot.recoverPendingTicketBatchStaffOperations();

    const item = harness.db.listTicketBatchAnswerItems("silent_unknown_archive")[0];
    assert.equal(item?.state, "APPLYING");
    assert.equal(item?.topic_echo_next_retry_at, "9999-12-31T23:59:59.999Z");
    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID && call.payload.message_thread_id === 8000),
      false
    );
  });

  it("sends one self-contained export document without copying attachments into the staff chat", async () => {
    const harness = createHarness();
    const active = harness.seedTicket({ messageThreadId: 5000 });
    const closed = harness.seedTicket({ user: { id: 124 }, messageThreadId: 5001, status: "CLOSED" });
    harness.db.addMessage({
      ticketId: active.id,
      direction: "USER_TO_STAFF",
      sourceChatId: active.user_telegram_id,
      sourceMessageId: 99,
      mediaType: "photo",
      fileId: "photo",
      text: "evidence",
    });
    harness.setFileDownload("photo", new Uint8Array([7, 8, 9]), { filePath: "evidence/photo.jpg" });

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("sendDocument"), 1);
    const exportDocument = harness.findApiCalls("sendDocument")[0];
    assert.equal(exportDocument?.payload.chat_id, TEST_STAFF_CHAT_ID);
    assert.ok(exportDocument?.documentBytes);
    const entries = unzipSync(exportDocument.documentBytes);
    const mediaIndex = JSON.parse(strFromU8(entries["media-index.json"]!)) as Array<{ archive_path: string }>;
    assert.equal(mediaIndex.length, 1);
    assert.deepEqual(entries[mediaIndex[0]!.archive_path], new Uint8Array([7, 8, 9]));
    assert.equal(harness.countApiCalls("copyMessage"), 0);
    assert.equal(
      harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length,
      0
    );
    assert.equal(
      harness.db.listActiveTicketsForStaffChat(TEST_STAFF_CHAT_ID).some((ticket) => ticket.id === closed.id),
      false
    );
  });

  it("marks an export unknown when delivery persistence fails after Telegram accepts the document", async () => {
    const harness = createHarness();
    try {
      harness.seedTicket();
      const original = harness.db.markTicketBatchExportDelivered.bind(harness.db);
      harness.db.markTicketBatchExportDelivered = () => {
        throw new Error("Simulated post-send persistence failure");
      };

      await harness.bot.handleUpdate(exportCommand());

      harness.db.markTicketBatchExportDelivered = original;
      const caption = String(harness.findApiCalls("sendDocument")[0]?.payload.caption);
      const exportId = /^Export: (export_[a-z0-9]+)$/m.exec(caption)?.[1];
      assert.ok(exportId);
      assert.equal(harness.countApiCalls("sendDocument"), 1);
      assert.equal(harness.db.getTicketBatchExport(exportId, TEST_STAFF_CHAT_ID)?.delivery_state, "UNKNOWN_DELIVERY");
    } finally {
      harness.cleanup();
    }
  });

  it("fails the whole export before delivery when an attachment cannot be downloaded", async () => {
    const harness = createHarness();
    const active = harness.seedTicket();
    harness.db.addMessage({
      ticketId: active.id,
      direction: "USER_TO_STAFF",
      sourceChatId: active.user_telegram_id,
      sourceMessageId: 99,
      mediaType: "document",
      fileId: "file_1",
    });
    harness.setFileDownload("file_1", new Uint8Array(), { status: 404 });

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("copyMessage"), 0);
    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("Export failed before delivery")),
      true
    );
  });

  it("exports available attachments when Telegram reports one file is too big", async () => {
    const harness = createHarness();
    const active = harness.seedTicket();
    harness.db.addMessage({
      ticketId: active.id,
      direction: "USER_TO_STAFF",
      sourceChatId: active.user_telegram_id,
      sourceMessageId: 98,
      mediaType: "photo",
      fileId: "small",
    });
    harness.db.addMessage({
      ticketId: active.id,
      direction: "USER_TO_STAFF",
      sourceChatId: active.user_telegram_id,
      sourceMessageId: 99,
      mediaType: "video",
      fileId: "large",
    });
    harness.setFileDownload("small", new Uint8Array([7, 8, 9]), { filePath: "evidence/photo.jpg" });
    harness.setApiResponseOverride("getFile", (call) =>
      call.payload.file_id === "large"
        ? { ok: false, error_code: 400, description: "Bad Request: file is too big" }
        : undefined
    );

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("sendDocument"), 1);
    const exportDocument = harness.findApiCalls("sendDocument")[0];
    assert.match(String(exportDocument?.payload.caption), /Attachments: 1 embedded, 1 unavailable/);
    const entries = unzipSync(exportDocument!.documentBytes!);
    const mediaIndex = JSON.parse(strFromU8(entries["media-index.json"]!)) as Array<{
      embedded: boolean;
      failure_category?: string;
    }>;
    assert.deepEqual(
      mediaIndex.map((attachment) => [attachment.embedded, attachment.failure_category]),
      [
        [true, undefined],
        [false, "TELEGRAM_FILE_TOO_LARGE"],
      ]
    );
  });

  it("exports available attachments when Telegram cannot retrieve a historical file ID", async () => {
    const harness = createHarness();
    const active = harness.seedTicket();
    harness.db.addMessage({
      ticketId: active.id,
      direction: "USER_TO_STAFF",
      sourceChatId: active.user_telegram_id,
      sourceMessageId: 98,
      mediaType: "photo",
      fileId: "current",
    });
    harness.db.addMessage({
      ticketId: active.id,
      direction: "USER_TO_STAFF",
      sourceChatId: active.user_telegram_id,
      sourceMessageId: 99,
      mediaType: "document",
      fileId: "historical",
      filename: "historical.pdf",
    });
    harness.setFileDownload("current", new Uint8Array([7, 8, 9]), { filePath: "evidence/photo.jpg" });
    harness.setApiResponseOverride("getFile", (call) =>
      call.payload.file_id === "historical"
        ? {
            ok: false,
            error_code: 400,
            description: "Bad Request: wrong file_id or the file is temporarily unavailable",
          }
        : undefined
    );

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("sendDocument"), 1);
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("Export failed before delivery")),
      false
    );
    const exportDocument = harness.findApiCalls("sendDocument")[0];
    assert.match(String(exportDocument?.payload.caption), /Attachments: 1 embedded, 1 unavailable/);
    const entries = unzipSync(exportDocument!.documentBytes!);
    const mediaIndex = JSON.parse(strFromU8(entries["media-index.json"]!)) as Array<{
      embedded: boolean;
      failure_category?: string;
      failure_reason?: string;
    }>;
    assert.deepEqual(
      mediaIndex.map((attachment) => [attachment.embedded, attachment.failure_category]),
      [
        [true, undefined],
        [false, "TELEGRAM_FILE_UNAVAILABLE"],
      ]
    );
    assert.match(
      mediaIndex[1]!.failure_reason ?? "",
      /could not retrieve this historical attachment with the current bot account/i
    );
    assert.equal(
      Object.keys(entries).some((name) => name.includes("historical.pdf")),
      false
    );
  });

  it("rejects an answer package when actual streamed bytes exceed the bounded read", async () => {
    let cancelled = false;
    let fetchCount = 0;
    const harness = createHarness({
      ticketBatchResourceLimits: { answerPackageMaxBytes: 6 },
      fetch: async () => {
        fetchCount += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3, 4]));
              controller.enqueue(new Uint8Array([5, 6, 7]));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-length": "1" } }
        );
      },
    });
    harness.seedTicket();
    await harness.bot.handleUpdate(exportCommand());
    const exportId = exportIdFromHarness(harness);

    await harness.bot.handleUpdate(
      buildStaffDocumentUpdate({
        fileName: `ticket-answers_${exportId}.json`,
        fileSize: 6,
      })
    );

    assert.equal(fetchCount, 1);
    assert.equal(cancelled, true);
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID), undefined);
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("Ticket answer packages must be 5 MiB or smaller")),
      true
    );
  });

  it("rejects declared answer-package size above 5 MiB before getFile", async () => {
    const harness = createHarness();
    harness.seedTicket();
    await harness.bot.handleUpdate(exportCommand());
    const exportId = exportIdFromHarness(harness);

    await harness.bot.handleUpdate(
      buildStaffDocumentUpdate({
        fileName: `ticket-answers_${exportId}.json`,
        fileSize: ANSWER_PACKAGE_MAX_BYTES + 1,
      })
    );

    assert.equal(harness.countApiCalls("getFile"), 0);
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID), undefined);
  });

  it("accepts a valid answer package whose actual body is just within the configured bound", async () => {
    const expectedLength = Buffer.byteLength(answerPackage(`export_${"0".repeat(32)}`, 1, `sha256:${"0".repeat(64)}`));
    let answerBody = "";
    const harness = createHarness({
      ticketBatchResourceLimits: { answerPackageMaxBytes: expectedLength },
      fetch: async () => new Response(answerBody),
    });
    const ticket = harness.seedTicket();
    await harness.bot.handleUpdate(exportCommand());
    const exportId = exportIdFromHarness(harness);
    const token = getTicketSnapshotToken(ticket, []);
    answerBody = answerPackage(exportId, ticket.id, token);
    assert.equal(Buffer.byteLength(answerBody), expectedLength);
    await harness.bot.handleUpdate(
      buildStaffDocumentUpdate({
        fileId: "valid-answer-package",
        fileName: `ticket-answers_${exportId}.json`,
        fileSize: Buffer.byteLength(answerBody),
      })
    );

    assert.ok(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID));
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("Ticket answer package preview")),
      true
    );
  });

  it("keeps malformed UTF-8 answer packages rejected", async () => {
    const harness = createHarness({
      fetch: async () => new Response(new Uint8Array([0xc3, 0x28])),
    });
    harness.seedTicket();
    await harness.bot.handleUpdate(exportCommand());
    const exportId = exportIdFromHarness(harness);

    await harness.bot.handleUpdate(
      buildStaffDocumentUpdate({
        fileId: "malformed-answer-package",
        fileName: `ticket-answers_${exportId}.json`,
        fileSize: 2,
      })
    );

    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID), undefined);
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("Could not validate the ticket answer package")),
      true
    );
  });

  it("marks attachment metadata over the hosted download limit unavailable without fetching it", async () => {
    let fetchCount = 0;
    const harness = createHarness({
      ticketBatchResourceLimits: { attachmentMaxBytes: 5 },
      fetch: async () => {
        fetchCount += 1;
        return new Response(new Uint8Array([1]));
      },
    });
    const ticket = harness.seedTicket();
    harness.db.addMessage({
      ticketId: ticket.id,
      direction: "USER_TO_STAFF",
      sourceChatId: ticket.user_telegram_id,
      sourceMessageId: 99,
      mediaType: "document",
      fileId: "too-large",
    });
    harness.setFileDownload("too-large", new Uint8Array([1]), { fileSize: 6 });

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(fetchCount, 0);
    assert.equal(harness.countApiCalls("sendDocument"), 1);
    assert.match(
      String(harness.findApiCalls("sendDocument")[0]?.payload.caption),
      /Attachments: 0 embedded, 1 unavailable/
    );
  });

  it("treats an attachment response Content-Length above the per-file bound as unavailable", async () => {
    const harness = createHarness({
      ticketBatchResourceLimits: { attachmentMaxBytes: 5, exportMaxBytes: 100_000, zipMaxBytes: 100_000 },
      fetch: async () => new Response(new Uint8Array(), { headers: { "content-length": "6" } }),
    });
    const ticket = harness.seedTicket();
    harness.db.addMessage({
      ticketId: ticket.id,
      direction: "USER_TO_STAFF",
      sourceChatId: ticket.user_telegram_id,
      sourceMessageId: 99,
      mediaType: "document",
      fileId: "header-large",
    });
    harness.setFileDownload("header-large", new Uint8Array([1]), { fileSize: 2 });

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("sendDocument"), 1);
    assert.match(
      String(harness.findApiCalls("sendDocument")[0]?.payload.caption),
      /Attachments: 0 embedded, 1 unavailable/
    );
  });

  it("fails an aggregate export overrun before sendDocument and keeps it a pre-delivery failure", async () => {
    const harness = createHarness({
      ticketBatchResourceLimits: { attachmentMaxBytes: 10, exportMaxBytes: 5, zipMaxBytes: 100_000 },
      fetch: async () => new Response(new Uint8Array([1, 2, 3])),
    });
    const ticket = harness.seedTicket();
    for (const [index, fileId] of ["aggregate-a", "aggregate-b"].entries()) {
      harness.db.addMessage({
        ticketId: ticket.id,
        direction: "USER_TO_STAFF",
        sourceChatId: ticket.user_telegram_id,
        sourceMessageId: 100 + index,
        mediaType: "document",
        fileId,
      });
      harness.setFileDownload(fileId, new Uint8Array([1, 2, 3]), { fileSize: 3 });
    }

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("Export failed before delivery")),
      true
    );
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("delivery could not be confirmed")),
      false
    );
  });

  it("rejects a generated ZIP above the hosted upload bound before sendDocument", async () => {
    const harness = createHarness({
      ticketBatchResourceLimits: { exportMaxBytes: 100_000, zipMaxBytes: 1 },
    });
    harness.seedTicket();

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("Export failed before delivery")),
      true
    );
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("delivery could not be confirmed")),
      false
    );
  });

  it("keeps a mid-stream attachment network failure strict and before delivery", async () => {
    const harness = createHarness({
      ticketBatchResourceLimits: { attachmentMaxBytes: 10, exportMaxBytes: 100_000, zipMaxBytes: 100_000 },
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              controller.error(new Error("attachment stream interrupted"));
            },
          })
        ),
    });
    const ticket = harness.seedTicket();
    harness.db.addMessage({
      ticketId: ticket.id,
      direction: "USER_TO_STAFF",
      sourceChatId: ticket.user_telegram_id,
      sourceMessageId: 99,
      mediaType: "document",
      fileId: "mid-stream-failure",
    });
    harness.setFileDownload("mid-stream-failure", new Uint8Array([1]), { fileSize: 2 });

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("Export failed before delivery")),
      true
    );
  });

  it("keeps other Telegram getFile failures strict", async () => {
    const harness = createHarness();
    const active = harness.seedTicket();
    harness.db.addMessage({
      ticketId: active.id,
      direction: "USER_TO_STAFF",
      sourceChatId: active.user_telegram_id,
      sourceMessageId: 99,
      mediaType: "document",
      fileId: "file_1",
    });
    harness.failNextApiCall("getFile", "Bad Request: file not found", 400);

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("Export failed before delivery")),
      true
    );
  });

  it("keeps Telegram rate limits strict during attachment retrieval", async () => {
    const harness = createHarness();
    const active = harness.seedTicket();
    harness.db.addMessage({
      ticketId: active.id,
      direction: "USER_TO_STAFF",
      sourceChatId: active.user_telegram_id,
      sourceMessageId: 99,
      mediaType: "document",
      fileId: "file_1",
    });
    harness.failNextApiCall("getFile", "Too Many Requests", 429);

    await harness.bot.handleUpdate(exportCommand());

    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("Export failed before delivery")),
      true
    );
  });

  it("rejects export commands inside ticket topics", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    await harness.bot.handleUpdate(exportCommand(ticket.message_thread_id ?? 0));
    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("outside ticket topics")),
      true
    );
  });

  it("persists and applies a valid answer package through the existing staff text delivery path", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_test",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_test", ticket.id, token));

    await harness.bot.handleUpdate(buildStaffDocumentUpdate());

    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    assert.match(String(preview.payload.text), /Ticket #1/);
    assert.match(String(preview.payload.text), /Action: reply_keep_open/);
    assert.match(String(preview.payload.text), /Reply:\nA valid reply/);
    const apply = callbackData(preview, "Apply");
    assert.ok(Buffer.byteLength(apply, "utf8") <= 64);
    assert.equal(harness.db.getTicket(ticket.id)?.status, "OPEN");
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);

    await harness.bot.handleUpdate(batchCallback(apply, 2, preview));
    assert.equal(harness.countApiCalls("answerCallbackQuery"), 1);
    assert.equal(harness.countApiCalls("deleteMessage"), 0);
    assert.equal(
      harness
        .findApiCalls("editMessageText")
        .some((call) => String(call.payload.text).includes("Answer package applied")),
      true
    );
    assert.equal(
      harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
      1
    );
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
    const delivery = harness.db.getTicketOutboundDelivery(`ticket-batch:answers_1:${ticket.id}`);
    assert.equal(delivery?.state, "DELIVERED");
    assert.equal(
      delivery?.delivery_message_id,
      harness.db.listMessagesChronological(ticket.id)[0]?.delivery_message_id
    );
    assert.equal(harness.db.getTicket(ticket.id)?.status, "IN_PROGRESS");
  });

  it("posts one staff-only batch echo and persists follow-up context for a version 2 reply", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_follow_up",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(
      JSON.stringify({
        schema: "telegram_ticket_answer_package",
        version: 2,
        export_id: "export_follow_up",
        answer_package_id: "answers_follow_up",
        created_at: "2026-07-31T00:00:00.000Z",
        answers: [
          {
            ticket_id: ticket.id,
            snapshot_token: token,
            action: "reply_keep_open",
            reply_text: "We are investigating this.",
            follow_up_state: "WAITING_DEVS",
            internal_note: "Check the withdrawal service.",
            escalation_target: "PAYMENTS",
          },
        ],
      })
    );

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_follow_up.json" }));
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 99, preview));

    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter(
          (call) =>
            call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "We are investigating this."
        ).length,
      1
    );
    const echo = harness
      .findApiCalls("sendMessage")
      .find(
        (call) =>
          call.payload.chat_id === TEST_STAFF_CHAT_ID &&
          call.payload.message_thread_id === ticket.message_thread_id &&
          String(call.payload.text).includes("Batch reply sent to user")
      );
    assert.ok(echo);
    assert.match(String(echo.payload.text), /We are investigating this\./);
    assert.match(String(echo.payload.text), /Follow-up: Waiting for developers/);
    assert.match(String(echo.payload.text), /Escalation: Payments/);
    assert.match(String(echo.payload.text), /Check the withdrawal service/);
    assert.equal(harness.db.getTicket(ticket.id)?.follow_up_state, "WAITING_DEVS");
    assert.equal(harness.db.getTicket(ticket.id)?.escalation_target, "PAYMENTS");
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_follow_up")[0]?.topic_echo_state, "SENT");
  });

  it("moves WAITING_USER back to IN_PROGRESS when the user sends a follow-up", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.db.setTicketFollowUpContext(ticket.id, {
      followUpState: "WAITING_USER",
      internalNote: "Need the transaction hash.",
      escalationTarget: "SUPPORT",
      sourceAnswerPackageId: "answers_waiting",
    });
    harness.db.updateTicketStatus(ticket.id, "WAITING_USER");

    await harness.bot.handleUpdate({
      update_id: 120,
      message: {
        message_id: 120,
        date: 1,
        from: { id: ticket.user_telegram_id, is_bot: false, first_name: "Test Customer", username: "test_customer" },
        chat: { id: ticket.user_telegram_id, type: "private", first_name: "Test Customer" },
        text: "Here is the transaction hash.",
      },
    });

    assert.equal(harness.db.getTicket(ticket.id)?.status, "IN_PROGRESS");
    assert.equal(harness.db.getTicket(ticket.id)?.follow_up_state, "NONE");
    assert.ok(harness.db.listTicketFollowUpHistory(ticket.id).length >= 2);
  });

  it("retries only a failed topic echo without resending the confirmed user reply", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_echo_retry",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(
      JSON.stringify({
        schema: "telegram_ticket_answer_package",
        version: 2,
        export_id: "export_echo_retry",
        answer_package_id: "answers_echo_retry",
        created_at: "2026-07-31T00:00:00.000Z",
        answers: [
          {
            ticket_id: ticket.id,
            snapshot_token: token,
            action: "reply_keep_open",
            reply_text: "Reply once.",
            follow_up_state: "WAITING_DEVS",
            internal_note: null,
            escalation_target: "DEVS",
          },
        ],
      })
    );
    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_echo_retry.json" }));
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    harness.setApiResponseOverride("sendMessage", (call, success) =>
      call.payload.chat_id === TEST_STAFF_CHAT_ID && call.payload.message_thread_id === ticket.message_thread_id
        ? { ok: false, error_code: 500, description: "Topic unavailable" }
        : success
    );

    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 121, preview));
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_echo_retry")[0]?.state, "STAFF_SYNC_PENDING");
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "Reply once.")
        .length,
      1
    );

    harness.clearApiOverrides();
    await harness.bot.recoverPendingTicketBatchStaffOperations();
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_echo_retry")[0]?.state, "STAFF_SYNC_PENDING");
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "Reply once.")
        .length,
      1
    );
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter(
          (call) =>
            call.payload.chat_id === TEST_STAFF_CHAT_ID &&
            call.payload.message_thread_id === ticket.message_thread_id &&
            String(call.payload.text).includes("Batch reply sent to user")
        ).length,
      3
    );
  });

  it("resumes reply_and_close after staff echo recovery without repeating post-delivery work", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_close_recovery",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_close_recovery", ticket.id, token, "reply_and_close"));
    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_close_recovery.json" }));
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    harness.setApiResponseOverride("sendMessage", (call, success) =>
      call.payload.chat_id === TEST_STAFF_CHAT_ID &&
      call.payload.message_thread_id === ticket.message_thread_id &&
      String(call.payload.text).includes("Batch reply sent to user")
        ? {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 1",
            parameters: { retry_after: 1 },
          }
        : success
    );

    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 122, preview));

    const deliveredItem = harness.db.listTicketBatchAnswerItems("answers_1")[0];
    assert.equal(deliveredItem?.state, "STAFF_SYNC_PENDING");
    assert.ok(deliveredItem?.delivery_message_id);
    assert.equal(harness.db.getTicket(ticket.id)?.status, "IN_PROGRESS");
    assert.equal(
      harness.db.listMessagesChronological(ticket.id).filter((message) => message.direction === "STAFF_TO_USER").length,
      1
    );
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply")
        .length,
      1
    );

    harness.clearApiOverrides();
    harness.db.recordTicketBatchTopicEcho("answers_1", ticket.id, "FAILED", {
      nextRetryAt: "2020-01-01T00:00:00.000Z",
    });
    await harness.bot.recoverPendingTicketBatchStaffOperations();

    assert.equal(harness.db.getTicket(ticket.id)?.status, "CLOSED");
    assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "COMPLETED");
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "COMPLETED");
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply")
        .length,
      1
    );
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter(
          (call) =>
            call.payload.chat_id === TEST_STAFF_CHAT_ID &&
            call.payload.message_thread_id === ticket.message_thread_id &&
            String(call.payload.text).includes("Batch reply sent to user")
        ).length,
      4
    );
    assert.equal(harness.countApiCalls("sendDocument"), 1);
    assert.equal(harness.countApiCalls("deleteForumTopic"), 1);
    const refreshedSummary = harness.findApiCalls("editMessageText").at(-1);
    assert.match(String(refreshedSummary?.payload.text), /Tickets closed: 1/);
    assert.match(String(refreshedSummary?.payload.text), /Ticket closures pending\/failed: 0/);
    assert.match(String(refreshedSummary?.payload.text), /Archives completed: 1/);
    assert.match(String(refreshedSummary?.payload.text), /Topic closures unconfirmed: 1/);

    await harness.bot.recoverPendingTicketBatchStaffOperations();

    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply")
        .length,
      1
    );
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter(
          (call) =>
            call.payload.chat_id === TEST_STAFF_CHAT_ID &&
            call.payload.message_thread_id === ticket.message_thread_id &&
            String(call.payload.text).includes("Batch reply sent to user")
        ).length,
      4
    );
    assert.equal(harness.countApiCalls("sendDocument"), 1);
    assert.equal(harness.countApiCalls("deleteForumTopic"), 1);
  });

  it("rejects malformed packages and answer packages inside ticket topics without forwarding them", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.setDownloadResponse("{");
    await harness.bot.handleUpdate(buildStaffDocumentUpdate());
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
    assert.equal(harness.countApiCalls("copyMessage"), 0);

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ messageThreadId: ticket.message_thread_id ?? 0 }));
    assert.equal(harness.countApiCalls("copyMessage"), 0);
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("outside ticket topics")),
      true
    );
  });

  it("cancels a pending package without deleting its items or sending a user reply", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_cancel",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_cancel", ticket.id, token));

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_cancel.json" }));
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    const cancel = callbackData(preview, "Cancel");
    await harness.bot.handleUpdate(batchCallback(cancel, 3, preview));

    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "CANCELLED");
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1").length, 1);
    assert.equal(harness.countApiCalls("deleteMessage"), 1);
    assert.equal(
      harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
      0
    );
    assert.equal(harness.db.claimTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID), undefined);
  });

  it("reuses the same preview message for a repeated pending upload", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_repeat",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_repeat", ticket.id, token));

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_repeat.json" }));
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    harness.clearApiCalls();
    await harness.bot.handleUpdate(
      buildStaffDocumentUpdate({ messageId: 7002, fileName: "ticket-answers_export_repeat.json" })
    );

    assert.equal(harness.countApiCalls("sendMessage"), 0);
    assert.equal(harness.countApiCalls("editMessageText"), 1);
    assert.equal(harness.findApiCalls("editMessageText")[0]?.payload.message_id, preview.responseMessageId);
  });

  it("replaces the same preview with the final summary without duplicating Apply", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_cleanup",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_cleanup", ticket.id, token));
    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_cleanup.json" }));
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 25, preview));

    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply")
        .length,
      1
    );
    assert.equal(harness.countApiCalls("deleteMessage"), 0);
    assert.equal(harness.countApiCalls("editMessageText"), 2);
    assert.equal(harness.findApiCalls("editMessageText")[0]?.payload.message_id, preview.responseMessageId);
    const packageRecord = harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID);
    assert.equal(packageRecord?.preview_token, null);
    assert.equal(packageRecord?.summary_delivery_state, "SENT");
  });

  it("completes Apply when preview cleanup fails and does not resend the user reply", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_preview_edit",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_preview_edit", ticket.id, token));
    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_preview_edit.json" }));
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    harness.setApiResponseOverride("editMessageText", () => ({
      ok: false,
      error_code: 500,
      description: "Temporary edit failure",
    }));

    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 26, preview));

    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply")
        .length,
      1
    );
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "COMPLETED");
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.preview_token, null);
  });

  it("treats already-applied preview and final-summary edits as successful", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_preview_not_modified",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_preview_not_modified", ticket.id, token));
    await harness.bot.handleUpdate(
      buildStaffDocumentUpdate({ fileName: "ticket-answers_export_preview_not_modified.json" })
    );
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    harness.clearApiCalls();
    harness.setApiResponseOverride("editMessageText", () => ({
      ok: false,
      error_code: 400,
      description: "Bad Request: message is not modified",
    }));

    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 27, preview));

    assert.equal(harness.countApiCalls("editMessageText"), 2);
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("Ticket batch applied")),
      false
    );
    assert.equal(
      harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.summary_delivery_state,
      "SENT"
    );
  });

  it("records a failed batch summary independently after a successful delivery", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_summary_failure",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_summary_failure", ticket.id, token));
    await harness.bot.handleUpdate(
      buildStaffDocumentUpdate({ fileName: "ticket-answers_export_summary_failure.json" })
    );
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    harness.setApiResponseOverride("editMessageText", (call, success) =>
      call.payload.message_id === preview.responseMessageId &&
      String(call.payload.text).includes("Answer package applied")
        ? { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 17 } }
        : success
    );

    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 27, preview));

    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply")
        .length,
      1
    );
    const packageRecord = harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID);
    assert.equal(packageRecord?.status, "COMPLETED");
    assert.equal(packageRecord?.summary_delivery_state, "FAILED");
    assert.equal(packageRecord?.summary_delivery_error, "RATE_LIMITED");
  });

  it("paginates a large persistent preview by editing the same message", async () => {
    const harness = createHarness();
    const entries = Array.from({ length: 52 }, (_, index) => {
      const ticket = harness.seedTicket({ user: { id: 900 + index }, messageThreadId: 6000 + index });
      return { ticket, token: getTicketSnapshotToken(ticket, []) };
    });
    harness.db.createTicketBatchExport({
      exportId: "export_pages",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: entries.length,
      items: entries.map(({ ticket, token }) => ({ ticketId: ticket.id, snapshotToken: token })),
    });
    harness.setDownloadResponse(
      multiAnswerPackage(
        "export_pages",
        entries.map(({ ticket, token }) => ({
          ticketId: ticket.id,
          token,
          action: "reply_keep_open",
          text: `Reply ${"x".repeat(150)} for ticket ${ticket.id}`,
        }))
      )
    );

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_pages.json" }));
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    assert.match(String(preview.payload.text), /Page 1\/\d+/);
    const next = callbackData(preview, "Next");
    await harness.bot.handleUpdate(batchCallback(next, 30, preview));

    assert.equal(harness.countApiCalls("editMessageText"), 1);
    const edit = harness.findApiCalls("editMessageText")[0];
    assert.equal(edit?.payload.message_id, preview.responseMessageId);
    assert.match(String(edit?.payload.text), /Page 2\/\d+/);
    assert.equal(
      harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length,
      1
    );
  });

  it("recovers a pending archive without resending the reply or recreating the preview", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_close",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_close", ticket.id, token, "reply_and_close"));
    harness.failNextApiCall("sendDocument", "Archive unavailable", 500);

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_close.json" }));
    const firstPreview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(firstPreview);
    await harness.bot.handleUpdate(batchCallback(callbackData(firstPreview, "Apply"), 4, firstPreview));

    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply")
        .length,
      1
    );
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "REPLY_SENT");
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "PARTIAL");

    harness.db.recordTicketBatchTopicEcho("answers_1", ticket.id, "SENT", {
      nextRetryAt: "2020-01-01T00:00:00.000Z",
    });
    await harness.bot.recoverPendingTicketBatchStaffOperations();

    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply")
        .length,
      1
    );
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "COMPLETED");
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "COMPLETED");

    const userRepliesBeforeRepeat = harness
      .findApiCalls("sendMessage")
      .filter(
        (call) => call.payload.chat_id === ticket.user_telegram_id && call.payload.text === "A valid reply"
      ).length;
    harness.clearApiCalls();
    await harness.bot.handleUpdate(
      buildStaffDocumentUpdate({ messageId: 7002, fileName: "ticket-answers_export_close.json" })
    );
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("no longer previewable")),
      true
    );
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some((call) => String(call.payload.text).includes("Ticket answer package preview")),
      false
    );
    assert.equal(
      harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
      0
    );
    assert.equal(userRepliesBeforeRepeat, 1);
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "COMPLETED");
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "COMPLETED");
  });

  it("does not create a preview for an already applying package", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_unknown",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_unknown", ticket.id, token));

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_unknown.json" }));
    harness.db.claimTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID);
    harness.db.claimTicketBatchAnswerItem("answers_1", ticket.id);
    harness.db.finalizeTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID);
    await harness.bot.handleUpdate(
      buildStaffDocumentUpdate({ messageId: 7003, fileName: "ticket-answers_export_unknown.json" })
    );
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => String(call.payload.text).includes("Ticket answer package preview")).length,
      1
    );
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => String(call.payload.text).includes("no longer previewable")),
      true
    );
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "APPLYING");
    assert.equal(
      harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
      0
    );
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "PARTIAL");
  });

  it("isolates stale and no_action items while applying later valid replies", async () => {
    const harness = createHarness();
    const stale = harness.seedTicket({ user: { id: 201 }, messageThreadId: 5201 });
    const valid = harness.seedTicket({ user: { id: 202 }, messageThreadId: 5202 });
    const noAction = harness.seedTicket({ user: { id: 203 }, messageThreadId: 5203 });
    const staleToken = getTicketSnapshotToken(stale, []);
    const validToken = getTicketSnapshotToken(valid, []);
    const noActionToken = getTicketSnapshotToken(noAction, []);
    harness.db.createTicketBatchExport({
      exportId: "export_isolation",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 3,
      items: [
        { ticketId: stale.id, snapshotToken: staleToken },
        { ticketId: valid.id, snapshotToken: validToken },
        { ticketId: noAction.id, snapshotToken: noActionToken },
      ],
    });
    harness.db.addMessage({ ticketId: stale.id, direction: "USER_TO_STAFF", text: "new evidence" });
    harness.setDownloadResponse(
      multiAnswerPackage("export_isolation", [
        { ticketId: stale.id, token: staleToken, action: "reply_keep_open" },
        { ticketId: valid.id, token: validToken, action: "reply_keep_open", text: "Valid reply" },
        { ticketId: noAction.id, token: noActionToken, action: "no_action" },
      ])
    );

    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_isolation.json" }));
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 7, preview));

    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.chat_id === valid.user_telegram_id && call.payload.text === "Valid reply")
        .length,
      1
    );
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === stale.user_telegram_id),
      false
    );
    assert.equal(
      harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === noAction.user_telegram_id),
      false
    );
    assert.deepEqual(
      harness.db.listTicketBatchAnswerItems("answers_1").map((item) => item.state),
      ["STALE", "COMPLETED", "NO_ACTION"]
    );
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "COMPLETED");
  });

  it("continues later items after a delivery failure without retrying the failed reply", async () => {
    const harness = createHarness();
    const failed = harness.seedTicket({ user: { id: 301 }, messageThreadId: 5301 });
    const valid = harness.seedTicket({ user: { id: 302 }, messageThreadId: 5302 });
    const failedToken = getTicketSnapshotToken(failed, []);
    const validToken = getTicketSnapshotToken(valid, []);
    harness.db.createTicketBatchExport({
      exportId: "export_failure",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 2,
      items: [
        { ticketId: failed.id, snapshotToken: failedToken },
        { ticketId: valid.id, snapshotToken: validToken },
      ],
    });
    harness.setDownloadResponse(
      multiAnswerPackage("export_failure", [
        { ticketId: failed.id, token: failedToken, action: "reply_keep_open", text: "First reply" },
        { ticketId: valid.id, token: validToken, action: "reply_keep_open", text: "Second reply" },
      ])
    );
    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_failure.json" }));
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    harness.failNextApiCall("sendMessage", "User unavailable", 403);
    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 8, preview));

    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[0]?.state, "FAILED");
    assert.equal(harness.db.listTicketBatchAnswerItems("answers_1")[1]?.state, "COMPLETED");
    assert.equal(
      harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === failed.user_telegram_id).length,
      1
    );
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.chat_id === valid.user_telegram_id && call.payload.text === "Second reply")
        .length,
      1
    );
    assert.equal(harness.db.getTicketBatchAnswerPackage("answers_1", TEST_STAFF_CHAT_ID)?.status, "PARTIAL");
    const failedItem = harness.db.listTicketBatchAnswerItems("answers_1")[0];
    assert.equal(failedItem?.delivery_error_category, "FORBIDDEN");
    assert.equal(failedItem?.delivery_error_permanence, "PERMANENT");
    assert.equal(failedItem?.delivery_attempt_count, 1);
    assert.equal(failedItem?.delivery_failure_event_state, "SENT");
    assert.equal(failedItem?.topic_echo_state, "NOT_REQUIRED");
    assert.equal(harness.db.getTicket(failed.id)?.status, "OPEN");
    assert.equal(
      harness.db.listMessagesChronological(failed.id).filter((message) => message.direction === "STAFF_TO_USER").length,
      0
    );
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter(
          (call) =>
            call.payload.chat_id === TEST_STAFF_CHAT_ID &&
            call.payload.message_thread_id === failed.message_thread_id &&
            String(call.payload.text).includes("Batch reply was not delivered")
        ).length,
      1
    );
    assert.equal(
      harness.findApiCalls("editMessageText").some((call) => String(call.payload.text).includes("FORBIDDEN")),
      true
    );

    await harness.bot.recoverPendingTicketBatchStaffOperations();

    assert.equal(
      harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === failed.user_telegram_id).length,
      1
    );
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter(
          (call) =>
            call.payload.chat_id === TEST_STAFF_CHAT_ID &&
            call.payload.message_thread_id === failed.message_thread_id &&
            String(call.payload.text).includes("Batch reply was not delivered")
        ).length,
      1
    );
  });

  it("records a rate-limited delivery as temporary without sending a success echo or closing the ticket", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    const token = getTicketSnapshotToken(ticket, []);
    harness.db.createTicketBatchExport({
      exportId: "export_rate_limit",
      staffChatId: TEST_STAFF_CHAT_ID,
      createdAt: "2026-07-30T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: token }],
    });
    harness.setDownloadResponse(answerPackage("export_rate_limit", ticket.id, token, "reply_and_close"));
    await harness.bot.handleUpdate(buildStaffDocumentUpdate({ fileName: "ticket-answers_export_rate_limit.json" }));
    const preview = harness
      .findApiCalls("sendMessage")
      .find((call) => String(call.payload.text).includes("Ticket answer package preview"));
    assert.ok(preview);
    harness.setApiResponseOverride("sendMessage", (call, success) =>
      call.payload.chat_id === ticket.user_telegram_id
        ? {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 39",
            parameters: { retry_after: 39 },
          }
        : success
    );

    await harness.bot.handleUpdate(batchCallback(callbackData(preview, "Apply"), 90, preview));

    const item = harness.db.listTicketBatchAnswerItems("answers_1")[0];
    assert.equal(item?.state, "FAILED");
    assert.equal(item?.delivery_error_category, "RATE_LIMITED");
    assert.equal(item?.delivery_error_permanence, "TEMPORARY");
    assert.equal(item?.delivery_retry_after_seconds, 39);
    assert.equal(item?.delivery_message_id, null);
    assert.equal(harness.db.getTicket(ticket.id)?.status, "OPEN");
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some(
          (call) =>
            call.payload.chat_id === TEST_STAFF_CHAT_ID &&
            call.payload.message_thread_id === ticket.message_thread_id &&
            String(call.payload.text).includes("Batch reply sent to user")
        ),
      false
    );
    assert.equal(
      harness.findApiCalls("editMessageText").some((call) => String(call.payload.text).includes("RATE_LIMITED")),
      true
    );
  });
});
