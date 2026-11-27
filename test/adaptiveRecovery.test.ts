import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { SupportDatabase } from "../src/db.js";
import { extractAdaptiveModerationFeatures } from "../src/languageModeration.js";
import { loadAdaptivePrivacy } from "../src/adaptivePrivacy.js";
import { adaptiveRecoveryFiles } from "../src/adaptiveRecoveryFiles.js";
import { ADAPTIVE_RECOVERY_CONFIRMATION } from "../src/persistence/adaptivePrivacyRecovery.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-recovery-"));
  const file = path.join(directory, "support.db");
  const key = path.join(directory, "private", "adaptive.key");
  const db = new SupportDatabase(file, { adaptiveKeyPath: key });
  db.upsertUser({ telegramId: 1, firstName: "Synthetic" });
  const ticket = db.createTicket(1, -100);
  db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", text: "Synthetic preserved transcript" });
  db.createTicketOutboundDeliveryIntent({
    operationKey: "staff-message:-100:99",
    ticketId: ticket.id,
    direction: "STAFF_TO_USER",
    sourceChatId: -100,
    sourceMessageId: 99,
    deliveryChatId: 1,
    senderType: "STAFF",
    senderDisplayName: "Support",
    text: "Synthetic unresolved reply",
  });
  db.markTicketOutboundDeliveryUnknown("staff-message:-100:99", "Synthetic ambiguity.");
  db.createTicketBatchExport({
    exportId: "preserved-export",
    staffChatId: -100,
    createdAt: "2026-11-21T00:00:00.000Z",
    selectionMode: "all_active",
    ticketCount: 1,
    items: [{ ticketId: ticket.id, snapshotToken: "sha256:preserved" }],
  });
  db.createTicketBatchAnswerPackage({
    answerPackageId: "preserved-package",
    exportId: "preserved-export",
    staffChatId: -100,
    packageHash: "sha256:preserved",
    sourceChatId: 10,
    sourceMessageId: 100,
    packageCreatedAt: "2026-11-21T00:00:00.000Z",
    items: [
      {
        ticket_id: ticket.id,
        snapshot_token: "sha256:preserved",
        action: "reply_keep_open",
        reply_text: "Synthetic Batch reply",
        follow_up_state: "NONE",
        internal_note: null,
      },
    ],
  });
  db.upsertUser({ telegramId: 2, firstName: "Synthetic archive" });
  const archived = db.createTicket(2, -100);
  db.addMessage({ ticketId: archived.id, direction: "USER_TO_STAFF", text: "Synthetic archived message" });
  db.updateTicketStatus(archived.id, "CLOSED");
  db.claimTicketArchiveSummary(archived.id, 200);
  db.markTicketArchiveSummarySent(archived.id, 201);
  db.claimTicketArchiveDocument(archived.id);
  db.markTicketArchiveDocumentDelivered(archived.id, 202);
  assert.equal(db.finalizeTicketArchiveDelivery(archived.id), true);
  db.upsertTeamMember({ userId: 10, role: "OWNER", addedBy: 10 });
  db.upsertLanguageModerationUserState({
    chat_id: -200,
    user_telegram_id: 1,
    username: null,
    current_strikes: 2,
    sanction_tier: 1,
    first_strike_at: "2026-11-21T00:00:00.000Z",
  });
  db.addLanguageModerationViolation({
    chat_id: -200,
    user_telegram_id: 1,
    message_id: 77,
    username: null,
    cycle_tier: 1,
  });
  db.recordLanguageModerationObservation({
    chatId: -200,
    messageId: 77,
    userTelegramId: 1,
    features: extractAdaptiveModerationFeatures("novelphrase alpha")!,
    observedAt: "2026-11-21T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
  });
  db.recordLanguageModerationOwnerFeedback({
    chatId: -200,
    messageId: 77,
    userTelegramId: 1,
    recordedAt: "2026-11-21T00:00:00.000Z",
    retainUntil: "2027-01-01T00:00:00.000Z",
  });
  db.close();
  return {
    directory,
    file,
    key,
    recover: () =>
      SupportDatabase.recoverAdaptivePrivacy(file, {
        adaptiveKeyPath: key,
        confirmation: ADAPTIVE_RECOVERY_CONFIRMATION,
      }),
  };
}
function businessState(file: string): Record<string, unknown> {
  const db = new Database(file, { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    return Object.fromEntries(
      tables
        .filter(
          ({ name }) =>
            ![
              "adaptive_moderation_hash_format",
              "language_moderation_message_features",
              "language_moderation_learning_signal_observations",
              "language_moderation_owner_feedback",
              "language_moderation_adaptive_maintenance",
            ].includes(name)
        )
        .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()])
    );
  } finally {
    db.close();
  }
}

test("offline key recovery requires strong confirmation and refuses an available key", () => {
  const f = fixture();
  try {
    assert.throws(
      () => SupportDatabase.recoverAdaptivePrivacy(f.file, { adaptiveKeyPath: f.key, confirmation: "yes" }),
      /explicit.*confirmation/
    );
    assert.throws(f.recover, /key is available/);
    const db = new SupportDatabase(f.file, { adaptiveKeyPath: f.key });
    assert.equal(db.countLanguageModerationOwnerFeedback(-200), 1);
    db.close();
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

for (const fault of ["restored original", "missing candidate", "mismatched candidate"] as const) {
  test(`pre-commit recovery journal preserves adaptive evidence: ${fault}`, () => {
    const f = fixture();
    const readEvidence = () => {
      const db = new Database(f.file, { readonly: true });
      try {
        return [
          "adaptive_moderation_hash_format",
          "language_moderation_message_features",
          "language_moderation_learning_signal_observations",
          "language_moderation_owner_feedback",
          "language_moderation_adaptive_maintenance",
        ].map((table) => db.prepare(`SELECT * FROM "${table}"`).all());
      } finally {
        db.close();
      }
    };
    try {
      const original = fs.readFileSync(f.key);
      const originalKeyId = loadAdaptivePrivacy(f.file, f.key, undefined, false).keyId;
      fs.unlinkSync(f.key);
      const files = adaptiveRecoveryFiles(f.file, f.key);
      const journal = files.prepare(originalKeyId);
      const candidate = path.join(path.dirname(f.key), `recovery-${journal.nonce}.key`);
      const before = readEvidence();

      if (fault === "restored original") {
        fs.writeFileSync(f.key, original, { mode: 0o600 });
        assert.throws(f.recover, /key is available/);
        assert.equal(fs.readFileSync(f.key).equals(original), true);
      } else if (fault === "missing candidate") {
        fs.unlinkSync(candidate);
        assert.throws(f.recover, { code: "MISSING" });
      } else {
        fs.writeFileSync(candidate, original);
        assert.throws(f.recover, { code: "MISMATCH" });
      }

      assert.deepEqual(readEvidence(), before);
      assert.deepEqual(files.read(), journal);
    } finally {
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  });
}

test("offline recovery rejects even an idle open application connection before clearing evidence", () => {
  const f = fixture();
  const live = new SupportDatabase(f.file, { adaptiveKeyPath: f.key });
  try {
    fs.unlinkSync(f.key);
    assert.throws(f.recover, /locked|busy/i);
    assert.equal(live.countLanguageModerationOwnerFeedback(-200), 1);
  } finally {
    live.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("an actual process exit after reset commit resumes with the same key and business state", () => {
  const f = fixture();
  const before = businessState(f.file);
  try {
    fs.unlinkSync(f.key);
    const script = `
      import Database from 'better-sqlite3';
      import { SupportDatabase } from ${JSON.stringify(new URL("../src/db.ts", import.meta.url).href)};
      const execute = Database.prototype.exec;
      Database.prototype.exec = function(sql) {
        const result = execute.call(this, sql);
        if (sql === 'COMMIT') process.exit(23);
        return result;
      };
      SupportDatabase.recoverAdaptivePrivacy(process.argv[1], { adaptiveKeyPath: process.argv[2], confirmation: ${JSON.stringify(ADAPTIVE_RECOVERY_CONFIRMATION)} });
    `;
    const crashed = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, f.file, f.key],
      { encoding: "utf8" }
    );
    assert.equal(crashed.status, 23, crashed.stdout + crashed.stderr);
    assert.equal(fs.existsSync(f.key), false);
    const result = f.recover();
    assert.equal(result.resumed, true);
    assert.equal(result.resetPerformed, false);
    assert.deepEqual(businessState(f.file), before);
    const reopened = new SupportDatabase(f.file, { adaptiveKeyPath: f.key });
    assert.equal(reopened.countLanguageModerationOwnerFeedback(-200), 0);
    reopened.close();
    const raw = new Database(f.file, { readonly: true });
    try {
      assert.equal(raw.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(raw.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

for (const phase of [
  "normal",
  "before-journal",
  "before-commit",
  "after-commit",
  "after-publish",
  "during-vacuum",
] as const) {
  test(`lost-key recovery preserves all business rows and resumes safely: ${phase}`, () => {
    const f = fixture();
    const before = businessState(f.file);
    fs.unlinkSync(f.key);
    let injection: { mock: { restore(): void } } | undefined;
    try {
      if (phase === "before-commit" || phase === "after-commit" || phase === "during-vacuum") {
        const original = Database.prototype.exec;
        injection = mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
          if ((sql === "COMMIT" && phase === "before-commit") || (sql === "VACUUM" && phase === "during-vacuum"))
            throw new Error("injected interruption");
          const result = original.call(this, sql);
          if (sql === "COMMIT" && phase === "after-commit") throw new Error("injected interruption");
          return result;
        });
      } else if (phase === "after-publish" || phase === "before-journal") {
        const original = fs.linkSync;
        injection = mock.method(fs, "linkSync", (source: fs.PathLike, destination: fs.PathLike) => {
          if (phase === "before-journal" && String(destination).endsWith(".recovery.json"))
            throw new Error("injected interruption");
          original(source, destination);
          if (phase === "after-publish" && destination === f.key) throw new Error("injected interruption");
        });
      }
      if (phase !== "normal") {
        assert.throws(f.recover, /injected interruption/);
        injection!.mock.restore();
        assert.deepEqual(businessState(f.file), before);
        if (phase === "before-journal" || phase === "before-commit") {
          const unchanged = new Database(f.file, { readonly: true });
          try {
            assert.equal(
              (unchanged.prepare("SELECT COUNT(*) AS n FROM language_moderation_owner_feedback").get() as { n: number })
                .n,
              1
            );
          } finally {
            unchanged.close();
          }
        }
      }
      const result = f.recover();
      assert.equal(result.resumed, phase !== "normal" && phase !== "before-journal");
      assert.equal(
        result.resetPerformed,
        phase === "normal" || phase === "before-journal" || phase === "before-commit"
      );
      assert.deepEqual(businessState(f.file), before);
      const reopened = new SupportDatabase(f.file, { adaptiveKeyPath: f.key });
      assert.equal(reopened.countLanguageModerationOwnerFeedback(-200), 0);
      assert.equal(reopened.getLanguageModerationMessageFeatures(-200, 77), undefined);
      assert.equal(reopened.listLanguageModerationLearningSignals(-200).length, 0);
      reopened.close();
      const raw = new Database(f.file, { readonly: true });
      assert.deepEqual(raw.prepare("SELECT COUNT(*) AS n, MAX(id) AS latest FROM schema_migrations").get(), {
        n: 28,
        latest: 28,
      });
      assert.equal(raw.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(raw.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(raw.pragma("foreign_key_check"), []);
      raw.close();
      assert.equal(fs.existsSync(`${f.key}.recovery.json`), false);
    } finally {
      injection?.mock.restore();
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  });
}
