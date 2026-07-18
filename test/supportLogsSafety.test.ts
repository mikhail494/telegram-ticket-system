import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Update } from "grammy/types";
import {
  TEST_STAFF_CHAT_ID,
  createBotHarness,
  type BotHarness,
  type RecordedApiCall
} from "./helpers/botHarness.js";

const { archiveTicketIfPossible, getSupportLogsTopicInfo } = await import("../src/archive.js");
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
      entities: [{ offset: 0, length: 8, type: "bot_command" }]
    }
  };
}

function staffTopicMessages(harness: BotHarness, messageThreadId: number): RecordedApiCall[] {
  return harness.findApiCalls("sendMessage").filter(
    (call) =>
      call.payload.chat_id === TEST_STAFF_CHAT_ID &&
      call.payload.message_thread_id === messageThreadId
  );
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

    const topic = await getSupportLogsTopicInfo(harness.bot.api, harness.db);

    assert.equal(topic.state, "created");
    assert.equal(topic.previousThreadId, ticket.message_thread_id);
    assert.notEqual(topic.threadId, ticket.message_thread_id);
    assert.equal(harness.db.getSetting(SUPPORT_LOGS_SETTING_KEY), String(topic.threadId));
    assert.equal(harness.countApiCalls("createForumTopic"), 1);
    assert.equal(
      harness.findApiCalls("sendChatAction").some(
        (call) => call.payload.message_thread_id === ticket.message_thread_id
      ),
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
      senderUsername: "test_customer"
    });
    harness.db.closeTicketRecord(ticket.id, {
      type: "STAFF",
      displayName: "@test_staff",
      username: "test_staff"
    });

    const archived = await archiveTicketIfPossible(harness.bot.api, harness.db, ticket.id);
    const archiveCalls = [
      ...harness.findApiCalls("sendMessage"),
      ...harness.findApiCalls("sendDocument")
    ].filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID);

    assert.equal(archived, true);
    assert.equal(archiveCalls.length, 2);
    assert.equal(
      archiveCalls.some((call) => call.payload.message_thread_id === ticket.message_thread_id),
      false
    );
    assert.equal(harness.countApiCalls("createForumTopic"), 1);
    assert.notEqual(harness.db.getSetting(SUPPORT_LOGS_SETTING_KEY), String(ticket.message_thread_id));
  });
});
