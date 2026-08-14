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

test("private control plane owns dashboard callbacks and private editor input dispatch", async () => {
  const db = new SupportDatabase(":memory:");
  const installation = new InstallationService(db);
  const controlPlane = new PrivateControlPlane(installation);
  const token = installation.createOwnerPairingToken();
  installation.consumeOwnerPairingToken(token, { telegramId: 42, username: "owner" });
  const edits: string[] = [];
  const context = {
    from: { id: 42, is_bot: false, first_name: "Owner" },
    chat: { id: 42, type: "private" },
    api: {
      async editMessageText(_chatId: number, _messageId: number, text: string) { edits.push(text); },
      async deleteMessage() {},
      async editMessageReplyMarkup() {}
    },
    callbackQuery: { message: { chat: { id: 42, type: "private" }, message_id: 100 } },
    async answerCallbackQuery() {},
    async reply() { return { chat: { id: 42 }, message_id: 100 }; }
  } as unknown as Context;

  controlPlane.configureOperatorUi({
    db,
    quickReplies: {} as never,
    canConfigure: async () => true,
    canUsePermission: async () => true,
    hasPrivateWorkspaceMembership: async () => true,
    getPendingBatchExport: () => undefined,
    onStartTestTicket: async () => {},
    onShowWorkspace: async () => {},
    onShowBatch: async () => {},
    packageVersion: "1.3.0",
    botUsername: () => "bot",
    botId: () => 1
  });

  try {
    await controlPlane.renderScreen(context, "Owner dashboard", new InlineKeyboard().text("Support settings", "dashboard:support"));
    assert.equal(await controlPlane.handleCallback(context, "dashboard:support"), true);
    assert.match(edits.at(-1) ?? "", /Support settings/);

    assert.equal(await controlPlane.handleCallback(context, "support:edit"), true);
    assert.equal(controlPlane.getPendingSupportSettingsInput(42), "RESPONSE_TIME");
    assert.equal(await controlPlane.handlePrivateInput(context, "30 minutes"), true);
    assert.equal(controlPlane.getPendingSupportSettingsInput(42), undefined);
    assert.equal(db.getSetting("support_expected_response_time"), "30 minutes");
    assert.equal(await controlPlane.handlePrivateInput(context, "unrelated operator text"), false);
  } finally {
    db.close();
  }
});

test("public callbacks require current staff workspace membership even for an owner", async () => {
  const db = new SupportDatabase(":memory:");
  const installation = new InstallationService(db);
  const controlPlane = new PrivateControlPlane(installation);
  const token = installation.createOwnerPairingToken();
  installation.consumeOwnerPairingToken(token, { telegramId: 42, username: "owner" });
  const workspace = installation.activateWorkspace({ chatId: -1001, title: "Staff" });
  db.upsertManagedPublicChat({ chatId: -2001, workspaceId: workspace.id, title: "Public" });
  db.setManagedPublicChatModerationEnabled(-2001, true);
  const alerts: Array<{ text?: string; show_alert?: boolean }> = [];
  let telegramInspectionCalls = 0;
  let screenReplies = 0;
  const context = {
    from: { id: 42, is_bot: false, first_name: "Owner" },
    chat: { id: 42, type: "private" },
    api: {
      async getChat() { telegramInspectionCalls += 1; },
      async editMessageText() {},
      async deleteMessage() {},
      async editMessageReplyMarkup() {}
    },
    callbackQuery: { message: { chat: { id: 42, type: "private" }, message_id: 100 } },
    async answerCallbackQuery(options?: { text?: string; show_alert?: boolean }) { alerts.push(options ?? {}); },
    async reply() { screenReplies += 1; return { chat: { id: 42 }, message_id: 100 }; }
  } as unknown as Context;
  controlPlane.configureOperatorUi({
    db,
    quickReplies: {} as never,
    canConfigure: async () => true,
    canUsePermission: async () => true,
    hasPrivateWorkspaceMembership: async () => false,
    getPendingBatchExport: () => undefined,
    onStartTestTicket: async () => {},
    onShowWorkspace: async () => {},
    onShowBatch: async () => {},
    packageVersion: "1.3.0",
    botUsername: () => "bot",
    botId: () => 1
  });

  try {
    assert.equal(await controlPlane.handleCallback(context, "public:disable:-2001"), true);
    assert.equal(await controlPlane.handleCallback(context, "public:list"), true);
    assert.deepEqual(alerts, [
      { text: "Staff workspace membership required.", show_alert: true },
      { text: "Staff workspace membership required.", show_alert: true }
    ]);
    assert.equal(db.getManagedPublicChat(-2001)?.moderation_enabled, 1);
    assert.equal(telegramInspectionCalls, 0);
    assert.equal(screenReplies, 0);
  } finally {
    db.close();
  }
});
