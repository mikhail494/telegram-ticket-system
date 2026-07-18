import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { QuickRepliesRegistry, QuickReplyCategory, QuickReplyTemplate } from "../src/quickReplies.js";
import type { TicketStatus } from "../src/db.js";
import {
  TEST_STAFF_CHAT_ID,
  TEST_USER_ID,
  buildStaffCallbackUpdate,
  createBotHarness,
  type BotHarness,
  type RecordedApiCall
} from "./helpers/botHarness.js";

const harnesses: BotHarness[] = [];

afterEach(() => {
  for (const harness of harnesses) {
    harness.cleanup();
  }

  harnesses.length = 0;
});

function createHarness(registry?: QuickRepliesRegistry): BotHarness {
  const harness = createBotHarness({ quickRepliesRegistry: registry });
  harnesses.push(harness);
  return harness;
}

function callbackAnswers(harness: BotHarness): RecordedApiCall[] {
  return harness.findApiCalls("answerCallbackQuery");
}

function assertCallbackAnswer(
  harness: BotHarness,
  expectedText?: string,
  expectedShowAlert?: boolean
): void {
  const answers = callbackAnswers(harness);
  assert.equal(answers.length, 1);

  if (expectedText !== undefined) {
    assert.equal(answers[0]?.payload.text, expectedText);
  }

  if (expectedShowAlert !== undefined) {
    assert.equal(answers[0]?.payload.show_alert, expectedShowAlert);
  }
}

function inlineButtons(call: RecordedApiCall): Array<{ text: string; callbackData?: string }> {
  const replyMarkup = call.payload.reply_markup;
  if (!isRecord(replyMarkup) || !Array.isArray(replyMarkup.inline_keyboard)) {
    return [];
  }

  return replyMarkup.inline_keyboard.flatMap((row) => {
    if (!Array.isArray(row)) {
      return [];
    }

    return row.flatMap((button) => {
      if (!isRecord(button) || typeof button.text !== "string") {
        return [];
      }

      return [
        {
          text: button.text,
          callbackData: typeof button.callback_data === "string" ? button.callback_data : undefined
        }
      ];
    });
  });
}

function templateButtons(call: RecordedApiCall): Array<{ text: string; callbackData?: string }> {
  return inlineButtons(call).filter((button) => button.callbackData?.startsWith("qr:template:"));
}

function createPaginationRegistry(templateCount = 13): QuickRepliesRegistry {
  const templates = Object.freeze(
    Array.from({ length: templateCount }, (_, index) =>
      Object.freeze({
        id: `reply_${index}`,
        title: `Reply ${index}`,
        text: `Template reply ${index}`
      })
    )
  ) as readonly QuickReplyTemplate[];
  const category = Object.freeze({
    id: "bulk",
    title: "Bulk replies",
    templates
  }) as QuickReplyCategory;
  const categories = Object.freeze([category]) as readonly QuickReplyCategory[];
  const templateById = new Map(templates.map((template) => [template.id, template]));

  return Object.freeze({
    listCategories: () => categories,
    findCategory: (categoryId: string) => (categoryId === category.id ? category : undefined),
    listTemplates: (categoryId: string) => (categoryId === category.id ? templates : Object.freeze([])),
    findTemplate: (templateId: string) => templateById.get(templateId)
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("Quick Replies callbacks", () => {
  it("opens the category menu for an active ticket topic", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(
      buildStaffCallbackUpdate({ callbackData: `qr:open:${ticket.id}`, messageThreadId: ticket.message_thread_id ?? 0 })
    );

    assertCallbackAnswer(harness, "Quick replies opened.");
    const menus = harness.findApiCalls("sendMessage");
    assert.equal(menus.length, 1);
    assert.equal(menus[0]?.payload.chat_id, TEST_STAFF_CHAT_ID);
    assert.equal(menus[0]?.payload.message_thread_id, ticket.message_thread_id);
    assert.equal(menus[0]?.payload.text, "Quick replies\nChoose a category:");
    assert.deepEqual(
      inlineButtons(menus[0]!).map((button) => button.text),
      ["Request details", "Status updates", "Cancel"]
    );
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
  });

  for (const validationCase of [
    {
      name: "callbacks outside the staff chat",
      seed: {},
      update: { callbackData: "qr:open:1", chatId: TEST_STAFF_CHAT_ID - 1 }
    },
    {
      name: "invalid ticket IDs",
      seed: {},
      update: { callbackData: "qr:open:not-a-ticket" }
    },
    {
      name: "missing tickets",
      seed: {},
      update: { callbackData: "qr:open:999" }
    },
    {
      name: "tickets from another staff chat",
      seed: { staffChatId: TEST_STAFF_CHAT_ID - 1 },
      update: { callbackData: "qr:open:1" }
    },
    {
      name: "closed tickets",
      seed: { status: "CLOSED" as TicketStatus },
      update: { callbackData: "qr:open:1" }
    },
    {
      name: "callbacks from another topic",
      seed: {},
      update: { callbackData: "qr:open:1", messageThreadId: 9999 }
    }
  ]) {
    it(`does not open a menu for ${validationCase.name}`, async () => {
      const harness = createHarness();
      harness.seedTicket(validationCase.seed);

      await harness.bot.handleUpdate(buildStaffCallbackUpdate(validationCase.update));

      assert.equal(harness.countApiCalls("sendMessage"), 0);
      assertCallbackAnswer(harness);
    });
  }

  it("renders a selected category by editing the existing menu", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(
      buildStaffCallbackUpdate({ callbackData: `qr:category:${ticket.id}:request_details` })
    );

    assertCallbackAnswer(harness, "Quick Replies category opened.");
    const edits = harness.findApiCalls("editMessageText");
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.payload.text, "Quick replies\nRequest details\nChoose a reply:");
    assert.deepEqual(
      inlineButtons(edits[0]!).map((button) => button.text),
      ["Ask for UID", "Ask for wallet", "Ask for evidence", "Back", "Cancel"]
    );
  });

  it("rejects an unknown category without editing the menu", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(
      buildStaffCallbackUpdate({ callbackData: `qr:category:${ticket.id}:unknown_category` })
    );

    assert.equal(harness.countApiCalls("editMessageText"), 0);
    assertCallbackAnswer(harness, "Quick Replies category not found.");
  });

  it("restores the category menu when Back is selected", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(buildStaffCallbackUpdate({ callbackData: `qr:back:${ticket.id}` }));

    assertCallbackAnswer(harness, "Quick replies opened.");
    const edits = harness.findApiCalls("editMessageText");
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.payload.text, "Quick replies\nChoose a category:");
    assert.deepEqual(
      inlineButtons(edits[0]!).map((button) => button.text),
      ["Request details", "Status updates", "Cancel"]
    );
  });

  it("removes the menu keyboard when Cancel is selected", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(buildStaffCallbackUpdate({ callbackData: `qr:cancel:${ticket.id}` }));

    assertCallbackAnswer(harness, "Quick replies closed.");
    const edits = harness.findApiCalls("editMessageReplyMarkup");
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.payload.reply_markup, undefined);
  });

  it("shows six templates and Next on the first pagination page", async () => {
    const harness = createHarness(createPaginationRegistry());
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(buildStaffCallbackUpdate({ callbackData: `qr:category:${ticket.id}:bulk` }));

    const edit = harness.findApiCalls("editMessageText")[0];
    assert.ok(edit);
    assert.equal(templateButtons(edit).length, 6);
    assert.equal(inlineButtons(edit).some((button) => button.text === "Previous"), false);
    assert.equal(inlineButtons(edit).some((button) => button.text === "Next"), true);
    assertCallbackAnswer(harness, "Quick Replies category opened.");
  });

  it("shows Previous and Next on a middle pagination page", async () => {
    const harness = createHarness(createPaginationRegistry());
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(buildStaffCallbackUpdate({ callbackData: `qr:page:${ticket.id}:bulk:1` }));

    const edit = harness.findApiCalls("editMessageText")[0];
    assert.ok(edit);
    assert.equal(templateButtons(edit).length, 6);
    assert.equal(inlineButtons(edit).some((button) => button.text === "Previous"), true);
    assert.equal(inlineButtons(edit).some((button) => button.text === "Next"), true);
    assertCallbackAnswer(harness, "Quick Replies category opened.");
  });

  it("shows Previous only on the final pagination page", async () => {
    const harness = createHarness(createPaginationRegistry());
    const ticket = harness.seedTicket();

    await harness.bot.handleUpdate(buildStaffCallbackUpdate({ callbackData: `qr:page:${ticket.id}:bulk:2` }));

    const edit = harness.findApiCalls("editMessageText")[0];
    assert.ok(edit);
    assert.equal(templateButtons(edit).length, 1);
    assert.equal(inlineButtons(edit).some((button) => button.text === "Previous"), true);
    assert.equal(inlineButtons(edit).some((button) => button.text === "Next"), false);
    assertCallbackAnswer(harness, "Quick Replies category opened.");
  });

  for (const page of ["-1", "not-a-page", "3"]) {
    it(`rejects invalid pagination page ${page}`, async () => {
      const harness = createHarness(createPaginationRegistry());
      const ticket = harness.seedTicket();

      await harness.bot.handleUpdate(buildStaffCallbackUpdate({ callbackData: `qr:page:${ticket.id}:bulk:${page}` }));

      assert.equal(harness.countApiCalls("editMessageText"), 0);
      assertCallbackAnswer(
        harness,
        page === "3" ? "Quick Replies page is out of range." : "Invalid Quick Replies page."
      );
    });
  }

  it("delivers and records a selected template", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ staffMessageId: 6000 });
    const template = harness.registry.findTemplate("ask_uid");
    assert.ok(template);

    await harness.bot.handleUpdate(
      buildStaffCallbackUpdate({ callbackData: `qr:template:${ticket.id}:${template.id}`, messageId: 7001 })
    );

    const userMessages = harness
      .findApiCalls("sendMessage")
      .filter((call) => call.payload.chat_id === ticket.user_telegram_id);
    assert.equal(userMessages.length, 1);
    assert.equal(userMessages[0]?.payload.text, template.text);

    const transcript = harness.db.listMessagesChronological(ticket.id);
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0]?.direction, "STAFF_TO_USER");
    assert.equal(transcript[0]?.from_telegram_id, 42);
    assert.equal(transcript[0]?.from_username, "test_staff");
    assert.equal(transcript[0]?.sender_display_name, "@test_staff");
    assert.equal(transcript[0]?.text, template.text);
    assert.equal(transcript[0]?.media_type, null);
    assert.equal(transcript[0]?.filename, null);
    assert.equal(transcript[0]?.file_id, null);

    assert.equal(harness.db.getTicket(ticket.id)?.status, "IN_PROGRESS");
    assert.equal(
      harness.findApiCalls("editMessageText").some((call) => call.payload.message_id === 6000),
      true
    );
    assertCallbackAnswer(harness, "Quick reply sent.");

    const menuCleanup = harness
      .findApiCalls("editMessageText")
      .find((call) => call.payload.message_id === 7001);
    assert.ok(menuCleanup);
    assert.equal(menuCleanup.payload.text, "Quick reply sent\nAsk for UID");
    assert.equal(menuCleanup.payload.reply_markup, undefined);
  });

  for (const status of ["IN_PROGRESS", "WAITING_USER"] as const) {
    it(`keeps ${status} when a Quick Reply is delivered`, async () => {
      const harness = createHarness();
      const ticket = harness.seedTicket({ status });

      await harness.bot.handleUpdate(buildStaffCallbackUpdate({ callbackData: `qr:template:${ticket.id}:ask_uid` }));

      assert.equal(
        harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TEST_USER_ID).length,
        1
      );
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
      assert.equal(harness.db.getTicket(ticket.id)?.status, status);
      assertCallbackAnswer(harness, "Quick reply sent.");
    });
  }

  for (const invalidDeliveryCase of [
    {
      name: "unknown templates",
      seed: {},
      update: { callbackData: "qr:template:1:unknown_template" }
    },
    {
      name: "closed tickets",
      seed: { status: "CLOSED" as TicketStatus },
      update: { callbackData: "qr:template:1:ask_uid" }
    },
    {
      name: "callbacks from another topic",
      seed: {},
      update: { callbackData: "qr:template:1:ask_uid", messageThreadId: 9999 }
    }
  ]) {
    it(`does not deliver ${invalidDeliveryCase.name}`, async () => {
      const harness = createHarness();
      const ticket = harness.seedTicket(invalidDeliveryCase.seed);

      await harness.bot.handleUpdate(buildStaffCallbackUpdate(invalidDeliveryCase.update));

      assert.equal(
        harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
        0
      );
      assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
      assertCallbackAnswer(harness);
    });
  }

  it("reports a Telegram delivery failure without creating a transcript row", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.setApiResponseOverride("sendMessage", (call, defaultResponse) =>
      call.payload.chat_id === ticket.user_telegram_id
        ? { ok: false, error_code: 403, description: "Forbidden: user blocked the bot" }
        : defaultResponse
    );

    await harness.bot.handleUpdate(buildStaffCallbackUpdate({ callbackData: `qr:template:${ticket.id}:ask_uid` }));

    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
    assert.equal(harness.db.getTicket(ticket.id)?.status, "OPEN");
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some(
          (call) =>
            call.payload.chat_id === TEST_STAFF_CHAT_ID &&
            call.payload.message_thread_id === ticket.message_thread_id &&
            typeof call.payload.text === "string" &&
            call.payload.text.includes("Could not send quick reply")
        ),
      true
    );
    assertCallbackAnswer(harness, "Could not send quick reply.", true);
  });

  it("keeps successful delivery when menu cleanup fails", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket({ staffMessageId: 6000 });
    harness.setApiResponseOverride("editMessageText", (call, defaultResponse) =>
      call.payload.message_id === 7001
        ? { ok: false, error_code: 400, description: "Bad Request: message not found" }
        : defaultResponse
    );

    await harness.bot.handleUpdate(
      buildStaffCallbackUpdate({ callbackData: `qr:template:${ticket.id}:ask_uid`, messageId: 7001 })
    );

    assert.equal(
      harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
      1
    );
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .some(
          (call) =>
            call.payload.chat_id === TEST_STAFF_CHAT_ID &&
            typeof call.payload.text === "string" &&
            call.payload.text.includes("Could not send quick reply")
        ),
      false
    );
    assertCallbackAnswer(harness, "Quick reply sent.");
  });

  it("does not retry a successful operation when callback acknowledgement fails", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.failNextApiCall("answerCallbackQuery", "Callback answer failed");

    await harness.bot.handleUpdate(buildStaffCallbackUpdate({ callbackData: `qr:open:${ticket.id}` }));

    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.text === "Quick replies\nChoose a category:").length,
      1
    );
    assert.equal(harness.countApiCalls("answerCallbackQuery"), 1);
  });

  it("does not retry a failed operation or its callback acknowledgement", async () => {
    const harness = createHarness();
    const ticket = harness.seedTicket();
    harness.setApiResponseOverride("sendMessage", (call, defaultResponse) =>
      call.payload.text === "Quick replies\nChoose a category:"
        ? { ok: false, error_code: 500, description: "Internal Server Error" }
        : defaultResponse
    );
    harness.failNextApiCall("answerCallbackQuery", "Callback answer failed");

    await assert.rejects(() =>
      harness.bot.handleUpdate(buildStaffCallbackUpdate({ callbackData: `qr:open:${ticket.id}` }))
    );

    assert.equal(
      harness
        .findApiCalls("sendMessage")
        .filter((call) => call.payload.text === "Quick replies\nChoose a category:").length,
      1
    );
    assert.equal(harness.countApiCalls("answerCallbackQuery"), 1);
  });
});
