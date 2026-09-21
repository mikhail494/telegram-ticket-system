import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { HttpError } from "grammy";
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

function seedUnknownBatchReply(
  harness: BotHarness,
  ticket: ReturnType<BotHarness["seedTicket"]>,
  answerPackageId: string
) {
  const operationKey = `ticket-batch:${answerPackageId}:${ticket.id}`;
  harness.db.createTicketBatchExport({
    exportId: `${answerPackageId}-export`,
    staffChatId: TEST_STAFF_CHAT_ID,
    createdAt: "2026-09-21T00:00:00.000Z",
    selectionMode: "all_active",
    ticketCount: 1,
    items: [{ ticketId: ticket.id, snapshotToken: `sha256:${answerPackageId}` }],
  });
  harness.db.createTicketBatchAnswerPackage({
    answerPackageId,
    exportId: `${answerPackageId}-export`,
    staffChatId: TEST_STAFF_CHAT_ID,
    packageHash: `sha256:${answerPackageId}`,
    sourceChatId: TEST_STAFF_CHAT_ID,
    sourceMessageId: 79,
    packageCreatedAt: "2026-09-21T00:00:00.000Z",
    items: [
      {
        ticket_id: ticket.id,
        snapshot_token: `sha256:${answerPackageId}`,
        action: "reply_keep_open",
        reply_text: "Confirmed customer reply",
      },
    ],
  });
  harness.db.createTicketOutboundDeliveryIntent({
    operationKey,
    ticketId: ticket.id,
    direction: "STAFF_TO_USER",
    sourceChatId: TEST_STAFF_CHAT_ID,
    sourceMessageId: 79,
    deliveryChatId: ticket.user_telegram_id,
    senderType: "STAFF",
    senderDisplayName: "Support",
    text: "Confirmed customer reply",
  });
  harness.db.markTicketOutboundDeliveryUnknown(operationKey, "Ambiguous customer delivery.");
  harness.db.updateTicketBatchAnswerItem(answerPackageId, ticket.id, "UNKNOWN_DELIVERY", {
    lastError: "Manual review required.",
  });
  return { operationKey, record: harness.db.listUnknownDeliveryReconciliations(TEST_STAFF_CHAT_ID)[0]! };
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

test("reconciling a delivered OPEN interactive reply restores local progress and refreshes its staff summary", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  const { ticket, operationKey, record } = seedUnknownInteractive(harness, 7101);
  harness.db.updateTicketStaffMessage(ticket.id, TEST_STAFF_CHAT_ID, 910);

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:delivery"));
  await harness.bot.handleUpdate(privateCallback(1, `delivery:delivered:${record.caseToken}`));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "8124"));

  assert.equal(harness.db.getTicketOutboundDelivery(operationKey)?.state, "DELIVERED");
  assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
  assert.equal(harness.db.getTicket(ticket.id)?.status, "IN_PROGRESS");
  assert.equal(
    harness
      .findApiCalls("editMessageText")
      .filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID && call.payload.message_id === 910).length,
    1
  );
  assert.equal(
    harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
    0
  );
});

test("reconciling a delivered WAITING_USER interactive reply preserves its ticket state", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  const { ticket, record } = seedUnknownInteractive(harness, 7102);
  harness.db.updateTicketStatus(ticket.id, "WAITING_USER");

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:delivery"));
  await harness.bot.handleUpdate(privateCallback(1, `delivery:delivered:${record.caseToken}`));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "8125"));

  assert.equal(harness.db.getTicket(ticket.id)?.status, "WAITING_USER");
  assert.equal(harness.db.listMessagesChronological(ticket.id).length, 1);
  assert.equal(
    harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
    0
  );
});

test("a delivered closed interactive reply is archived without replaying the original staff send", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  const { ticket, operationKey, record } = seedUnknownInteractive(harness, 7103);
  harness.db.updateTicketStatus(ticket.id, "CLOSED");

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:delivery"));
  await harness.bot.handleUpdate(privateCallback(1, `delivery:delivered:${record.caseToken}`));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "8126"));

  assert.equal(harness.db.getTicketOutboundDelivery(operationKey), undefined);
  assert.equal(harness.db.getTicket(ticket.id)?.archived_at !== null, true);
  assert.equal(
    harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
    0
  );
  assert.equal(
    harness.findApiCalls("sendDocument").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length,
    1
  );
});

test("a failed closed interactive reply can continue the archive without replaying the reply", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  const { ticket, operationKey, record } = seedUnknownInteractive(harness, 7104);
  harness.db.addMessage({
    ticketId: ticket.id,
    direction: "USER_TO_STAFF",
    sourceChatId: ticket.user_telegram_id,
    sourceMessageId: 45,
    text: "Existing ticket transcript",
  });
  harness.db.updateTicketStatus(ticket.id, "CLOSED");

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:delivery"));
  await harness.bot.handleUpdate(privateCallback(1, `delivery:failed:${record.caseToken}`));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "Confirmed absent from Telegram."));

  assert.equal(harness.db.getTicketOutboundDelivery(operationKey), undefined);
  assert.equal(harness.db.getTicket(ticket.id)?.archived_at !== null, true);
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

test("reconciling an archive summary continues with one transcript upload without resending the summary", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  const ticket = harness.seedTicket({ status: "CLOSED" });
  harness.db.addMessage({
    ticketId: ticket.id,
    direction: "USER_TO_STAFF",
    sourceChatId: ticket.user_telegram_id,
    sourceMessageId: 34,
    text: "Archive transcript",
  });
  assert.equal(harness.db.claimTicketArchiveSummary(ticket.id, 810).claimed, true);
  harness.db.markTicketArchiveUnknown(ticket.id, "Summary outcome unknown.");
  const record = harness.db.listUnknownDeliveryReconciliations(TEST_STAFF_CHAT_ID)[0]!;

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:delivery"));
  await harness.bot.handleUpdate(privateCallback(1, `delivery:delivered:${record.caseToken}`));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "820"));

  assert.equal(
    harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length,
    0
  );
  assert.equal(
    harness.findApiCalls("sendDocument").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length,
    1
  );
  assert.equal(harness.db.getTicket(ticket.id)?.logs_message_id, 820);
  assert.equal(harness.db.getTicket(ticket.id)?.archived_at !== null, true);
});

test("reconciling an archive summary keeps an ambiguous transcript delivery unresolved without replay", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  const ticket = harness.seedTicket({ status: "CLOSED" });
  harness.db.addMessage({
    ticketId: ticket.id,
    direction: "USER_TO_STAFF",
    sourceChatId: ticket.user_telegram_id,
    sourceMessageId: 35,
    text: "Archive transcript",
  });
  assert.equal(harness.db.claimTicketArchiveSummary(ticket.id, 810).claimed, true);
  harness.db.markTicketArchiveUnknown(ticket.id, "Summary outcome unknown.");
  const record = harness.db.listUnknownDeliveryReconciliations(TEST_STAFF_CHAT_ID)[0]!;
  harness.setApiResponseOverride("sendDocument", () => {
    throw new HttpError("socket closed", Object.assign(new Error("socket closed"), { code: "ECONNRESET" }));
  });

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:delivery"));
  await harness.bot.handleUpdate(privateCallback(1, `delivery:delivered:${record.caseToken}`));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "820"));

  assert.equal(
    harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length,
    0
  );
  assert.equal(
    harness.findApiCalls("sendDocument").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length,
    1
  );
  assert.equal(harness.db.getTicketArchiveDelivery(ticket.id)?.state, "UNKNOWN_DELIVERY");
  assert.equal(harness.db.getTicket(ticket.id)?.archived_at, null);
});

test("reconciling a delivered Batch reply immediately resumes staff-only recovery without another customer send", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  const ticket = harness.seedTicket();
  const answerPackageId = "reconcile-batch-continuation";
  const operationKey = `ticket-batch:${answerPackageId}:${ticket.id}`;
  harness.db.createTicketBatchExport({
    exportId: "reconcile-batch-export",
    staffChatId: TEST_STAFF_CHAT_ID,
    createdAt: "2026-09-20T00:00:00.000Z",
    selectionMode: "all_active",
    ticketCount: 1,
    items: [{ ticketId: ticket.id, snapshotToken: "sha256:reconcile" }],
  });
  harness.db.createTicketBatchAnswerPackage({
    answerPackageId,
    exportId: "reconcile-batch-export",
    staffChatId: TEST_STAFF_CHAT_ID,
    packageHash: "sha256:reconcile",
    sourceChatId: TEST_STAFF_CHAT_ID,
    sourceMessageId: 77,
    packageCreatedAt: "2026-09-20T00:00:00.000Z",
    items: [
      {
        ticket_id: ticket.id,
        snapshot_token: "sha256:reconcile",
        action: "reply_keep_open",
        reply_text: "Confirmed customer reply",
      },
    ],
  });
  harness.db.createTicketOutboundDeliveryIntent({
    operationKey,
    ticketId: ticket.id,
    direction: "STAFF_TO_USER",
    sourceChatId: TEST_STAFF_CHAT_ID,
    sourceMessageId: 77,
    deliveryChatId: ticket.user_telegram_id,
    senderType: "STAFF",
    senderDisplayName: "Support",
    text: "Confirmed customer reply",
  });
  harness.db.markTicketOutboundDeliveryUnknown(operationKey, "Ambiguous customer delivery.");
  harness.db.updateTicketBatchAnswerItem(answerPackageId, ticket.id, "UNKNOWN_DELIVERY", {
    lastError: "Manual review required.",
  });
  const record = harness.db.listUnknownDeliveryReconciliations(TEST_STAFF_CHAT_ID)[0]!;

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:delivery"));
  await harness.bot.handleUpdate(privateCallback(1, `delivery:delivered:${record.caseToken}`));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "830"));

  assert.equal(
    harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
    0
  );
  assert.equal(
    harness
      .findApiCalls("sendMessage")
      .filter(
        (call) =>
          call.payload.chat_id === TEST_STAFF_CHAT_ID &&
          call.payload.message_thread_id === ticket.message_thread_id &&
          String(call.payload.text).includes("Batch reply sent to user")
      ).length,
    1
  );
  assert.equal(harness.db.listTicketBatchAnswerItems(answerPackageId)[0]?.state, "COMPLETED");
  assert.equal(harness.db.getTicketBatchAnswerPackage(answerPackageId, TEST_STAFF_CHAT_ID)?.status, "COMPLETED");
});

test("reconciling a delivered reply_keep_open on a closed ticket leaves no staff retry loop", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  const ticket = harness.seedTicket({ status: "CLOSED" });
  const answerPackageId = "reconcile-closed-batch";
  const { operationKey, record } = seedUnknownBatchReply(harness, ticket, answerPackageId);

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:delivery"));
  await harness.bot.handleUpdate(privateCallback(1, `delivery:delivered:${record.caseToken}`));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "8301"));
  await harness.bot.recoverPendingTicketBatchStaffOperations();
  await harness.bot.recoverPendingTicketBatchStaffOperations();

  const item = harness.db.listTicketBatchAnswerItems(answerPackageId)[0]!;
  assert.equal(harness.db.getTicketOutboundDelivery(operationKey), undefined);
  assert.equal(item.state, "INACTIVE");
  assert.equal(item.topic_echo_state, "NOT_REQUIRED");
  assert.equal(item.topic_echo_next_retry_at, null);
  assert.equal(harness.db.getNextTicketBatchStaffRetryAt(TEST_STAFF_CHAT_ID), undefined);
  assert.equal(harness.db.getTicket(ticket.id)?.follow_up_state, "NONE");
  assert.equal(
    harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
    0
  );
});

test("reconciling a failed Batch reply refreshes staff-only package status without a customer retry", async () => {
  const { harness } = createReadyHarness({ rbac: true });
  const ticket = harness.seedTicket();
  const answerPackageId = "reconcile-batch-failure";
  const operationKey = `ticket-batch:${answerPackageId}:${ticket.id}`;
  harness.db.createTicketBatchExport({
    exportId: "reconcile-batch-failure-export",
    staffChatId: TEST_STAFF_CHAT_ID,
    createdAt: "2026-09-20T00:00:00.000Z",
    selectionMode: "all_active",
    ticketCount: 1,
    items: [{ ticketId: ticket.id, snapshotToken: "sha256:reconcile-failure" }],
  });
  harness.db.createTicketBatchAnswerPackage({
    answerPackageId,
    exportId: "reconcile-batch-failure-export",
    staffChatId: TEST_STAFF_CHAT_ID,
    packageHash: "sha256:reconcile-failure",
    sourceChatId: TEST_STAFF_CHAT_ID,
    sourceMessageId: 78,
    packageCreatedAt: "2026-09-20T00:00:00.000Z",
    items: [
      {
        ticket_id: ticket.id,
        snapshot_token: "sha256:reconcile-failure",
        action: "reply_keep_open",
        reply_text: "Unconfirmed customer reply",
      },
    ],
  });
  harness.db.queueTicketBatchFinalSummary(answerPackageId, TEST_STAFF_CHAT_ID, {
    text: "Unknown user delivery: 1",
    chatId: 1,
  });
  harness.db.recordTicketBatchFinalSummarySent(answerPackageId, TEST_STAFF_CHAT_ID, 901);
  harness.db.createTicketOutboundDeliveryIntent({
    operationKey,
    ticketId: ticket.id,
    direction: "STAFF_TO_USER",
    sourceChatId: TEST_STAFF_CHAT_ID,
    sourceMessageId: 78,
    deliveryChatId: ticket.user_telegram_id,
    senderType: "STAFF",
    senderDisplayName: "Support",
    text: "Unconfirmed customer reply",
  });
  harness.db.markTicketOutboundDeliveryUnknown(operationKey, "Ambiguous customer delivery.");
  harness.db.updateTicketBatchAnswerItem(answerPackageId, ticket.id, "UNKNOWN_DELIVERY", {
    lastError: "Manual review required.",
  });
  const record = harness.db.listUnknownDeliveryReconciliations(TEST_STAFF_CHAT_ID)[0]!;

  await harness.bot.handleUpdate(privateCallback(1, "dashboard:delivery"));
  await harness.bot.handleUpdate(privateCallback(1, `delivery:failed:${record.caseToken}`));
  harness.clearApiCalls();
  await harness.bot.handleUpdate(privateMessage(1, "Verified absent from Telegram."));

  assert.equal(
    harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === ticket.user_telegram_id).length,
    0
  );
  const item = harness.db.listTicketBatchAnswerItems(answerPackageId)[0]!;
  assert.equal(item.state, "FAILED");
  assert.equal(item.delivery_error_category, "OPERATOR_CONFIRMED_NOT_DELIVERED");
  assert.equal(item.delivery_error_permanence, "PERMANENT");
  assert.equal(harness.db.getTicketBatchAnswerPackage(answerPackageId, TEST_STAFF_CHAT_ID)?.status, "PARTIAL");
  assert.equal(
    harness
      .findApiCalls("editMessageText")
      .some(
        (call) => call.payload.message_id === 901 && String(call.payload.text).includes("Unknown user delivery: 0")
      ),
    true
  );
});
