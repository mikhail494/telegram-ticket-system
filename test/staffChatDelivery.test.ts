import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GrammyError, HttpError } from "grammy";
import { StaffChatDeliveryCoordinator } from "../src/staffChatDelivery.js";

describe("staff-only batch delivery coordination", () => {
  it("retries a Telegram 429 after retry_after without duplicating a successful operation", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const coordinator = new StaffChatDeliveryCoordinator({
      minimumIntervalMs: 0,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    const result = await coordinator.run(
      -100900,
      async () => {
        attempts += 1;
        if (attempts === 1)
          throw new GrammyError(
            "Too Many Requests",
            { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } },
            "sendMessage",
            {}
          );
        return 42;
      },
      { replaySafety: "NON_IDEMPOTENT", operationName: "sendMessage" }
    );

    assert.equal(result.value, 42);
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [1250]);
  });

  it("defers a long rate limit instead of blocking the update handler", async () => {
    const coordinator = new StaffChatDeliveryCoordinator({ minimumIntervalMs: 0, sleep: async () => undefined });
    const result = await coordinator.run(
      -100900,
      async () => {
        throw new GrammyError(
          "Too Many Requests",
          { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 20 } },
          "sendMessage",
          {}
        );
      },
      { replaySafety: "NON_IDEMPOTENT", operationName: "sendMessage" }
    );

    assert.equal(result.value, undefined);
    assert.equal(result.diagnostic?.category, "RATE_LIMITED");
    assert.ok(result.retryAt);
  });

  it("coordinates later staff-only operations behind a long retry_after", async () => {
    const coordinator = new StaffChatDeliveryCoordinator({ minimumIntervalMs: 0, sleep: async () => undefined });
    await coordinator.run(
      -100900,
      async () => {
        throw new GrammyError(
          "Too Many Requests",
          { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 20 } },
          "sendMessage",
          {}
        );
      },
      { replaySafety: "NON_IDEMPOTENT", operationName: "sendMessage" }
    );
    let called = false;
    const deferred = await coordinator.run(
      -100900,
      async () => {
        called = true;
        return 1;
      },
      { replaySafety: "NON_IDEMPOTENT", operationName: "sendMessage" }
    );

    assert.equal(called, false);
    assert.equal(deferred.diagnostic?.category, "RATE_LIMITED");
    assert.ok(deferred.retryAt);
  });

  it("does not replay an ambiguous non-idempotent staff send", async () => {
    let attempts = 0;
    const coordinator = new StaffChatDeliveryCoordinator({ minimumIntervalMs: 0, sleep: async () => undefined });

    const result = await coordinator.run(
      -100900,
      async () => {
        attempts += 1;
        throw new HttpError("socket closed", Object.assign(new Error("socket closed"), { code: "ECONNRESET" }));
      },
      { replaySafety: "NON_IDEMPOTENT", operationName: "sendMessage" }
    );

    assert.equal(attempts, 1);
    assert.equal(result.diagnostic?.permanence, "UNKNOWN_DELIVERY");
    assert.equal(result.retryAt, null);
  });

  it("retries confirmed temporary failures for replay-safe operations", async () => {
    let attempts = 0;
    const coordinator = new StaffChatDeliveryCoordinator({ minimumIntervalMs: 0, sleep: async () => undefined });

    const result = await coordinator.run(
      -100900,
      async () => {
        attempts += 1;
        if (attempts === 1)
          throw new GrammyError(
            "Internal Server Error",
            { ok: false, error_code: 500, description: "Internal Server Error" },
            "editMessageText",
            {}
          );
        return 42;
      },
      { replaySafety: "REPLAY_SAFE", operationName: "editMessageText" }
    );

    assert.equal(result.value, 42);
    assert.equal(attempts, 2);
  });

  it("retries an ambiguous network error only for a replay-safe operation", async () => {
    let attempts = 0;
    const coordinator = new StaffChatDeliveryCoordinator({ minimumIntervalMs: 0, sleep: async () => undefined });

    const result = await coordinator.run(
      -100900,
      async () => {
        attempts += 1;
        if (attempts === 1)
          throw new HttpError("socket closed", Object.assign(new Error("socket closed"), { code: "ECONNRESET" }));
        return 42;
      },
      { replaySafety: "REPLAY_SAFE", operationName: "editMessageText" }
    );

    assert.equal(result.value, 42);
    assert.equal(attempts, 2);
  });

  it("retries an ambiguous timeout only for a replay-safe operation", async () => {
    let attempts = 0;
    const coordinator = new StaffChatDeliveryCoordinator({ minimumIntervalMs: 0, sleep: async () => undefined });

    const result = await coordinator.run(
      -100900,
      async () => {
        attempts += 1;
        if (attempts === 1)
          throw new HttpError("request timed out", Object.assign(new Error("timeout"), { name: "AbortError" }));
        return 42;
      },
      { replaySafety: "REPLAY_SAFE", operationName: "editMessageText" }
    );

    assert.equal(result.value, 42);
    assert.equal(attempts, 2);
  });

  it("does not retry an arbitrary unknown exception even for a replay-safe operation", async () => {
    let attempts = 0;
    const coordinator = new StaffChatDeliveryCoordinator({ minimumIntervalMs: 0, sleep: async () => undefined });

    const result = await coordinator.run(
      -100900,
      async () => {
        attempts += 1;
        throw new Error("unclassified failure");
      },
      { replaySafety: "REPLAY_SAFE", operationName: "editMessageText" }
    );

    assert.equal(attempts, 1);
    assert.equal(result.diagnostic?.permanence, "UNKNOWN_DELIVERY");
    assert.equal(result.retryAt, null);
  });

  it("keeps unrelated permanent replay-safe edit failures terminal", async () => {
    let attempts = 0;
    const coordinator = new StaffChatDeliveryCoordinator({ minimumIntervalMs: 0, sleep: async () => undefined });

    const result = await coordinator.run(
      -100900,
      async () => {
        attempts += 1;
        throw new GrammyError(
          "Bad Request",
          { ok: false, error_code: 400, description: "Bad Request: message cannot be edited" },
          "editMessageText",
          {}
        );
      },
      { replaySafety: "REPLAY_SAFE", operationName: "editMessageText" }
    );

    assert.equal(attempts, 1);
    assert.equal(result.diagnostic?.permanence, "PERMANENT");
    assert.equal(result.retryAt, null);
  });

  it("does not block a later non-idempotent operation after exhausted replay-safe network retries", async () => {
    let replayAttempts = 0;
    let nonIdempotentAttempts = 0;
    const coordinator = new StaffChatDeliveryCoordinator({ minimumIntervalMs: 0, sleep: async () => undefined });

    const exhausted = await coordinator.run(
      -100900,
      async () => {
        replayAttempts += 1;
        throw new HttpError("socket closed", Object.assign(new Error("socket closed"), { code: "ECONNRESET" }));
      },
      { replaySafety: "REPLAY_SAFE", operationName: "editMessageText" }
    );
    const later = await coordinator.run(
      -100900,
      async () => {
        nonIdempotentAttempts += 1;
        return 42;
      },
      { replaySafety: "NON_IDEMPOTENT", operationName: "sendMessage" }
    );

    assert.equal(replayAttempts, 3);
    assert.equal(exhausted.diagnostic?.permanence, "UNKNOWN_DELIVERY");
    assert.ok(exhausted.retryAt);
    assert.equal(nonIdempotentAttempts, 1);
    assert.equal(later.value, 42);
  });
});
