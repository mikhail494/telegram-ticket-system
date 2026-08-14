import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import type { Update } from "grammy/types";
import { DEFAULT_SUPPORT_EXPECTED_RESPONSE_TIME } from "../src/format.js";
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

test("new ticket acknowledgement uses the default or configured expected response time without repeating on follow-up", async () => {
  const { harness } = createReadyHarness();
  const userId = 501;
  harness.setStaffMembership(userId, "left");

  await harness.bot.handleUpdate(privateMessage(userId, "Need help", 1));
  assert.equal(acknowledgementText(harness, userId), [
    "Thanks, your request has been received.",
    "",
    `Expected response time: ${DEFAULT_SUPPORT_EXPECTED_RESPONSE_TIME}.`,
    "",
    "You can continue sending messages in this chat until your ticket is closed."
  ].join("\n"));
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
    } else {
      assert.doesNotMatch(text, /Support settings/);
      assert.equal(harness.db.getSetting("support_expected_response_time"), undefined);
    }
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
    await restarted.bot.handleUpdate(privateCallback(1, "support:reset", 10));
    assert.equal(restarted.db.getSetting("support_expected_response_time"), "");
    assert.match(String(restarted.findApiCalls("editMessageText").at(-1)?.payload.text), /1-7 business days/);
  } finally {
    restarted?.cleanup();
    if (restarted) harnesses.splice(harnesses.indexOf(restarted), 1);
    await rm(directory, { recursive: true, force: true });
  }
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
