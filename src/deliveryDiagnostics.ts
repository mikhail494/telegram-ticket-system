import { GrammyError, HttpError } from "grammy";

export const DELIVERY_ERROR_CATEGORIES = [
  "USER_BLOCKED_BOT",
  "USER_DEACTIVATED",
  "CHAT_UNAVAILABLE",
  "FORBIDDEN",
  "RATE_LIMITED",
  "TELEGRAM_BAD_REQUEST",
  "TELEGRAM_SERVER_ERROR",
  "NETWORK_TIMEOUT",
  "NETWORK_ERROR",
  "UNKNOWN_TELEGRAM_ERROR"
] as const;

export type DeliveryErrorCategory = (typeof DELIVERY_ERROR_CATEGORIES)[number];
export type DeliveryErrorPermanence = "PERMANENT" | "TEMPORARY" | "UNKNOWN_DELIVERY";

export interface NormalizedDeliveryError {
  category: DeliveryErrorCategory;
  permanence: DeliveryErrorPermanence;
  method: string | null;
  telegramErrorCode: number | null;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
  description: string | null;
  occurredAt: string;
}

const MAX_DESCRIPTION_LENGTH = 180;

export function normalizeTelegramDeliveryError(error: unknown, occurredAt = new Date()): NormalizedDeliveryError {
  if (error instanceof GrammyError) {
    const description = sanitizeDescription(error.description);
    const lower = description.toLowerCase();
    const retryAfter = typeof error.parameters.retry_after === "number" ? error.parameters.retry_after : null;
    let category: DeliveryErrorCategory = "UNKNOWN_TELEGRAM_ERROR";
    let permanence: DeliveryErrorPermanence = "UNKNOWN_DELIVERY";

    if (lower.includes("bot was blocked by the user")) {
      category = "USER_BLOCKED_BOT";
      permanence = "PERMANENT";
    } else if (lower.includes("user is deactivated")) {
      category = "USER_DEACTIVATED";
      permanence = "PERMANENT";
    } else if (lower.includes("chat not found")) {
      category = "CHAT_UNAVAILABLE";
      permanence = "PERMANENT";
    } else if (error.error_code === 429) {
      category = "RATE_LIMITED";
      permanence = "TEMPORARY";
    } else if (error.error_code >= 500 && error.error_code <= 599) {
      category = "TELEGRAM_SERVER_ERROR";
      permanence = "TEMPORARY";
    } else if (error.error_code === 403) {
      category = "FORBIDDEN";
      permanence = "PERMANENT";
    } else if (error.error_code >= 400 && error.error_code <= 499) {
      category = "TELEGRAM_BAD_REQUEST";
      permanence = "PERMANENT";
    }

    return {
      category,
      permanence,
      method: error.method,
      telegramErrorCode: error.error_code,
      httpStatus: null,
      retryAfterSeconds: retryAfter,
      description,
      occurredAt: occurredAt.toISOString()
    };
  }

  if (error instanceof HttpError) {
    const cause = error.error;
    const code = errorCodeOf(cause);
    const name = errorNameOf(cause);
    const isTimeout = name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT";
    return {
      category: isTimeout ? "NETWORK_TIMEOUT" : "NETWORK_ERROR",
      permanence: isTimeout ? "UNKNOWN_DELIVERY" : "TEMPORARY",
      method: null,
      telegramErrorCode: null,
      httpStatus: null,
      retryAfterSeconds: null,
      description: null,
      occurredAt: occurredAt.toISOString()
    };
  }

  return {
    category: "UNKNOWN_TELEGRAM_ERROR",
    permanence: "UNKNOWN_DELIVERY",
    method: null,
    telegramErrorCode: null,
    httpStatus: null,
    retryAfterSeconds: null,
    description: null,
    occurredAt: occurredAt.toISOString()
  };
}

export function formatDeliveryFailureCategory(category: DeliveryErrorCategory): string {
  return category.replaceAll("_", " ");
}

function sanitizeDescription(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_LENGTH);
}

function errorCodeOf(value: unknown): string | null {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" ? value.code : null;
}

function errorNameOf(value: unknown): string | null {
  return value instanceof Error ? value.name : null;
}
