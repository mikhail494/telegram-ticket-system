import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { HttpError } from "grammy";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Update } from "grammy/types";
import { SupportDatabase } from "../src/db.js";
import { InstallationService } from "../src/installation.js";
import { TEST_STAFF_CHAT_ID, TEST_USER_ID, createBotHarness, type BotHarness } from "./helpers/botHarness.js";

const STAFF_CHAT_ID = -100901;
const USER_ID = 901;

function inboundInput(sourceMessageId = 1) {
  return {
    sourceChatId: USER_ID,
    sourceMessageId,
    staffChatId: STAFF_CHAT_ID,
    userTelegramId: USER_ID,
    fromUsername: "customer",
    fromFirstName: "Customer",
    fromLastName: null,
    senderDisplayName: "@customer",
    senderUsername: "customer",
    text: "Please help.",
    mediaType: null,
    filename: null,
    fileId: null,
    shouldCopyOriginal: false,
  };
}

function privateMessage(messageId: number, text = "Please help.", userId = TEST_USER_ID): Update {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1,
      from: { id: userId, is_bot: false, first_name: "Test Customer", username: "test_customer" },
      chat: { id: userId, type: "private", first_name: "Test Customer" },
      text,
    },
  };
}

function staffTopicMessages(harness: BotHarness): ReturnType<BotHarness["findApiCalls"]> {
  return harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID);
}

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("ticket inbound routing durability", () => {
  it("ignores private messages without a Telegram user actor", async () => {
    const harness = createBotHarness();
    try {
      const update = {
        update_id: 919,
        message: {
          message_id: 919,
          date: 1,
          chat: { id: TEST_USER_ID, type: "private" as const, first_name: "Test Customer" },
          text: "Please help without an actor",
        },
      } as Update;

      await harness.bot.handleUpdate(update);

      assert.equal(harness.db.getUser(TEST_USER_ID), undefined);
      assert.equal(harness.db.findActiveTicketForUser(TEST_USER_ID, TEST_STAFF_CHAT_ID), undefined);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 919), undefined);
      assert.equal(staffTopicMessages(harness).length, 0);
    } finally {
      harness.cleanup();
    }
  });

  it("does not route senderless or sender_chat staff-topic messages to a customer", async () => {
    const harness = createBotHarness();
    try {
      const ticket = harness.seedTicket({ messageThreadId: 5000 });
      const baseMessage = {
        message_id: 920,
        date: 1,
        chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup" as const, title: "Test Staff Chat" },
        message_thread_id: ticket.message_thread_id!,
        text: "Anonymous staff reply",
      };
      await harness.bot.handleUpdate({ update_id: 920, message: baseMessage } as Update);
      await harness.bot.handleUpdate({
        update_id: 921,
        message: {
          ...baseMessage,
          message_id: 921,
          from: { id: 42, is_bot: false, first_name: "Test Staff" },
          sender_chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Test Staff Chat" },
        },
      } as Update);

      assert.equal(harness.countApiCalls("sendMessage"), 0);
      assert.equal(harness.countApiCalls("sendPhoto"), 0);
      assert.equal(harness.countApiCalls("copyMessage"), 0);
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
    } finally {
      harness.cleanup();
    }
  });

  it("archives only after the last concurrent inbound attempt reaches terminal truth", async () => {
    const harness = createBotHarness();
    const bothEntered = barrier();
    const firstRelease = barrier();
    const lastRelease = barrier();
    const updates: Promise<void>[] = [];
    try {
      const ticket = harness.seedTicket();
      let entered = 0;
      harness.bot.api.config.use(async (previous, method, payload, signal) => {
        if (
          method === "sendMessage" &&
          "message_thread_id" in payload &&
          payload.message_thread_id === ticket.message_thread_id
        ) {
          if (++entered === 2) bothEntered.resolve();
          await ("text" in payload && String(payload.text).includes("Rejected last") ? lastRelease : firstRelease)
            .promise;
        }
        return previous(method, payload, signal);
      });
      harness.setApiResponseOverride("sendMessage", (call) =>
        call.payload.message_thread_id === ticket.message_thread_id &&
        String(call.payload.text).includes("Rejected last")
          ? { ok: false, error_code: 400, description: "Bad Request: message text is empty" }
          : undefined
      );
      updates.push(harness.bot.handleUpdate(privateMessage(920, "Delivered first")));
      updates.push(harness.bot.handleUpdate(privateMessage(921, "Rejected last")));
      await bothEntered.promise;
      harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
      firstRelease.resolve();
      await updates[0];
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 920)?.state, "DELIVERED");
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 921)?.state, "PENDING");
      assert.equal(harness.countApiCalls("sendDocument"), 0);
      lastRelease.resolve();
      await updates[1];
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 921)?.state, "CANCELLED");
      assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), false);
      assert.equal(harness.countApiCalls("sendDocument"), 1);
      assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
      const transcript = Buffer.from(harness.findApiCalls("sendDocument")[0]!.documentBytes!).toString("utf8");
      assert.equal(transcript.match(/Delivered first/g)?.length, 1);
      assert.equal(transcript.match(/Rejected last/g)?.length, 1);
    } finally {
      firstRelease.resolve();
      lastRelease.resolve();
      await Promise.all(updates);
      harness.cleanup();
    }
  });

  it("stops a ready drain with no progress instead of spinning during another topic claim", async () => {
    const harness = createBotHarness();
    try {
      const ticket = harness.seedTicket();
      for (const sourceMessageId of [910, 911, 912])
        harness.db.beginTicketInboundRouting({
          ...inboundInput(sourceMessageId),
          sourceChatId: TEST_USER_ID,
          userTelegramId: TEST_USER_ID,
          staffChatId: TEST_STAFF_CHAT_ID,
        });
      harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 910, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
      harness.db.markTicketInboundRoutingUpdateDelivered(TEST_USER_ID, 910, TEST_STAFF_CHAT_ID, 601);
      harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 912, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
      harness.db.restartTicketInboundRoutingAfterUnavailableTopic(TEST_USER_ID, 912, TEST_STAFF_CHAT_ID);
      harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 912, TEST_STAFF_CHAT_ID, "CREATE_TOPIC");
      const list = harness.db.listReadyTicketInboundRoutingOperationsForTicket.bind(harness.db);
      let passes = 0;
      harness.db.listReadyTicketInboundRoutingOperationsForTicket = (...args) => {
        assert.ok(++passes <= 2, "a stuck ready operation must not be scanned indefinitely");
        return list(...args);
      };
      await harness.bot.handleUpdate(privateMessage(910));
      assert.equal(passes, 1);
      assert.equal(harness.db.getTicket(ticket.id)?.message_thread_id, null);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 911)?.state, "READY");
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 912)?.state, "PENDING");
      assert.equal(harness.countApiCalls("sendMessage"), 0);
      assert.equal(harness.countApiCalls("createForumTopic"), 0);
      assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), true);
    } finally {
      harness.cleanup();
    }
  });

  it("stops ready draining and follow-up calls immediately when its workspace changes", async () => {
    let installation!: InstallationService;
    const harness = createBotHarness({
      installationServiceFactory: (db) => {
        installation = new InstallationService(db);
        installation.activateWorkspace({ chatId: TEST_STAFF_CHAT_ID, title: "Staff A" });
        installation.markReady();
        return installation;
      },
    });
    try {
      const ticket = harness.seedTicket({ staffMessageId: 700 });
      for (const sourceMessageId of [913, 914, 915])
        harness.db.beginTicketInboundRouting({
          ...inboundInput(sourceMessageId),
          sourceChatId: TEST_USER_ID,
          userTelegramId: TEST_USER_ID,
          staffChatId: TEST_STAFF_CHAT_ID,
          text: `Workspace-bound ${sourceMessageId}`,
          shouldCopyOriginal: sourceMessageId === 914,
        });
      harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 913, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
      harness.db.markTicketInboundRoutingUpdateDelivered(TEST_USER_ID, 913, TEST_STAFF_CHAT_ID, 601);
      harness.setApiResponseOverride("sendMessage", () => {
        installation.activateWorkspace({ chatId: -100999, title: "Staff B" });
        return undefined;
      });
      await harness.bot.handleUpdate(privateMessage(913));
      assert.equal(harness.countApiCalls("sendMessage"), 1);
      assert.equal(harness.findApiCalls("sendMessage")[0]?.payload.chat_id, TEST_STAFF_CHAT_ID);
      assert.equal(harness.countApiCalls("copyMessage"), 0);
      assert.equal(harness.countApiCalls("editMessageText"), 0);
      assert.equal(harness.countApiCalls("createForumTopic"), 0);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 914)?.stage, "COPY_ORIGINAL");
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 914)?.state, "READY");
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 915)?.state, "READY");
      assert.equal(harness.db.getTicket(ticket.id)?.staff_chat_id, TEST_STAFF_CHAT_ID);
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 2);
    } finally {
      harness.cleanup();
    }
  });

  for (const ambiguous of [false, true]) {
    it(`${ambiguous ? "ambiguous closed" : "confirmed open"} copy failure retains the correct recovery boundary`, async () => {
      const harness = createBotHarness();
      try {
        const ticket = harness.seedTicket();
        harness.db.beginTicketInboundRouting({
          ...inboundInput(916),
          sourceChatId: TEST_USER_ID,
          userTelegramId: TEST_USER_ID,
          staffChatId: TEST_STAFF_CHAT_ID,
          shouldCopyOriginal: true,
          mediaType: "photo",
          fileId: "photo-evidence",
        });
        harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 916, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
        harness.db.markTicketInboundRoutingUpdateDelivered(TEST_USER_ID, 916, TEST_STAFF_CHAT_ID, 601);
        if (ambiguous)
          harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
        harness.setApiResponseOverride("copyMessage", () => {
          if (ambiguous) throw new HttpError("uncertain copy", new Error("ECONNRESET"));
          return { ok: false, error_code: 400, description: "Bad Request: message to copy not found" };
        });
        await harness.bot.handleUpdate(privateMessage(916));
        assert.equal(
          harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 916)?.state,
          ambiguous ? "UNKNOWN_DELIVERY" : "FAILED"
        );
        assert.equal(harness.countApiCalls("copyMessage"), 1);
        assert.equal(harness.db.listMessagesChronological(ticket.id)[0]?.file_id, "photo-evidence");
        assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), true);
        harness.clearApiOverrides();
        await harness.bot.handleUpdate(privateMessage(916));
        if (ambiguous) {
          const { archiveTicketIfPossible } = await import("../src/archive.js");
          assert.equal(
            await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id),
            false
          );
          assert.equal(harness.countApiCalls("copyMessage"), 1);
          assert.equal(harness.countApiCalls("sendDocument"), 0);
          assert.equal(
            harness.db.listUnknownDeliveryReconciliations(TEST_STAFF_CHAT_ID)[0]?.inboundStage,
            "COPY_ORIGINAL"
          );
        } else {
          assert.equal(harness.countApiCalls("copyMessage"), 2);
          assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 916)?.state, "DELIVERED");
          assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 916)?.attempt, 2);
          assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
        }
      } finally {
        harness.cleanup();
      }
    });
  }

  for (const ownerOutcome of ["DELIVERED", "FAILED", "UNKNOWN_DELIVERY"] as const) {
    it(`drains all 25 waiting sources in ordered chunks when the topic owner is ${ownerOutcome}`, async () => {
      const harness = createBotHarness();
      const entered = barrier();
      const release = barrier();
      let owner: Promise<void> | undefined;
      try {
        harness.bot.api.config.use(async (previous, method, payload, signal) => {
          if (method === "createForumTopic") {
            entered.resolve();
            await release.promise;
          }
          return previous(method, payload, signal);
        });
        const ownerUpdate = privateMessage(1000, "Provisioning owner");
        if (ownerOutcome !== "DELIVERED" && ownerUpdate.message) {
          delete ownerUpdate.message.text;
          ownerUpdate.message.caption = "Provisioning owner";
          ownerUpdate.message.photo = [
            { file_id: "owner-photo", file_unique_id: "owner-unique", width: 100, height: 100 },
          ];
          harness.setApiResponseOverride("copyMessage", (call) => {
            if (call.payload.message_id !== 1000) return undefined;
            if (ownerOutcome === "UNKNOWN_DELIVERY")
              throw new HttpError("Uncertain owner copy", new Error("ECONNRESET"));
            return { ok: false, error_code: 400, description: "Bad Request: message to copy not found" };
          });
        }
        owner = harness.bot.handleUpdate(ownerUpdate);
        await entered.promise;
        const sourceIds = Array.from({ length: 25 }, (_, index) => 1001 + index);
        for (const sourceId of sourceIds) {
          const update = privateMessage(sourceId, `Queued inbound #${sourceId}`);
          if (sourceId % 2 === 1 && update.message) {
            delete update.message.text;
            update.message.caption = `Queued inbound #${sourceId}`;
            update.message.photo = [
              { file_id: `photo-${sourceId}`, file_unique_id: `unique-${sourceId}`, width: 100, height: 100 },
            ];
          }
          await harness.bot.handleUpdate(update);
          assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, sourceId)?.stage, "WAITING_FOR_TOPIC");
        }
        release.resolve();
        await owner;
        const ticketId = harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 1000)!.ticket_id;
        for (const sourceId of [1000, ...sourceIds]) {
          assert.equal(
            harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, sourceId)?.state,
            sourceId === 1000 ? ownerOutcome : "DELIVERED",
            `source ${sourceId}`
          );
          assert.equal(
            harness.db.listMessagesChronological(ticketId).filter((message) => message.source_message_id === sourceId)
              .length,
            1
          );
        }
        assert.equal(harness.countApiCalls("createForumTopic"), 1);
        assert.equal(staffTopicMessages(harness).length, 27); // Summary, initial post, 25 updates.
        assert.deepEqual(
          harness.findApiCalls("copyMessage").map((call) => call.payload.message_id),
          [...(ownerOutcome === "DELIVERED" ? [] : [1000]), ...sourceIds.filter((id) => id % 2 === 1)]
        );
        assert.deepEqual(
          staffTopicMessages(harness)
            .map((call) => String(call.payload.text).match(/Queued inbound #(\d+)/)?.[1])
            .filter(Boolean),
          sourceIds.map(String)
        );
        assert.equal(
          harness.db.listReadyTicketInboundRoutingOperationsForTicket(ticketId, TEST_STAFF_CHAT_ID).length,
          0
        );
        assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticketId), ownerOutcome !== "DELIVERED");
        const cases = harness.db.listUnknownDeliveryReconciliations(TEST_STAFF_CHAT_ID);
        assert.equal(cases.length, ownerOutcome === "DELIVERED" ? 0 : 1);
        if (ownerOutcome !== "DELIVERED") assert.equal(cases[0]?.sourceMessageId, 1000);
      } finally {
        release.resolve();
        await owner;
        harness.cleanup();
      }
    });
  }

  for (const stage of ["CREATE_TOPIC", "SEND_SUMMARY", "SEND_UPDATE"] as const) {
    it(`continues archive when in-flight ${stage} resolves after ticket closure`, async () => {
      const harness = createBotHarness();
      const entered = barrier();
      const release = barrier();
      let inFlight: Promise<void> | undefined;
      try {
        if (stage === "SEND_UPDATE") harness.seedTicket();
        const method = stage === "CREATE_TOPIC" ? "createForumTopic" : "sendMessage";
        harness.bot.api.config.use(async (previous, calledMethod, payload, signal) => {
          const operation = harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 900);
          if (calledMethod === method && operation?.stage === stage && operation.state === "PENDING") {
            entered.resolve();
            await release.promise;
          }
          return previous(calledMethod, payload, signal);
        });
        if (stage === "SEND_UPDATE")
          harness.setApiResponseOverride("sendMessage", (call) =>
            call.payload.message_thread_id ===
            harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 900)?.topic_thread_id
              ? { ok: false, error_code: 400, description: "Bad Request: message text is empty" }
              : undefined
          );
        inFlight = harness.bot.handleUpdate(privateMessage(900, "Content retained through closure"));
        await entered.promise;
        const operation = harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 900)!;
        assert.equal(operation.state, "PENDING");
        harness.db.closeTicketRecordIfOpen(operation.ticket_id, TEST_STAFF_CHAT_ID, {
          type: "STAFF",
          displayName: "Agent",
        });
        const { archiveTicketIfPossible } = await import("../src/archive.js");
        assert.equal(
          await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, operation.ticket_id),
          false
        );
        assert.equal(harness.countApiCalls("sendDocument"), 0);
        release.resolve();
        await inFlight;
        assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 900)?.state, "CANCELLED");
        assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(operation.ticket_id), false);
        assert.ok(harness.db.getTicket(operation.ticket_id)?.archived_at);
        assert.equal(harness.countApiCalls("sendDocument"), 1);
        assert.match(
          Buffer.from(harness.findApiCalls("sendDocument")[0]!.documentBytes!).toString("utf8"),
          /Content retained through closure/
        );
        await harness.bot.handleUpdate(privateMessage(900, "Content retained through closure"));
        assert.equal(harness.countApiCalls("sendDocument"), 1);
      } finally {
        release.resolve();
        await inFlight;
        harness.cleanup();
      }
    });
  }

  for (const closeBeforeCopy of [true, false]) {
    it(`settles a proven failed copy when closed ${closeBeforeCopy ? "before" : "during"} the send and archives across restart`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "closed-copy-failure-"));
      const databasePath = `file:${path.join(directory, "support.db")}`;
      let harness = createBotHarness({ databasePath });
      const entered = barrier();
      const release = barrier();
      let inFlight: Promise<void> | undefined;
      try {
        const ticket = harness.seedTicket();
        harness.db.beginTicketInboundRouting({
          ...inboundInput(901),
          sourceChatId: TEST_USER_ID,
          userTelegramId: TEST_USER_ID,
          staffChatId: TEST_STAFF_CHAT_ID,
          shouldCopyOriginal: true,
          text: "Retained document caption",
          mediaType: "document",
          filename: "report.pdf",
          fileId: "retained-file-id",
        });
        harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 901, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
        harness.db.markTicketInboundRoutingUpdateDelivered(TEST_USER_ID, 901, TEST_STAFF_CHAT_ID, 601);
        const close = () =>
          harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
        if (closeBeforeCopy) close();
        harness.bot.api.config.use(async (previous, method, payload, signal) => {
          if (method === "copyMessage") {
            entered.resolve();
            await release.promise;
          }
          return previous(method, payload, signal);
        });
        harness.setApiResponseOverride("copyMessage", () => ({
          ok: false,
          error_code: 400,
          description: "Bad Request: message to copy not found",
        }));
        harness.setApiResponseOverride("sendDocument", () => {
          const messages = harness.db.listMessagesChronological(ticket.id);
          assert.equal(messages.length, 1);
          assert.equal(messages[0]?.file_id, "retained-file-id");
          assert.equal(messages[0]?.media_type, "document");
          assert.equal(messages[0]?.filename, "report.pdf");
          assert.equal(messages[0]?.delivery_message_id, 601);
          return undefined;
        });
        inFlight = harness.bot.handleUpdate(privateMessage(901));
        await entered.promise;
        if (!closeBeforeCopy) close();
        const { archiveTicketIfPossible } = await import("../src/archive.js");
        assert.equal(await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), false);
        release.resolve();
        await inFlight;
        const operation = harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 901)!;
        assert.equal(operation.state, "CANCELLED");
        assert.equal(operation.copied_message_id, null);
        assert.equal(operation.file_id, "retained-file-id");
        assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
        assert.equal(harness.countApiCalls("sendDocument"), 1);
        assert.match(
          Buffer.from(harness.findApiCalls("sendDocument")[0]!.documentBytes!).toString("utf8"),
          /Retained document caption/
        );
        await harness.bot.handleUpdate(privateMessage(901));
        assert.equal(harness.countApiCalls("copyMessage"), 1);
        assert.equal(harness.countApiCalls("sendDocument"), 1);
        harness.cleanup();
        harness = createBotHarness({ databasePath });
        assert.equal(harness.db.markPendingTicketInboundRoutingOperationsUnknown(), 0);
        assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 901)?.state, "CANCELLED");
        await harness.bot.handleUpdate(privateMessage(901));
        assert.equal(harness.countApiCalls("copyMessage"), 0);
        assert.equal(harness.countApiCalls("sendDocument"), 0);
      } finally {
        release.resolve();
        await inFlight;
        harness.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("waits for an in-flight replacement owner after a late confirmed copy rejection", async () => {
    const harness = createBotHarness();
    const copying = barrier();
    const provisioning = barrier();
    const releaseCopy = barrier();
    const releaseTopic = barrier();
    try {
      const ticket = harness.seedTicket({ messageThreadId: 5100 });
      harness.db.beginTicketInboundRouting({
        ...inboundInput(809),
        sourceChatId: TEST_USER_ID,
        userTelegramId: TEST_USER_ID,
        staffChatId: TEST_STAFF_CHAT_ID,
        shouldCopyOriginal: true,
      });
      harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 809, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
      harness.db.markTicketInboundRoutingUpdateDelivered(TEST_USER_ID, 809, TEST_STAFF_CHAT_ID, 601);
      harness.bot.api.config.use(async (previous, method, payload, signal) => {
        if (method === "copyMessage" && "message_thread_id" in payload && payload.message_thread_id === 5100) {
          copying.resolve();
          await releaseCopy.promise;
        }
        if (method === "createForumTopic") {
          provisioning.resolve();
          await releaseTopic.promise;
        }
        return previous(method, payload, signal);
      });
      const missing = { ok: false as const, error_code: 400, description: "Bad Request: message thread not found" };
      harness.setApiResponseOverride("sendMessage", (call) =>
        call.payload.message_thread_id === 5100 ? missing : undefined
      );
      harness.setApiResponseOverride("copyMessage", (call) =>
        call.payload.message_thread_id === 5100 ? missing : undefined
      );
      const copy = harness.bot.handleUpdate(privateMessage(809));
      await copying.promise;
      const otherSource = harness.bot.handleUpdate(privateMessage(810, "Replacement owner content"));
      await provisioning.promise;
      releaseCopy.resolve();
      await copy;
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 809)?.stage, "WAITING_FOR_TOPIC");
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 809)?.delivery_message_id, 601);
      releaseTopic.resolve();
      await otherSource;
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 809)?.state, "DELIVERED");
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 810)?.state, "DELIVERED");
      assert.equal(harness.countApiCalls("createForumTopic"), 1);
      assert.equal(harness.countApiCalls("copyMessage"), 2); // One proven rejection, one delivered copy.
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 2);
      assert.equal(
        staffTopicMessages(harness).filter((call) => String(call.payload.text).includes("Please help.")).length,
        0
      );
      assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), false);
    } finally {
      releaseCopy.resolve();
      releaseTopic.resolve();
      harness.cleanup();
    }
  });

  for (const stage of ["SEND_UPDATE", "COPY_ORIGINAL"] as const) {
    it(`never rebinds an ambiguous old-topic ${stage} after replacement or closure`, async () => {
      const harness = createBotHarness();
      try {
        const ticket = harness.seedTicket({ messageThreadId: 5100 });
        harness.db.beginTicketInboundRouting({
          ...inboundInput(811),
          sourceChatId: TEST_USER_ID,
          userTelegramId: TEST_USER_ID,
          staffChatId: TEST_STAFF_CHAT_ID,
          shouldCopyOriginal: stage === "COPY_ORIGINAL",
        });
        if (stage === "COPY_ORIGINAL") {
          harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 811, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
          harness.db.markTicketInboundRoutingUpdateDelivered(TEST_USER_ID, 811, TEST_STAFF_CHAT_ID, 601);
        }
        const method = stage === "COPY_ORIGINAL" ? "copyMessage" : "sendMessage";
        harness.setApiResponseOverride(method, () => {
          harness.db.updateTicketForumTopic(ticket.id, TEST_STAFF_CHAT_ID, 5101);
          throw new HttpError("Uncertain old-topic outcome", new Error("ECONNRESET"));
        });
        await harness.bot.handleUpdate(privateMessage(811));
        harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
        await harness.bot.handleUpdate(privateMessage(811));
        const operation = harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 811)!;
        assert.equal(operation.state, "UNKNOWN_DELIVERY");
        assert.equal(operation.attempt, 1);
        assert.equal(operation.topic_thread_id, 5100);
        assert.equal(harness.countApiCalls(method), 1);
        assert.equal(harness.countApiCalls("createForumTopic"), 0);
        assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), true);
        assert.equal(harness.db.listUnknownDeliveryReconciliations(TEST_STAFF_CHAT_ID)[0]?.inboundStage, stage);
      } finally {
        harness.cleanup();
      }
    });
  }

  it("keeps an ambiguous provisioning owner exclusive for later sources", async () => {
    const harness = createBotHarness();
    try {
      harness.db.upsertUser({ telegramId: TEST_USER_ID });
      const input = {
        ...inboundInput(812),
        sourceChatId: TEST_USER_ID,
        userTelegramId: TEST_USER_ID,
        staffChatId: TEST_STAFF_CHAT_ID,
      };
      harness.db.beginTicketInboundRouting(input);
      harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 812, TEST_STAFF_CHAT_ID, "CREATE_TOPIC");
      harness.db.markPendingTicketInboundRoutingOperationsUnknown();
      await harness.bot.handleUpdate(privateMessage(813));
      assert.equal(harness.countApiCalls("createForumTopic"), 0);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 812)?.state, "UNKNOWN_DELIVERY");
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 813)?.stage, "WAITING_FOR_TOPIC");
    } finally {
      harness.cleanup();
    }
  });

  it("rebinds a not-yet-attempted required copy when another source already replaced the topic", async () => {
    const harness = createBotHarness();
    try {
      const ticket = harness.seedTicket({ messageThreadId: 5100 });
      harness.db.beginTicketInboundRouting({
        ...inboundInput(808),
        sourceChatId: TEST_USER_ID,
        userTelegramId: TEST_USER_ID,
        staffChatId: TEST_STAFF_CHAT_ID,
        shouldCopyOriginal: true,
      });
      harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 808, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
      harness.db.markTicketInboundRoutingUpdateDelivered(TEST_USER_ID, 808, TEST_STAFF_CHAT_ID, 601);
      harness.db.updateTicketForumTopic(ticket.id, TEST_STAFF_CHAT_ID, 5101);
      await harness.bot.handleUpdate(privateMessage(808));
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 808)?.state, "DELIVERED");
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 808)?.attempt, 2);
      assert.deepEqual(
        harness.findApiCalls("copyMessage").map((call) => call.payload.message_thread_id),
        [5101]
      );
      assert.equal(staffTopicMessages(harness).length, 0);
      assert.equal(harness.countApiCalls("createForumTopic"), 0);
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
    } finally {
      harness.cleanup();
    }
  });

  for (const concurrent of [false, true]) {
    it(`elects one provisioning owner for a migration-26 topicless ticket (${concurrent ? "two sources" : "one source"})`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "orphan-topicless-"));
      const databasePath = path.join(directory, "support.db");
      let harness: BotHarness | undefined;
      const release = barrier();
      try {
        const seeded = new SupportDatabase(`file:${databasePath}`);
        seeded.upsertUser({ telegramId: TEST_USER_ID, firstName: "Customer" });
        const ticket = seeded.createTicket(TEST_USER_ID, TEST_STAFF_CHAT_ID);
        seeded.close();
        const fixture = new Database(databasePath);
        fixture.exec(`DROP TABLE ticket_inbound_reconciliation_audit;
          DROP TABLE ticket_inbound_routing_operations; DELETE FROM schema_migrations WHERE id = 27;`);
        fixture.close();
        harness = createBotHarness({ databasePath: `file:${databasePath}` });
        const begun = barrier();
        const begin = harness.db.beginTicketInboundRouting.bind(harness.db);
        let started = 0;
        harness.db.beginTicketInboundRouting = (input) => {
          const result = begin(input);
          started += 1;
          if (started === (concurrent ? 2 : 1)) begun.resolve();
          return result;
        };
        harness.bot.api.config.use(async (previous, method, payload, signal) => {
          if (method === "createForumTopic") await release.promise;
          return previous(method, payload, signal);
        });
        const first = harness.bot.handleUpdate(privateMessage(805));
        const second = concurrent ? harness.bot.handleUpdate(privateMessage(806)) : Promise.resolve();
        await begun.promise;
        const operations = [805, ...(concurrent ? [806] : [])].map((id) =>
          harness!.db.getTicketInboundRoutingOperation(TEST_USER_ID, id)!
        );
        assert.equal(operations.filter((op) => op.stage === "CREATE_TOPIC").length, 1);
        assert.equal(operations.filter((op) => op.stage === "WAITING_FOR_TOPIC").length, concurrent ? 1 : 0);
        release.resolve();
        await Promise.all([first, second]);
        assert.equal(harness.countApiCalls("createForumTopic"), 1);
        assert.equal(harness.db.listTicketsForUser(TEST_USER_ID, TEST_STAFF_CHAT_ID).length, 1);
        assert.equal(harness.db.listMessagesChronological(ticket.id).length, concurrent ? 2 : 1);
        for (const operation of operations)
          assert.equal(
            harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, operation.source_message_id)?.state,
            "DELIVERED"
          );
        assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), false);
      } finally {
        release.resolve();
        harness?.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("does not create a second topic when a READY provisioning owner finds the ticket already linked", async () => {
    const harness = createBotHarness();
    try {
      harness.db.upsertUser({ telegramId: TEST_USER_ID });
      const started = harness.db.beginTicketInboundRouting({
        ...inboundInput(807),
        sourceChatId: TEST_USER_ID,
        userTelegramId: TEST_USER_ID,
        staffChatId: TEST_STAFF_CHAT_ID,
      });
      assert.equal(started.operation.stage, "CREATE_TOPIC");
      harness.db.updateTicketForumTopic(started.ticket.id, TEST_STAFF_CHAT_ID, 5101);
      await harness.bot.handleUpdate(privateMessage(807));
      assert.equal(harness.countApiCalls("createForumTopic"), 0);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 807)?.state, "DELIVERED");
      assert.equal(staffTopicMessages(harness)[0]?.payload.message_thread_id, 5101);
    } finally {
      harness.cleanup();
    }
  });

  for (const replacementExists of [true, false]) {
    it(`recovers a required copy after confirmed topic loss (${replacementExists ? "existing" : "self-provisioned"} replacement)`, async () => {
      const harness = createBotHarness();
      try {
        const ticket = harness.seedTicket({ messageThreadId: 5100 });
        harness.db.beginTicketInboundRouting({
          ...inboundInput(803),
          sourceChatId: TEST_USER_ID,
          userTelegramId: TEST_USER_ID,
          staffChatId: TEST_STAFF_CHAT_ID,
          shouldCopyOriginal: true,
          mediaType: "photo",
          fileId: "required-photo",
        });
        harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 803, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
        harness.db.markTicketInboundRoutingUpdateDelivered(TEST_USER_ID, 803, TEST_STAFF_CHAT_ID, 601);
        harness.setApiResponseOverride("copyMessage", (call) => {
          if (call.payload.message_thread_id !== 5100) return undefined;
          if (replacementExists) harness.db.updateTicketForumTopic(ticket.id, TEST_STAFF_CHAT_ID, 5101);
          return { ok: false, error_code: 400, description: "Bad Request: message thread not found" };
        });
        await harness.bot.handleUpdate(privateMessage(803));
        await harness.bot.handleUpdate(privateMessage(803));
        const operation = harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 803)!;
        assert.equal(operation.state, "DELIVERED");
        assert.equal(operation.attempt, 2);
        assert.equal(operation.delivery_message_id, 601);
        assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
        const replacement = harness.db.getTicket(ticket.id)!.message_thread_id;
        assert.notEqual(replacement, 5100);
        assert.deepEqual(
          harness.findApiCalls("copyMessage").map((call) => call.payload.message_thread_id),
          [5100, replacement]
        );
        assert.equal(harness.countApiCalls("createForumTopic"), replacementExists ? 0 : 1);
        assert.equal(
          staffTopicMessages(harness).filter((call) => String(call.payload.text).includes("Please help.")).length,
          0
        );
        harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
        const { archiveTicketIfPossible } = await import("../src/archive.js");
        assert.equal(await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), true);
      } finally {
        harness.cleanup();
      }
    });
  }

  it("cancels a closed-ticket copy only after proven topic rejection and allows archive", async () => {
    const harness = createBotHarness();
    try {
      const ticket = harness.seedTicket({ messageThreadId: 5100 });
      harness.db.beginTicketInboundRouting({
        ...inboundInput(804),
        sourceChatId: TEST_USER_ID,
        userTelegramId: TEST_USER_ID,
        staffChatId: TEST_STAFF_CHAT_ID,
        shouldCopyOriginal: true,
        mediaType: "photo",
        fileId: "archived-photo",
      });
      harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 804, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
      harness.db.markTicketInboundRoutingUpdateDelivered(TEST_USER_ID, 804, TEST_STAFF_CHAT_ID, 602);
      harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
      harness.setApiResponseOverride("copyMessage", () => ({
        ok: false,
        error_code: 400,
        description: "Bad Request: message thread not found",
      }));
      await harness.bot.handleUpdate(privateMessage(804));
      const operation = harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 804)!;
      assert.equal(operation.state, "CANCELLED");
      assert.equal(operation.file_id, "archived-photo");
      assert.equal(operation.delivery_message_id, 602);
      assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
      assert.equal(harness.countApiCalls("copyMessage"), 1);
      assert.equal(harness.countApiCalls("createForumTopic"), 1); // Support Logs only.
      assert.equal(harness.db.getTicket(ticket.id)?.message_thread_id, 5100);
      assert.equal(harness.db.markPendingTicketInboundRoutingOperationsUnknown(), 0);
    } finally {
      harness.cleanup();
    }
  });

  it("rebinds a late confirmed old-topic rejection without a second replacement or duplicate content", async () => {
    const harness = createBotHarness();
    const bothStarted = barrier();
    const releaseLateFailure = barrier();
    try {
      const ticket = harness.seedTicket({ messageThreadId: 5100 });
      let oldAttempts = 0;
      harness.bot.api.config.use(async (previous, method, payload, signal) => {
        if (method === "sendMessage" && "message_thread_id" in payload && payload.message_thread_id === 5100) {
          oldAttempts += 1;
          if (oldAttempts === 1) await bothStarted.promise;
          else {
            bothStarted.resolve();
            await releaseLateFailure.promise;
          }
        }
        return previous(method, payload, signal);
      });
      harness.setApiResponseOverride("sendMessage", (call) =>
        call.payload.message_thread_id === 5100
          ? { ok: false, error_code: 400, description: "Bad Request: message thread not found" }
          : undefined
      );
      const first = harness.bot.handleUpdate(privateMessage(801, "First source content"));
      const second = harness.bot.handleUpdate(privateMessage(802, "Late source content"));
      await bothStarted.promise;
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 802)?.state, "PENDING");
      await first;
      const replacement = harness.db.getTicket(ticket.id)!.message_thread_id;
      assert.notEqual(replacement, 5100);
      releaseLateFailure.resolve();
      await second;
      await harness.bot.handleUpdate(privateMessage(802, "Late source content"));
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 802)?.state, "DELIVERED");
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 802)?.attempt, 2);
      assert.equal(oldAttempts, 2);
      assert.equal(harness.countApiCalls("createForumTopic"), 1);
      for (const text of ["First source content", "Late source content"]) {
        assert.equal(
          staffTopicMessages(harness).filter(
            (call) => call.payload.message_thread_id === replacement && String(call.payload.text).includes(text)
          ).length,
          1
        );
      }
      assert.deepEqual(
        harness.db.listMessagesChronological(ticket.id).map((message) => message.source_message_id),
        [801, 802]
      );
      assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), false);
    } finally {
      releaseLateFailure.resolve();
      harness.cleanup();
    }
  });

  it("settles a proven failed in-flight send after closure without leaving retryable work or a fake orphan", () => {
    const harness = createBotHarness();
    try {
      const ticket = harness.seedTicket();
      harness.db.beginTicketInboundRouting({
        ...inboundInput(296),
        sourceChatId: TEST_USER_ID,
        userTelegramId: TEST_USER_ID,
        staffChatId: TEST_STAFF_CHAT_ID,
      });
      harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 296, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
      harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
      harness.db.markTicketInboundRoutingFailed(
        TEST_USER_ID,
        296,
        TEST_STAFF_CHAT_ID,
        "RATE_LIMITED",
        "Confirmed rejection"
      );
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 296)?.state, "CANCELLED");
      assert.equal(harness.db.markPendingTicketInboundRoutingOperationsUnknown(), 0);
      assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), false);
      assert.equal(harness.db.listMessagesChronological(ticket.id)[0]?.delivery_message_id, null);
    } finally {
      harness.cleanup();
    }
  });

  for (const state of ["READY", "FAILED", "PENDING", "UNKNOWN_DELIVERY", "DELIVERED"] as const) {
    it(`required original copy in ${state} prevents premature archive unless terminal`, async () => {
      const harness = createBotHarness();
      try {
        const ticket = harness.seedTicket();
        harness.db.beginTicketInboundRouting({
          ...inboundInput(294),
          sourceChatId: TEST_USER_ID,
          userTelegramId: TEST_USER_ID,
          staffChatId: TEST_STAFF_CHAT_ID,
          shouldCopyOriginal: true,
          mediaType: "photo",
          fileId: "preserved-photo",
        });
        harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 294, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
        harness.db.markTicketInboundRoutingUpdateDelivered(TEST_USER_ID, 294, TEST_STAFF_CHAT_ID, 601);
        if (state !== "READY")
          harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 294, TEST_STAFF_CHAT_ID, "COPY_ORIGINAL");
        if (state === "FAILED")
          harness.db.markTicketInboundRoutingFailed(TEST_USER_ID, 294, TEST_STAFF_CHAT_ID, "RATE_LIMITED", "Rejected");
        if (state === "UNKNOWN_DELIVERY")
          harness.db.markTicketInboundRoutingUnknown(TEST_USER_ID, 294, TEST_STAFF_CHAT_ID, "Uncertain copy");
        if (state === "DELIVERED")
          harness.db.markTicketInboundRoutingCopyDelivered(TEST_USER_ID, 294, TEST_STAFF_CHAT_ID, 602);
        harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
        assert.equal(
          harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 294)?.state,
          state === "FAILED" ? "CANCELLED" : state
        );
        assert.equal(harness.db.listMessagesChronological(ticket.id)[0]?.file_id, "preserved-photo");
        const { archiveTicketIfPossible } = await import("../src/archive.js");
        assert.equal(
          await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id),
          state === "DELIVERED" || state === "FAILED"
        );
        if (state !== "DELIVERED" && state !== "FAILED") {
          assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 294)?.state, state);
          assert.equal(harness.db.listMessagesChronological(ticket.id)[0]?.file_id, "preserved-photo");
        }
      } finally {
        harness.cleanup();
      }
    });
  }

  it("permits only a new safe copy claim on a closed ticket whose formatted content was already delivered", async () => {
    const harness = createBotHarness();
    try {
      const ticket = harness.seedTicket();
      harness.db.beginTicketInboundRouting({
        ...inboundInput(295),
        sourceChatId: TEST_USER_ID,
        userTelegramId: TEST_USER_ID,
        staffChatId: TEST_STAFF_CHAT_ID,
        shouldCopyOriginal: true,
      });
      harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 295, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
      harness.db.markTicketInboundRoutingUpdateDelivered(TEST_USER_ID, 295, TEST_STAFF_CHAT_ID, 603);
      harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
      await harness.bot.handleUpdate(privateMessage(295));
      assert.equal(harness.countApiCalls("copyMessage"), 1);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 295)?.state, "DELIVERED");
      assert.equal(harness.db.getTicket(ticket.id)?.status, "CLOSED");
      assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
    } finally {
      harness.cleanup();
    }
  });

  for (const media of [true, false]) {
    for (const boundary of [
      "before-formatted",
      "before-copy",
      "copy-in-flight",
      "copy-persist-failed",
      "copy-ambiguous",
    ] as const) {
      it(`file-backed ${media ? "media" : "long text"} restart at ${boundary} retains original content without duplicate effects`, async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "inbound-copy-crash-"));
        const databasePath = `file:${path.join(directory, "support.db")}`;
        let harness: BotHarness | undefined;
        try {
          harness = createBotHarness({ databasePath });
          const ticket = harness.seedTicket();
          const text = media ? "Photo caption" : "Full long customer content ".repeat(200);
          const update = privateMessage(291, text);
          if (media && update.message) {
            delete update.message.text;
            update.message.caption = text;
            update.message.photo = [
              { file_id: "photo-original", file_unique_id: "photo-unique", width: 100, height: 100 },
            ];
          }
          if (boundary === "before-formatted") {
            harness.db.beginTicketInboundRouting({
              ...inboundInput(291),
              sourceChatId: TEST_USER_ID,
              userTelegramId: TEST_USER_ID,
              staffChatId: TEST_STAFF_CHAT_ID,
              text,
              mediaType: media ? "photo" : null,
              fileId: media ? "photo-original" : null,
              shouldCopyOriginal: true,
            });
          } else {
            if (boundary === "before-copy" || boundary === "copy-in-flight") {
              const finalize = harness.db.markTicketInboundRoutingUpdateDelivered.bind(harness.db);
              harness.db.markTicketInboundRoutingUpdateDelivered = (...args) => {
                finalize(...args);
                throw new Error("Injected interruption after formatted stage commit");
              };
            } else if (boundary === "copy-persist-failed")
              harness.db.markTicketInboundRoutingCopyDelivered = () => false;
            else
              harness.setApiResponseOverride("copyMessage", () => {
                throw new HttpError("uncertain", new Error("ECONNRESET"));
              });
            await harness.bot.handleUpdate(update);
            if (boundary === "copy-in-flight")
              assert.equal(
                harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 291, TEST_STAFF_CHAT_ID, "COPY_ORIGINAL")
                  ?.claimed,
                true
              );
          }
          const sentBefore = staffTopicMessages(harness).length;
          const copiedBefore = harness.countApiCalls("copyMessage");
          harness.cleanup();
          harness = createBotHarness({ databasePath });
          harness.db.markPendingTicketInboundRoutingOperationsUnknown();
          const ambiguous =
            boundary === "copy-in-flight" || boundary === "copy-persist-failed" || boundary === "copy-ambiguous";
          await harness.bot.handleUpdate(update);
          await harness.bot.handleUpdate(update);
          assert.equal(sentBefore + staffTopicMessages(harness).length, 1);
          assert.equal(copiedBefore + harness.countApiCalls("copyMessage"), boundary === "copy-in-flight" ? 0 : 1);
          const operation = harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 291)!;
          assert.equal(operation.state, ambiguous ? "UNKNOWN_DELIVERY" : "DELIVERED");
          assert.equal(operation.text, text);
          if (media) assert.equal(operation.file_id, "photo-original");
          assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
          if (ambiguous) {
            const record = harness.db.listUnknownDeliveryReconciliations(TEST_STAFF_CHAT_ID)[0]!;
            assert.equal(record.inboundStage, "COPY_ORIGINAL");
            assert.equal(
              harness.db.reconcileUnknownDelivery({
                staffChatId: TEST_STAFF_CHAT_ID,
                caseToken: record.caseToken,
                action: "CONFIRMED_DELIVERED",
                telegramMessageId: 9123,
                reconciledBy: 1,
              }).outcome,
              "APPLIED"
            );
            await harness.bot.handleUpdate(update);
            assert.equal(harness.countApiCalls("copyMessage"), 0);
          }
          assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), false);
          assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 291)?.state, "DELIVERED");
        } finally {
          harness?.cleanup();
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  }

  it("does not cancel a genuinely in-flight formatted send when ticket closure races with it", async () => {
    const harness = createBotHarness();
    try {
      const ticket = harness.seedTicket();
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      harness.bot.api.config.use(async (previous, method, payload, signal) => {
        if (
          method === "sendMessage" &&
          "chat_id" in payload &&
          payload.chat_id === TEST_STAFF_CHAT_ID &&
          "message_thread_id" in payload &&
          payload.message_thread_id === ticket.message_thread_id
        ) {
          enter();
          await barrier;
        }
        return previous(method, payload, signal);
      });
      const inFlight = harness.bot.handleUpdate(privateMessage(292, "Pending while closed"));
      await entered;
      try {
        assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 292)?.state, "PENDING");
        harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
        assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 292)?.state, "PENDING");
        assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), true);
        const { archiveTicketIfPossible } = await import("../src/archive.js");
        assert.equal(await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), false);
      } finally {
        release();
      }
      await inFlight;
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 292)?.state, "DELIVERED");
      assert.equal(harness.db.getTicket(ticket.id)?.status, "CLOSED");
      assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
    } finally {
      harness.cleanup();
    }
  });

  for (const state of ["READY", "FAILED", "PENDING", "UNKNOWN_DELIVERY", "DELIVERED"] as const) {
    it(`archive respects ${state} routing and its explicit close outcome across reopen`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "inbound-close-"));
      const databasePath = `file:${path.join(directory, "support.db")}`;
      let harness: BotHarness | undefined;
      try {
        harness = createBotHarness({ databasePath });
        const ticket = harness.seedTicket();
        harness.db.beginTicketInboundRouting({
          ...inboundInput(293),
          sourceChatId: TEST_USER_ID,
          userTelegramId: TEST_USER_ID,
          staffChatId: TEST_STAFF_CHAT_ID,
        });
        if (state !== "READY")
          harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 293, TEST_STAFF_CHAT_ID, "SEND_UPDATE");
        if (state === "FAILED")
          harness.db.markTicketInboundRoutingFailed(TEST_USER_ID, 293, TEST_STAFF_CHAT_ID, "RATE_LIMITED", "Rejected");
        if (state === "UNKNOWN_DELIVERY")
          harness.db.markTicketInboundRoutingUnknown(TEST_USER_ID, 293, TEST_STAFF_CHAT_ID, "Uncertain");
        if (state === "DELIVERED")
          harness.db.markTicketInboundRoutingUpdateDelivered(TEST_USER_ID, 293, TEST_STAFF_CHAT_ID, 500);
        assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), state !== "DELIVERED");
        harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
        const terminal = state === "READY" || state === "FAILED" || state === "DELIVERED";
        assert.equal(
          harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 293)?.state,
          state === "READY" || state === "FAILED" ? "CANCELLED" : state
        );
        harness.cleanup();
        harness = createBotHarness({ databasePath });
        assert.equal(harness.db.markPendingTicketInboundRoutingOperationsUnknown(), state === "PENDING" ? 1 : 0);
        assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), !terminal);
        const { archiveTicketIfPossible } = await import("../src/archive.js");
        assert.equal(
          await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id),
          terminal
        );
        assert.equal(harness.countApiCalls("sendDocument"), terminal ? 1 : 0);
        if (terminal) {
          const bytes = harness.findApiCalls("sendDocument")[0]?.documentBytes;
          assert.ok(bytes);
          assert.match(Buffer.from(bytes).toString("utf8"), /Please help/);
        }
      } finally {
        harness?.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("cancels a wrong-workspace READY claim without manufacturing orphan ambiguity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "inbound-moved-"));
    const databasePath = `file:${path.join(directory, "support.db")}`;
    let db: SupportDatabase | undefined;
    try {
      db = new SupportDatabase(databasePath);
      db.upsertUser({ telegramId: USER_ID });
      const started = db.beginTicketInboundRouting(inboundInput());
      db.updateTicketForumTopic(started.ticket.id, STAFF_CHAT_ID - 1, 999);
      const claim = db.claimTicketInboundRoutingOperation(USER_ID, 1, STAFF_CHAT_ID, "CREATE_TOPIC");
      assert.equal(claim?.claimed, false);
      assert.equal(claim?.operation.state, "CANCELLED");
      assert.equal(db.listMessagesChronological(started.ticket.id).length, 0);
      db.close();
      db = new SupportDatabase(databasePath);
      assert.equal(db.markPendingTicketInboundRoutingOperationsUnknown(), 0);
      assert.equal(db.getTicketInboundRoutingOperation(USER_ID, 1)?.state, "CANCELLED");
    } finally {
      db?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const media of [true, false]) {
    it(`keeps required ${media ? "media" : "long text"} copy ambiguous and never repeats it on source replay`, async () => {
      const harness = createBotHarness();
      try {
        const ticket = harness.seedTicket();
        const update = privateMessage(290, media ? "Photo caption" : "Long customer text ".repeat(240));
        if (media && "message" in update && update.message) {
          delete update.message.text;
          update.message.photo = [
            { file_id: "photo-original", file_unique_id: "photo-unique", width: 100, height: 100 },
          ];
        }
        harness.setApiResponseOverride("copyMessage", () => {
          assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 290)?.stage, "COPY_ORIGINAL");
          assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 290)?.state, "PENDING");
          throw new HttpError("socket closed", new Error("ECONNRESET"));
        });
        await harness.bot.handleUpdate(update);
        await harness.bot.handleUpdate(update);
        assert.equal(staffTopicMessages(harness).length, 1);
        assert.equal(harness.countApiCalls("copyMessage"), 1);
        assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 290)?.state, "UNKNOWN_DELIVERY");
        assert.equal(harness.db.hasUnresolvedTicketInboundRoutingOperations(ticket.id), true);
        assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
      } finally {
        harness.cleanup();
      }
    });
  }

  it("does not claim unsent routing work after the ticket has closed", () => {
    const db = new SupportDatabase(":memory:");
    try {
      db.upsertUser({ telegramId: USER_ID });
      const started = db.beginTicketInboundRouting(inboundInput());
      db.closeTicketRecordIfOpen(started.ticket.id, STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" });
      const claim = db.claimTicketInboundRoutingOperation(USER_ID, 1, STAFF_CHAT_ID, "CREATE_TOPIC");
      assert.equal(claim?.claimed, false);
      assert.equal(claim?.operation.state, "CANCELLED");
      assert.equal(db.markPendingTicketInboundRoutingOperationsUnknown(), 0);
      assert.equal(db.hasUnresolvedTicketInboundRoutingOperations(started.ticket.id), false);
    } finally {
      db.close();
    }
  });

  it("persists a fresh-ticket intent before topic creation and classifies an orphaned claim as unknown after reopen", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-inbound-routing-"));
    const databasePath = path.join(directory, "support.db");
    let beforeRestart: SupportDatabase | undefined;
    let reopened: SupportDatabase | undefined;

    try {
      beforeRestart = new SupportDatabase(`file:${databasePath}`);
      beforeRestart.upsertUser({ telegramId: USER_ID, username: "customer", firstName: "Customer" });

      const started = beforeRestart.beginTicketInboundRouting(inboundInput());
      assert.equal(started.created, true);
      assert.equal(started.operation.kind, "FRESH_TICKET");
      assert.equal(started.operation.stage, "CREATE_TOPIC");
      assert.equal(started.operation.state, "READY");
      const claimedBeforeRestart = beforeRestart.claimTicketInboundRoutingOperation(
        USER_ID,
        1,
        STAFF_CHAT_ID,
        "CREATE_TOPIC"
      );
      assert.ok(claimedBeforeRestart);
      assert.equal(claimedBeforeRestart.claimed, true);
      beforeRestart.close();
      beforeRestart = undefined;

      reopened = new SupportDatabase(`file:${databasePath}`);
      assert.equal(reopened.markPendingTicketInboundRoutingOperationsUnknown(), 1);
      const operation = reopened.getTicketInboundRoutingOperation(USER_ID, 1);
      assert.equal(operation?.state, "UNKNOWN_DELIVERY");
      const rejectedAfterRestart = reopened.claimTicketInboundRoutingOperation(
        USER_ID,
        1,
        STAFF_CHAT_ID,
        "CREATE_TOPIC"
      );
      assert.ok(rejectedAfterRestart);
      assert.equal(rejectedAfterRestart.claimed, false);
    } finally {
      beforeRestart?.close();
      reopened?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses one durable source operation for a fresh ticket replay", async () => {
    const harness = createBotHarness();
    try {
      const update = privateMessage(21, "Fresh ticket replay");

      await harness.bot.handleUpdate(update);
      await harness.bot.handleUpdate(update);

      const tickets = harness.db.listTicketsForUser(TEST_USER_ID, TEST_STAFF_CHAT_ID);
      assert.equal(tickets.length, 1);
      assert.equal(harness.countApiCalls("createForumTopic"), 1);
      assert.equal(staffTopicMessages(harness).length, 2);
      assert.equal(harness.db.listMessagesChronological(tickets[0]!.id).length, 1);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 21)?.state, "DELIVERED");
    } finally {
      harness.cleanup();
    }
  });

  it("keeps concurrent fresh source updates on one active ticket and one topic", async () => {
    const harness = createBotHarness();
    try {
      await Promise.all([
        harness.bot.handleUpdate(privateMessage(211, "First concurrent request")),
        harness.bot.handleUpdate(privateMessage(212, "Second concurrent request")),
      ]);

      const tickets = harness.db.listTicketsForUser(TEST_USER_ID, TEST_STAFF_CHAT_ID);
      assert.equal(tickets.length, 1);
      assert.equal(harness.countApiCalls("createForumTopic"), 1);
      assert.equal(harness.db.listMessagesChronological(tickets[0]!.id).length, 2);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 211)?.state, "DELIVERED");
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 212)?.state, "DELIVERED");
    } finally {
      harness.cleanup();
    }
  });

  it("does not duplicate an existing-ticket staff update when Telegram redelivers the source message", async () => {
    const harness = createBotHarness();
    try {
      const ticket = harness.seedTicket();
      const update = privateMessage(22, "Existing ticket replay");

      await harness.bot.handleUpdate(update);
      await harness.bot.handleUpdate(update);

      assert.equal(staffTopicMessages(harness).length, 1);
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 22)?.state, "DELIVERED");
    } finally {
      harness.cleanup();
    }
  });

  it("keeps an existing-ticket update routable when a new-ticket acknowledgement setting is invalid", async () => {
    const harness = createBotHarness();
    try {
      const ticket = harness.seedTicket();
      harness.db.setSetting("support_expected_response_time", "x".repeat(80));
      harness.db.setSetting("support_ticket_received_template", "{{response_time}}".repeat(52));

      await harness.bot.handleUpdate(privateMessage(221, "Existing ticket remains routable"));

      assert.equal(staffTopicMessages(harness).length, 1);
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 221)?.state, "DELIVERED");
    } finally {
      harness.cleanup();
    }
  });

  it("persists the existing-ticket claim before the staff-topic send", async () => {
    const harness = createBotHarness();
    try {
      harness.seedTicket();
      harness.setApiResponseOverride("sendMessage", (call, defaultResponse) => {
        if (call.payload.chat_id === TEST_STAFF_CHAT_ID) {
          assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 23)?.state, "PENDING");
        }
        return defaultResponse;
      });

      await harness.bot.handleUpdate(privateMessage(23, "Intent before staff routing"));

      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 23)?.state, "DELIVERED");
    } finally {
      harness.cleanup();
    }
  });

  it("does not resend an existing-ticket update after Telegram succeeds but local finalization fails", async () => {
    const harness = createBotHarness();
    try {
      const ticket = harness.seedTicket();
      const original = harness.db.markTicketInboundRoutingUpdateDelivered.bind(harness.db);
      harness.db.markTicketInboundRoutingUpdateDelivered = () => false;

      const update = privateMessage(231, "Persisted after remote success");
      await harness.bot.handleUpdate(update);

      harness.db.markTicketInboundRoutingUpdateDelivered = original;
      assert.equal(staffTopicMessages(harness).length, 1);
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 231)?.state, "UNKNOWN_DELIVERY");

      await harness.bot.handleUpdate(update);
      assert.equal(staffTopicMessages(harness).length, 1);
    } finally {
      harness.cleanup();
    }
  });

  it("records an ambiguous existing-ticket staff send as unknown without replay", async () => {
    const harness = createBotHarness();
    try {
      const ticket = harness.seedTicket();
      harness.setApiResponseOverride("sendMessage", (call, defaultResponse) => {
        if (call.payload.chat_id === TEST_STAFF_CHAT_ID) {
          throw new HttpError("socket closed", Object.assign(new Error("socket closed"), { code: "ECONNRESET" }));
        }
        return defaultResponse;
      });

      const update = privateMessage(232, "Ambiguous staff routing");
      await harness.bot.handleUpdate(update);

      assert.equal(staffTopicMessages(harness).length, 1);
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 232)?.state, "UNKNOWN_DELIVERY");

      await harness.bot.handleUpdate(update);
      assert.equal(staffTopicMessages(harness).length, 1);
    } finally {
      harness.cleanup();
    }
  });

  it("replaces a confirmed unavailable ticket topic without retrying the old topic send", async () => {
    const harness = createBotHarness();
    try {
      const ticket = harness.seedTicket({ messageThreadId: 5100 });
      let failedOldTopic = false;
      harness.setApiResponseOverride("sendMessage", (call, defaultResponse) => {
        if (!failedOldTopic && call.payload.message_thread_id === 5100) {
          failedOldTopic = true;
          return { ok: false, error_code: 400, description: "Bad Request: message thread not found" };
        }
        return defaultResponse;
      });

      await harness.bot.handleUpdate(privateMessage(24, "Replace unavailable topic"));

      assert.equal(failedOldTopic, true);
      assert.equal(staffTopicMessages(harness).filter((call) => call.payload.message_thread_id === 5100).length, 1);
      assert.equal(harness.countApiCalls("createForumTopic"), 1);
      assert.notEqual(harness.db.getTicket(ticket.id)?.message_thread_id, 5100);
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
      assert.equal(harness.db.getTicketInboundRoutingOperation(TEST_USER_ID, 24)?.state, "DELIVERED");
    } finally {
      harness.cleanup();
    }
  });

  it("does not let a late old-topic failure reset a replacement topic", () => {
    const harness = createBotHarness();
    try {
      harness.db.upsertUser({ telegramId: USER_ID, username: "customer", firstName: "Customer" });
      const ticket = harness.seedTicket({
        user: { id: USER_ID, username: "customer", firstName: "Customer" },
        staffChatId: STAFF_CHAT_ID,
        messageThreadId: 5100,
      });
      const first = harness.db.beginTicketInboundRouting(inboundInput(241));
      const second = harness.db.beginTicketInboundRouting(inboundInput(242));
      assert.equal(first.operation.stage, "SEND_UPDATE");
      assert.equal(second.operation.stage, "SEND_UPDATE");
      assert.equal(first.operation.topic_thread_id, 5100);
      assert.equal(second.operation.topic_thread_id, 5100);
      assert.equal(
        harness.db.claimTicketInboundRoutingOperation(USER_ID, 241, STAFF_CHAT_ID, "SEND_UPDATE")?.claimed,
        true
      );
      assert.equal(
        harness.db.claimTicketInboundRoutingOperation(USER_ID, 242, STAFF_CHAT_ID, "SEND_UPDATE")?.claimed,
        true
      );

      assert.ok(harness.db.restartTicketInboundRoutingAfterUnavailableTopic(USER_ID, 241, STAFF_CHAT_ID));
      assert.equal(
        harness.db.claimTicketInboundRoutingOperation(USER_ID, 241, STAFF_CHAT_ID, "CREATE_TOPIC")?.claimed,
        true
      );
      assert.equal(harness.db.markTicketInboundRoutingTopicCreated(USER_ID, 241, STAFF_CHAT_ID, 5101), true);

      const rebound = harness.db.restartTicketInboundRoutingAfterUnavailableTopic(USER_ID, 242, STAFF_CHAT_ID)!;
      assert.equal(rebound.stage, "SEND_UPDATE");
      assert.equal(rebound.state, "READY");
      assert.equal(rebound.attempt, 2);
      assert.equal(rebound.topic_thread_id, 5101);
      assert.equal(harness.db.getTicket(ticket.id)?.message_thread_id, 5101);
    } finally {
      harness.cleanup();
    }
  });

  it("does not replay an orphaned existing-ticket staff update after restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-inbound-existing-restart-"));
    const databasePath = path.join(directory, "support.db");
    let beforeRestart: SupportDatabase | undefined;
    let afterRestart: SupportDatabase | undefined;
    let harness: BotHarness | undefined;

    try {
      beforeRestart = new SupportDatabase(`file:${databasePath}`);
      beforeRestart.upsertUser({ telegramId: USER_ID, username: "customer", firstName: "Customer" });
      const ticket = beforeRestart.createTicket(USER_ID, STAFF_CHAT_ID);
      beforeRestart.updateTicketForumTopic(ticket.id, STAFF_CHAT_ID, 5001);
      const started = beforeRestart.beginTicketInboundRouting(inboundInput(25));
      assert.equal(started.operation.kind, "EXISTING_TICKET");
      const claimedBeforeRestart = beforeRestart.claimTicketInboundRoutingOperation(
        USER_ID,
        25,
        STAFF_CHAT_ID,
        "SEND_UPDATE"
      );
      assert.ok(claimedBeforeRestart);
      assert.equal(claimedBeforeRestart.claimed, true);
      beforeRestart.close();
      beforeRestart = undefined;

      afterRestart = new SupportDatabase(`file:${databasePath}`);
      assert.equal(afterRestart.markPendingTicketInboundRoutingOperationsUnknown(), 1);
      afterRestart.close();
      afterRestart = undefined;

      harness = createBotHarness({ databasePath: `file:${databasePath}` });
      await harness.bot.handleUpdate(privateMessage(25, "Please help.", USER_ID));

      assert.equal(staffTopicMessages(harness).length, 0);
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
      assert.equal(harness.db.getTicketInboundRoutingOperation(USER_ID, 25)?.state, "UNKNOWN_DELIVERY");
    } finally {
      beforeRestart?.close();
      afterRestart?.close();
      harness?.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks a closed-ticket archive while a staff-topic inbound send is unresolved", async () => {
    const harness = createBotHarness();
    try {
      const { archiveTicketIfPossible } = await import("../src/archive.js");
      const ticket = harness.seedTicket();
      const started = harness.db.beginTicketInboundRouting({
        ...inboundInput(251),
        sourceChatId: TEST_USER_ID,
        staffChatId: TEST_STAFF_CHAT_ID,
        userTelegramId: TEST_USER_ID,
      });
      assert.equal(started.operation.stage, "SEND_UPDATE");
      assert.equal(
        harness.db.claimTicketInboundRoutingOperation(TEST_USER_ID, 251, TEST_STAFF_CHAT_ID, "SEND_UPDATE")?.claimed,
        true
      );
      assert.equal(
        harness.db.closeTicketRecordIfOpen(ticket.id, TEST_STAFF_CHAT_ID, { type: "STAFF", displayName: "Agent" })
          .outcome,
        "APPLIED"
      );

      assert.equal(await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), false);
      assert.equal(harness.countApiCalls("sendDocument"), 0);
    } finally {
      harness.cleanup();
    }
  });

  it("upgrades a real file-backed schema from migration 26 without changing historical ticket data", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-inbound-migration-"));
    const databasePath = path.join(directory, "support.db");
    try {
      const seeded = new SupportDatabase(`file:${databasePath}`);
      seeded.upsertUser({ telegramId: USER_ID, username: "customer", firstName: "Customer" });
      const ticket = seeded.createTicket(USER_ID, STAFF_CHAT_ID);
      seeded.updateTicketForumTopic(ticket.id, STAFF_CHAT_ID, 5002);
      seeded.addMessage({
        ticketId: ticket.id,
        direction: "USER_TO_STAFF",
        sourceChatId: USER_ID,
        sourceMessageId: 1,
        text: "Historical ticket message",
      });
      seeded.closeTicketRecord(ticket.id, { type: "STAFF", displayName: "Agent" });
      seeded.close();

      const fixture = new Database(databasePath);
      try {
        fixture.exec(`
          DROP TABLE IF EXISTS ticket_inbound_reconciliation_audit;
          DROP TABLE IF EXISTS ticket_inbound_routing_operations;
          DELETE FROM schema_migrations WHERE id = 27;
        `);
      } finally {
        fixture.close();
      }

      const migrated = new SupportDatabase(`file:${databasePath}`);
      migrated.close();
      const reopened = new SupportDatabase(`file:${databasePath}`);
      reopened.close();

      const inspected = new Database(databasePath, { readonly: true });
      try {
        assert.deepEqual(
          inspected.prepare("SELECT COUNT(*) AS count, MAX(id) AS latest FROM schema_migrations").get(),
          { count: 27, latest: 27 }
        );
        assert.equal(
          (
            inspected.prepare("SELECT COUNT(*) AS count FROM ticket_inbound_reconciliation_audit").get() as {
              count: number;
            }
          ).count,
          0
        );
        const fresh = new SupportDatabase(":memory:");
        try {
          fresh.upsertUser({ telegramId: USER_ID });
          assert.equal(fresh.beginTicketInboundRouting(inboundInput()).operation.attempt, 1);
        } finally {
          fresh.close();
        }
        assert.equal(
          (
            inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 27").get() as {
              count: number;
            }
          ).count,
          1
        );
        assert.equal(
          (
            inspected.prepare("SELECT COUNT(*) AS count FROM ticket_inbound_routing_operations").get() as {
              count: number;
            }
          ).count,
          0
        );
        const historical = inspected
          .prepare("SELECT status, message_thread_id, closed_at FROM tickets WHERE id = ?")
          .get(ticket.id) as { status: string; message_thread_id: number; closed_at: string | null };
        assert.equal(historical.status, "CLOSED");
        assert.equal(historical.message_thread_id, 5002);
        assert.ok(historical.closed_at);
        assert.equal(
          (inspected.prepare("SELECT text FROM messages WHERE ticket_id = ?").get(ticket.id) as { text: string }).text,
          "Historical ticket message"
        );
        assert.equal((inspected.pragma("foreign_key_check") as unknown[]).length, 0);
        assert.equal(
          (inspected.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]?.integrity_check,
          "ok"
        );
      } finally {
        inspected.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
