import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GrammyError, HttpError } from "grammy";
import {
  isForumTopicClosed,
  isForumTopicUnavailable,
  isTicketRoutingTopicUnavailable,
} from "../src/forumTopicErrors.js";

function telegramBadRequest(description: string): GrammyError {
  return new GrammyError("Telegram API error", { ok: false, error_code: 400, description }, "sendMessage", {});
}

describe("forum topic error classification", () => {
  it("recognizes known missing forum-topic responses", () => {
    assert.equal(isForumTopicUnavailable(telegramBadRequest("Bad Request: message thread not found")), true);
    assert.equal(isForumTopicUnavailable(telegramBadRequest("Bad Request: topic not found")), true);
  });

  it("keeps closed topics distinct from missing topics", () => {
    const closed = telegramBadRequest("Bad Request: topic is closed");
    assert.equal(isForumTopicClosed(closed), true);
    assert.equal(isForumTopicUnavailable(closed), false);
  });

  it("accepts reply-target wording only for ticket routing to its forum target", () => {
    const replyTarget = telegramBadRequest("Bad Request: message to be replied not found");
    assert.equal(isForumTopicUnavailable(replyTarget), false);
    assert.equal(isTicketRoutingTopicUnavailable(replyTarget), true);
  });

  it("does not infer a missing topic from generic fields, errors, or transport failures", () => {
    assert.equal(isForumTopicUnavailable(telegramBadRequest("Bad Request: message_thread_id is invalid")), false);
    assert.equal(isForumTopicUnavailable(new Error("message_thread_id is invalid")), false);
    assert.equal(isForumTopicUnavailable(new HttpError("socket closed", new Error("socket closed"))), false);
  });
});
