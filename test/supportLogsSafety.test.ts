import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { TEST_STAFF_CHAT_ID, createBotHarness, type BotHarness, type RecordedApiCall } from "./helpers/botHarness.js";

const { archiveClosedTicketsPendingUpload, archiveTicketIfPossible, getSupportLogsTopicInfo } =
  await import("../src/archive.js");
const { StartupRecoveryBudget } = await import("../src/startup.js");
const SUPPORT_LOGS_SETTING_KEY = `support_logs_message_thread_id:${TEST_STAFF_CHAT_ID}`;
const TICKET_TOPIC_REJECTION = "This topic belongs to a support ticket and cannot be used as Support Logs.";

const harnesses: BotHarness[] = [];

afterEach(() => {
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

function buildSetLogsCommand(messageThreadId: number): Update {
  return {
    update_id: 1,
    message: {
      message_id: 7001,
      date: 1,
      from: { id: 42, is_bot: false, first_name: "Test Staff", username: "test_staff" },
      chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Test Staff Chat" },
      message_thread_id: messageThreadId,
      text: "/setlogs",
      entities: [{ offset: 0, length: 8, type: "bot_command" }],
    },
  };
}

function staffTopicMessages(harness: BotHarness, messageThreadId: number): RecordedApiCall[] {
  return harness
    .findApiCalls("sendMessage")
    .filter(
      (call) => call.payload.chat_id === TEST_STAFF_CHAT_ID && call.payload.message_thread_id === messageThreadId
    );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  return {
    promise: new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve: () => resolve?.(),
  };
}

function archiveApi(
  handlers: {
    sendMessage?: () => Promise<{ message_id: number }>;
    sendDocument?: () => Promise<{ message_id: number }>;
    createForumTopic?: () => Promise<{ message_thread_id: number }>;
    reopenForumTopic?: () => Promise<true>;
  } = {}
) {
  return {
    sendChatAction: async () => true,
    sendMessage: handlers.sendMessage ?? (async () => ({ message_id: 9001 })),
    sendDocument: handlers.sendDocument ?? (async () => ({ message_id: 9002 })),
    createForumTopic: handlers.createForumTopic ?? (async () => ({ message_thread_id: 8001 })),
    reopenForumTopic: handlers.reopenForumTopic ?? (async () => true),
    deleteForumTopic: async () => true,
  } as unknown as BotHarness["bot"]["api"];
}

function seedClosedTicketForArchive(harness: BotHarness) {
  const ticket = harness.seedTicket({ messageThreadId: 5000 });
  harness.db.setSetting(SUPPORT_LOGS_SETTING_KEY, "8000");
  harness.db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", text: "Archive me" });
  harness.db.closeTicketRecord(ticket.id, { type: "STAFF", displayName: "@test_staff", username: "test_staff" });
  return ticket;
}

function grammyFailure(method: string, description: string, errorCode = 400): GrammyError {
  return new GrammyError(method, { ok: false, error_code: errorCode, description }, method, {});
}

describe("Support Logs topic safety", () => {
  it("rejects /setlogs in a ticket topic without changing the existing setting", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ messageThreadId: 5000 });
    harness.db.setSetting(SUPPORT_LOGS_SETTING_KEY, "8000");

    await harness.bot.handleUpdate(buildSetLogsCommand(ticket.message_thread_id ?? 0));

    assert.equal(harness.db.getSetting(SUPPORT_LOGS_SETTING_KEY), "8000");
    assert.equal(
      staffTopicMessages(harness, ticket.message_thread_id ?? 0).some(
        (call) => call.payload.text === TICKET_TOPIC_REJECTION
      ),
      true
    );
  });

  it("allows /setlogs in a normal non-ticket topic", async () => {
    const harness = createHarness();
    const logsThreadId = 8000;

    await harness.bot.handleUpdate(buildSetLogsCommand(logsThreadId));

    assert.equal(harness.db.getSetting(SUPPORT_LOGS_SETTING_KEY), String(logsThreadId));
    assert.equal(
      staffTopicMessages(harness, logsThreadId).some(
        (call) => call.payload.text === "This topic is now used as Support Logs."
      ),
      true
    );
  });

  it("replaces a stored Support Logs override that points to a ticket topic", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ messageThreadId: 5000 });
    harness.db.setSetting(SUPPORT_LOGS_SETTING_KEY, String(ticket.message_thread_id));

    const topic = await getSupportLogsTopicInfo(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID);

    assert.equal(topic.state, "created");
    assert.equal(topic.previousThreadId, ticket.message_thread_id);
    assert.notEqual(topic.threadId, ticket.message_thread_id);
    assert.equal(harness.db.getSetting(SUPPORT_LOGS_SETTING_KEY), String(topic.threadId));
    assert.equal(harness.countApiCalls("createForumTopic"), 1);
    assert.equal(
      harness
        .findApiCalls("sendChatAction")
        .some((call) => call.payload.message_thread_id === ticket.message_thread_id),
      false
    );
  });

  it("archives to a replacement Support Logs topic instead of the ticket topic", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ messageThreadId: 5000 });
    harness.db.setSetting(SUPPORT_LOGS_SETTING_KEY, String(ticket.message_thread_id));
    harness.db.addMessage({
      ticketId: ticket.id,
      direction: "USER_TO_STAFF",
      text: "Please help with my account.",
      senderType: "USER",
      senderDisplayName: "@test_customer",
      senderUsername: "test_customer",
    });
    harness.db.closeTicketRecord(ticket.id, {
      type: "STAFF",
      displayName: "@test_staff",
      username: "test_staff",
    });

    const archived = await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id);
    const archiveCalls = [...harness.findApiCalls("sendMessage"), ...harness.findApiCalls("sendDocument")].filter(
      (call) => call.payload.chat_id === TEST_STAFF_CHAT_ID
    );

    assert.equal(archived, true);
    assert.equal(archiveCalls.length, 2);
    assert.equal(
      archiveCalls.some((call) => call.payload.message_thread_id === ticket.message_thread_id),
      false
    );
    assert.equal(harness.countApiCalls("createForumTopic"), 1);
    assert.notEqual(harness.db.getSetting(SUPPORT_LOGS_SETTING_KEY), String(ticket.message_thread_id));
  });

  it("bounds startup archive recovery without losing later durable archive work", async () => {
    const harness = createHarness();
    const first = harness.seedTicket({ messageThreadId: 5000 });
    const second = harness.seedTicket({
      messageThreadId: 5001,
      user: { id: 124, username: "second_customer", firstName: "Second Customer" },
    });
    for (const ticket of [first, second]) {
      harness.db.addMessage({
        ticketId: ticket.id,
        direction: "USER_TO_STAFF",
        text: "Please help with my account.",
        senderType: "USER",
        senderDisplayName: "@test_customer",
        senderUsername: "test_customer",
      });
      harness.db.closeTicketRecord(ticket.id, {
        type: "STAFF",
        displayName: "@test_staff",
        username: "test_staff",
      });
    }

    const result = await archiveClosedTicketsPendingUpload(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, {
      budget: new StartupRecoveryBudget({ maxItems: 1 }),
    });

    assert.deepEqual(result, { processed: 1, hasMore: true });
    assert.ok(harness.db.getTicket(first.id)?.archived_at);
    assert.equal(harness.db.getTicket(second.id)?.archived_at, null);

    const resumed = await archiveClosedTicketsPendingUpload(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, {
      budget: new StartupRecoveryBudget({ maxItems: 1 }),
    });
    assert.deepEqual(resumed, { processed: 1, hasMore: false });
    assert.ok(harness.db.getTicket(second.id)?.archived_at);
  });

  it("leaves a transiently failed final archive candidate durable without scheduling another attempt", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ messageThreadId: 5000 });
    harness.db.addMessage({
      ticketId: ticket.id,
      direction: "USER_TO_STAFF",
      text: "Please help with my account.",
      senderType: "USER",
      senderDisplayName: "@test_customer",
      senderUsername: "test_customer",
    });
    harness.db.closeTicketRecord(ticket.id, {
      type: "STAFF",
      displayName: "@test_staff",
      username: "test_staff",
    });
    harness.failNextApiCall("sendDocument");

    const failed = await archiveClosedTicketsPendingUpload(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, {
      budget: new StartupRecoveryBudget({ maxItems: 1 }),
    });

    assert.deepEqual(failed, { processed: 1, hasMore: true });
    assert.equal(harness.db.getTicket(ticket.id)?.archived_at, null);
    assert.equal(harness.countApiCalls("sendDocument"), 1);
  });

  it("continues an archive after a durably recorded summary without resending it", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ messageThreadId: 5000 });
    harness.db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", text: "Archive me" });
    harness.db.closeTicketRecord(ticket.id, { type: "STAFF", displayName: "@test_staff", username: "test_staff" });
    assert.equal(harness.db.claimTicketArchiveSummary(ticket.id, 8000).claimed, true);
    harness.db.markTicketArchiveSummarySent(ticket.id, 9001);

    assert.equal(await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), true);
    assert.equal(harness.countApiCalls("sendMessage"), 0);
    assert.equal(harness.countApiCalls("sendDocument"), 1);
    assert.equal(harness.db.getTicket(ticket.id)?.logs_message_id, 9001);
    assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
  });

  it("finalizes a delivered archive locally without resending Support Logs content", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ messageThreadId: 5000 });
    harness.db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", text: "Finalize me" });
    harness.db.closeTicketRecord(ticket.id, { type: "STAFF", displayName: "@test_staff", username: "test_staff" });
    assert.equal(harness.db.claimTicketArchiveSummary(ticket.id, 8000).claimed, true);
    harness.db.markTicketArchiveSummarySent(ticket.id, 9002);
    assert.equal(harness.db.claimTicketArchiveDocument(ticket.id)?.claimed, true);
    harness.db.markTicketArchiveDocumentDelivered(ticket.id, 9003);

    assert.equal(await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), true);
    assert.equal(harness.countApiCalls("sendMessage"), 0);
    assert.equal(harness.countApiCalls("sendDocument"), 0);
    assert.equal(harness.db.getTicket(ticket.id)?.logs_message_id, 9002);
    assert.equal(harness.db.getTicket(ticket.id)?.transcript_message_id, 9003);
  });

  it("marks an orphan archive pending state unknown without Telegram replay", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ messageThreadId: 5000 });
    assert.equal(harness.db.claimTicketArchiveSummary(ticket.id, 8000).claimed, true);

    assert.equal(harness.db.markPendingTicketArchiveDeliveriesUnknown(), 1);
    assert.equal(harness.db.getTicketArchiveDelivery(ticket.id)?.state, "UNKNOWN_DELIVERY");
    assert.equal(await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), false);
    assert.equal(harness.countApiCalls("sendMessage"), 0);
    assert.equal(harness.countApiCalls("sendDocument"), 0);
  });

  it("purges delivered interactive payloads only after their ticket archive is finalized", async () => {
    const harness = createHarness();
    const ticket = seedClosedTicketForArchive(harness);
    const unrelated = harness.seedTicket({
      messageThreadId: 5001,
      user: { id: 124, username: "unrelated_customer", firstName: "Unrelated Customer" },
    });
    const deliveredOperation = "staff-message:-100900:9101";
    const unrelatedOperation = "staff-message:-100900:9102";
    for (const [operationKey, targetTicket] of [
      [deliveredOperation, ticket],
      [unrelatedOperation, unrelated],
    ] as const) {
      harness.db.createTicketOutboundDeliveryIntent({
        operationKey,
        ticketId: targetTicket.id,
        direction: "STAFF_TO_USER",
        deliveryChatId: targetTicket.user_telegram_id,
        text: "Durable interactive reply",
        mediaType: "document",
        filename: "durable.txt",
        fileId: "durable-file-id",
        senderType: "STAFF",
      });
      assert.equal(harness.db.markTicketOutboundDeliveryDelivered(operationKey, 9100), 9100);
    }
    harness.clearApiCalls();

    assert.equal(await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), true);

    const transcript = new TextDecoder().decode(harness.findApiCalls("sendDocument")[0]?.documentBytes);
    assert.match(transcript, /Durable interactive reply/);
    assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
    assert.equal(harness.db.getTicketOutboundDelivery(deliveredOperation), undefined);
    assert.equal(harness.db.getTicketOutboundDelivery(unrelatedOperation)?.state, "DELIVERED");
  });

  it("allows only one concurrent archive invocation to claim each Support Logs send", async () => {
    const harness = createHarness();
    const ticket = seedClosedTicketForArchive(harness);
    let summarySends = 0;
    let documentSends = 0;
    const api = archiveApi({
      sendMessage: async () => ({ message_id: 9000 + ++summarySends }),
      sendDocument: async () => ({ message_id: 9100 + ++documentSends }),
    });

    const results = await Promise.all([
      archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id),
      archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id),
    ]);

    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(summarySends, 1);
    assert.equal(documentSends, 1);
    assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
    assert.equal(harness.db.getTicketArchiveDelivery(ticket.id), undefined);
  });

  it("leaves a live SUMMARY_PENDING claim untouched by a competing archive invocation", async () => {
    const harness = createHarness();
    const ticket = seedClosedTicketForArchive(harness);
    const summaryEntered = deferred();
    const releaseSummary = deferred();
    let summarySends = 0;
    let documentSends = 0;
    const api = archiveApi({
      sendMessage: async () => {
        summarySends += 1;
        summaryEntered.resolve();
        await releaseSummary.promise;
        return { message_id: 9001 };
      },
      sendDocument: async () => ({ message_id: 9002 + ++documentSends }),
    });

    const first = archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id);
    await summaryEntered.promise;
    assert.equal(await archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), false);
    assert.equal(summarySends, 1);
    assert.equal(documentSends, 0);
    assert.equal(harness.db.getTicketArchiveDelivery(ticket.id)?.state, "SUMMARY_PENDING");

    releaseSummary.resolve();
    assert.equal(await first, true);
    assert.equal(documentSends, 1);
  });

  it("leaves a live DOCUMENT_PENDING claim untouched by a competing archive invocation", async () => {
    const harness = createHarness();
    const ticket = seedClosedTicketForArchive(harness);
    assert.equal(harness.db.claimTicketArchiveSummary(ticket.id, 8000).claimed, true);
    assert.equal(harness.db.markTicketArchiveSummarySent(ticket.id, 9001), true);
    const documentEntered = deferred();
    const releaseDocument = deferred();
    let documentSends = 0;
    const api = archiveApi({
      sendDocument: async () => {
        documentSends += 1;
        documentEntered.resolve();
        await releaseDocument.promise;
        return { message_id: 9002 };
      },
    });

    const first = archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id);
    await documentEntered.promise;
    assert.equal(await archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), false);
    assert.equal(documentSends, 1);
    assert.equal(harness.db.getTicketArchiveDelivery(ticket.id)?.state, "DOCUMENT_PENDING");

    releaseDocument.resolve();
    assert.equal(await first, true);
  });

  it("restages the summary and document together after a confirmed Support Logs topic loss", async () => {
    const harness = createHarness();
    const ticket = seedClosedTicketForArchive(harness);
    let documentAttempts = 0;
    harness.setApiResponseOverride("sendDocument", () => {
      documentAttempts += 1;
      if (documentAttempts === 1) {
        return { ok: false, error_code: 400, description: "Bad Request: message thread not found" };
      }
      return undefined;
    });

    assert.equal(await archiveTicketIfPossible(harness.bot.api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), true);

    const summaries = harness.findApiCalls("sendMessage");
    const documents = harness.findApiCalls("sendDocument");
    assert.equal(summaries.length, 2);
    assert.equal(documents.length, 2);
    const originalSummary = summaries[0]!;
    const replacementSummary = summaries[1]!;
    const originalDocument = documents[0]!;
    const replacementDocument = documents[1]!;
    const replacementTopic = replacementSummary.payload.message_thread_id;
    assert.equal(originalSummary.payload.message_thread_id, 8000);
    assert.notEqual(replacementTopic, 8000);
    assert.equal(originalDocument.payload.message_thread_id, 8000);
    assert.equal(replacementDocument.payload.message_thread_id, replacementTopic);
    assert.equal(harness.db.getTicket(ticket.id)?.logs_message_id, replacementSummary.responseMessageId);
    assert.equal(harness.db.getTicket(ticket.id)?.transcript_message_id, replacementDocument.responseMessageId);
  });

  it("keeps confirmed document-topic failure retryable when replacement topic creation fails", async () => {
    const harness = createHarness();
    const ticket = seedClosedTicketForArchive(harness);
    let documentAttempts = 0;
    let topicAttempts = 0;
    const api = archiveApi({
      sendDocument: async () => {
        documentAttempts += 1;
        if (documentAttempts <= 2) throw grammyFailure("sendDocument", "Bad Request: message thread not found");
        return { message_id: 9003 };
      },
      createForumTopic: async () => {
        topicAttempts += 1;
        if (topicAttempts === 1) throw grammyFailure("createForumTopic", "Bad Request: chat not found");
        return { message_thread_id: 8001 };
      },
    });

    assert.equal(await archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), false);
    assert.equal(harness.db.getTicketArchiveDelivery(ticket.id)?.state, "SUMMARY_SENT");
    assert.equal(documentAttempts, 1);
    assert.equal(topicAttempts, 1);

    assert.equal(await archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), true);
    assert.equal(documentAttempts, 3);
    assert.equal(topicAttempts, 2);
    assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
  });

  it("keeps archive content retryable when replacement topic creation has an ambiguous outcome", async () => {
    const harness = createHarness();
    const ticket = seedClosedTicketForArchive(harness);
    let documentAttempts = 0;
    let topicAttempts = 0;
    const api = archiveApi({
      sendDocument: async () => {
        documentAttempts += 1;
        if (documentAttempts <= 2) throw grammyFailure("sendDocument", "Bad Request: message thread not found");
        return { message_id: 9003 };
      },
      createForumTopic: async () => {
        topicAttempts += 1;
        if (topicAttempts === 1) throw new Error("Synthetic transport interruption");
        return { message_thread_id: 8001 };
      },
    });

    assert.equal(await archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), false);
    assert.equal(harness.db.getTicketArchiveDelivery(ticket.id)?.state, "SUMMARY_SENT");
    assert.equal(documentAttempts, 1);
    assert.equal(topicAttempts, 1);

    assert.equal(await archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), true);
    assert.equal(documentAttempts, 3);
    assert.equal(topicAttempts, 2);
    assert.ok(harness.db.getTicket(ticket.id)?.archived_at);
  });

  it("reopens a closed Support Logs topic and retries only the document", async () => {
    const harness = createHarness();
    const ticket = seedClosedTicketForArchive(harness);
    assert.equal(harness.db.claimTicketArchiveSummary(ticket.id, 8000).claimed, true);
    assert.equal(harness.db.markTicketArchiveSummarySent(ticket.id, 9001), true);
    let documentAttempts = 0;
    let reopenAttempts = 0;
    let summaryAttempts = 0;
    const api = archiveApi({
      sendMessage: async () => {
        summaryAttempts += 1;
        return { message_id: 9101 };
      },
      sendDocument: async () => {
        documentAttempts += 1;
        if (documentAttempts === 1) throw grammyFailure("sendDocument", "Bad Request: topic is closed");
        return { message_id: 9003 };
      },
      reopenForumTopic: async () => {
        reopenAttempts += 1;
        return true;
      },
    });

    assert.equal(await archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), true);
    assert.equal(summaryAttempts, 0);
    assert.equal(reopenAttempts, 1);
    assert.equal(documentAttempts, 2);
    assert.equal(harness.db.getTicket(ticket.id)?.logs_message_id, 9001);
    assert.equal(harness.db.getTicket(ticket.id)?.transcript_message_id, 9003);
  });

  for (const [name, reopenForumTopic] of [
    [
      "confirmed",
      async () => Promise.reject(grammyFailure("reopenForumTopic", "Forbidden: bot lacks permissions", 403)),
    ],
    ["ambiguous", async () => Promise.reject(new Error("Synthetic transport interruption"))],
  ] as const) {
    it(`keeps a closed-topic archive retryable when reopening has a ${name} failure`, async () => {
      const harness = createHarness();
      const ticket = seedClosedTicketForArchive(harness);
      assert.equal(harness.db.claimTicketArchiveSummary(ticket.id, 8000).claimed, true);
      assert.equal(harness.db.markTicketArchiveSummarySent(ticket.id, 9001), true);
      let documentAttempts = 0;
      let summaryAttempts = 0;
      let topicAttempts = 0;
      const api = archiveApi({
        sendMessage: async () => {
          summaryAttempts += 1;
          return { message_id: 9101 };
        },
        sendDocument: async () => {
          documentAttempts += 1;
          throw grammyFailure("sendDocument", "Bad Request: topic is closed");
        },
        reopenForumTopic,
        createForumTopic: async () => {
          topicAttempts += 1;
          return { message_thread_id: 8001 };
        },
      });

      assert.equal(await archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), false);
      assert.equal(harness.db.getTicketArchiveDelivery(ticket.id)?.state, "SUMMARY_SENT");
      assert.equal(summaryAttempts, 0);
      assert.equal(documentAttempts, 1);
      assert.equal(topicAttempts, 0);
    });
  }

  it("replaces a missing closed Support Logs topic with a complete replacement archive", async () => {
    const harness = createHarness();
    const ticket = seedClosedTicketForArchive(harness);
    assert.equal(harness.db.claimTicketArchiveSummary(ticket.id, 8000).claimed, true);
    assert.equal(harness.db.markTicketArchiveSummarySent(ticket.id, 9001), true);
    let documentAttempts = 0;
    let summaryAttempts = 0;
    let topicAttempts = 0;
    const api = archiveApi({
      sendMessage: async () => {
        summaryAttempts += 1;
        return { message_id: 9101 };
      },
      sendDocument: async () => {
        documentAttempts += 1;
        if (documentAttempts === 1) throw grammyFailure("sendDocument", "Bad Request: topic is closed");
        return { message_id: 9102 };
      },
      reopenForumTopic: async () => {
        throw grammyFailure("reopenForumTopic", "Bad Request: message thread not found");
      },
      createForumTopic: async () => {
        topicAttempts += 1;
        return { message_thread_id: 8001 };
      },
    });

    assert.equal(await archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), true);
    assert.equal(topicAttempts, 1);
    assert.equal(summaryAttempts, 1);
    assert.equal(documentAttempts, 2);
    assert.equal(harness.db.getTicket(ticket.id)?.logs_message_id, 9101);
    assert.equal(harness.db.getTicket(ticket.id)?.transcript_message_id, 9102);
  });

  it("never restages or resends an archive after an ambiguous document outcome", async () => {
    const harness = createHarness();
    const ticket = seedClosedTicketForArchive(harness);
    let summarySends = 0;
    let documentSends = 0;
    const api = archiveApi({
      sendMessage: async () => ({ message_id: 9000 + ++summarySends }),
      sendDocument: async () => {
        documentSends += 1;
        throw new Error("Synthetic transport interruption");
      },
    });

    assert.equal(await archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), false);
    assert.equal(harness.db.getTicketArchiveDelivery(ticket.id)?.state, "UNKNOWN_DELIVERY");
    assert.equal(await archiveTicketIfPossible(api, harness.db, TEST_STAFF_CHAT_ID, ticket.id), false);
    assert.equal(summarySends, 1);
    assert.equal(documentSends, 1);
  });
});
