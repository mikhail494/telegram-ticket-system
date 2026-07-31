import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyEnglishOnlyMessage, preprocessModerationText } from "../src/languageModeration.js";

describe("language moderation classifier", () => {
  it("ignores technical and non-linguistic input", () => {
    for (const value of [
      "https://example.com/test", "/start", "@support_bot #quest $TOKEN", "0x1234567890abcdef1234567890abcdef12345678",
      "a".repeat(64), "`привет мир`", "```\nпривет мир\n```", "12345", "😀😀😀", "> привет мир", "dslkfgnsdfgsdlfgna"
    ]) assert.equal(classifyEnglishOnlyMessage(value), "ignored", value);
  });

  it("removes allowlisted deployment terms without mutating the input", () => {
    const source = "AgentOn привет мир";
    assert.equal(preprocessModerationText(source, ["agenton"]), "привет мир");
    assert.equal(source, "AgentOn привет мир");
  });

  it("detects only meaningful dominant non-English phrases conservatively", () => {
    assert.equal(classifyEnglishOnlyMessage("привет как твои дела сегодня"), "violation");
    assert.equal(classifyEnglishOnlyMessage("مرحبا كيف حالك اليوم"), "violation");
    assert.equal(classifyEnglishOnlyMessage("hello привет"), "ignored");
    assert.equal(classifyEnglishOnlyMessage("да"), "ignored");
  });
});
