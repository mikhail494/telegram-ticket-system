import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { EntityNotificationProvider } from "../src/entityNotifications.js";
import {
  EntityNotificationValidationError,
  createEntityNotificationProviderRegistry,
  processEntityNotificationEvent,
  renderEntityNotification,
  validateEntityNotificationEvent
} from "../src/entityNotifications.js";
import { SupportDatabase } from "../src/db.js";
import { createBotHarness, type BotHarness } from "./helpers/botHarness.js";

const TARGET_CHAT_ID = -100811;
const EVENT = {
  provider: "fixture_test",
  entity_type: "quest",
  entity_id: "quest-123",
  event_type: "created",
  observed_at: "2026-07-30T18:00:00Z",
  payload: {
    title: "Complete the weekly quest",
    objective: "Finish the listed tasks.",
    publisher: "AgentOn Labs",
    reward: "100 points",
    deadline: "2026-08-01T18:00:00Z",
    displayedCapacity: "100 spots",
    settlementLabel: "Instant Pay",
    requirements: "Verified account",
    canonicalLink: "https://example.com/quests/quest-123"
  }
};

const harnesses: BotHarness[] = [];
afterEach(() => {
  for (const harness of harnesses) harness.cleanup();
  harnesses.length = 0;
});

function createHarness(): BotHarness {
  const harness = createBotHarness();
  harnesses.push(harness);
  return harness;
}

function provider(available = true): EntityNotificationProvider {
  return {
    key: "fixture_test",
    authoritative: true,
    isAvailable: () => available,
    status: () => (available ? "fixture available" : "fixture unavailable")
  };
}

function settings(overrides: Partial<Parameters<typeof processEntityNotificationEvent>[3]> = {}) {
  return {
    enabled: true,
    targetChatId: TARGET_CHAT_ID,
    providerKey: "fixture_test",
    providers: createEntityNotificationProviderRegistry([provider()]),
    ...overrides
  };
}

describe("entity notification event contracts", () => {
  it("accepts a valid quest created event", () => {
    const event = validateEntityNotificationEvent(EVENT);
    assert.equal(event.provider, "fixture_test");
    assert.equal(event.entityType, "quest");
    assert.equal(event.eventType, "created");
    assert.equal(event.payload.canonicalLink, EVENT.payload.canonicalLink);
  });

  it("rejects malformed identity, timestamp, payload, and unsafe fields", () => {
    for (const input of [
      { ...EVENT, provider: "" },
      { ...EVENT, entity_id: "" },
      { ...EVENT, observed_at: "not-a-date" },
      { ...EVENT, payload: { ...EVENT.payload, reward: 100 } },
      { ...EVENT, payload: { ...EVENT.payload, unexpected: "value" } }
    ]) {
      assert.throws(() => validateEntityNotificationEvent(input), EntityNotificationValidationError);
    }
  });

  it("ignores unsupported lifecycle events without treating them as publishable", async () => {
    const harness = createHarness();
    for (const eventType of ["CREATED", "updated", "update", "ended", "completed", "cancelled", "removed", "deleted", "unknown"]) {
      const result = await processEntityNotificationEvent(
        harness.bot.api,
        harness.db,
        { ...EVENT, event_type: eventType },
        settings()
      );
      assert.equal(result.status, "IGNORED");
    }
    assert.equal(harness.db.countEntityNotificationPublications(), 0);
    assert.equal(harness.countApiCalls("sendMessage"), 0);
  });

  it("handles oversized fields and rendered messages deterministically", () => {
    assert.throws(
      () => validateEntityNotificationEvent({ ...EVENT, payload: { ...EVENT.payload, title: "x".repeat(501) } }),
      /title.*500/i
    );
    assert.throws(
      () => renderEntityNotification(validateEntityNotificationEvent({
        ...EVENT,
        payload: Object.fromEntries(Object.keys(EVENT.payload).map((key) => [key, key === "canonicalLink" ? `https://example.com/${"x".repeat(500)}` : "x".repeat(500)]))
      })),
      /4096|message.*limit/i
    );
  });
});

describe("entity notification rendering", () => {
  it("renders supplied fields in stable order without inferred meanings", () => {
    const text = renderEntityNotification(validateEntityNotificationEvent(EVENT));
    assert.match(text, /^New quest created\n/);
    assert.ok(text.indexOf("Title:") < text.indexOf("Objective:"));
    assert.ok(text.indexOf("Reward:") < text.indexOf("Deadline:"));
    assert.match(text, /Displayed capacity: 100 spots/);
    assert.match(text, /Settlement: Instant Pay/);
    assert.match(text, /Link: https:\/\/example\.com\/quests\/quest-123/);
    assert.doesNotMatch(text, /FCFS|queue priority|approval timing|payment timing/i);
  });

  it("omits absent fields and renders equivalent events identically", () => {
    const one = validateEntityNotificationEvent({ ...EVENT, payload: { title: "Only title", canonicalLink: EVENT.payload.canonicalLink } });
    const two = validateEntityNotificationEvent({ ...EVENT, payload: { canonicalLink: EVENT.payload.canonicalLink, title: "Only title" } });
    assert.equal(renderEntityNotification(one), renderEntityNotification(two));
    assert.doesNotMatch(renderEntityNotification(one), /Objective|Reward|Settlement|Requirements/);
  });
});

describe("entity notification publication state", () => {
  it("claims and publishes once, then suppresses replay", async () => {
    const harness = createHarness();
    const first = await processEntityNotificationEvent(harness.bot.api, harness.db, EVENT, settings());
    const second = await processEntityNotificationEvent(harness.bot.api, harness.db, EVENT, settings());
    assert.equal(first.status, "PUBLISHED");
    assert.equal(second.status, "DUPLICATE");
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TARGET_CHAT_ID).length, 1);
    assert.equal(harness.db.countEntityNotificationPublications("PUBLISHED"), 1);
  });

  it("uses the full provider/entity/created identity for dedupe", async () => {
    const harness = createHarness();
    const otherProvider = { ...provider(), key: "other_fixture" };
    const result = await processEntityNotificationEvent(
      harness.bot.api,
      harness.db,
      { ...EVENT, provider: "other_fixture" },
      settings({ providers: createEntityNotificationProviderRegistry([provider(), otherProvider]), providerKey: "other_fixture" })
    );
    assert.equal(result.status, "PUBLISHED");
    assert.equal(harness.countApiCalls("sendMessage"), 1);
  });

  it("allows only one concurrent claim to reach Telegram", async () => {
    const harness = createHarness();
    const results = await Promise.all([
      processEntityNotificationEvent(harness.bot.api, harness.db, EVENT, settings()),
      processEntityNotificationEvent(harness.bot.api, harness.db, EVENT, settings())
    ]);
    assert.equal(results.filter((result) => result.status === "PUBLISHED").length, 1);
    assert.equal(results.filter((result) => result.status === "IN_FLIGHT").length, 1);
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TARGET_CHAT_ID).length, 1);
  });

  it("does not mark failed Telegram delivery as published and allows a failed replay", async () => {
    const harness = createHarness();
    harness.failNextApiCall("sendMessage", "Telegram unavailable");
    const failed = await processEntityNotificationEvent(harness.bot.api, harness.db, EVENT, settings());
    const replay = await processEntityNotificationEvent(harness.bot.api, harness.db, EVENT, settings());
    assert.equal(failed.status, "FAILED");
    assert.equal(replay.status, "PUBLISHED");
    assert.equal(harness.db.countEntityNotificationPublications("PUBLISHED"), 1);
  });

  it("suppresses an interrupted CLAIMED identity conservatively", async () => {
    const harness = createHarness();
    const event = validateEntityNotificationEvent(EVENT);
    assert.equal(harness.db.claimEntityNotificationPublication({
      provider: event.provider,
      entityType: event.entityType,
      entityId: event.entityId,
      eventType: "created",
      observedAt: event.observedAt,
      targetChatId: TARGET_CHAT_ID
    }), "CLAIMED");
    const result = await processEntityNotificationEvent(harness.bot.api, harness.db, EVENT, settings());
    assert.equal(result.status, "IN_FLIGHT");
    assert.equal(harness.countApiCalls("sendMessage"), 0);
  });

  it("skips unavailable prerequisites without creating publication rows", async () => {
    const harness = createHarness();
    for (const configuration of [
      settings({ enabled: false }),
      settings({ targetChatId: null }),
      settings({ providerKey: null }),
      settings({ providers: createEntityNotificationProviderRegistry([]) }),
      settings({ providers: createEntityNotificationProviderRegistry([{ ...provider(), authoritative: false }]) }),
      settings({ providers: createEntityNotificationProviderRegistry([provider(false)]) }),
      settings({ providers: createEntityNotificationProviderRegistry([{ ...provider(), isAvailable: () => { throw new Error("provider status failed"); } }]) })
    ]) {
      const result = await processEntityNotificationEvent(harness.bot.api, harness.db, EVENT, configuration);
      assert.match(result.status, /DISABLED|SKIPPED|UNAVAILABLE/);
    }
    assert.equal(harness.db.countEntityNotificationPublications(), 0);
  });

  it("is idempotent across SupportDatabase restart", async () => {
    const directory = await mkdtemp(path.join(process.env.TEMP ?? ".", "entity-notification-"));
    const databasePath = path.join(directory, "notifications.db");
    try {
      const firstDb = new SupportDatabase(databasePath);
      const harness = createHarness();
      const first = await processEntityNotificationEvent(harness.bot.api, firstDb, EVENT, settings());
      firstDb.close();
      const secondDb = new SupportDatabase(databasePath);
      const second = await processEntityNotificationEvent(harness.bot.api, secondDb, EVENT, settings());
      secondDb.close();
      assert.equal(first.status, "PUBLISHED");
      assert.equal(second.status, "DUPLICATE");
      assert.equal(harness.countApiCalls("sendMessage"), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
