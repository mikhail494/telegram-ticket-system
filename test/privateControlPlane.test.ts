import assert from "node:assert/strict";
import test from "node:test";
import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";

process.env.BOT_TOKEN ??= "123456:TEST_PRIVATE_CONTROL_PLANE_TOKEN";
const { SupportDatabase } = await import("../src/db.js");
const { InstallationService } = await import("../src/installation.js");
const { PrivateControlPlane } = await import("../src/privateControlPlane.js");

test("private control plane keeps one authoritative screen and rejects stale callbacks", async () => {
  const db = new SupportDatabase(":memory:");
  const installation = new InstallationService(db);
  const controlPlane = new PrivateControlPlane(installation);
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  const context = {
    from: { id: 42, is_bot: false, first_name: "Operator" },
    chat: { id: 42, type: "private" },
    api: {
      async editMessageText(chatId: number, messageId: number, text: string) {
        edits.push({ chatId, messageId, text });
      },
      async deleteMessage() {},
      async editMessageReplyMarkup() {}
    },
    async reply() {
      return { chat: { id: 42 }, message_id: 100 };
    }
  } as unknown as Context;

  try {
    await controlPlane.renderScreen(context, "Owner dashboard", new InlineKeyboard().text("System status", "dashboard:status"));
    await controlPlane.renderScreen(context, "System status", new InlineKeyboard().text("Back", "dashboard:home"));

    assert.deepEqual(edits, [{ chatId: 42, messageId: 100, text: "System status" }]);
    const staleCallback = {
      ...context,
      callbackQuery: { message: { chat: { id: 42, type: "private" }, message_id: 99 } }
    } as unknown as Context;
    const activeCallback = {
      ...context,
      callbackQuery: { message: { chat: { id: 42, type: "private" }, message_id: 100 } }
    } as unknown as Context;
    assert.equal(controlPlane.isObsoleteOperatorCallback(staleCallback, "dashboard"), true);
    assert.equal(controlPlane.isObsoleteOperatorCallback(activeCallback, "dashboard"), false);
  } finally {
    db.close();
  }
});
