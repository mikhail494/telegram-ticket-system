import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  ADAPTIVE_STORAGE_MAINTENANCE_INTERVAL,
  MAX_ADAPTIVE_MESSAGE_FEATURES_PER_CHAT,
  MAX_ADAPTIVE_SIGNAL_OBSERVATIONS_PER_CHAT,
} from "../src/adaptiveModerationPolicy.js";
import { SupportDatabase } from "../src/db.js";
import {
  ADAPTIVE_LEARNING_HORIZON_MS,
  ADAPTIVE_MESSAGE_FEATURE_TTL_MS,
  classifyModerationLanguage,
  extractAdaptiveModerationFeatures,
  scoreAdaptiveModerationEvidence,
} from "../src/languageModeration.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-manual-moderation-"));
  directories.push(directory);
  return path.join(directory, "support.db");
}

describe("manual moderation persistence", () => {
  it("adds migration 24 once with safe manual defaults and hash-only adaptive storage", async () => {
    const filename = await databasePath();
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE managed_public_chats (
        chat_id INTEGER PRIMARY KEY,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE language_moderation_message_authors (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        user_telegram_id INTEGER NOT NULL,
        username TEXT,
        message_thread_id INTEGER,
        created_at TEXT NOT NULL,
        PRIMARY KEY(chat_id, message_id)
      );
      INSERT INTO sentinel (id, value) VALUES (1, 'preserved');
      INSERT INTO managed_public_chats (chat_id, active, created_at, updated_at)
      VALUES (-100701, 1, '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z');
      INSERT INTO language_moderation_message_authors
        (chat_id, message_id, user_telegram_id, username, message_thread_id, created_at)
      VALUES (-100701, 44, 501, 'preserved_user', 7, '2026-09-04T00:00:00.000Z');
    `);
    const migration = legacy.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)");
    for (let id = 1; id <= 23; id += 1) migration.run(id, `migration_${id}`, "2026-09-04T00:00:00.000Z");
    legacy.close();

    new SupportDatabase(filename).close();
    new SupportDatabase(filename).close();

    const inspected = new Database(filename, { readonly: true });
    try {
      assert.equal(
        (inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 24").get() as { count: number })
          .count,
        1
      );
      assert.equal(
        (inspected.prepare("SELECT value FROM sentinel WHERE id = 1").get() as { value: string }).value,
        "preserved"
      );
      assert.deepEqual(
        inspected
          .prepare("SELECT manual_strikes_enabled, manual_strike_reaction FROM managed_public_chats WHERE chat_id = ?")
          .get(-100701),
        { manual_strikes_enabled: 1, manual_strike_reaction: "👀" }
      );
      assert.deepEqual(
        inspected
          .prepare(
            "SELECT user_telegram_id, username, message_thread_id FROM language_moderation_message_authors WHERE chat_id = ? AND message_id = ?"
          )
          .get(-100701, 44),
        { user_telegram_id: 501, username: "preserved_user", message_thread_id: 7 }
      );
      const expectedColumns = new Map([
        [
          "language_moderation_message_features",
          [
            "chat_id",
            "message_id",
            "user_telegram_id",
            "fingerprint_hash",
            "token_hashes_json",
            "trigram_hashes_json",
            "created_at",
            "expires_at",
          ],
        ],
        ["language_moderation_owner_feedback", ["chat_id", "message_id", "user_telegram_id", "created_at"]],
        [
          "language_moderation_learning_signal_observations",
          [
            "chat_id",
            "message_id",
            "signal_kind",
            "signal_hash",
            "observed_at",
            "positive",
            "positive_at",
            "retained_at",
          ],
        ],
        ["language_moderation_adaptive_maintenance", ["chat_id", "observations_since_maintenance"]],
      ]);
      for (const [table, expected] of expectedColumns) {
        const columns = inspected.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        assert.deepEqual(
          columns.map((column) => column.name),
          expected
        );
        assert.equal(
          columns.some((column) => /(?:^|_)(?:text|body|caption)(?:_|$)/.test(column.name)),
          false,
          table
        );
      }
    } finally {
      inspected.close();
    }
  });

  it("adds migration 23 once without rewriting existing pre-23 data", async () => {
    const filename = await databasePath();
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO sentinel (id, value) VALUES (1, 'preserved');
    `);
    const migration = legacy.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)");
    for (let id = 1; id <= 22; id += 1) migration.run(id, `migration_${id}`, "2026-09-04T00:00:00.000Z");
    legacy.close();

    new SupportDatabase(filename).close();
    new SupportDatabase(filename).close();

    const inspected = new Database(filename, { readonly: true });
    try {
      assert.deepEqual(
        (inspected.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>).map(
          (row) => row.id
        ),
        Array.from({ length: 24 }, (_, index) => index + 1)
      );
      assert.equal(
        (inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 23").get() as { count: number })
          .count,
        1
      );
      assert.equal(
        (inspected.prepare("SELECT value FROM sentinel WHERE id = 1").get() as { value: string }).value,
        "preserved"
      );
      const columns = inspected.prepare("PRAGMA table_info(language_moderation_message_authors)").all() as Array<{
        name: string;
      }>;
      assert.deepEqual(
        columns.map((column) => column.name),
        ["chat_id", "message_id", "user_telegram_id", "username", "message_thread_id", "created_at"]
      );
      assert.equal(
        columns.some((column) => column.name.includes("text") || column.name.includes("body")),
        false
      );
    } finally {
      inspected.close();
    }
  });

  it("keeps the original mapped author across duplicates and process restart", async () => {
    const filename = await databasePath();
    const first = new SupportDatabase(filename);
    first.addLanguageModerationMessageAuthor({
      chatId: -100701,
      messageId: 81,
      userTelegramId: 501,
      username: "original_user",
      messageThreadId: 7,
    });
    first.addLanguageModerationMessageAuthor({
      chatId: -100701,
      messageId: 81,
      userTelegramId: 999,
      username: "replacement_user",
      messageThreadId: 8,
    });
    first.close();

    const reopened = new SupportDatabase(filename);
    try {
      const author = reopened.getLanguageModerationMessageAuthor(-100701, 81);
      assert.ok(author);
      assert.deepEqual(
        { ...author, created_at: undefined },
        {
          chat_id: -100701,
          message_id: 81,
          user_telegram_id: 501,
          username: "original_user",
          message_thread_id: 7,
          created_at: undefined,
        }
      );
      assert.equal(Number.isNaN(Date.parse(author.created_at)), false);
      assert.equal(reopened.getLanguageModerationMessageAuthor(-100702, 81), undefined);
    } finally {
      reopened.close();
    }
  });

  it("persists bounded adaptive observations and applies OWNER feedback exactly once", async () => {
    const filename = await databasePath();
    const observedAt = new Date("2026-09-04T12:00:00.000Z");
    const features = extractAdaptiveModerationFeatures("novel alpha phrase");
    assert.ok(features);
    const first = new SupportDatabase(filename);
    assert.equal(
      first.recordLanguageModerationObservation({
        chatId: -100701,
        messageId: 81,
        userTelegramId: 501,
        features,
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS).toISOString(),
      }),
      true
    );
    assert.equal(
      first.recordLanguageModerationObservation({
        chatId: -100701,
        messageId: 81,
        userTelegramId: 501,
        features,
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS).toISOString(),
      }),
      false
    );
    const stored = first.getLanguageModerationMessageFeatures(-100701, 81);
    assert.ok(stored);
    assert.equal(JSON.stringify(stored).includes("novel alpha phrase"), false);
    assert.equal(JSON.stringify(stored).includes("novel"), false);
    assert.equal(
      first.listLanguageModerationLearningSignals(-100701).every((signal) => signal.seen_count === 1),
      true
    );

    const feedback = first.recordLanguageModerationOwnerFeedback({
      chatId: -100701,
      messageId: 81,
      userTelegramId: 501,
      recordedAt: observedAt.toISOString(),
      retainUntil: new Date(observedAt.getTime() + ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
    });
    assert.deepEqual(feedback, { feedbackRecorded: true, featuresAvailable: true });
    assert.deepEqual(
      first.recordLanguageModerationOwnerFeedback({
        chatId: -100701,
        messageId: 81,
        userTelegramId: 501,
        recordedAt: observedAt.toISOString(),
        retainUntil: new Date(observedAt.getTime() + ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
      }),
      { feedbackRecorded: false, featuresAvailable: true }
    );
    assert.equal(first.countLanguageModerationOwnerFeedback(-100701), 1);
    assert.equal(
      first
        .listLanguageModerationLearningSignals(-100701)
        .every((signal) => signal.positive_count === 1 && signal.positive_count <= signal.seen_count),
      true
    );
    assert.equal(
      first.getLanguageModerationAdaptiveEvidence({
        chatId: -100701,
        features,
        activeSince: new Date(observedAt.getTime() - ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
        currentTime: observedAt.toISOString(),
      }).exactOwnerConfirmed,
      true
    );
    assert.equal(
      first.getLanguageModerationAdaptiveEvidence({
        chatId: -100702,
        features,
        activeSince: new Date(observedAt.getTime() - ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
        currentTime: observedAt.toISOString(),
      }).exactOwnerConfirmed,
      false
    );
    first.close();

    const reopened = new SupportDatabase(filename);
    try {
      assert.equal(reopened.countLanguageModerationOwnerFeedback(-100701), 1);
      assert.ok(reopened.getLanguageModerationMessageFeatures(-100701, 81));
    } finally {
      reopened.close();
    }
  });

  it("prunes expired adaptive snapshots and stale OWNER-confirmed signals", async () => {
    const db = new SupportDatabase(":memory:");
    try {
      const oldTime = new Date("2025-01-01T00:00:00.000Z");
      const currentTime = new Date("2026-09-04T12:00:00.000Z");
      const oldFeatures = extractAdaptiveModerationFeatures("obsolete zafra signal");
      const currentFeatures = extractAdaptiveModerationFeatures("current nival marker");
      assert.ok(oldFeatures);
      assert.ok(currentFeatures);
      db.recordLanguageModerationObservation({
        chatId: -100701,
        messageId: 90,
        userTelegramId: 501,
        features: oldFeatures,
        observedAt: oldTime.toISOString(),
        expiresAt: new Date(oldTime.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS).toISOString(),
      });
      db.recordLanguageModerationOwnerFeedback({
        chatId: -100701,
        messageId: 90,
        userTelegramId: 501,
        recordedAt: oldTime.toISOString(),
        retainUntil: new Date(oldTime.getTime() + ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
      });

      db.recordLanguageModerationObservation({
        chatId: -100701,
        messageId: 91,
        userTelegramId: 501,
        features: currentFeatures,
        observedAt: currentTime.toISOString(),
        expiresAt: new Date(currentTime.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS).toISOString(),
      });

      assert.equal(db.getLanguageModerationMessageFeatures(-100701, 90), undefined);
      assert.ok(db.getLanguageModerationMessageFeatures(-100701, 91));
      assert.equal(db.countLanguageModerationOwnerFeedback(-100701), 0);
      const retainedHashes = new Set(
        db.listLanguageModerationLearningSignals(-100701).map((signal) => signal.signal_hash)
      );
      assert.equal(
        oldFeatures.tokenHashes.some((hash) => retainedHashes.has(hash)),
        false
      );
      assert.equal(
        currentFeatures.tokenHashes.every((hash) => retainedHashes.has(hash)),
        true
      );
    } finally {
      db.close();
    }
  });

  it("does not train from a feature snapshot after its temporary TTL", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const observedAt = new Date("2026-08-01T00:00:00.000Z");
      const feedbackAt = new Date(observedAt.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS + 1);
      const features = extractAdaptiveModerationFeatures("expired zorpa sample");
      assert.ok(features);
      db.recordLanguageModerationObservation({
        chatId: -100701,
        messageId: 95,
        userTelegramId: 501,
        features,
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS).toISOString(),
      });
      assert.deepEqual(
        db.recordLanguageModerationOwnerFeedback({
          chatId: -100701,
          messageId: 95,
          userTelegramId: 501,
          recordedAt: feedbackAt.toISOString(),
          retainUntil: new Date(feedbackAt.getTime() + ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
        }),
        { feedbackRecorded: true, featuresAvailable: false }
      );
      assert.equal(
        db.listLanguageModerationLearningSignals(-100701).every((signal) => signal.positive_count === 0),
        true
      );
    } finally {
      db.close();
    }
  });

  it("generalizes only after repeated high-ratio OWNER feedback", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const currentTime = new Date("2026-09-04T12:00:00.000Z");
      const observe = (messageId: number, text: string, positive: boolean) => {
        const features = extractAdaptiveModerationFeatures(text);
        assert.ok(features);
        db.recordLanguageModerationObservation({
          chatId: -100701,
          messageId,
          userTelegramId: 501,
          features,
          observedAt: currentTime.toISOString(),
          expiresAt: new Date(currentTime.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS).toISOString(),
        });
        if (positive)
          db.recordLanguageModerationOwnerFeedback({
            chatId: -100701,
            messageId,
            userTelegramId: 501,
            recordedAt: currentTime.toISOString(),
            retainUntil: new Date(currentTime.getTime() + ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
          });
        return features;
      };

      observe(100, "singa tunera alpha", true);
      const onePositiveTarget = observe(101, "singa tunera delta", false);
      let evidence = db.getLanguageModerationAdaptiveEvidence({
        chatId: -100701,
        features: onePositiveTarget,
        activeSince: new Date(currentTime.getTime() - ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
        currentTime: currentTime.toISOString(),
      });
      assert.equal(scoreAdaptiveModerationEvidence(evidence, currentTime), 0);

      observe(102, "zorpa veluna beta", true);
      observe(103, "zorpa veluna gamma", true);
      observe(105, "zorpa veluna theta", true);
      const learnedTarget = observe(104, "zorpa veluna epsilon", false);
      evidence = db.getLanguageModerationAdaptiveEvidence({
        chatId: -100701,
        features: learnedTarget,
        activeSince: new Date(currentTime.getTime() - ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
        currentTime: currentTime.toISOString(),
      });
      assert.ok(scoreAdaptiveModerationEvidence(evidence, currentTime) >= 4);
      assert.equal(classifyModerationLanguage("zorpa veluna epsilon", [], evidence, currentTime), "non_english");

      const suffixes = ["alfa", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
      for (let index = 0; index < suffixes.length; index += 1)
        observe(200 + index, `norda solena ${suffixes[index]}`, index < 2);
      const commonTarget = observe(208, "norda solena neutral", false);
      const commonEvidence = db.getLanguageModerationAdaptiveEvidence({
        chatId: -100701,
        features: commonTarget,
        activeSince: new Date(currentTime.getTime() - ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
        currentTime: currentTime.toISOString(),
      });
      assert.equal(scoreAdaptiveModerationEvidence(commonEvidence, currentTime), 0);
      assert.equal(
        db.listLanguageModerationLearningSignals(-100701).every((signal) => signal.positive_count <= signal.seen_count),
        true
      );
    } finally {
      db.close();
    }
  });

  it("keeps generic and single-family learned tokens non-actionable", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const currentTime = new Date("2026-09-04T12:00:00.000Z");
      const positives = ["alpha", "beta", "gamma"];
      let messageId = 250;
      for (const suffix of positives) {
        for (const text of [`agenton context ${suffix}`, `wallet context ${suffix}`, `zorpalux ${suffix}`]) {
          const features = extractAdaptiveModerationFeatures(text);
          assert.ok(features);
          db.recordLanguageModerationObservation({
            chatId: -100701,
            messageId,
            userTelegramId: 501,
            features,
            observedAt: currentTime.toISOString(),
            expiresAt: new Date(currentTime.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS).toISOString(),
          });
          db.recordLanguageModerationOwnerFeedback({
            chatId: -100701,
            messageId,
            userTelegramId: 501,
            recordedAt: currentTime.toISOString(),
            retainUntil: new Date(currentTime.getTime() + ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
          });
          messageId += 1;
        }
      }

      for (const text of ["agenton", "wallet", "zorpalux"]) {
        const features = extractAdaptiveModerationFeatures(text);
        assert.ok(features);
        const evidence = db.getLanguageModerationAdaptiveEvidence({
          chatId: -100701,
          features,
          activeSince: new Date(currentTime.getTime() - ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
          currentTime: currentTime.toISOString(),
        });
        assert.ok(scoreAdaptiveModerationEvidence(evidence, currentTime) < 4, text);
        assert.notEqual(classifyModerationLanguage(text, [], evidence, currentTime), "non_english", text);
      }
    } finally {
      db.close();
    }
  });

  it("uses adaptive trigrams for typo similarity only with an independent learned family", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const currentTime = new Date("2026-09-04T12:00:00.000Z");
      for (const [index, suffix] of ["alpha", "beta", "gamma"].entries()) {
        const features = extractAdaptiveModerationFeatures(`florvanta nexorima ${suffix}`);
        assert.ok(features);
        db.recordLanguageModerationObservation({
          chatId: -100701,
          messageId: 280 + index,
          userTelegramId: 501,
          features,
          observedAt: currentTime.toISOString(),
          expiresAt: new Date(currentTime.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS).toISOString(),
        });
        db.recordLanguageModerationOwnerFeedback({
          chatId: -100701,
          messageId: 280 + index,
          userTelegramId: 501,
          recordedAt: currentTime.toISOString(),
          retainUntil: new Date(currentTime.getTime() + ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
        });
      }

      const original = extractAdaptiveModerationFeatures("florvanta");
      const variantOnly = extractAdaptiveModerationFeatures("florvanto");
      const corroborated = extractAdaptiveModerationFeatures("florvanto nexorima delta");
      assert.ok(original);
      assert.ok(variantOnly);
      assert.ok(corroborated);
      assert.notEqual(original.tokenHashes[0], variantOnly.tokenHashes[0]);

      const activeSince = new Date(currentTime.getTime() - ADAPTIVE_LEARNING_HORIZON_MS).toISOString();
      const variantEvidence = db.getLanguageModerationAdaptiveEvidence({
        chatId: -100701,
        features: variantOnly,
        activeSince,
        currentTime: currentTime.toISOString(),
      });
      assert.equal(variantEvidence.families[0]?.token, undefined);
      assert.equal((variantEvidence.families[0]?.trigrams.length ?? 0) > 0, true);
      assert.ok(scoreAdaptiveModerationEvidence(variantEvidence, currentTime) < 4);

      const corroboratedEvidence = db.getLanguageModerationAdaptiveEvidence({
        chatId: -100701,
        features: corroborated,
        activeSince,
        currentTime: currentTime.toISOString(),
      });
      assert.ok(scoreAdaptiveModerationEvidence(corroboratedEvidence, currentTime) >= 4);
      assert.equal(
        classifyModerationLanguage("florvanto nexorima delta", [], corroboratedEvidence, currentTime),
        "non_english"
      );
    } finally {
      db.close();
    }
  });

  it("amortizes indexed cap maintenance with bounded overshoot and keeps current rows", async () => {
    const filename = await databasePath();
    new SupportDatabase(filename).close();
    const seeded = new Database(filename);
    try {
      seeded.exec(`
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence
          WHERE value < ${MAX_ADAPTIVE_MESSAGE_FEATURES_PER_CHAT + 1}
        )
        INSERT INTO language_moderation_message_features
          (chat_id, message_id, user_telegram_id, fingerprint_hash, token_hashes_json,
           trigram_hashes_json, created_at, expires_at)
        SELECT -100701, value, 501, printf('%064x', value), '[]', '[]',
               '2026-09-03T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
        FROM sequence;

        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence
          WHERE value < ${MAX_ADAPTIVE_SIGNAL_OBSERVATIONS_PER_CHAT + 1}
        )
        INSERT INTO language_moderation_learning_signal_observations
          (chat_id, message_id, signal_kind, signal_hash, observed_at, positive, positive_at, retained_at)
        SELECT -100701, value, 'TOKEN', printf('%064x', value),
               '2026-09-03T00:00:00.000Z', 0, NULL, '2026-09-03T00:00:00.000Z'
        FROM sequence;
      `);
    } finally {
      seeded.close();
    }

    const db = new SupportDatabase(filename);
    const currentTime = new Date("2026-09-04T12:00:00.000Z");
    const record = (index: number) => {
      const features = extractAdaptiveModerationFeatures(`current feature alpha beta ${wordSuffix(index)}`);
      assert.ok(features);
      assert.equal(
        db.recordLanguageModerationObservation({
          chatId: -100701,
          messageId: 300_000 + index,
          userTelegramId: 501,
          features,
          observedAt: new Date(currentTime.getTime() + index).toISOString(),
          expiresAt: new Date(currentTime.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS).toISOString(),
        }),
        true
      );
    };
    try {
      for (let index = 1; index < ADAPTIVE_STORAGE_MAINTENANCE_INTERVAL; index += 1) record(index);
      const beforeMaintenance = new Database(filename, { readonly: true });
      try {
        assert.equal(
          (
            beforeMaintenance
              .prepare(
                "SELECT observations_since_maintenance AS count FROM language_moderation_adaptive_maintenance WHERE chat_id = ?"
              )
              .get(-100701) as { count: number }
          ).count,
          ADAPTIVE_STORAGE_MAINTENANCE_INTERVAL - 1
        );
        assert.ok(
          (
            beforeMaintenance
              .prepare("SELECT COUNT(*) AS count FROM language_moderation_message_features WHERE chat_id = ?")
              .get(-100701) as { count: number }
          ).count > MAX_ADAPTIVE_MESSAGE_FEATURES_PER_CHAT
        );
      } finally {
        beforeMaintenance.close();
      }

      record(ADAPTIVE_STORAGE_MAINTENANCE_INTERVAL);
      const inspected = new Database(filename, { readonly: true });
      try {
        assert.equal(
          (
            inspected
              .prepare("SELECT COUNT(*) AS count FROM language_moderation_message_features WHERE chat_id = ?")
              .get(-100701) as { count: number }
          ).count,
          MAX_ADAPTIVE_MESSAGE_FEATURES_PER_CHAT
        );
        assert.equal(
          (
            inspected
              .prepare(
                "SELECT COUNT(*) AS count FROM language_moderation_learning_signal_observations WHERE chat_id = ?"
              )
              .get(-100701) as { count: number }
          ).count,
          MAX_ADAPTIVE_SIGNAL_OBSERVATIONS_PER_CHAT
        );
        assert.equal(
          (
            inspected
              .prepare(
                "SELECT COUNT(*) AS count FROM language_moderation_message_features WHERE chat_id = ? AND message_id = ?"
              )
              .get(-100701, 1) as { count: number }
          ).count,
          0
        );
        assert.equal(
          (
            inspected
              .prepare(
                "SELECT COUNT(*) AS count FROM language_moderation_message_features WHERE chat_id = ? AND message_id = ?"
              )
              .get(-100701, 300_000 + ADAPTIVE_STORAGE_MAINTENANCE_INTERVAL) as { count: number }
          ).count,
          1
        );
        const lookupPlan = inspected
          .prepare(
            `EXPLAIN QUERY PLAN SELECT signal_hash, COUNT(*)
             FROM language_moderation_learning_signal_observations
             WHERE chat_id = ? AND signal_kind = ? AND signal_hash IN (?) AND retained_at >= ?
             GROUP BY signal_hash`
          )
          .all(-100701, "TOKEN", "0".repeat(64), "2026-06-06T00:00:00.000Z") as Array<{ detail: string }>;
        assert.equal(
          lookupPlan.some((step) => step.detail.includes("idx_language_moderation_signal_observations_lookup")),
          true
        );
      } finally {
        inspected.close();
      }
    } finally {
      db.close();
    }
  });

  it("keeps day-89 evidence on day 91 while excluding only observations older than 90 days across restart", async () => {
    const filename = await databasePath();
    let db = new SupportDatabase(filename);
    try {
      const start = new Date("2026-01-01T00:00:00.000Z");
      const observe = (messageId: number, text: string, at: Date, positive: boolean) => {
        const features = extractAdaptiveModerationFeatures(text);
        assert.ok(features);
        db.recordLanguageModerationObservation({
          chatId: -100701,
          messageId,
          userTelegramId: 501,
          features,
          observedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS).toISOString(),
        });
        if (positive)
          db.recordLanguageModerationOwnerFeedback({
            chatId: -100701,
            messageId,
            userTelegramId: 501,
            recordedAt: at.toISOString(),
            retainUntil: new Date(at.getTime() + ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
          });
        return features;
      };
      observe(300, "verda nexora olda", start, true);
      observe(301, "verda nexora oldb", new Date(start.getTime() + 1_000), true);
      observe(302, "verda nexora oldc", new Date(start.getTime() + 2_000), true);
      const day89 = new Date(start.getTime() + 89 * 24 * 60 * 60 * 1_000);
      observe(303, "verda nexora fresha", day89, true);
      observe(304, "verda nexora freshb", new Date(day89.getTime() + 1_000), true);
      observe(305, "verda nexora freshc", new Date(day89.getTime() + 2_000), true);
      db.close();
      db = new SupportDatabase(filename);

      const day91 = new Date(start.getTime() + 91 * 24 * 60 * 60 * 1_000);
      const target = observe(306, "verda nexora current", day91, false);
      const evidence = db.getLanguageModerationAdaptiveEvidence({
        chatId: -100701,
        features: target,
        activeSince: new Date(day91.getTime() - ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
        currentTime: day91.toISOString(),
      });
      assert.equal(scoreAdaptiveModerationEvidence(evidence, day91), 4);
      const learnedFamilies = evidence.families.filter((family) => family.token);
      assert.equal(learnedFamilies.length >= 2, true);
      assert.equal(
        learnedFamilies
          .slice(0, 2)
          .every((family) => family.token?.seenCount === 4 && family.token.positiveCount === 3),
        true
      );
    } finally {
      db.close();
    }
  });

  it("retains a delayed OWNER positive for 90 days from its feedback timestamp", () => {
    const db = new SupportDatabase(":memory:");
    try {
      const start = new Date("2026-01-01T00:00:00.000Z");
      const observedAt = new Date(start.getTime() + 84 * 24 * 60 * 60 * 1_000);
      const feedbackAt = new Date(start.getTime() + 89 * 24 * 60 * 60 * 1_000);
      for (const [index, suffix] of ["alpha", "beta", "gamma"].entries()) {
        const features = extractAdaptiveModerationFeatures(`delora minerva ${suffix}`);
        assert.ok(features);
        db.recordLanguageModerationObservation({
          chatId: -100701,
          messageId: 400 + index,
          userTelegramId: 501,
          features,
          observedAt: new Date(observedAt.getTime() + index).toISOString(),
          expiresAt: new Date(observedAt.getTime() + ADAPTIVE_MESSAGE_FEATURE_TTL_MS).toISOString(),
        });
        db.recordLanguageModerationOwnerFeedback({
          chatId: -100701,
          messageId: 400 + index,
          userTelegramId: 501,
          recordedAt: new Date(feedbackAt.getTime() + index).toISOString(),
          retainUntil: new Date(feedbackAt.getTime() + ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
        });
      }

      const day176 = new Date(start.getTime() + 176 * 24 * 60 * 60 * 1_000);
      const target = extractAdaptiveModerationFeatures("delora minerva current");
      assert.ok(target);
      const activeEvidence = db.getLanguageModerationAdaptiveEvidence({
        chatId: -100701,
        features: target,
        activeSince: new Date(day176.getTime() - ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
        currentTime: day176.toISOString(),
      });
      assert.equal(scoreAdaptiveModerationEvidence(activeEvidence, day176), 4);

      const day180 = new Date(start.getTime() + 180 * 24 * 60 * 60 * 1_000);
      const expiredEvidence = db.getLanguageModerationAdaptiveEvidence({
        chatId: -100701,
        features: target,
        activeSince: new Date(day180.getTime() - ADAPTIVE_LEARNING_HORIZON_MS).toISOString(),
        currentTime: day180.toISOString(),
      });
      assert.equal(scoreAdaptiveModerationEvidence(expiredEvidence, day180), 0);
    } finally {
      db.close();
    }
  });

  it("keeps manual strike configuration isolated per managed chat across restart", async () => {
    const filename = await databasePath();
    const first = new SupportDatabase(filename);
    first.upsertManagedPublicChat({ chatId: -100701, title: "Chat A" });
    first.upsertManagedPublicChat({ chatId: -100702, title: "Chat B" });
    assert.equal(first.getManagedPublicChat(-100701)?.manual_strikes_enabled, 1);
    assert.equal(first.getManagedPublicChat(-100701)?.manual_strike_reaction, "👀");
    assert.equal(first.updateManagedPublicChatManualStrikeConfig(-100701, { enabled: false }), true);
    assert.equal(first.updateManagedPublicChatManualStrikeConfig(-100701, { reaction: "🔥" }), true);
    first.close();

    const reopened = new SupportDatabase(filename);
    try {
      assert.deepEqual(
        (({ manual_strikes_enabled, manual_strike_reaction }) => ({
          manual_strikes_enabled,
          manual_strike_reaction,
        }))(reopened.getManagedPublicChat(-100701)!),
        { manual_strikes_enabled: 0, manual_strike_reaction: "🔥" }
      );
      assert.equal(reopened.getManagedPublicChat(-100702)?.manual_strikes_enabled, 1);
      assert.equal(reopened.getManagedPublicChat(-100702)?.manual_strike_reaction, "👀");
    } finally {
      reopened.close();
    }
  });
});

function wordSuffix(index: number): string {
  return `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
}
