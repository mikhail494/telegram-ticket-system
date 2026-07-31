import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GrammyError, HttpError } from "grammy";
import { normalizeTelegramDeliveryError } from "../src/deliveryDiagnostics.js";

function grammy(description: string, errorCode: number, parameters: Record<string, unknown> = {}): GrammyError {
  return new GrammyError("Telegram API error", {
    ok: false,
    error_code: errorCode,
    description,
    parameters
  }, "sendMessage", { chat_id: 123, text: "private reply must never appear" });
}

describe("batch delivery diagnostics", () => {
  it("classifies permanent Telegram recipient failures without retaining request payloads", () => {
    const normalized = normalizeTelegramDeliveryError(grammy("Forbidden: bot was blocked by the user", 403));
    assert.equal(normalized.category, "USER_BLOCKED_BOT");
    assert.equal(normalized.permanence, "PERMANENT");
    assert.equal(normalized.method, "sendMessage");
    assert.equal(normalized.telegramErrorCode, 403);
    assert.equal(JSON.stringify(normalized).includes("private reply must never appear"), false);
  });

  it("classifies deactivated and unavailable chats as permanent", () => {
    assert.equal(normalizeTelegramDeliveryError(grammy("Forbidden: user is deactivated", 403)).category, "USER_DEACTIVATED");
    assert.equal(normalizeTelegramDeliveryError(grammy("Bad Request: chat not found", 400)).category, "CHAT_UNAVAILABLE");
  });

  it("classifies Telegram rate limits as temporary and retains retry_after", () => {
    const normalized = normalizeTelegramDeliveryError(grammy("Too Many Requests: retry after 39", 429, { retry_after: 39 }));
    assert.equal(normalized.category, "RATE_LIMITED");
    assert.equal(normalized.permanence, "TEMPORARY");
    assert.equal(normalized.retryAfterSeconds, 39);
  });

  it("classifies Telegram 5xx and uncertain network failures safely", () => {
    assert.equal(normalizeTelegramDeliveryError(grammy("Internal Server Error", 500)).category, "TELEGRAM_SERVER_ERROR");
    const timeout = new HttpError("request timed out", Object.assign(new Error("timeout"), { name: "AbortError" }));
    assert.equal(normalizeTelegramDeliveryError(timeout).permanence, "UNKNOWN_DELIVERY");
  });
});
