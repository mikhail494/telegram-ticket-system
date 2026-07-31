import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Update } from "grammy/types";
import type { EntityNotificationProvider } from "../src/entityNotifications.js";
import { processEntityNotificationEvent, createEntityNotificationProviderRegistry } from "../src/entityNotifications.js";
import { TEST_STAFF_CHAT_ID, createBotHarness, type BotHarness } from "./helpers/botHarness.js";

const TARGET_CHAT_ID = -100811;
const EVENT = {
  provider: "fixture_test",
  entity_type: "quest",
  entity_id: "quest-456",
  event_type: "created",
  observed_at: "2026-07-30T18:00:00Z",
  payload: { title: "New quest", canonicalLink: "https://example.com/quest-456" }
};

const harnesses: BotHarness[] = [];
afterEach(() => {
  for (const harness of harnesses) harness.cleanup();
  harnesses.length = 0;
});

function provider(available = true): EntityNotificationProvider {
  return { key: "fixture_test", authoritative: true, isAvailable: () => available, status: () => available ? "available" : "unavailable" };
}

function createHarness(available = true): BotHarness {
  const harness = createBotHarness({
    entityNotificationProviders: createEntityNotificationProviderRegistry([provider(available)])
  });
  harnesses.push(harness);
  return harness;
}

function command(text: string, chatId = TEST_STAFF_CHAT_ID): Update {
  return {
    update_id: 1,
    message: {
      message_id: 8000,
      date: 1,
      from: { id: 42, is_bot: false, first_name: "Staff", username: "staff" },
      chat: chatId === TEST_STAFF_CHAT_ID ? { id: chatId, type: "supergroup", title: "Staff" } : { id: chatId, type: "private", first_name: "User" },
      text,
      entities: [{ offset: 0, length: text.split(" ")[0]?.length ?? text.length, type: "bot_command" }]
    }
  };
}

function mockReachableTarget(harness: BotHarness): void {
  harness.setApiResponseOverride("getChat", () => ({ ok: true, result: { id: TARGET_CHAT_ID, type: "supergroup", title: "Public Announcements" } }));
}

describe("/questnotify controls", () => {
  it("defaults to disabled and reports no provider", async () => {
    const harness = createBotHarness();
    harnesses.push(harness);
    await harness.bot.handleUpdate(command("/questnotify status"));
    const text = String(harness.findApiCalls("sendMessage").at(-1)?.payload.text);
    assert.match(text, /disabled/i);
    assert.match(text, /not configured/i);
    assert.match(text, /provider registered: no/i);
    assert.match(text, /publication can run: no/i);
  });

  it("persists a reachable target and refuses an unreachable replacement", async () => {
    const harness = createHarness();
    mockReachableTarget(harness);
    await harness.bot.handleUpdate(command(`/questnotify target ${TARGET_CHAT_ID}`));
    assert.equal(harness.db.getSetting("entity_notifications:target_chat_id"), String(TARGET_CHAT_ID));
    harness.failNextApiCall("getChat");
    await harness.bot.handleUpdate(command("/questnotify target -100999"));
    assert.equal(harness.db.getSetting("entity_notifications:target_chat_id"), String(TARGET_CHAT_ID));
  });

  it("rejects unknown, unavailable, and non-authoritative providers", async () => {
    const unavailable = createHarness(false);
    await unavailable.bot.handleUpdate(command("/questnotify provider fixture_test"));
    assert.equal(unavailable.db.getSetting("entity_notifications:provider"), undefined);

    const unknown = createHarness();
    await unknown.bot.handleUpdate(command("/questnotify provider missing"));
    assert.equal(unknown.db.getSetting("entity_notifications:provider"), undefined);

    const nonAuthoritative = createBotHarness({
      entityNotificationProviders: createEntityNotificationProviderRegistry([{ key: "fixture_test", authoritative: false, isAvailable: () => true }])
    });
    harnesses.push(nonAuthoritative);
    await nonAuthoritative.bot.handleUpdate(command("/questnotify provider fixture_test"));
    assert.equal(nonAuthoritative.db.getSetting("entity_notifications:provider"), undefined);
  });

  it("requires target and available authoritative provider before enabling", async () => {
    const harness = createHarness();
    await harness.bot.handleUpdate(command("/questnotify provider fixture_test"));
    await harness.bot.handleUpdate(command("/questnotify enable"));
    assert.equal(harness.db.getSetting("entity_notifications:enabled"), undefined);
    mockReachableTarget(harness);
    await harness.bot.handleUpdate(command(`/questnotify target ${TARGET_CHAT_ID}`));
    await harness.bot.handleUpdate(command("/questnotify enable"));
    assert.equal(harness.db.getSetting("entity_notifications:enabled"), "true");
  });

  it("publishes directly to the configured target without ticket or staff preview mutations", async () => {
    const harness = createHarness();
    mockReachableTarget(harness);
    await harness.bot.handleUpdate(command(`/questnotify target ${TARGET_CHAT_ID}`));
    await harness.bot.handleUpdate(command("/questnotify provider fixture_test"));
    await harness.bot.handleUpdate(command("/questnotify enable"));
    harness.clearApiCalls();

    const result = await processEntityNotificationEvent(harness.bot.api, harness.db, EVENT, {
      enabled: true,
      targetChatId: TARGET_CHAT_ID,
      providerKey: "fixture_test",
      providers: createEntityNotificationProviderRegistry([provider()])
    });
    assert.equal(result.status, "PUBLISHED");
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TARGET_CHAT_ID).length, 1);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID), false);
    assert.equal(harness.db.listMessagesChronological(1).length, 0);
  });

  it("disable preserves provider and publication state and prevents posting", async () => {
    const harness = createHarness();
    mockReachableTarget(harness);
    await harness.bot.handleUpdate(command(`/questnotify target ${TARGET_CHAT_ID}`));
    await harness.bot.handleUpdate(command("/questnotify provider fixture_test"));
    await harness.bot.handleUpdate(command("/questnotify enable"));
    const first = await processEntityNotificationEvent(harness.bot.api, harness.db, EVENT, {
      enabled: true, targetChatId: TARGET_CHAT_ID, providerKey: "fixture_test", providers: createEntityNotificationProviderRegistry([provider()])
    });
    assert.equal(first.status, "PUBLISHED");
    await harness.bot.handleUpdate(command("/questnotify disable"));
    const second = await processEntityNotificationEvent(harness.bot.api, harness.db, { ...EVENT, entity_id: "quest-disabled" }, {
      enabled: false, targetChatId: TARGET_CHAT_ID, providerKey: "fixture_test", providers: createEntityNotificationProviderRegistry([provider()])
    });
    assert.equal(second.status, "DISABLED");
    assert.equal(harness.db.getSetting("entity_notifications:provider"), "fixture_test");
  });

  it("keeps controls staff-only and updates help without leaking them to private users", async () => {
    const harness = createHarness();
    await harness.bot.handleUpdate(command("/questnotify help"));
    assert.match(String(harness.findApiCalls("sendMessage").at(-1)?.payload.text), /target|provider|enable|disable/i);
    await harness.bot.handleUpdate(command("/questnotify target 123", 999));
    assert.equal(harness.db.getSetting("entity_notifications:target_chat_id"), undefined);
    await harness.bot.handleUpdate({ ...command("/help", 999), message: { ...command("/help", 999).message!, chat: { id: 999, type: "private", first_name: "User" } } });
    assert.doesNotMatch(String(harness.findApiCalls("sendMessage").at(-1)?.payload.text), /questnotify/i);
  });
});
