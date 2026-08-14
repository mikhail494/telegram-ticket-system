import test from "node:test";
import assert from "node:assert/strict";

process.env.BOT_TOKEN ??= "123456:TEST_LOGGER_TOKEN";
const { createLogger } = await import("../src/logger.js");

test("logger redacts structured credentials, errors, URLs, and deep links", () => {
  const lines: string[] = [];
  const secret = "123456:FAKE_SECRET_VALUE_123456-";
  const stream = { write: (line: string) => { lines.push(line); return true; } } as never;
  const logger = createLogger(stream);
  const error = new Error(`failed ${secret}`); error.stack = `stack ${secret}`;
  logger.error({ token: secret, nested: { pairingToken: secret }, link: `https://t.me/example?start=setup_${"a".repeat(24)}`, url: `https://api.telegram.org/bot${secret}/getMe`, err: error, ticketId: 7, updateId: 9, normalUrl: "https://example.test/help" }, "safe text");
  const output = lines.join("");
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes(`setup_${"a".repeat(24)}`), false);
  assert.match(output, /ticketId":7/); assert.match(output, /updateId":9/); assert.match(output, /example\.test\/help/); assert.match(output, /\[REDACTED\]/);
});

test("logger redacts direct messages, interpolation arguments, and bearer credentials", () => {
  const lines: string[] = [];
  const secret = "123456:MESSAGE_SECRET_VALUE_123456-";
  const bearer = "Bearer fake-bearer-credential-value";
  const stream = { write: (line: string) => { lines.push(line); return true; } } as never;
  const logger = createLogger(stream);
  logger.warn(`failure ${secret}`);
  logger.warn("failure %s", secret);
  logger.warn(`authorization ${bearer}`);
  logger.info("ordinary ticket 42 update 99 remains visible");
  const output = lines.join("");
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("fake-bearer-credential-value"), false);
  assert.match(output, /ticket 42 update 99 remains visible/);
});
