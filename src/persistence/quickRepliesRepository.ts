import Database from "better-sqlite3";
import { now } from "./helpers.js";
import type { QuickReplyCategoryRecord, QuickReplyTemplateRecord } from "./types.js";
export class QuickRepliesRepository {
  constructor(private readonly db: Database.Database) {}
  private getSetting(key: string): string | undefined { return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value; }
  seedQuickReplies(categories: ReadonlyArray<{ id: string; title: string; templates: ReadonlyArray<{ id: string; title: string; text: string }> }>): void {
    if (this.getSetting("quick_replies:seeded") === "true") return;
    const seed = this.db.transaction(() => {
      const timestamp = now();
      const insertCategory = this.db.prepare(`INSERT OR IGNORE INTO quick_reply_categories (id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
      const insertTemplate = this.db.prepare(`INSERT OR IGNORE INTO quick_reply_templates (id, category_id, title, text, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const [categoryOrder, category] of categories.entries()) {
        insertCategory.run(category.id, category.title, categoryOrder, timestamp, timestamp);
        for (const [templateOrder, template] of category.templates.entries()) {
          insertTemplate.run(template.id, category.id, template.title, template.text, templateOrder, timestamp, timestamp);
        }
      }
      this.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('quick_replies:seeded', 'true', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(timestamp);
    });
    seed();
  }

  listQuickReplyCategories(): QuickReplyCategoryRecord[] {
    return this.db.prepare(`SELECT id, title, sort_order, created_at, updated_at FROM quick_reply_categories ORDER BY sort_order, id`).all() as QuickReplyCategoryRecord[];
  }

  listQuickReplyTemplates(categoryId: string): QuickReplyTemplateRecord[] {
    return this.db.prepare(`SELECT id, category_id, title, text, sort_order, created_at, updated_at FROM quick_reply_templates WHERE category_id = ? ORDER BY sort_order, id`).all(categoryId) as QuickReplyTemplateRecord[];
  }

  getQuickReplyTemplate(templateId: string): QuickReplyTemplateRecord | undefined {
    return this.db.prepare(`SELECT id, category_id, title, text, sort_order, created_at, updated_at FROM quick_reply_templates WHERE id = ?`).get(templateId) as QuickReplyTemplateRecord | undefined;
  }

  updateQuickReplyTemplate(templateId: string, input: { title: string; text: string }): QuickReplyTemplateRecord | undefined {
    const timestamp = now();
    const updated = this.db.prepare(`UPDATE quick_reply_templates SET title = ?, text = ?, updated_at = ? WHERE id = ?`).run(input.title, input.text, timestamp, templateId);
    return updated.changes === 1 ? this.getQuickReplyTemplate(templateId) : undefined;
  }

  createQuickReplyTemplate(input: { id: string; categoryId: string; title: string; text: string }): QuickReplyTemplateRecord {
    const category = this.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS maximum FROM quick_reply_templates WHERE category_id = ?`).get(input.categoryId) as { maximum: number };
    const timestamp = now();
    this.db.prepare(`INSERT INTO quick_reply_templates (id, category_id, title, text, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.categoryId, input.title, input.text, category.maximum + 1, timestamp, timestamp);
    return this.getQuickReplyTemplate(input.id)!;
  }

  deleteQuickReplyTemplate(templateId: string): "DELETED" | "NOT_FOUND" | "LAST_TEMPLATE" {
    const remove = this.db.transaction(() => {
      const existing = this.getQuickReplyTemplate(templateId);
      if (!existing) return "NOT_FOUND" as const;
      const count = this.db.prepare(`SELECT COUNT(*) AS count FROM quick_reply_templates WHERE category_id = ?`).get(existing.category_id) as { count: number };
      if (count.count <= 1) return "LAST_TEMPLATE" as const;
      this.db.prepare(`DELETE FROM quick_reply_templates WHERE id = ?`).run(templateId);
      return "DELETED" as const;
    });
    return remove();
  }


}