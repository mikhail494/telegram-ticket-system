import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Update } from "grammy/types";
import { InstallationService } from "../src/installation.js";
import { SupportIngressLimiter } from "../src/supportIngressLimiter.js";
import { buildStaffTextMessageUpdate, createBotHarness, TEST_STAFF_CHAT_ID, type BotHarness } from "./helpers/botHarness.js";

const harnesses: BotHarness[] = [];

afterEach(() => {
  for (const harness of harnesses) harness.cleanup();
  harnesses.length = 0;
});

function privateMessage(userId: number, text: string, messageId: number): Update {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1,
      from: { id: userId, is_bot: false, first_name: `Customer ${userId}`, username: `customer_${userId}` },
      chat: { id: userId, type: "private", first_name: `Customer ${userId}` },
      text
    }
  };
}

function createHarness(now: () => number, options: { capacity?: number } = {}): BotHarness {
  const harness = createBotHarness({
    supportIngressLimiter: new SupportIngressLimiter({ now, capacity: options.capacity })
  });
  harnesses.push(harness);
  return harness;
}

describe("customer private support ingress protection", () => {
  it("allows twenty immediate customer messages through the normal ticket flow", async () => {
    let now = 0;
    const harness = createHarness(() => now);

    for (let index = 1; index <= 20; index += 1) {
      await harness.bot.handleUpdate(privateMessage(501, `Evidence ${index}`, index));
    }

    const ticket = harness.db.findActiveTicketForUser(501, TEST_STAFF_CHAT_ID);
    assert.ok(ticket);
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, 20);
    assert.equal(harness.findApiCalls("sendMessage").some((call) => /sending messages too quickly/i.test(String(call.payload.text))), false);
  });

  it("rejects the thirty-first customer message without persistence or staff routing, then recovers after refill", async () => {
    let now = 0;
    const harness = createHarness(() => now);

    for (let index = 1; index <= 30; index += 1) {
      await harness.bot.handleUpdate(privateMessage(502, `Message ${index}`, index));
    }
    const ticket = harness.db.findActiveTicketForUser(502, TEST_STAFF_CHAT_ID);
    assert.ok(ticket);
    const beforeMessages = harness.db.listMessagesChronological(ticket.id).length;
    const beforeStaffSends = harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length;

    await harness.bot.handleUpdate(privateMessage(502, "Rejected", 31));
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, beforeMessages);
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => call.payload.chat_id === TEST_STAFF_CHAT_ID).length, beforeStaffSends);
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => /sending messages too quickly/i.test(String(call.payload.text))).length, 1);

    await harness.bot.handleUpdate(privateMessage(502, "Still rejected", 32));
    assert.equal(harness.findApiCalls("sendMessage").filter((call) => /sending messages too quickly/i.test(String(call.payload.text))).length, 1);

    now += 1_000;
    await harness.bot.handleUpdate(privateMessage(502, "Allowed again", 33));
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, beforeMessages + 1);
  });

  it("keeps banned customer replies bounded and leaves staff test-ticket mode exempt", async () => {
    let now = 0;
    const bannedHarness = createHarness(() => now, { capacity: 1 });
    bannedHarness.db.banUser({ userTelegramId: 503, username: "customer_503", reason: "Test", bannedBy: 1 });
    await bannedHarness.bot.handleUpdate(privateMessage(503, "First", 1));
    await bannedHarness.bot.handleUpdate(privateMessage(503, "Flood", 2));
    assert.equal(bannedHarness.findApiCalls("sendMessage").filter((call) => /restricted from opening/i.test(String(call.payload.text))).length, 1);
    assert.equal(bannedHarness.findApiCalls("sendMessage").filter((call) => /sending messages too quickly/i.test(String(call.payload.text))).length, 1);

    let service!: InstallationService;
    const staffHarness = createBotHarness({
      supportIngressLimiter: new SupportIngressLimiter({ now: () => now, capacity: 1 }),
      installationServiceFactory: (db) => {
        service = new InstallationService(db);
        service.adoptLegacyInstallation(TEST_STAFF_CHAT_ID);
        service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
        return service;
      }
    });
    harnesses.push(staffHarness);
    staffHarness.db.setSetting("staff_test_ticket_mode:1", "true");
    await staffHarness.bot.handleUpdate(privateMessage(1, "Harmless test ticket", 10));
    assert.ok(staffHarness.db.findActiveTicketForUser(1, TEST_STAFF_CHAT_ID));
    assert.equal(staffHarness.findApiCalls("sendMessage").some((call) => /sending messages too quickly/i.test(String(call.payload.text))), false);
  });

  it("contains warning delivery failures without processing the rejected message", async () => {
    let now = 0;
    const harness = createHarness(() => now, { capacity: 1 });
    await harness.bot.handleUpdate(privateMessage(504, "Allowed", 1));
    const ticket = harness.db.findActiveTicketForUser(504, TEST_STAFF_CHAT_ID);
    assert.ok(ticket);
    const beforeMessages = harness.db.listMessagesChronological(ticket.id).length;
    harness.failNextApiCall("sendMessage", "Warning failed");

    await harness.bot.handleUpdate(privateMessage(504, "Rejected", 2));
    assert.equal(harness.db.listMessagesChronological(ticket.id).length, beforeMessages);
  });

  it("does not consume customer limiter state for public or staff-workspace traffic", async () => {
    let now = 0;
    const limiter = new SupportIngressLimiter({ now: () => now, capacity: 1 });
    const harness = createBotHarness({ supportIngressLimiter: limiter });
    harnesses.push(harness);
    harness.setStaffMembership(42);

    await harness.bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        from: { id: 601, is_bot: false, first_name: "Public customer" },
        chat: { id: -100601, type: "supergroup", title: "Unmanaged public chat" },
        text: "Public message"
      }
    });
    await harness.bot.handleUpdate(buildStaffTextMessageUpdate({ updateId: 2, staff: { id: 42 } }));

    assert.equal(limiter.trackedUserCount, 0);
  });
});
