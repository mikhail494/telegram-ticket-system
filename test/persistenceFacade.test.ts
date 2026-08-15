import assert from "node:assert/strict";
import test from "node:test";
import { SupportDatabase } from "../src/db.js";

test("SupportDatabase preserves its facade across extracted persistence domains", () => {
  const db = new SupportDatabase(":memory:");

  try {
    db.upsertUser({ telegramId: 501, username: "facade_user", firstName: "Facade", lastName: null });
    const ticket = db.createTicket(501, -100501);
    db.addMessage({ ticketId: ticket.id, direction: "USER_TO_STAFF", text: "Facade message" });
    assert.equal(db.getTicketWithUser(ticket.id)?.username, "facade_user");
    assert.equal(db.listMessages(ticket.id).length, 1);

    db.createTicketBatchExport({
      exportId: "export_facade",
      staffChatId: -100501,
      createdAt: "2026-08-15T00:00:00.000Z",
      selectionMode: "all_active",
      ticketCount: 1,
      items: [{ ticketId: ticket.id, snapshotToken: "facade-token" }]
    });
    assert.equal(db.getTicketBatchExport("export_facade", -100501)?.ticket_count, 1);

    const workspace = db.upsertWorkspace({ telegramChatId: -100501, title: "Facade workspace" });
    const publicChat = db.upsertManagedPublicChat({
      chatId: -100502,
      workspaceId: workspace.id,
      title: "Facade public chat"
    });
    assert.equal(db.getManagedPublicChat(publicChat.chat_id)?.title, "Facade public chat");

    assert.equal(
      db.addLanguageModerationViolation({
        chat_id: publicChat.chat_id,
        user_telegram_id: 501,
        message_id: 9,
        username: "facade_user",
        cycle_tier: 0
      }),
      true
    );
    assert.equal(
      db.listLanguageModerationViolations(publicChat.chat_id, "1970-01-01T00:00:00.000Z").length,
      1
    );

    db.seedQuickReplies([
      {
        id: "facade",
        title: "Facade",
        templates: [{ id: "facade-template", title: "Template", text: "Facade quick reply" }]
      }
    ]);
    assert.equal(db.getQuickReplyTemplate("facade-template")?.text, "Facade quick reply");
  } finally {
    db.close();
  }
});
