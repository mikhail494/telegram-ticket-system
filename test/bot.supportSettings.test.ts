import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import type { Update } from "grammy/types";
import {
  DEFAULT_SUPPORT_EXPECTED_RESPONSE_TIME,
  DEFAULT_SUPPORT_TICKET_RECEIVED_TEMPLATE
} from "../src/format.js";
import { InstallationService } from "../src/installation.js";
import { createBotHarness, TEST_STAFF_CHAT_ID, type BotHarness } from "./helpers/botHarness.js";

const harnesses: BotHarness[] = [];

afterEach(() => {
  for (const harness of harnesses) harness.cleanup();
  harnesses.length = 0;
});

function createReadyHarness(options: { role?: "OWNER" | "ADMIN" | "SENIOR_AGENT" | "AGENT"; rbac?: boolean; databasePath?: string } = {}) {
  let installation!: InstallationService;
  const harness = createBotHarness({ databasePath: options.databasePath, installationServiceFactory: (db) => {
    installation = new InstallationService(db);
    installation.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
    installation.consumeOwnerPairingToken(installation.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    if (options.role && options.role !== "OWNER") installation.assignRole(1, 2, options.role);
    if (options.rbac) {
      const preview = installation.previewRoleBasedAccessActivation();
      installation.activateRoleBasedAccess(1, preview.confirmationToken);
    }
    return installation;
  } });
  harnesses.push(harness);
  return { harness, installation };
}

function createRestartedHarness(databasePath: string) {
  let installation!: InstallationService;
  const harness = createBotHarness({ databasePath, installationServiceFactory: (db) => (installation = new InstallationService(db)) });
  harnesses.push(harness);
  return { harness, installation };
}

function privateMessage(userId: number, text: string, messageId = 1): Update {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1,
      from: { id: userId, is_bot: false, first_name: `User ${userId}`, username: `user_${userId}` },
      chat: { id: userId, type: "private", first_name: `User ${userId}` },
      text
    }
  };
}

function privateCallback(userId: number, data: string, messageId = 10): Update {
  return {
    update_id: messageId,
    callback_query: {
      id: `callback-${messageId}`,
      from: { id: userId, is_bot: false, first_name: `User ${userId}`, username: `user_${userId}` },
      chat_instance: "private",
      data,
      message: { message_id: messageId, date: 1, chat: { id: userId, type: "private", first_name: `User ${userId}` }, text: "Dashboard" }
    }
  };
}

function acknowledgementText(harness: BotHarness, userId: number): string {
  const call = harness.findApiCalls("sendMessage").find((entry) => entry.payload.chat_id === userId && String(entry.payload.text).startsWith("Thanks, your request"));
  return String(call?.payload.text);
}

function ticketAcknowledgementText(harness: BotHarness, userId: number): string {
  const call = harness.findApiCalls("sendMessage").find((entry) => entry.payload.chat_id === userId && entry.payload.reply_markup !== undefined);
  return String(call?.payload.text);
}

test("new ticket acknowledgement uses the default or configured expected response time without repeating on follow-up", async () => {
  const { harness } = createReadyHarness();
  const userId = 501;
  harness.setStaffMembership(userId, "left");

  await harness.bot.handleUpdate(privateMessage(userId, "Need help", 1));
  assert.equal(acknowledgementText(harness, userId), DEFAULT_SUPPORT_TICKET_RECEIVED_TEMPLATE.replaceAll("{{response_time}}", DEFAULT_SUPPORT_EXPECTED_RESPONSE_TIME));
  assert.doesNotMatch(acknowledgementText(harness, userId), /get back to you soon/i);

  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(userId, "A follow-up", 2));
  assert.equal(harness.findApiCalls("sendMessage").some((entry) => String(entry.payload.text).includes("Expected response time:")), false);

  harness.db.setSetting("support_expected_response_time", "1-3 business days");
  await harness.bot.handleUpdate(privateMessage(502, "Another request", 3));
  assert.match(acknowledgementText(harness, 502), /Expected response time: 1-3 business days\./);
});

test("OWNER and ADMIN can manage support settings while junior roles cannot", async () => {
  for (const role of ["OWNER", "ADMIN", "SENIOR_AGENT", "AGENT"] as const) {
    const { harness } = createReadyHarness({ role, rbac: true });
    const userId = role === "OWNER" ? 1 : 2;
    await harness.bot.handleUpdate(privateCallback(userId, "dashboard:support", 10));
    const text = String(harness.findApiCalls("editMessageText").at(-1)?.payload.text);
    if (role === "OWNER" || role === "ADMIN") {
      assert.match(text, /Support settings/);
      assert.match(text, /Expected response time:\n1-7 business days/);
      assert.match(text, /New-ticket acknowledgement preview/);
      assert.match(JSON.stringify(harness.findApiCalls("editMessageText").at(-1)?.payload.reply_markup), /Edit acknowledgement/);
    } else {
      assert.doesNotMatch(text, /Support settings/);
      assert.equal(harness.db.getSetting("support_expected_response_time"), undefined);
    }
  }
});

test("support acknowledgement editor rejects unsafe, oversized, and Telegram-oversized rendered templates", async () => {
  const { harness } = createReadyHarness();
  harness.db.setSetting("support_expected_response_time", "x".repeat(80));
  await harness.bot.handleUpdate(privateCallback(1, "dashboard:support", 10));
  await harness.bot.handleUpdate(privateCallback(1, "support:edit-acknowledgement", 10));

  for (const [value, error] of [["contains\u0000nul", /unsafe control/], ["x".repeat(3501), /3500 characters/], ["{{response_time}}".repeat(52), /4096-character/]] as const) {
    harness.clearApiCalls();
    await harness.bot.handleUpdate(privateMessage(1, value, 20));
    assert.match(String(harness.findApiCalls("editMessageText").at(-1)?.payload.text), error);
    assert.equal(harness.db.getSetting("support_ticket_received_template"), undefined);
    assert.equal(harness.findApiCalls("deleteMessage").some((entry) => entry.payload.message_id === 20), true);
  }
});

test("support response time editor validates input, persists through restart, and resets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "support-settings-"));
  const databasePath = path.join(directory, "support.sqlite");
  let restarted: BotHarness | undefined;
  try {
    const { harness } = createReadyHarness({ databasePath });
    await harness.bot.handleUpdate(privateCallback(1, "dashboard:support", 10));
    await harness.bot.handleUpdate(privateCallback(1, "support:edit", 10));

    for (const [value, error] of [["   ", /empty/], ["one\ntwo", /one line/], ["x".repeat(81), /80 characters/]] as const) {
      harness.clearApiCalls();
      await harness.bot.handleUpdate(privateMessage(1, value, 20));
      assert.match(String(harness.findApiCalls("editMessageText").at(-1)?.payload.text), error);
      assert.equal(harness.db.getSetting("support_expected_response_time"), undefined);
    }

    await harness.bot.handleUpdate(privateMessage(1, "  within 24 hours  ", 21));
    assert.equal(harness.db.getSetting("support_expected_response_time"), "within 24 hours");
    harness.cleanup();
    harnesses.splice(harnesses.indexOf(harness), 1);

    ({ harness: restarted } = createRestartedHarness(databasePath));
    assert.equal(restarted.db.getSetting("support_expected_response_time"), "within 24 hours");
    await restarted.bot.handleUpdate(privateCallback(1, "dashboard:support", 10));
    await restarted.bot.handleUpdate(privateCallback(1, "support:reset-response-time", 10));
    assert.equal(restarted.db.getSetting("support_expected_response_time"), "");
    assert.match(String(restarted.findApiCalls("editMessageText").at(-1)?.payload.text), /1-7 business days/);
  } finally {
    restarted?.cleanup();
    if (restarted) harnesses.splice(harnesses.indexOf(restarted), 1);
    await rm(directory, { recursive: true, force: true });
  }
});

test("support response time editor rejects a value that would make the current acknowledgement too long", async () => {
  const { harness } = createReadyHarness();
  const shortResponseTime = "soon";
  const longResponseTime = "x".repeat(80);
  const template = "{{response_time}}".repeat(52);
  harness.db.setSetting("support_expected_response_time", shortResponseTime);
  harness.db.setSetting("support_ticket_received_template", template);

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:support", 10));
  await harness.bot.handleUpdate(privateCallback(1, "support:edit", 10));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, longResponseTime, 20));

  assert.equal(harness.db.getSetting("support_expected_response_time"), shortResponseTime);
  assert.equal(harness.findApiCalls("deleteMessage").some((entry) => entry.payload.message_id === 20), true);
  assert.match(String(harness.findApiCalls("editMessageText").at(-1)?.payload.text), /current acknowledgement too long/i);

  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "within 24 hours", 21));
  assert.equal(harness.db.getSetting("support_expected_response_time"), "within 24 hours");
});

test("support response time changes remain valid for acknowledgement templates without placeholders", async () => {
  const { harness } = createReadyHarness();
  harness.db.setSetting("support_ticket_received_template", "We received your request.");
  await harness.bot.handleUpdate(privateCallback(1, "dashboard:support", 10));
  await harness.bot.handleUpdate(privateCallback(1, "support:edit", 10));
  await harness.bot.handleUpdate(privateMessage(1, "within 24 hours", 20));

  assert.equal(harness.db.getSetting("support_expected_response_time"), "within 24 hours");
  harness.setStaffMembership(505, "left");
  await harness.bot.handleUpdate(privateMessage(505, "Need help", 21));
  assert.equal(ticketAcknowledgementText(harness, 505), "We received your request.");
});

test("invalid persisted acknowledgement settings do not create a ticket", async () => {
  const { harness } = createReadyHarness();
  const userId = 506;
  harness.setStaffMembership(userId, "left");
  harness.db.setSetting("support_expected_response_time", "x".repeat(80));
  harness.db.setSetting("support_ticket_received_template", "{{response_time}}".repeat(52));

  await harness.bot.handleUpdate(privateMessage(userId, "Need help", 1));

  assert.equal(harness.db.listTicketsForUser(userId, TEST_STAFF_CHAT_ID).length, 0);
  assert.equal(
    harness.findApiCalls("sendMessage").some((entry) => entry.payload.chat_id === userId && /settings need attention/i.test(String(entry.payload.text))),
    true
  );
});

test("support acknowledgement templates render every response-time placeholder and reset to the default", async () => {
  const { harness } = createReadyHarness();
  harness.db.setSetting("support_expected_response_time", "up to 5 working days");
  await harness.bot.handleUpdate(privateCallback(1, "dashboard:support", 10));
  await harness.bot.handleUpdate(privateCallback(1, "support:edit-acknowledgement", 10));
  await harness.bot.handleUpdate(privateMessage(1, "Reply in {{response_time}}.\nAgain: {{response_time}}.", 20));

  assert.equal(harness.db.getSetting("support_ticket_received_template"), "Reply in {{response_time}}.\nAgain: {{response_time}}.");
  harness.setStaffMembership(501, "left");
  await harness.bot.handleUpdate(privateMessage(501, "Need help", 21));
  assert.equal(ticketAcknowledgementText(harness, 501), "Reply in up to 5 working days.\nAgain: up to 5 working days.");

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:support", 10));
  await harness.bot.handleUpdate(privateCallback(1, "support:reset-acknowledgement", 10));
  assert.equal(harness.db.getSetting("support_ticket_received_template"), "");
});

test("a normal customer close keeps the customer flow and does not render an operator dashboard", async () => {
  const { harness } = createReadyHarness();
  const userId = 504;
  harness.setStaffMembership(userId, "left");
  await harness.bot.handleUpdate(privateMessage(userId, "Need help", 1));
  const ticket = harness.db.findActiveTicketForUser(userId, TEST_STAFF_CHAT_ID)!;
  const acknowledgement = harness.findApiCalls("sendMessage").find((call) => call.payload.chat_id === userId && call.payload.reply_markup !== undefined)!;

  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateCallback(userId, `user:close:${ticket.id}`, acknowledgement.responseMessageId));
  assert.equal(harness.findApiCalls("sendMessage").some((call) => /Owner dashboard|Admin dashboard/.test(String(call.payload.text))), false);
});

test("support acknowledgement editor permits a template without a response-time placeholder and deletes consumed input", async () => {
  const { harness } = createReadyHarness();
  await harness.bot.handleUpdate(privateCallback(1, "dashboard:support", 10));
  await harness.bot.handleUpdate(privateCallback(1, "support:edit-acknowledgement", 10));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "We received your request.", 20));

  assert.equal(harness.db.getSetting("support_ticket_received_template"), "We received your request.");
  assert.equal(harness.findApiCalls("deleteMessage").some((entry) => entry.payload.message_id === 20), true);
  harness.setStaffMembership(502, "left");
  await harness.bot.handleUpdate(privateMessage(502, "Need help", 21));
  assert.equal(ticketAcknowledgementText(harness, 502), "We received your request.");
});

test("invalid support settings input is deleted without consuming ordinary customer messages", async () => {
  const { harness } = createReadyHarness();
  await harness.bot.handleUpdate(privateCallback(1, "dashboard:support", 10));
  await harness.bot.handleUpdate(privateCallback(1, "support:edit", 10));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "one\ntwo", 20));
  assert.equal(harness.findApiCalls("deleteMessage").some((entry) => entry.payload.message_id === 20), true);

  harness.clearApiCalls();
  harness.setStaffMembership(503, "left");
  await harness.bot.handleUpdate(privateMessage(503, "Customer request", 21));
  assert.equal(harness.countApiCalls("deleteMessage"), 0);
});

test("support settings use one current private screen and stale callbacks are inert", async () => {
  const { harness } = createReadyHarness();
  await harness.bot.handleUpdate(privateCallback(1, "dashboard:support", 10));
  assert.equal(harness.countApiCalls("sendMessage"), 0);
  assert.equal(harness.countApiCalls("editMessageText"), 1);

  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateCallback(1, "support:edit", 11));
  assert.equal(harness.countApiCalls("editMessageText"), 0);
  assert.equal(harness.countApiCalls("answerCallbackQuery"), 1);
  assert.match(String(harness.findApiCalls("answerCallbackQuery")[0]?.payload.text), /no longer active/i);
});

test("support settings disarm test-ticket mode and accept editor text while a batch export is pending", async () => {
  const { harness } = createReadyHarness();
  harness.db.setSetting("staff_test_ticket_mode:1", "true");
  harness.db.createTicketBatchExport({
    exportId: "export_support_settings",
    staffChatId: TEST_STAFF_CHAT_ID,
    createdAt: "2026-08-14T00:00:00.000Z",
    selectionMode: "all_active",
    ticketCount: 0,
    items: []
  });
  harness.db.setSetting("private_batch_export:1", "export_support_settings");

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:support", 10));
  assert.equal(harness.db.getSetting("staff_test_ticket_mode:1"), "false");
  await harness.bot.handleUpdate(privateCallback(1, "support:edit", 10));
  await harness.bot.handleUpdate(privateMessage(1, "up to 5 working days", 20));

  assert.equal(harness.db.getSetting("support_expected_response_time"), "up to 5 working days");
  assert.equal(harness.db.listTicketsForUser(1, TEST_STAFF_CHAT_ID).length, 0);
  assert.equal(harness.db.getSetting("private_batch_export:1"), "export_support_settings");
});
