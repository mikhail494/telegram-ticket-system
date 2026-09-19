import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { Update } from "grammy/types";
import { InstallationService } from "../src/installation.js";
import { createBotHarness, TEST_STAFF_CHAT_ID, type BotHarness } from "./helpers/botHarness.js";

const harnesses: BotHarness[] = [];

afterEach(() => {
  for (const harness of harnesses) harness.cleanup();
  harnesses.length = 0;
});

function createReadyHarness(options: { admin?: boolean; rbac?: boolean } = {}) {
  let installation!: InstallationService;
  const harness = createBotHarness({
    installationServiceFactory: (db) => {
      installation = new InstallationService(db);
      installation.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
      installation.consumeOwnerPairingToken(installation.createOwnerPairingToken(), {
        telegramId: 1,
        username: "owner",
      });
      if (options.admin) installation.assignRole(1, 2, "ADMIN");
      if (options.rbac) {
        const preview = installation.previewRoleBasedAccessActivation();
        installation.activateRoleBasedAccess(1, preview.confirmationToken);
      }
      return installation;
    },
  });
  harnesses.push(harness);
  return { harness, installation };
}

function privateCallback(userId: number, data: string, messageId = 10): Update {
  return {
    update_id: messageId,
    callback_query: {
      id: `callback-${userId}-${messageId}-${data}`,
      from: { id: userId, is_bot: false, first_name: `User ${userId}` },
      chat_instance: "private",
      data,
      message: {
        message_id: messageId,
        date: 1,
        chat: { id: userId, type: "private", first_name: `User ${userId}` },
        text: "Dashboard",
      },
    },
  };
}

function privateMessage(userId: number, text: string, messageId = 20): Update {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1,
      from: { id: userId, is_bot: false, first_name: `User ${userId}` },
      chat: { id: userId, type: "private", first_name: `User ${userId}` },
      text,
    },
  };
}

function seedUnknownInteractive(harness: BotHarness, sourceMessageId = 7001) {
  const ticket = harness.seedTicket();
  const operationKey = `staff-message:${TEST_STAFF_CHAT_ID}:${sourceMessageId}`;
  harness.db.createTicketOutboundDeliveryIntent({
    operationKey,
    ticketId: ticket.id,
    direction: "STAFF_TO_USER",
    sourceChatId: TEST_STAFF_CHAT_ID,
    sourceMessageId,
    deliveryChatId: ticket.user_telegram_id,
    fromTelegramId: 1,
    senderType: "STAFF",
    senderDisplayName: "Owner",
    text: "Ambiguous reply",
  });
  harness.db.markTicketOutboundDeliveryUnknown(operationKey, "Ambiguous transport outcome.");
  return { ticket, operationKey, record: harness.db.listUnknownDeliveryReconciliations(TEST_STAFF_CHAT_ID)[0]! };
}

test("OWNER reconciles an UNKNOWN interactive delivery without resending it", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  const { ticket, operationKey, record } = seedUnknownInteractive(harness);

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:delivery"));
  assert.match(String(harness.findApiCalls("editMessageText").at(-1)?.payload.text), /1 unresolved delivery record/);

  await harness.bot.handleUpdate(privateCallback(1, `delivery:view:${record.caseToken}`));
  await harness.bot.handleUpdate(privateCallback(1, `delivery:delivered:${record.caseToken}`));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "8123"));

  assert.equal(harness.db.getTicketOutboundDelivery(operationKey)?.state, "DELIVERED");
  assert.equal(harness.db.getTicketOutboundDelivery(operationKey)?.delivery_message_id, 8123);
  assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
  assert.equal(harness.db.listDeliveryReconciliationAudit(TEST_STAFF_CHAT_ID).length, 1);
  assert.equal(
    harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
    0
  );
});

test("a demoted ADMIN cannot use a stale delivery reconciliation action", async () => {
  const { harness, installation } = createReadyHarness({ admin: true, rbac: true });
  const { operationKey, record } = seedUnknownInteractive(harness);

  await harness.bot.handleUpdate(privateCallback(2, "dashboard:delivery"));
  installation.revokeMember(1, 2);
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateCallback(2, `delivery:delivered:${record.caseToken}`));
  await harness.bot.handleUpdate(privateMessage(2, "9001"));

  assert.equal(harness.db.getTicketOutboundDelivery(operationKey)?.state, "UNKNOWN_DELIVERY");
  assert.equal(harness.db.listDeliveryReconciliationAudit(TEST_STAFF_CHAT_ID).length, 0);
  assert.equal(
    harness.findApiCalls("sendMessage").some((call) => /role does not allow/i.test(String(call.payload.text))),
    true
  );
});

test("an ADMIN removed from the staff workspace cannot reconcile delivery", async () => {
  const { harness } = createReadyHarness({ admin: true, rbac: true });
  const { operationKey, record } = seedUnknownInteractive(harness);

  await harness.bot.handleUpdate(privateCallback(2, "dashboard:delivery"));
  harness.setStaffMembership(2, "left");
  await harness.bot.handleUpdate(privateCallback(2, `delivery:failed:${record.caseToken}`));

  assert.equal(harness.db.getTicketOutboundDelivery(operationKey)?.state, "UNKNOWN_DELIVERY");
  assert.equal(harness.db.listDeliveryReconciliationAudit(TEST_STAFF_CHAT_ID).length, 0);
});

test("reconciling a delivered archive document finalizes locally without another archive send", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  const ticket = harness.seedTicket({ status: "CLOSED" });
  harness.db.addMessage({
    ticketId: ticket.id,
    direction: "USER_TO_STAFF",
    sourceChatId: ticket.user_telegram_id,
    sourceMessageId: 33,
    text: "Archived transcript",
  });
  assert.equal(harness.db.claimTicketArchiveSummary(ticket.id, 810).claimed, true);
  assert.equal(harness.db.markTicketArchiveSummarySent(ticket.id, 820), true);
  assert.equal(harness.db.claimTicketArchiveDocument(ticket.id)?.claimed, true);
  harness.db.markTicketArchiveUnknown(ticket.id, "Document outcome unknown.");
  const record = harness.db.listUnknownDeliveryReconciliations(TEST_STAFF_CHAT_ID)[0]!;

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:delivery"));
  await harness.bot.handleUpdate(privateCallback(1, `delivery:delivered:${record.caseToken}`));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "830"));

  assert.equal(harness.db.getTicket(ticket.id)?.logs_message_id, 820);
  assert.equal(harness.db.getTicket(ticket.id)?.transcript_message_id, 830);
  assert.equal(harness.db.getTicket(ticket.id)?.archived_at !== null, true);
  assert.equal(harness.db.listMessagesChronological(ticket.id).length, 0);
  assert.equal(
    harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length,
    0
  );
  assert.equal(
    harness.findApiCalls("sendDocument").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length,
    0
  );
});
