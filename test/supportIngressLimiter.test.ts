import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SupportIngressLimiter } from "../src/supportIngressLimiter.js";

function createLimiter(now: () => number, overrides: Partial<ConstructorParameters<typeof SupportIngressLimiter>[0]> = {}) {
  return new SupportIngressLimiter({
    now,
    capacity: 30,
    refillPerSecond: 1,
    warningCooldownMs: 30_000,
    idleTtlMs: 30 * 60_000,
    maxEntries: 10_000,
    ...overrides
  });
}

describe("SupportIngressLimiter", () => {
  it("allows a legitimate immediate burst of twenty messages", () => {
    let now = 0;
    const limiter = createLimiter(() => now);

    for (let index = 0; index < 20; index += 1) {
      assert.deepEqual(limiter.check(1), { allowed: true });
    }
  });

  it("enforces capacity, refills continuously, and clamps at capacity", () => {
    let now = 0;
    const limiter = createLimiter(() => now);

    for (let index = 0; index < 30; index += 1) assert.equal(limiter.check(1).allowed, true);
    const throttled = limiter.check(1);
    assert.equal(throttled.allowed, false);
    if (!throttled.allowed) {
      assert.equal(throttled.shouldWarn, true);
      assert.equal(throttled.retryAfterMs, 1_000);
    }

    now += 1_000;
    assert.deepEqual(limiter.check(1), { allowed: true });
    now += 60_000;
    for (let index = 0; index < 30; index += 1) assert.equal(limiter.check(1).allowed, true);
    assert.equal(limiter.check(1).allowed, false);
  });

  it("isolates users and rate-limits warnings independently", () => {
    let now = 0;
    const limiter = createLimiter(() => now, { refillPerSecond: 0.01 });

    for (let index = 0; index < 30; index += 1) limiter.check(1);
    const first = limiter.check(1);
    assert.equal(first.allowed, false);
    if (!first.allowed) assert.equal(first.shouldWarn, true);
    const repeated = limiter.check(1);
    assert.equal(repeated.allowed, false);
    if (!repeated.allowed) assert.equal(repeated.shouldWarn, false);
    assert.deepEqual(limiter.check(2), { allowed: true });

    now += 30_000;
    const afterCooldown = limiter.check(1);
    assert.equal(afterCooldown.allowed, false);
    if (!afterCooldown.allowed) assert.equal(afterCooldown.shouldWarn, true);
  });

  it("evicts idle entries, bounds tracked users, and handles a clock moving backward", () => {
    let now = 10_000;
    const limiter = createLimiter(() => now, { idleTtlMs: 1_000, maxEntries: 3 });
    limiter.check(1);
    limiter.check(2);
    limiter.check(3);
    limiter.check(4);
    assert.ok(limiter.trackedUserCount <= 3);

    now += 1_001;
    for (let index = 0; index < 128; index += 1) limiter.check(5);
    assert.equal(limiter.trackedUserCount, 1);

    let clock = 10_000;
    const backwards = createLimiter(() => clock);
    for (let index = 0; index < 30; index += 1) backwards.check(9);
    clock = 9_000;
    assert.equal(backwards.check(9).allowed, false);
  });
});
