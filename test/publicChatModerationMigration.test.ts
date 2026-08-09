import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { SupportDatabase } from "../src/db.js";

test("migration 21 adopts legacy moderation data without changing historical state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-public-chat-migration-"));
  const databasePath = path.join(directory, "support.db");
  const legacy = new Database(databasePath);
  const timestamp = "2026-08-09T00:00:00.000Z";
  try {
    legacy.exec(`
      CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE workspaces (id INTEGER PRIMARY KEY, telegram_chat_id INTEGER NOT NULL UNIQUE);
      CREATE TABLE managed_public_chats (
        chat_id INTEGER PRIMARY KEY, workspace_id INTEGER, title TEXT, username TEXT,
        active INTEGER NOT NULL DEFAULT 1, imported_from_legacy INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE language_moderation_chat_state (
        chat_id INTEGER PRIMARY KEY, last_warning_message_id INTEGER, last_warning_at TEXT,
        ordinary_messages_since_warning INTEGER NOT NULL DEFAULT 0, pending_warning_due_at TEXT,
        pending_warning_started_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE language_moderation_user_state (
        chat_id INTEGER NOT NULL, user_telegram_id INTEGER NOT NULL, username TEXT,
        current_strikes INTEGER NOT NULL, sanction_tier INTEGER NOT NULL, first_strike_at TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY(chat_id, user_telegram_id)
      );
      CREATE TABLE language_moderation_violations (
        chat_id INTEGER NOT NULL, user_telegram_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
        username TEXT, detected_at TEXT NOT NULL, cycle_tier INTEGER NOT NULL,
        moderation_cycle_id TEXT, cleanup_state TEXT NOT NULL DEFAULT 'PENDING',
        cleanup_attempt_count INTEGER NOT NULL DEFAULT 0, cleanup_last_error_category TEXT,
        cleanup_last_error_code INTEGER, cleanup_last_error_description TEXT, cleanup_completed_at TEXT,
        PRIMARY KEY(chat_id, message_id)
      );
      CREATE TABLE ticket_batch_answer_packages (
        answer_package_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        final_summary_state TEXT NOT NULL
      );
      CREATE TABLE ticket_batch_answer_items (
        answer_package_id TEXT NOT NULL,
        ticket_id INTEGER NOT NULL,
        state TEXT NOT NULL,
        delivery_message_id INTEGER,
        PRIMARY KEY(answer_package_id, ticket_id)
      );
    `);
    const migration = legacy.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)");
    for (let id = 1; id <= 20; id += 1) migration.run(id, `migration_${id}`, timestamp);
    const setting = legacy.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
    setting.run("language_moderation:target", "-100801", timestamp);
    setting.run("language_moderation:enabled", "true", timestamp);
    setting.run("language_moderation:warning_text", "Legacy warning", timestamp);
    setting.run("language_moderation:allowlist", '["uid","wallet"]', timestamp);
    setting.run("language_moderation:warning_cooldown_minutes", "12", timestamp);
    setting.run("language_moderation:warning_message_threshold", "19", timestamp);
    setting.run("language_moderation:lookback_minutes", "8", timestamp);
    legacy.prepare("INSERT INTO managed_public_chats VALUES (?, ?, ?, ?, 1, 1, ?, ?)")
      .run(-100801, 1, "Legacy community", "legacy_community", timestamp, timestamp);
    legacy.prepare("INSERT INTO language_moderation_chat_state VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(-100801, 700, timestamp, 4, null, null, timestamp);
    legacy.prepare("INSERT INTO language_moderation_user_state VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(-100801, 91, "synthetic_user", 2, 1, timestamp, timestamp);
    legacy.prepare("INSERT INTO language_moderation_violations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(-100801, 91, 701, "synthetic_user", timestamp, 1, "synthetic-cycle", "PENDING", 0, null, null, null, null);
    legacy.prepare("INSERT INTO ticket_batch_answer_packages VALUES (?, ?, ?)")
      .run("synthetic-package", "PARTIAL", "FAILED");
    legacy.prepare("INSERT INTO ticket_batch_answer_items VALUES (?, ?, ?, ?)")
      .run("synthetic-package", 42, "STAFF_SYNC_PENDING", 9001);
  } finally {
    legacy.close();
  }

  try {
    const upgraded = new SupportDatabase(databasePath);
    const chat = upgraded.getManagedPublicChat(-100801);
    assert.equal(chat?.moderation_enabled, 1);
    assert.equal(chat?.warning_text, "Legacy warning");
    assert.deepEqual(chat?.allowlist, ["uid", "wallet"]);
    assert.equal(chat?.warning_cooldown_minutes, 12);
    assert.equal(chat?.warning_message_threshold, 19);
    assert.equal(chat?.lookback_minutes, 8);
    assert.equal(upgraded.getLanguageModerationWarningState(-100801, null)?.last_warning_message_id, 700);
    assert.equal(upgraded.getLanguageModerationUserState(-100801, 91)?.sanction_tier, 1);
    assert.equal(upgraded.listLanguageModerationViolations(-100801, "1970-01-01T00:00:00.000Z")[0]?.moderation_cycle_id, "synthetic-cycle");
    upgraded.close();

    const reopened = new SupportDatabase(databasePath);
    reopened.close();
    const inspected = new Database(databasePath, { readonly: true });
    try {
      const migrations = inspected.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: number }>;
      assert.deepEqual(migrations.map((row) => row.id), Array.from({ length: 21 }, (_, index) => index + 1));
      assert.equal((inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 21").get() as { count: number }).count, 1);
      const violationColumns = inspected.prepare("PRAGMA table_info(language_moderation_violations)").all() as Array<{ name: string }>;
      assert.ok(violationColumns.some((column) => column.name === "message_thread_id"));
      const publicChatColumns = inspected.prepare("PRAGMA table_info(managed_public_chats)").all() as Array<{ name: string }>;
      assert.ok(publicChatColumns.some((column) => column.name === "connection_status"));
      const batchPackage = inspected.prepare("SELECT status, final_summary_state FROM ticket_batch_answer_packages WHERE answer_package_id = ?")
        .get("synthetic-package") as { status: string; final_summary_state: string };
      const batchItem = inspected.prepare("SELECT state, delivery_message_id FROM ticket_batch_answer_items WHERE answer_package_id = ? AND ticket_id = 42")
        .get("synthetic-package") as { state: string; delivery_message_id: number };
      assert.deepEqual(batchPackage, { status: "PARTIAL", final_summary_state: "FAILED" });
      assert.deepEqual(batchItem, { state: "STAFF_SYNC_PENDING", delivery_message_id: 9001 });
    } finally {
      inspected.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
