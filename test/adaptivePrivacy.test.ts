import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mock, test } from "node:test";
import Database from "better-sqlite3";
import { SupportDatabase } from "../src/db.js";
import { extractAdaptiveModerationFeatures } from "../src/languageModeration.js";
import { BackupService, verifyRestoreCandidate } from "../src/backups.js";
import { AdaptivePrivacy, loadAdaptivePrivacy } from "../src/adaptivePrivacy.js";
import { ModerationRepository } from "../src/persistence/moderationRepository.js";
import { classifyModerationLanguage, scoreAdaptiveModerationEvidence } from "../src/languageModeration.js";

for (const requireById of [false, true]) {
  test(`a key disappearing between checks is never regenerated (key identity required: ${requireById})`, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "adaptive-disappearing-"));
    const key = path.join(directory, "private", "adaptive.key");
    const original = loadAdaptivePrivacy("unused.db", key);
    const exists = fs.existsSync;
    let checks = 0;
    const race = mock.method(fs, "existsSync", (file: fs.PathLike) => {
      if (file === key && ++checks === 2) unlinkSync(key);
      return exists(file);
    });
    try {
      assert.throws(
        () => loadAdaptivePrivacy("unused.db", key, requireById ? original.keyId : undefined, requireById),
        /key.*missing/i
      );
      assert.equal(exists(key), false);
    } finally {
      race.mock.restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("interrupted page cleanup remains marked and resumes before database use", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "adaptive-compaction-"));
  const file = path.join(directory, "support.db");
  const exec = Database.prototype.exec;
  const failure = mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
    if (sql === "VACUUM") throw new Error("injected compaction interruption");
    return exec.call(this, sql);
  });
  try {
    assert.throws(() => new SupportDatabase(file), /compaction interruption/);
    failure.mock.restore();
    const pending = new Database(file, { readonly: true });
    assert.deepEqual(pending.prepare("SELECT cleanup_required FROM adaptive_moderation_hash_format").get(), {
      cleanup_required: 1,
    });
    pending.close();
    new SupportDatabase(file).close();
    const finished = new Database(file, { readonly: true });
    assert.deepEqual(finished.prepare("SELECT cleanup_required FROM adaptive_moderation_hash_format").get(), {
      cleanup_required: 0,
    });
    assert.deepEqual(finished.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id=28").get(), { n: 1 });
    finished.close();
  } finally {
    failure.mock.restore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("key publication resumes after interruption without accepting unrelated hard links", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "adaptive-publication-"));
  const key = path.join(directory, "private", "adaptive.key");
  try {
    const original = loadAdaptivePrivacy("unused.db", key);
    const orphan = path.join(path.dirname(key), `.key-${"a".repeat(32)}.tmp`);
    linkSync(key, orphan);
    const unrelated = path.join(path.dirname(key), `.key-${"b".repeat(32)}.tmp`);
    writeFileSync(unrelated, Buffer.alloc(32, 3));
    assert.equal(loadAdaptivePrivacy("unused.db", key, original.keyId).keyId, original.keyId);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(unrelated), true);
    assert.equal(lstatSync(key).nlink, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy restore verification never creates a missing installation key", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "adaptive-legacy-restore-"));
  const live = path.join(directory, "live.db");
  const key = path.join(directory, "private", "adaptive.key");
  const candidate = path.join(directory, "legacy.sqlite");
  try {
    new SupportDatabase(live, { adaptiveKeyPath: key }).close();
    copyFileSync(live, candidate);
    const legacy = new Database(candidate);
    legacy.exec("DROP TABLE adaptive_moderation_hash_format; DELETE FROM schema_migrations WHERE id=28;");
    legacy.close();
    unlinkSync(key);
    await assert.rejects(() => verifyRestoreCandidate(candidate, live, { adaptiveKeyPath: key }), /key.*missing/i);
    assert.equal(existsSync(key), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("adaptive key creation rejects substituted files and unsafe permissions", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "adaptive-key-"));
  const key = path.join(directory, "private", "adaptive.key");
  try {
    const privacy = loadAdaptivePrivacy("unused.db", key);
    assert.equal(readFileSync(key).length, 32);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(key).mode & 0o777, 0o600);
      assert.equal(lstatSync(path.dirname(key)).mode & 0o777, 0o700);
      chmodSync(key, 0o644);
      assert.throws(() => loadAdaptivePrivacy("unused.db", key, privacy.keyId), /permissions/);
      chmodSync(key, 0o600);
    }
    const alias = path.join(directory, "alias.key");
    linkSync(key, alias);
    assert.throws(() => loadAdaptivePrivacy("unused.db", key, privacy.keyId), /Unsafe/);
    unlinkSync(alias);
    const junction = path.join(directory, "linked");
    symlinkSync(path.dirname(key), junction, process.platform === "win32" ? "junction" : "dir");
    assert.equal(
      loadAdaptivePrivacy("unused.db", path.join(junction, "adaptive.key"), privacy.keyId).keyId,
      privacy.keyId
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("interrupted adaptive migration rolls back every hash and its version marker", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "adaptive-atomic-"));
  const file = path.join(directory, "support.db");
  const features = extractAdaptiveModerationFeatures("novelphrase alpha")!;
  try {
    new SupportDatabase(file).close();
    const legacy = new Database(file);
    legacy.exec("DROP TABLE adaptive_moderation_hash_format; DELETE FROM schema_migrations WHERE id=28;");
    const insert = legacy.prepare("INSERT INTO language_moderation_message_features VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const id of [1, 2])
      insert.run(
        -1,
        id,
        2,
        features.fingerprintHash,
        JSON.stringify(features.tokenHashes),
        JSON.stringify(features.trigramHashes),
        "2026-11-21",
        "2026-12-01"
      );
    legacy.exec(
      "CREATE TRIGGER interrupt_adaptive BEFORE UPDATE ON language_moderation_message_features WHEN OLD.message_id=2 BEGIN SELECT RAISE(ABORT,'injected interruption'); END;"
    );
    legacy.close();
    assert.throws(() => new SupportDatabase(file), /injected interruption/);
    const check = new Database(file);
    assert.deepEqual(
      check.prepare("SELECT DISTINCT fingerprint_hash FROM language_moderation_message_features").all(),
      [{ fingerprint_hash: features.fingerprintHash }]
    );
    assert.deepEqual(check.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id=28").get(), { n: 0 });
    assert.equal(
      check.prepare("SELECT 1 FROM sqlite_master WHERE name='adaptive_moderation_hash_format'").get(),
      undefined
    );
    check.exec("DROP TRIGGER interrupt_adaptive");
    check.close();
    new SupportDatabase(file).close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("adaptive evidence is keyed per installation and missing/replaced keys fail closed", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "adaptive-privacy-"));
  const file = path.join(directory, "support.db");
  const key = path.join(directory, "private", "adaptive.key");
  const features = extractAdaptiveModerationFeatures("novelphrase alpha")!;
  const input = {
    chatId: -1,
    messageId: 1,
    userTelegramId: 2,
    features,
    observedAt: "2026-11-21T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
  };
  try {
    const db = new SupportDatabase(file, { adaptiveKeyPath: key });
    db.recordLanguageModerationObservation(input);
    const stored = db.getLanguageModerationMessageFeatures(-1, 1)!;
    assert.notEqual(stored.fingerprint_hash, features.fingerprintHash);
    const other = new SupportDatabase(":memory:");
    other.recordLanguageModerationObservation(input);
    assert.notEqual(other.getLanguageModerationMessageFeatures(-1, 1)!.fingerprint_hash, stored.fingerprint_hash);
    other.close();
    db.close();
    const reopened = new SupportDatabase(file, { adaptiveKeyPath: key });
    assert.deepEqual(reopened.getLanguageModerationMessageFeatures(-1, 1), stored);
    reopened.close();
    const saved = readFileSync(key);
    unlinkSync(key);
    assert.throws(() => new SupportDatabase(file, { adaptiveKeyPath: key }), /key.*missing/i);
    writeFileSync(key, Buffer.alloc(32, 7), { mode: 0o600 });
    assert.throws(() => new SupportDatabase(file, { adaptiveKeyPath: key }), /key.*mismatch/i);
    writeFileSync(key, saved, { mode: 0o600 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema 27 hashes migrate atomically without losing feedback, times or learning", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "adaptive-migration-"));
  const file = path.join(directory, "support.db");
  const key = path.join(directory, "private", "adaptive.key");
  const features = extractAdaptiveModerationFeatures("novelphrase alpha")!;
  const observed = "2026-11-21T00:00:00.000Z";
  const expires = "2026-12-01T00:00:00.000Z";
  let db: SupportDatabase | undefined;
  try {
    new SupportDatabase(file, { adaptiveKeyPath: key }).close();
    const legacy = new Database(file);
    legacy.exec("DROP TABLE adaptive_moderation_hash_format; DELETE FROM schema_migrations WHERE id = 28;");
    legacy
      .prepare("INSERT INTO language_moderation_message_features VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        -1,
        1,
        2,
        features.fingerprintHash,
        JSON.stringify(features.tokenHashes),
        JSON.stringify(features.trigramHashes),
        observed,
        expires
      );
    legacy.prepare("INSERT INTO language_moderation_owner_feedback VALUES (?, ?, ?, ?)").run(-1, 1, 2, observed);
    const insert = legacy.prepare(
      "INSERT INTO language_moderation_learning_signal_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const [kind, hashes] of [
      ["TOKEN", features.tokenHashes],
      ["TRIGRAM", features.trigramHashes],
    ] as const)
      for (const hash of hashes) {
        insert.run(-1, 1, kind, hash, observed, 1, observed, expires);
        insert.run(-1, 2, kind, hash, observed, 1, observed, expires);
        insert.run(-1, 3, kind, hash, observed, 0, null, expires);
      }
    // Reproduce schema-27's unkeyed repository boundary against the real legacy DB.
    class LegacyFormat extends AdaptivePrivacy {
      override protect<T extends Parameters<AdaptivePrivacy["protect"]>[0]>(value: T): T {
        return value;
      }
    }
    const legacyRepository = new ModerationRepository(legacy, new LegacyFormat(Buffer.alloc(32)));
    const cases = [
      { chatId: -1, features, activeSince: observed, currentTime: observed },
      { chatId: -2, features, activeSince: observed, currentTime: observed },
      {
        chatId: -1,
        features: extractAdaptiveModerationFeatures("novelphras alpha")!,
        activeSince: observed,
        currentTime: observed,
      },
      { chatId: -1, features, activeSince: "2027-01-01T00:00:00.000Z", currentTime: "2027-01-01T00:00:00.000Z" },
      { chatId: -1, features, activeSince: observed, currentTime: expires },
    ];
    const outcome = (
      evidence: ReturnType<SupportDatabase["getLanguageModerationAdaptiveEvidence"]>,
      currentTime: string
    ) => ({
      evidence,
      score: scoreAdaptiveModerationEvidence(evidence, new Date(currentTime)),
      classification: classifyModerationLanguage("novelphrase alpha", [], evidence, new Date(currentTime)),
    });
    const before = cases.map((input) =>
      outcome(legacyRepository.getLanguageModerationAdaptiveEvidence(input), input.currentTime)
    );
    legacy.close();
    db = new SupportDatabase(file, { adaptiveKeyPath: key });
    const migrated = db;
    assert.deepEqual(
      cases.map((input) => outcome(migrated.getLanguageModerationAdaptiveEvidence(input), input.currentTime)),
      before
    );
    const evidence = db.getLanguageModerationAdaptiveEvidence({
      chatId: -1,
      features,
      activeSince: observed,
      currentTime: observed,
    });
    assert.equal(evidence.exactOwnerConfirmed, true);
    assert.ok(
      evidence.families.every(
        (f) =>
          f.token?.positiveCount === 2 &&
          f.token.seenCount === 3 &&
          f.trigrams.every((t) => t.positiveCount === 2 && t.seenCount === 3 && t.lastPositiveAt === observed)
      )
    );
    assert.equal(db.countLanguageModerationOwnerFeedback(-1), 1);
    assert.equal(db.getLanguageModerationMessageFeatures(-1, 1)!.created_at, observed);
    db.recordLanguageModerationObservation({
      chatId: -1,
      messageId: 4,
      userTelegramId: 2,
      features,
      observedAt: observed,
      expiresAt: expires,
    });
    assert.deepEqual(
      db.recordLanguageModerationOwnerFeedback({
        chatId: -1,
        messageId: 4,
        userTelegramId: 2,
        recordedAt: observed,
        retainUntil: expires,
      }),
      { feedbackRecorded: true, featuresAvailable: true }
    );
    const afterFeedback = db.getLanguageModerationAdaptiveEvidence({
      chatId: -1,
      features,
      activeSince: observed,
      currentTime: observed,
    });
    assert.ok(afterFeedback.families.every((f) => f.token?.positiveCount === 3 && f.token.seenCount === 4));
    const backup = await new BackupService(db, {
      enabled: true,
      intervalMs: 1,
      retentionCount: 1,
      directory: path.join(directory, "backups"),
    }).createBackup();
    const backupBytes = readFileSync(backup.path).toString("latin1");
    assert.equal(readFileSync(backup.path).includes(readFileSync(key)), false);
    for (const hash of [features.fingerprintHash, ...features.tokenHashes, ...features.trigramHashes])
      assert.equal(backupBytes.includes(hash), false);
    await assert.rejects(
      () => verifyRestoreCandidate(backup.path, file, { adaptiveKeyPath: path.join(directory, "missing", "key") }),
      /key.*missing/i
    );
    assert.equal(
      (await verifyRestoreCandidate(backup.path, file, { adaptiveKeyPath: key })).applicationCompatibility,
      "ok"
    );
    db.close();
    db = undefined;
    const raw = new Database(file, { readonly: true });
    assert.deepEqual(raw.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id=28").get(), { n: 1 });
    const rows =
      JSON.stringify(raw.prepare("SELECT * FROM language_moderation_message_features").all()) +
      JSON.stringify(raw.prepare("SELECT * FROM language_moderation_learning_signal_observations").all());
    for (const hash of [features.fingerprintHash, ...features.tokenHashes, ...features.trigramHashes])
      assert.equal(rows.includes(hash), false);
    assert.equal(raw.pragma("integrity_check", { simple: true }), "ok");
    raw.close();
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
