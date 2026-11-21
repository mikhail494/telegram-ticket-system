import assert from "node:assert/strict";
import { test } from "node:test";
// The executable checker uses the same deterministic budget rules.
const { budgetErrors, physicalLines } = await import("../scripts/architecture-budgets.mjs");
test("grandfathered budgets ratchet down and cannot be raised", () => {
  const baseline = { defaultMaxLines: 800, moduleBudgets: { "src/large.ts": { baselineLines: 900, maxLines: 925 } } };
  assert.deepEqual(budgetErrors(baseline, baseline, new Map([["src/large.ts", 910]])), []);
  assert.match(
    budgetErrors(baseline, baseline, new Map([["src/large.ts", 880]])).join(),
    /lower baselineLines and maxLines/
  );
  const reduced = { ...baseline, moduleBudgets: { "src/large.ts": { baselineLines: 880, maxLines: 905 } } };
  assert.deepEqual(budgetErrors(reduced, baseline, new Map([["src/large.ts", 880]])), []);
  assert.match(budgetErrors(baseline, reduced, new Map([["src/large.ts", 900]])).join(), /may not increase/);
  assert.match(
    budgetErrors(
      { ...baseline, moduleBudgets: { "src/new.ts": { baselineLines: 900, maxLines: 925 } } },
      baseline,
      new Map()
    ).join(),
    /may not increase or be added/
  );
  for (const newline of ["\n", "\r\n"]) assert.equal(physicalLines(`one${newline}two${newline}`), 2);
  assert.equal(physicalLines(""), 0);
});
