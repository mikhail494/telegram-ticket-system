import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function findTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findTests(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const files = findTests("test");
if (files.length === 0) throw new Error("No TypeScript test files found under test/.");

const args = [require.resolve("tsx/cli"), "--test", ...files];
const env = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? "test",
  BOT_TOKEN: process.env.BOT_TOKEN ?? "123456:TEST_BOT_TOKEN",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
};
const result = spawnSync(process.execPath, args, { stdio: "inherit", env });
process.exit(result.status ?? 1);
