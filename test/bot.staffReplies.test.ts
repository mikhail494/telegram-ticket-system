import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Update } from "grammy/types";
import {
  TEST_STAFF_CHAT_ID,
  TEST_USER_ID,
  buildStaffMediaMessageUpdate,
  buildStaffTextMessageUpdate,
  createBotHarness,
  type BotHarness,
  type RecordedApiCall,
  type StaffMediaType
} from "./helpers/botHarness.js";

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

function userSendMessages(harness: BotHarness, userId = TEST_USER_ID): RecordedApiCall[] {
  return harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === userId);
}

function assertFailureNotice(harness: BotHarness, ticketId: number, messageThreadId: number): void {
  const notices = harness.findApiCalls("sendMessage").filter(
    (call) =>
      call.payload.chat_id === TEST_STAFF_CHAT_ID &&
      call.payload.message_thread_id === messageThreadId &&
      typeof call.payload.text === "string" &&
      call.payload.text.toLowerCase().includes(`ticket #${ticketId}`)
  );

  assert.equal(notices.length, 1);
}

function buildStaffTextUpdateWithoutTopic(text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 7001,
      date: 1,
      from: { id: 42, is_bot: false, first_name: "Test Staff", username: "test_staff" },
      chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Test Staff Chat" },
      text
    }
  };
}

function buildUnsupportedStaffMessageUpdate(): Update {
  return {
    update_id: 1,
    message: {
      message_id: 7001,
      date: 1,
      from: { id: 42, is_bot: false, first_name: "Test Staff", username: "test_staff" },
      chat: { id: TEST_STAFF_CHAT_ID, type: "supergroup", title: "Test Staff Chat" },
      message_thread_id: 5000,
      location: { latitude: 0, longitude: 0 }
    }
  };
}

describe("Staff ticket replies", () => {
  it("delivers, records, and refreshes an OPEN text reply", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ staffMessageId: 6000 });
    const text = "Please send your transaction hash.";

    await harness.bot.handleUpdate(buildStaffTextMessageUpdate({ messageId: 7001, text }));

    const deliveries = userSendMessages(harness);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.payload.text, text);

    const transcript = harness.db.listMessagesChronological(ticket.id);
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0]?.direction, "STAFF_TO_USER");
    assert.equal(transcript[0]?.from_telegram_id, 42);
    assert.equal(transcript[0]?.from_username, "test_staff");
    assert.equal(transcript[0]?.sender_display_name, "@test_staff");
    assert.equal(transcript[0]?.source_chat_id, TEST_STAFF_CHAT_ID);
    assert.equal(transcript[0]?.source_message_id, 7001);
    assert.equal(transcript[0]?.delivery_message_id, 1000);
    assert.equal(transcript[0]?.text, text);
    assert.equal(transcript[0]?.media_type, null);
    assert.equal(transcript[0]?.filename, null);
    assert.equal(transcript[0]?.file_id, null);

    assert.equal(harness.db.getTicket(ticket.id)?.status, "IN_PROGRESS");
    assert.equal(
      harness.findApiCalls("editMessageText").some((call) => call.payload.message_id === 6000),
      true
    );
  });

  for (const status of ["IN_PROGRESS", "WAITING_USER"] as const) {
    it(`keeps ${status} when a text reply is delivered`, async () => {
      const harness = createHarness();
      const ticket = harness.seedTicket({ status });

      await harness.bot.handleUpdate(buildStaffTextMessageUpdate({ text: `Reply while ${status}` }));

      assert.equal(userSendMessages(harness).length, 1);
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
      assert.equal(harness.db.getTicket(ticket.id)?.status, status);
    });
  }

  for (const mediaCase of [
    {
      type: "photo" as StaffMediaType,
      fileId: "photo-file",
      fileName: undefined,
      caption: "Photo evidence"
    },
    {
      type: "document" as StaffMediaType,
      fileId: "document-file",
      fileName: "evidence.pdf",
      caption: "Document evidence"
    }
  ]) {
    it(`copies and records a ${mediaCase.type} reply`, async () => {
      const harness = createHarness();
      const ticket = harness.seedTicket({ staffMessageId: 6000 });

      await harness.bot.handleUpdate(
        buildStaffMediaMessageUpdate({
          mediaType: mediaCase.type,
          fileId: mediaCase.fileId,
          fileName: mediaCase.fileName,
          messageId: 7010,
          text: mediaCase.caption
        })
      );

      const copies = harness.findApiCalls("copyMessage");
      assert.equal(copies.length, 1);
      assert.equal(copies[0]?.payload.chat_id, ticket.user_telegram_id);
      assert.equal(copies[0]?.payload.from_chat_id, TEST_STAFF_CHAT_ID);
      assert.equal(copies[0]?.payload.message_id, 7010);
      assert.equal(userSendMessages(harness).length, 0);

      const transcript = harness.db.listMessagesChronological(ticket.id);
      assert.equal(transcript.length, 1);
      assert.equal(transcript[0]?.direction, "STAFF_TO_USER");
      assert.equal(transcript[0]?.media_type, mediaCase.type);
      assert.equal(transcript[0]?.filename, mediaCase.fileName ?? null);
      assert.equal(transcript[0]?.file_id, mediaCase.fileId);
      assert.equal(transcript[0]?.text, mediaCase.caption);
      assert.equal(transcript[0]?.from_telegram_id, 42);
      assert.equal(transcript[0]?.from_username, "test_staff");
      assert.equal(transcript[0]?.sender_display_name, "@test_staff");
      assert.equal(transcript[0]?.delivery_message_id, 1000);
      assert.equal(harness.db.getTicket(ticket.id)?.status, "IN_PROGRESS");
    });
  }

  for (const replyCase of [
    {
      name: "text",
      update: () => buildStaffTextMessageUpdate({ text: "Closed ticket reply" })
    },
    {
      name: "media",
      update: () => buildStaffMediaMessageUpdate({ mediaType: "photo", text: "Closed photo" })
    }
  ]) {
    it(`does not deliver or record ${replyCase.name} replies for closed tickets`, async () => {
      const harness = createHarness();
      const ticket = harness.seedTicket({ status: "CLOSED" });

      await harness.bot.handleUpdate(replyCase.update());

      assert.equal(userSendMessages(harness).length, 0);
      assert.equal(harness.countApiCalls("copyMessage"), 0);
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
      assertFailureNotice(harness, ticket.id, ticket.message_thread_id ?? 0);
    });
  }

  it("ignores messages in an unlinked staff topic", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(buildStaffTextMessageUpdate({ messageThreadId: 9999, text: "Unlinked topic" }));

    assert.equal(userSendMessages(harness).length, 0);
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
  });

  it("ignores staff messages outside a forum topic", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(buildStaffTextUpdateWithoutTopic("No topic"));

    assert.equal(userSendMessages(harness).length, 0);
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
  });

  it("does not treat another chat as staff", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(buildStaffTextMessageUpdate({ chatId: TEST_STAFF_CHAT_ID - 1, text: "Other chat" }));

    assert.equal(userSendMessages(harness).length, 0);
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
  });

  it("does not forward commands from ticket topics", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(buildStaffTextMessageUpdate({ text: "/unknown" }));

    assert.equal(userSendMessages(harness).length, 0);
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
  });

  it("ignores unsupported staff content", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(buildUnsupportedStaffMessageUpdate());

    assert.equal(userSendMessages(harness).length, 0);
    assert.equal(harness.countApiCalls("copyMessage"), 0);
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
  });

  it("reports text delivery failures without retrying or changing ticket status", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.setApiResponseOverride("sendMessage", (call, defaultResponse) =>
      call.payload.chat_id === ticket.user_telegram_id
        ? { ok: false, error_code: 403, description: "Forbidden: user blocked the bot" }
        : defaultResponse
    );

    await harness.bot.handleUpdate(buildStaffTextMessageUpdate({ text: "Will fail" }));

    assert.equal(userSendMessages(harness).length, 1);
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
    assert.equal(harness.db.getTicket(ticket.id)?.status, "OPEN");
    assertFailureNotice(harness, ticket.id, ticket.message_thread_id ?? 0);
  });

  it("reports media delivery failures without retrying or changing ticket status", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.failNextApiCall("copyMessage", "Forbidden: user blocked the bot", 403);

    await harness.bot.handleUpdate(buildStaffMediaMessageUpdate({ mediaType: "photo", text: "Will fail" }));

    assert.equal(harness.countApiCalls("copyMessage"), 1);
    assert.equal(userSendMessages(harness).length, 0);
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
    assert.equal(harness.db.getTicket(ticket.id)?.status, "OPEN");
    assertFailureNotice(harness, ticket.id, ticket.message_thread_id ?? 0);
  });
});
