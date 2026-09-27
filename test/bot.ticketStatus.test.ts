import assert from "node:assert/strict";
import test from "node:test";
import { buildStaffCallbackUpdate, createBotHarness } from "./helpers/botHarness.js";

test("stale ticket-status callbacks cannot overwrite a newer status", async () => {
  const harness = createBotHarness();
  try {
    const ticket = harness.seedTicket({ staffMessageId: 6100 });

    await harness.bot.handleUpdate(
      buildStaffCallbackUpdate({
        callbackId: "status-waiting",
        callbackData: `ticket:status:${ticket.id}:WAITING_USER:OPEN`,
        messageThreadId: ticket.message_thread_id ?? 0,
      })
    );
    await harness.bot.handleUpdate(
      buildStaffCallbackUpdate({
        callbackId: "status-stale",
        callbackData: `ticket:status:${ticket.id}:IN_PROGRESS:OPEN`,
        messageThreadId: ticket.message_thread_id ?? 0,
      })
    );

    assert.equal(harness.db.getTicket(ticket.id)?.status, "WAITING_USER");
    assert.equal(
      harness
        .findApiCalls("answerCallbackQuery")
        .some((call) => call.payload.text === "Ticket changed. Refresh it before applying another status."),
      true
    );
  } finally {
    harness.cleanup();
  }
});
