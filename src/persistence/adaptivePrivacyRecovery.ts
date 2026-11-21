import type Database from "better-sqlite3";
import { adaptiveRecoveryFiles } from "../adaptiveRecoveryFiles.js";
import { loadAdaptivePrivacy } from "../adaptivePrivacy.js";
import { AdaptiveKeyError } from "../adaptiveKeyErrors.js";
import { finalizeAdaptivePrivacyMigration } from "./adaptivePrivacyMigration.js";

export const ADAPTIVE_RECOVERY_CONFIRMATION = "APPLICATION STOPPED; RESET ADAPTIVE EVIDENCE";
export interface AdaptiveRecoveryOptions {
  confirmation: string;
  adaptiveKeyPath?: string;
}
export interface AdaptiveRecoveryResult {
  resumed: boolean;
  resetPerformed: boolean;
  removed: { features: number; observations: number; feedback: number; maintenance: number };
}

export function validateAdaptiveRecoveryRequest(databasePath: string, confirmation: string): void {
  if (confirmation !== ADAPTIVE_RECOVERY_CONFIRMATION)
    throw new Error("Offline adaptive recovery requires explicit stopped-application confirmation.");
  if (databasePath === ":memory:")
    throw new Error("Offline adaptive recovery requires an existing file-backed database.");
}

export function recoverAdaptivePrivacy(
  db: Database.Database,
  databasePath: string,
  options: AdaptiveRecoveryOptions
): AdaptiveRecoveryResult {
  validateAdaptiveRecoveryRequest(databasePath, options.confirmation);
  let originalMode: string | undefined;
  try {
    db.pragma("busy_timeout = 0");
    db.pragma("foreign_keys = ON");
    originalMode = String(db.pragma("journal_mode", { simple: true })).toLowerCase();
    if (originalMode !== "wal" && originalMode !== "delete")
      throw new Error("Unsupported SQLite journal mode for offline recovery.");
    db.pragma("locking_mode = EXCLUSIVE");
    // Switching out of WAL rejects even idle connections; BEGIN alone does not.
    db.pragma("journal_mode = DELETE");
    db.exec("BEGIN EXCLUSIVE");
    const format = db.prepare("SELECT version, key_id FROM adaptive_moderation_hash_format WHERE id=1").get() as
      { version: number; key_id: string } | undefined;
    const latest = db.prepare("SELECT MAX(id) AS id FROM schema_migrations").get() as { id: number };
    if (latest.id !== 28 || format?.version !== 2 || !/^[a-f0-9]{64}$/.test(format.key_id))
      throw new Error("Offline adaptive recovery requires schema 28; no migrations are run.");
    const files = adaptiveRecoveryFiles(databasePath, options.adaptiveKeyPath);
    let journal = files.read();
    const resumed = Boolean(journal);
    if (!journal) {
      try {
        loadAdaptivePrivacy(databasePath, files.keyFile, format.key_id, false);
        throw new Error("The installation key is available; refusing destructive adaptive recovery.");
      } catch (error) {
        if (!(error instanceof AdaptiveKeyError) || (error.code !== "MISSING" && error.code !== "MISMATCH"))
          throw error;
      }
      journal = files.prepare(format.key_id);
    }
    if (format.key_id !== journal.originalKeyId && format.key_id !== journal.newKeyId)
      throw new Error("Adaptive recovery state conflicts with this database.");
    const resetPerformed = format.key_id !== journal.newKeyId;
    const removed = { features: 0, observations: 0, feedback: 0, maintenance: 0 };
    if (resetPerformed) {
      removed.features = db.prepare("DELETE FROM language_moderation_message_features").run().changes;
      removed.observations = db.prepare("DELETE FROM language_moderation_learning_signal_observations").run().changes;
      removed.feedback = db.prepare("DELETE FROM language_moderation_owner_feedback").run().changes;
      removed.maintenance = db.prepare("DELETE FROM language_moderation_adaptive_maintenance").run().changes;
      db.prepare("UPDATE adaptive_moderation_hash_format SET key_id=?, cleanup_required=1 WHERE id=1").run(
        journal.newKeyId
      );
    }
    db.exec("COMMIT");
    files.publish(journal);
    finalizeAdaptivePrivacyMigration(db);
    files.complete(journal);
    return { resumed, resetPerformed, removed };
  } finally {
    try {
      if (db.inTransaction) db.exec("ROLLBACK");
    } finally {
      if (originalMode) db.pragma(`journal_mode = ${originalMode}`);
    }
  }
}
