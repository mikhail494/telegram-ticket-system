import assert from "node:assert/strict";
import test from "node:test";
import { SupportDatabase } from "../src/db.js";

test("database ping is a read-only lightweight availability probe", () => {
  const database = new SupportDatabase(":memory:");
  assert.equal(database.getSetting("missing"), undefined);
  assert.equal(database.ping(), true);
  assert.equal(database.getSetting("missing"), undefined);
  database.close();
  assert.throws(() => database.ping());
});
