import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "node:test";
import Database from "better-sqlite3";
import { SupportDatabase } from "../src/db.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("upgrades a v1.2.1 ticket batch schema through migration 16 without changing legacy exports", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-ticket-batch-migration-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "support.db");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE ticket_batch_exports (
      export_id TEXT PRIMARY KEY, staff_chat_id INTEGER NOT NULL, created_at TEXT NOT NULL,
      selection_mode TEXT NOT NULL, ticket_count INTEGER NOT NULL
    );
    CREATE TABLE ticket_batch_answer_packages (
      answer_package_id TEXT PRIMARY KEY, export_id TEXT NOT NULL, staff_chat_id INTEGER NOT NULL,
      package_hash TEXT NOT NULL, source_chat_id INTEGER, source_message_id INTEGER,
      package_created_at TEXT NOT NULL, imported_at TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE ticket_batch_answer_items (
      answer_package_id TEXT NOT NULL, ticket_id INTEGER NOT NULL, snapshot_token TEXT NOT NULL,
      action TEXT NOT NULL, reply_text TEXT, state TEXT NOT NULL, delivery_message_id INTEGER,
      applied_at TEXT, last_error TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY (answer_package_id, ticket_id)
    );
    CREATE TABLE tickets (
      id INTEGER PRIMARY KEY, user_telegram_id INTEGER NOT NULL, status TEXT NOT NULL,
      staff_chat_id INTEGER, message_thread_id INTEGER, staff_message_id INTEGER,
      logs_message_id INTEGER, transcript_message_id INTEGER, archived_at TEXT,
      closed_by_type TEXT, closed_by_display_name TEXT, closed_by_username TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
    );
  `);
  const timestamp = "2026-07-31T00:00:00.000Z";
  const insertMigration = legacy.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)");
  for (let id = 1; id <= 12; id += 1) insertMigration.run(id, `migration_${id}`, timestamp);
  legacy.prepare("INSERT INTO ticket_batch_exports (export_id, staff_chat_id, created_at, selection_mode, ticket_count) VALUES (?, ?, ?, ?, ?)")
    .run("legacy_export", -100900, timestamp, "all_active", 1);
  legacy.close();

  const upgraded = new SupportDatabase(databasePath);
  upgraded.close();
  const inspected = new Database(databasePath, { readonly: true });
  try {
    const migrationIds = inspected.prepare("SELECT id FROM schema_migrations ORDER BY id ASC").all() as Array<{ id: number }>;
    const exportColumns = inspected.prepare("PRAGMA table_info(ticket_batch_exports)").all() as Array<{ name: string }>;
    const packageColumns = inspected.prepare("PRAGMA table_info(ticket_batch_answer_packages)").all() as Array<{ name: string }>;
    const legacyExport = inspected.prepare("SELECT delivery_state, delivery_message_id, delivered_at, last_error FROM ticket_batch_exports WHERE export_id = ?")
      .get("legacy_export") as { delivery_state: string; delivery_message_id: number | null; delivered_at: string | null; last_error: string | null };

    const itemColumns = inspected.prepare("PRAGMA table_info(ticket_batch_answer_items)").all() as Array<{ name: string }>;
    const ticketColumns = inspected.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>;
    assert.deepEqual(migrationIds.map((row) => row.id), Array.from({ length: 16 }, (_, index) => index + 1));
    assert.deepEqual(exportColumns.map((column) => column.name).filter((name) => name.startsWith("delivery_") || name === "delivered_at" || name === "last_error"), ["delivery_state", "delivery_message_id", "delivered_at", "last_error"]);
    assert.deepEqual(packageColumns.map((column) => column.name).filter((name) => name.startsWith("preview_")), ["preview_token", "preview_chat_id", "preview_message_id", "preview_page"]);
    assert.ok(itemColumns.some((column) => column.name === "topic_echo_state"));
    assert.ok(itemColumns.some((column) => column.name === "delivery_error_category"));
    assert.ok(itemColumns.some((column) => column.name === "delivery_failure_event_message_id"));
    assert.ok(packageColumns.some((column) => column.name === "summary_delivery_state"));
    assert.ok(packageColumns.some((column) => column.name === "final_summary_state"));
    assert.ok(itemColumns.some((column) => column.name === "topic_echo_next_retry_at"));
    assert.ok(itemColumns.some((column) => column.name === "delivery_failure_event_next_retry_at"));
    assert.ok(ticketColumns.some((column) => column.name === "follow_up_state"));
    assert.deepEqual(legacyExport, { delivery_state: "DELIVERED", delivery_message_id: null, delivered_at: null, last_error: null });
  } finally {
    inspected.close();
  }

  const reopened = new SupportDatabase(databasePath);
  reopened.close();
});
