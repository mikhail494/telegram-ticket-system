import test from "node:test";
import assert from "node:assert/strict";

process.env.BOT_TOKEN ??= "123456:TEST_LOGGER_TOKEN";
const { createLogger } = await import("../src/logger.js");

test("logger redacts credentials in fields, nested values, URLs, deep links, and errors", () => {
  const lines: string[] = [];
  const secret = "123456:FAKE_SECRET_VALUE_123456";
  const stream = { write: (line: string) => { lines.push(line); return true; } } as never;
  const logger = createLogger(stream);
  const error = new Error(`failed ${secret}`); error.stack = `stack ${secret}`;
  logger.error({ token: secret, nested: { pairingToken: secret }, link: `https://t.me/example?start=setup_${"a".repeat(24)}`, url: `https://api.telegram.org/bot${secret}/getMe`, err: error, ticketId: 7, updateId: 9, normalUrl: "https://example.test/help" }, "safe text");
  const output = lines.join("");
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes(`setup_${"a".repeat(24)}`), false);
  assert.match(output, /ticketId":7/); assert.match(output, /updateId":9/); assert.match(output, /example\.test\/help/); assert.match(output, /\[REDACTED\]/);
});
