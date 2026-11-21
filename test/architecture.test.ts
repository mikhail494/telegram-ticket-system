import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../scripts/check-architecture.mjs", import.meta.url));
const repository = fileURLToPath(new URL("..", import.meta.url));

function check(root: string) {
  return spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
}

function fixture(files: Record<string, string>, verify: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "architecture-check-"));
  try {
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "scripts"));
    const baseline = JSON.parse(readFileSync(path.join(repository, "scripts/architecture-baseline.json"), "utf8"));
    baseline.moduleBudgets = {};
    writeFileSync(path.join(root, "scripts/architecture-baseline.json"), JSON.stringify(baseline));
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(root, "src", name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    verify(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("architecture check accepts the approved production baseline", () => {
  const result = check(repository);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Architecture check passed/);
});

test("architecture check rejects a new module over 800 physical lines", () => {
  fixture({ "newModule.ts": "// physical line\n".repeat(801) }, (root) => {
    const result = check(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/newModule.ts.*801.*800/);
  });
});

test("architecture check rejects runtime persistence dependencies on Telegram and UI", () => {
  fixture(
    {
      "persistence/exampleRepository.ts": 'import { Bot } from "grammy"; export const bot = new Bot("test");',
    },
    (root) => {
      const result = check(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /persistence\/exampleRepository.ts.*forbidden runtime dependency.*grammy/);
    }
  );
});

test("architecture check rejects SQLite connection ownership outside the approved modules", () => {
  fixture(
    { "extraConnection.ts": 'import Database from "better-sqlite3"; export const db = new Database(":memory:");' },
    (root) => {
      const result = check(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /extraConnection.ts.*unauthorized SQLite.*better-sqlite3/);
    }
  );
});

test("architecture check detects a runtime cycle through an import and re-export", () => {
  fixture(
    {
      "a.ts": 'import { b } from "./b.js"; export const a = () => b;',
      "b.ts": 'export { a as b } from "./a.js";',
    },
    (root) => {
      const result = check(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Runtime import cycle: src\/a.ts -> src\/b.ts -> src\/a.ts/);
    }
  );
});

test("architecture check allows type-only Telegram dependencies and type-only cycles", () => {
  fixture(
    {
      "persistence/exampleRepository.ts": `
        import type { Bot } from "grammy";
        import { type View } from "../bot.js";
        import Database from "better-sqlite3";
        export type { View } from "../bot.js";
        export type Store = { db: Database.Database; bot: Bot; view: View };
      `,
      "bot.ts": 'import type { Store } from "./persistence/exampleRepository.js"; export type View = { store: Store };',
    },
    (root) => {
      const result = check(root);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  );
});

test("architecture check erases implicit type re-exports using the whole TypeScript program", () => {
  fixture(
    {
      "persistence/exampleRepository.ts": 'export { View } from "../bot.js";',
      "bot.ts": 'import { View } from "./persistence/exampleRepository.js"; export interface View { other?: View; }',
    },
    (root) => {
      const result = check(root);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  );
});

test("architecture check preserves SQLite owner exceptions and injected repository connections", () => {
  fixture(
    {
      "db.ts": 'import Database from "better-sqlite3"; export const db = new Database(":memory:");',
      "backups.ts":
        'import Database from "better-sqlite3"; export const backup = new Database("backup.db", { readonly: true });',
      "persistence/exampleRepository.ts": `
        import type Database from "better-sqlite3";
        import { now } from "./helpers.js";
        import { policy } from "../domainPolicy.js";
        import type { Diagnostic } from "../deliveryDiagnostics.js";
        export function query(db: Database.Database, diagnostic: Diagnostic) { return db.prepare(policy).get(now(), diagnostic); }
      `,
      "persistence/helpers.ts": "export const now = () => new Date().toISOString();",
      "domainPolicy.ts": 'export const policy = "SELECT 1";',
      "deliveryDiagnostics.ts": 'export type Diagnostic = { category: "UNKNOWN_DELIVERY" };',
    },
    (root) => {
      const result = check(root);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  );
});

test("architecture check ignores import-looking comments and strings", () => {
  fixture(
    {
      "persistence/exampleRepository.ts": `
        // import { Bot } from "grammy";
        /* new Database(":memory:") */
        export const text = 'import Database from "better-sqlite3"';
      `,
    },
    (root) => {
      const result = check(root);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  );
});

for (const [label, statement, target] of [
  ["UI import", 'import { value } from "../bot.js"; export const x = value;', "bot.ts"],
  ["UI re-export", 'export * from "../privateControlPlane.js";', "privateControlPlane.ts"],
  ["entity handler", 'export { value } from "../entityNotifications.js";', "entityNotifications.ts"],
  ["Batch runtime", 'export { value } from "../ticketBatchRuntime.js";', "ticketBatchRuntime.ts"],
  ["moderation orchestration", 'export { value } from "../languageModeration.js";', "languageModeration.ts"],
  ["surface dynamic import", 'export const load = () => import("../newTelegram.js");', "newTelegram.ts"],
  ["grammY submodule", 'export * from "grammy/types";', null],
  ["grammY plugin", 'export * from "@grammyjs/runner";', null],
] as const) {
  test(`architecture check rejects persistence ${label}`, () => {
    const files: Record<string, string> = { "persistence/exampleRepository.ts": statement };
    if (target) files[target] = "export const value = 1;";
    fixture(files, (root) => {
      const result = check(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /forbidden runtime dependency/);
    });
  });
}

test("architecture check covers literal dynamic imports and require calls", () => {
  fixture(
    {
      "a.ts": 'export const load = () => import("./b.js");',
      "b.ts": 'export const load = () => require("./a.js");',
    },
    (root) => {
      const result = check(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Runtime import cycle/);
    }
  );
});

test("architecture check cannot silently skip computed module loads", () => {
  fixture({ "loader.ts": "export const load = (module: string) => import(module);" }, (root) => {
    const result = check(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /computed import\/require cannot be checked statically/);
  });
});

test("architecture check rejects node:sqlite and dynamic driver imports outside owners", () => {
  fixture(
    {
      "connection.ts": 'import { DatabaseSync } from "node:sqlite"; export const db = new DatabaseSync(":memory:");',
      "dynamicConnection.ts": 'export const connect = () => import("better-sqlite3");',
    },
    (root) => {
      const result = check(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /connection.ts.*unauthorized SQLite.*node:sqlite/);
      assert.match(result.stderr, /dynamicConnection.ts.*unauthorized SQLite.*better-sqlite3/);
    }
  );
});

test("architecture check covers TypeScript import-equals without banning erased connection types", () => {
  fixture(
    { "connection.ts": 'import DB = require("better-sqlite3"); export const db = new DB(":memory:");' },
    (root) => {
      const result = check(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /unauthorized SQLite/);
      writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
      const esm = check(root);
      assert.equal(esm.status, 1);
      assert.match(esm.stderr, /unauthorized SQLite/);
      writeFileSync(
        path.join(root, "src/connection.ts"),
        'import DB = require("better-sqlite3"); export type Store = DB.Database;'
      );
      const typeOnly = check(root);
      assert.equal(typeOnly.status, 0, typeOnly.stdout + typeOnly.stderr);
    }
  );
});

test("architecture check counts physical lines consistently with CRLF and no final newline", () => {
  fixture({ "allowed.ts": Array(800).fill("// line").join("\r\n") }, (root) => {
    const result = check(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

test("architecture check enforces grandfathered budgets without extending them automatically", () => {
  fixture({ "bot.ts": "// line\n".repeat(1985) }, (root) => {
    const file = path.join(root, "scripts/architecture-baseline.json");
    const baseline = JSON.parse(readFileSync(file, "utf8"));
    baseline.moduleBudgets["src/bot.ts"] = { baselineLines: 1960, maxLines: 1985 };
    writeFileSync(file, JSON.stringify(baseline));
    assert.equal(check(root).status, 0);
    writeFileSync(path.join(root, "src/bot.ts"), "// line\n".repeat(1986));
    const result = check(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bot.ts.*1986.*1985/);
    writeFileSync(path.join(root, "src/bot.ts"), "// line\n".repeat(1900));
    assert.match(check(root).stderr, /lower baselineLines and maxLines/);
    baseline.moduleBudgets["src/bot.ts"] = { baselineLines: 1900, maxLines: 1925 };
    writeFileSync(file, JSON.stringify(baseline));
    assert.equal(check(root).status, 0);
  });
});

test("architecture check resolves configured local module aliases", () => {
  fixture(
    {
      "a.ts": 'import { b } from "@local/b"; export const a = () => b;',
      "b.ts": 'export { a as b } from "./a.js";',
    },
    (root) => {
      writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { paths: { "@local/*": ["./src/*"] } } })
      );
      const result = check(root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Runtime import cycle/);
    }
  );
});
