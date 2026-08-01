import { normalizeTelegramDeliveryError, type NormalizedDeliveryError } from "./deliveryDiagnostics.js";

export interface StaffDeliveryResult<T> {
  value?: T;
  diagnostic?: NormalizedDeliveryError;
  retryAt: string | null;
}

export interface StaffChatDeliveryOptions {
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  minimumIntervalMs?: number;
}

const MAX_INLINE_DELAY_MS = 5_000;
const MAX_ATTEMPTS = 3;

/** Serializes staff-only Telegram work for each supergroup and retries only confirmed temporary failures. */
export class StaffChatDeliveryCoordinator {
  private readonly queues = new Map<number, Promise<void>>();
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly minimumIntervalMs: number;
  private readonly lastSentAt = new Map<number, number>();
  private readonly blockedUntil = new Map<number, number>();
  private readonly blockedDiagnostics = new Map<number, NormalizedDeliveryError>();

  constructor(options: StaffChatDeliveryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.minimumIntervalMs = options.minimumIntervalMs ?? 250;
  }

  run<T>(chatId: number, operation: () => Promise<T>): Promise<StaffDeliveryResult<T>> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.execute(chatId, operation));
    this.queues.set(chatId, task.then(() => undefined, () => undefined));
    return task;
  }

  private async execute<T>(chatId: number, operation: () => Promise<T>): Promise<StaffDeliveryResult<T>> {
    const now = this.now().getTime();
    const blockedUntil = this.blockedUntil.get(chatId) ?? 0;
    if (blockedUntil > now) {
      const delay = blockedUntil - now;
      const diagnostic = this.blockedDiagnostics.get(chatId);
      if (delay > MAX_INLINE_DELAY_MS) return { diagnostic, retryAt: new Date(blockedUntil).toISOString() };
      await this.sleep(delay);
    }
    const elapsed = this.now().getTime() - (this.lastSentAt.get(chatId) ?? 0);
    if (elapsed >= 0 && elapsed < this.minimumIntervalMs) await this.sleep(this.minimumIntervalMs - elapsed);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const value = await operation();
        this.lastSentAt.set(chatId, this.now().getTime());
        return { value, retryAt: null };
      } catch (error) {
        const diagnostic = normalizeTelegramDeliveryError(error, this.now());
        const delay = retryDelay(diagnostic, attempt);
        if (diagnostic.permanence !== "TEMPORARY" || delay === null) {
          return { diagnostic, retryAt: diagnostic.permanence === "TEMPORARY" ? futureIso(this.now(), retryDelay(diagnostic, 1) ?? 1_000) : null };
        }
        if (delay > MAX_INLINE_DELAY_MS || attempt === MAX_ATTEMPTS) {
          const retryAt = futureIso(this.now(), delay);
          this.blockedUntil.set(chatId, new Date(retryAt).getTime());
          this.blockedDiagnostics.set(chatId, diagnostic);
          return { diagnostic, retryAt };
        }
        await this.sleep(delay);
      }
    }
    return { diagnostic: normalizeTelegramDeliveryError(new Error("Staff delivery retry exhausted"), this.now()), retryAt: futureIso(this.now(), 1_000) };
  }
}

function retryDelay(diagnostic: NormalizedDeliveryError, attempt: number): number | null {
  if (diagnostic.category === "RATE_LIMITED") return ((diagnostic.retryAfterSeconds ?? 1) * 1_000) + 250;
  if (diagnostic.category === "TELEGRAM_SERVER_ERROR" || diagnostic.category === "NETWORK_ERROR") return 500 * 2 ** (attempt - 1);
  return null;
}

function futureIso(now: Date, delay: number): string {
  return new Date(now.getTime() + delay).toISOString();
}
