import type Database from "better-sqlite3";
import { loadAdaptivePrivacy, type AdaptivePrivacy, type AdaptiveHashKind } from "../adaptivePrivacy.js";

export function databaseAdaptivePrivacy(
  db: Database.Database,
  databasePath: string,
  keyPath?: string,
  createIfMissing = true
): AdaptivePrivacy {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adaptive_moderation_hash_format'")
    .get();
  const migrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!exists && migrations && db.prepare("SELECT 1 FROM schema_migrations WHERE id=28").get())
    throw new Error("Missing adaptive privacy format metadata.");
  const format = exists
    ? (db.prepare("SELECT version, key_id FROM adaptive_moderation_hash_format WHERE id=1").get() as
        { version: number; key_id: string } | undefined)
    : undefined;
  if (exists && (!format || format.version !== 2 || !/^[a-f0-9]{64}$/.test(format.key_id)))
    throw new Error("Invalid adaptive privacy format metadata.");
  return loadAdaptivePrivacy(databasePath, keyPath, format?.key_id, createIfMissing);
}

// Called only inside SupportDatabase's migration transaction.
export function migrateAdaptivePrivacy(db: Database.Database, privacy: AdaptivePrivacy): void {
  type FeatureRow = {
    rowid: number;
    chat_id: number;
    message_id: number;
    fingerprint_hash: string;
    token_hashes_json: string;
    trigram_hashes_json: string;
  };
  const update = db.prepare(
    "UPDATE language_moderation_message_features SET fingerprint_hash=?, token_hashes_json=?, trigram_hashes_json=? WHERE chat_id=? AND message_id=?"
  );
  function hashes(json: string, kind: AdaptiveHashKind): string {
    const values: unknown = JSON.parse(json);
    if (!Array.isArray(values) || !values.every((value): value is string => typeof value === "string"))
      throw new Error("Invalid adaptive hash array.");
    return JSON.stringify(values.map((value) => privacy.wrap(kind, value)));
  }
  for (const row of rows<FeatureRow>(db, "language_moderation_message_features")) {
    update.run(
      privacy.wrap("FINGERPRINT", row.fingerprint_hash),
      hashes(row.token_hashes_json, "TOKEN"),
      hashes(row.trigram_hashes_json, "TRIGRAM"),
      row.chat_id,
      row.message_id
    );
  }
  const updateSignal = db.prepare(
    "UPDATE language_moderation_learning_signal_observations SET signal_hash=? WHERE rowid=?"
  );
  for (const row of rows<{ rowid: number; signal_kind: "TOKEN" | "TRIGRAM"; signal_hash: string }>(
    db,
    "language_moderation_learning_signal_observations"
  )) {
    updateSignal.run(privacy.wrap(row.signal_kind, row.signal_hash), row.rowid);
  }
  db.exec(
    "CREATE TABLE adaptive_moderation_hash_format (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=2), key_id TEXT NOT NULL, cleanup_required INTEGER NOT NULL CHECK(cleanup_required IN (0,1)))"
  );
  db.prepare("INSERT INTO adaptive_moderation_hash_format VALUES (1, 2, ?, 1)").run(privacy.keyId);
}

export function finalizeAdaptivePrivacyMigration(db: Database.Database): void {
  const pending = db.prepare("SELECT cleanup_required FROM adaptive_moderation_hash_format WHERE id=1").get() as {
    cleanup_required: number;
  };
  if (!pending.cleanup_required) return;
  // UPDATE leaves legacy digests in unused page space; rebuild before publishing new backups.
  // The marker survives interruption so compaction/checkpoint is retried before runtime starts.
  db.exec("VACUUM");
  const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
  if (checkpoint.some((row) => row.busy !== 0))
    throw new Error("Adaptive privacy cleanup requires exclusive database startup access.");
  db.prepare("UPDATE adaptive_moderation_hash_format SET cleanup_required=0 WHERE id=1").run();
}

function* rows<T extends { rowid: number }>(
  db: Database.Database,
  table: "language_moderation_message_features" | "language_moderation_learning_signal_observations"
): Generator<T> {
  const query = db.prepare(`SELECT rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 500`);
  let cursor = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const batch = query.all(cursor) as T[];
    if (!batch.length) return;
    for (const row of batch) yield row;
    cursor = batch[batch.length - 1]!.rowid;
  }
}
