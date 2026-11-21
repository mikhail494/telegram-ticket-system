import { readFileSync } from "node:fs";
import path from "node:path";

const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
for (const file of ["src/ownerPair.ts", "src/setup.ts"]) {
  const coverage = summary[path.resolve(file)];
  if (!coverage || coverage.branches.pct < 80) throw new Error(`${file}: branch coverage must be at least 80%.`);
  console.log(`${file}: ${coverage.branches.pct}% branch coverage (minimum 80%).`);
}
