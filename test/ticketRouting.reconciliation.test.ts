import assert from "node:assert/strict";
import test from "node:test";
import { TicketRoutingService } from "../src/ticketRouting.js";

test("a reconciled archive continuation never reroutes into a newer active workspace", async () => {
  let archiveSendCount = 0;
  const routing = new TicketRoutingService({
    installation: { requireStaffChatId: () => -1002 },
    api: {
      sendMessage: async () => {
        archiveSendCount += 1;
        return { message_id: 1 };
      },
    },
  } as never);

  assert.equal(await routing.finalizeReconciledArchive(42, -1001), false);
  assert.equal(archiveSendCount, 0);
});
