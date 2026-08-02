import test from "node:test";
import assert from "node:assert/strict";
import { InstallationService } from "../src/installation.js";
import { isPrivateInviteLink, parsePublicSupergroupReference } from "../src/workspaceValidation.js";
import { createBotHarness } from "./helpers/botHarness.js";
import type { Update } from "grammy/types";

function sharedUpdate(chatId: number): Update {
  return { update_id: 1, message: { message_id: 1, date: 1, from: { id: 1, is_bot: false, first_name: "Owner" }, chat: { id: 1, type: "private", first_name: "Owner" }, chat_shared: { request_id: 1300, chat_id: chatId, title: "Candidate" } } };
}

test("public supergroup references normalize safely", () => {
  assert.equal(parsePublicSupergroupReference("@support_team"), "@support_team");
  assert.equal(parsePublicSupergroupReference("https://t.me/support_team"), "@support_team");
  assert.equal(parsePublicSupergroupReference("123456"), null);
  assert.equal(isPrivateInviteLink("https://t.me/+secret"), true);
});

test("non-forum workspace is rejected and not persisted", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => { service = new InstallationService(db); service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 }); return service; } });
  try {
    harness.setApiResponseOverride("getChat", () => ({ ok: true, result: { id: -100700, type: "supergroup", title: "No Topics", is_forum: false } }));
    await harness.bot.handleUpdate(sharedUpdate(-100700));
    assert.equal(service.getStaffChatId(), null);
    assert.match(String(harness.findApiCalls("sendMessage")[0]?.payload.text), /Forum topics enabled/);
  } finally { harness.cleanup(); }
});

test("missing bot rights produces a human-readable checklist", async () => {
  let service!: InstallationService;
  const harness = createBotHarness({ installationServiceFactory: (db) => { service = new InstallationService(db); service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 }); return service; } });
  try {
    harness.setApiResponseOverride("getChatMember", (call) => Number(call.payload.user_id) === 777 ? ({ ok: true, result: { status: "member", user: { id: 777, is_bot: true, first_name: "Bot" } } }) : undefined);
    await harness.bot.handleUpdate(sharedUpdate(-100701));
    const text = String(harness.findApiCalls("sendMessage")[0]?.payload.text);
    assert.match(text, /❌ Bot is an administrator/);
    assert.match(text, /❌ Manage topics/);
    assert.equal(service.getStaffChatId(), null);
  } finally { harness.cleanup(); }
});
