import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.BOT_TOKEN = "123456:TEST_BOT_TOKEN";
process.env.STAFF_CHAT_ID = "-100900";
process.env.DATABASE_URL = ":memory:";
process.env.LOG_LEVEL = "silent";

const { classifyEnglishOnlyMessage, classifyModerationLanguage, preprocessModerationText } = await import("../src/languageModeration.js");

const REAL_NON_ENGLISH_CHAT_CORPUS = [
  "Misi yg mana",
  "gatau ga ada status approve task yg mana",
  "JD skarang langsung ke wallet fluxa ?",
  "web agentonya dulu nanti baru wd ke fluxa",
  "Tunggu seminggu/event taco end baru di proses \u{1F602}",
  "haha nunggu ruygful kenya",
  "Si anjj pantes udah 2 hari ini ga ada tugas ternyata di yang ambil semua tugas nya babi",
  "Maksudnya bg",
  "lu ngetik apaan kocak",
  "maksud dia kaya nya gk bakalan ada lagi tugas baru karena udah di ambil alih sama agent yang di buat oleh dev nyamungkin\u{1F622}",
  "Beta dalam uji coba faham ga si Beta?",
  "Gimna kalo bener\u00b2di rilis\u{1F974}",
  "Jjaja banyak yang cepu",
  "klian klo kebanyakan ngoceh disini kalah cepet end, bikin rusuh. mending bahas di ch/grup masing\u00b2, jangan matiin rejeki org",
  "Setuju",
  "Nah ini kebanyakan komplen ga dapet lah gaada task lah",
  "berisik disini malah bikin rusuh jd cepet end",
  "Emng edah end co",
  "Wd toco aja gk land yang gak tau work berapa dolar nya\u{1F974}",
  "Kok toco gw udah 2 hari WD ga land. Skarang malah gini",
  "yauda gausah ribut disini pake bhs kita, udh ke ban masih aja ribut, mlah bkin makin ancur aja"
] as const;

const REAL_ALLOWED_LATIN_CHAT_CORPUS = [
  "chek landing $2",
  "Rcv",
  "good sir",
  "both no help my withdrwal",
  "please keep it English",
  "How?",
  "Skill issue, translation apps are free.",
  "Bro wants the entire internet in English \u{1F4B0}",
  "Language issue too if can't speak in english need to be quite",
  "Bro lost the English competition he started pfft",
  "Abu",
  "ok",
  "gm",
  "lol",
  "BTC",
  "USDT",
  "wallet fluxa",
  "withdrawal pending",
  "agent status approve task",
  "The support agent will review the wallet status and send another update tomorrow."
] as const;

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
    for (const value of ["ok", "gm", "hi", "lol", "BTC", "USDT", "ga", "di", "jd", "bg", "wd", "123456", "https://example.com", "@support_bot", "😀😀", "Alex"]) {
      assert.equal(classifyModerationLanguage(value), "uncertain", value);
      assert.equal(classifyEnglishOnlyMessage(value), "ignored", value);
    }
    assert.equal(classifyModerationLanguage("The support agent will review the update from Jakarta and send the next response tomorrow."), "english");
    assert.equal(classifyEnglishOnlyMessage("Saya membutuhkan bantuan dengan product update dan status tiket saya."), "violation");
  });

  it("detects real Indonesian and Malay Telegram chat slang", () => {
    for (const value of REAL_NON_ENGLISH_CHAT_CORPUS) {
      assert.equal(classifyModerationLanguage(value), "non_english", value);
      assert.equal(classifyEnglishOnlyMessage(value), "violation", value);
    }
  });

  it("keeps real allowed Latin chat and adversarial English inputs non-actionable", () => {
    const adversarialEnglish = [
      "The GA release is scheduled for tomorrow and the support team will post an update.",
      "JD from the team will check the wallet status.",
      "The beta is still in testing and the agent will reply later.",
      "Please check the task status in the web agent.",
      "We can use the Indonesian word setuju as an example in this documentation."
    ];
    for (const value of [...REAL_ALLOWED_LATIN_CHAT_CORPUS, ...adversarialEnglish]) {
      assert.equal(classifyEnglishOnlyMessage(value), "ignored", value);
    }
  });
});
