import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GrammyError } from "grammy";
import { StaffChatDeliveryCoordinator } from "../src/staffChatDelivery.js";

describe("staff-only batch delivery coordination", () => {
  it("retries a Telegram 429 after retry_after without duplicating a successful operation", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const coordinator = new StaffChatDeliveryCoordinator({
      minimumIntervalMs: 0,
      sleep: async (milliseconds) => { delays.push(milliseconds); }
    });

    const result = await coordinator.run(-100900, async () => {
      attempts += 1;
      if (attempts === 1) throw new GrammyError("Too Many Requests", { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }, "sendMessage", {});
      return 42;
    });

    assert.equal(result.value, 42);
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [1250]);
  });

  it("defers a long rate limit instead of blocking the update handler", async () => {
    const coordinator = new StaffChatDeliveryCoordinator({ minimumIntervalMs: 0, sleep: async () => undefined });
    const result = await coordinator.run(-100900, async () => {
      throw new GrammyError("Too Many Requests", { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 20 } }, "sendMessage", {});
    });

    assert.equal(result.value, undefined);
    assert.equal(result.diagnostic?.category, "RATE_LIMITED");
    assert.ok(result.retryAt);
  });

  it("coordinates later staff-only operations behind a long retry_after", async () => {
    const coordinator = new StaffChatDeliveryCoordinator({ minimumIntervalMs: 0, sleep: async () => undefined });
    await coordinator.run(-100900, async () => {
      throw new GrammyError("Too Many Requests", { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 20 } }, "sendMessage", {});
    });
    let called = false;
    const deferred = await coordinator.run(-100900, async () => {
      called = true;
      return 1;
    });

    assert.equal(called, false);
    assert.equal(deferred.diagnostic?.category, "RATE_LIMITED");
    assert.ok(deferred.retryAt);
  });
});
