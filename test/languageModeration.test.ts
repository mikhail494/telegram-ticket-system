import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.BOT_TOKEN = "123456:TEST_BOT_TOKEN";
process.env.STAFF_CHAT_ID = "-100900";
process.env.DATABASE_URL = ":memory:";
process.env.LOG_LEVEL = "silent";

const { classifyEnglishOnlyMessage, classifyModerationLanguage, preprocessModerationText } = await import("../src/languageModeration.js");

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

  it("identifies confident English and common non-English Latin languages offline", () => {
    assert.equal(classifyModerationLanguage("This is a complete English support message explaining the account issue and the requested next steps."), "english");
    for (const value of [
      "Saya ingin mengetahui status permintaan saya karena belum ada balasan dari tim dukungan.",
      "Saya mahu mengetahui status permintaan saya kerana belum ada balasan daripada pasukan sokongan.",
      "Necesito ayuda con mi solicitud porque todavia no he recibido una respuesta del equipo.",
      "Preciso de ajuda com minha solicitacao porque ainda nao recebi uma resposta da equipe.",
      "Je voudrais obtenir de aide concernant ma demande car je ai pas encore recu de reponse.",
      "Ich benoetige Hilfe mit meiner Anfrage, da ich noch keine Antwort vom Support erhalten habe."
    ]) {
      assert.equal(classifyModerationLanguage(value), "non_english", value);
      assert.equal(classifyEnglishOnlyMessage(value), "violation", value);
    }
  });

  it("keeps low-signal and mixed English text uncertain or English", () => {
    for (const value of ["ok", "gm", "hi", "lol", "BTC", "USDT", "123456", "https://example.com", "@support_bot", "😀😀", "Alex"]) {
      assert.equal(classifyModerationLanguage(value), "uncertain", value);
      assert.equal(classifyEnglishOnlyMessage(value), "ignored", value);
    }
    assert.equal(classifyModerationLanguage("The support agent will review the update from Jakarta and send the next response tomorrow."), "english");
    assert.equal(classifyEnglishOnlyMessage("Saya membutuhkan bantuan dengan product update dan status tiket saya."), "violation");
  });
});
