import test from "node:test";
import assert from "node:assert/strict";

process.env.BOT_TOKEN ??= "123456:TEST_OWNER_PAIR_TOKEN";
const { runOwnerPair } = await import("../src/ownerPair.js");

test("owner pairing refuses non-interactive invocation before creating a token", async () => {
  await assert.rejects(() => runOwnerPair({ interactive: false }), /interactive terminal/i);
});
