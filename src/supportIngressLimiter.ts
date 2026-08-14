export interface SupportIngressLimiterOptions {
  capacity?: number;
  refillPerSecond?: number;
  warningCooldownMs?: number;
  idleTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export type SupportIngressDecision =
  | { allowed: true }
  | { allowed: false; shouldWarn: boolean; retryAfterMs: number };

interface Entry {
  tokens: number;
  lastRefillAt: number;
  lastActivityAt: number;
  lastWarningAt?: number;
}

export const DEFAULT_SUPPORT_INGRESS_LIMITER_OPTIONS = {
  capacity: 30,
  refillPerSecond: 1,
  warningCooldownMs: 30_000,
  idleTtlMs: 30 * 60_000,
  maxEntries: 10_000
} as const;

const PRUNE_EVERY_CHECKS = 128;

/**
 * Process-local, per-customer admission control for private support messages.
 * It deliberately has no timers: state is refilled and cleaned lazily by checks.
 */
export class SupportIngressLimiter {
  private readonly entries = new Map<number, Entry>();
  private readonly capacity: number;
  private readonly refillPerMillisecond: number;
  private readonly warningCooldownMs: number;
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private checksSincePrune = 0;

  constructor(options: SupportIngressLimiterOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_SUPPORT_INGRESS_LIMITER_OPTIONS.capacity;
    const refillPerSecond = options.refillPerSecond ?? DEFAULT_SUPPORT_INGRESS_LIMITER_OPTIONS.refillPerSecond;
    this.refillPerMillisecond = refillPerSecond / 1_000;
    this.warningCooldownMs = options.warningCooldownMs ?? DEFAULT_SUPPORT_INGRESS_LIMITER_OPTIONS.warningCooldownMs;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_SUPPORT_INGRESS_LIMITER_OPTIONS.idleTtlMs;
    this.maxEntries = options.maxEntries ?? DEFAULT_SUPPORT_INGRESS_LIMITER_OPTIONS.maxEntries;
    this.now = options.now ?? Date.now;

    if (this.capacity <= 0 || this.refillPerMillisecond <= 0 || this.warningCooldownMs < 0 || this.idleTtlMs <= 0 || this.maxEntries <= 0) {
      throw new Error("Support ingress limiter options must be positive.");
    }
  }

  get trackedUserCount(): number {
    return this.entries.size;
  }

  check(userId: number): SupportIngressDecision {
    const now = this.now();
    this.checksSincePrune += 1;
    if (this.checksSincePrune >= PRUNE_EVERY_CHECKS) {
      this.pruneIdle(now);
      this.checksSincePrune = 0;
    }

    let entry = this.entries.get(userId);
    if (!entry) {
      this.evictToCapacity();
      entry = {
        tokens: this.capacity,
        lastRefillAt: now,
        lastActivityAt: now
      };
      this.entries.set(userId, entry);
    } else {
      const elapsed = Math.max(0, now - entry.lastRefillAt);
      entry.tokens = Math.min(this.capacity, entry.tokens + elapsed * this.refillPerMillisecond);
      entry.lastRefillAt = Math.max(entry.lastRefillAt, now);
      entry.lastActivityAt = Math.max(entry.lastActivityAt, now);
      this.touch(userId, entry);
    }

    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      return { allowed: true };
    }

    const shouldWarn = entry.lastWarningAt === undefined || now - entry.lastWarningAt >= this.warningCooldownMs;
    if (shouldWarn) entry.lastWarningAt = now;
    return {
      allowed: false,
      shouldWarn,
      retryAfterMs: Math.max(1, Math.ceil((1 - entry.tokens) / this.refillPerMillisecond))
    };
  }

  private touch(userId: number, entry: Entry): void {
    this.entries.delete(userId);
    this.entries.set(userId, entry);
  }

  private pruneIdle(now: number): void {
    for (const [userId, entry] of this.entries) {
      if (now - entry.lastActivityAt <= this.idleTtlMs) continue;
      this.entries.delete(userId);
    }
  }

  private evictToCapacity(): void {
    while (this.entries.size >= this.maxEntries) {
      const oldestUserId = this.entries.keys().next().value;
      if (oldestUserId === undefined) return;
      this.entries.delete(oldestUserId);
    }
  }
}
