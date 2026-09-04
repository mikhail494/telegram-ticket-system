import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { SupportDatabase } from "../src/db.js";

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
        Array.from({ length: 23 }, (_, index) => index + 1)
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
});
