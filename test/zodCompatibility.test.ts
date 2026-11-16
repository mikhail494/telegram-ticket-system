import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { SupportDatabase } from "../src/db.js";
import {
  createPersistentQuickRepliesRegistry,
  loadQuickRepliesRegistry,
  QuickRepliesConfigError,
} from "../src/quickReplies.js";
import { parseAndValidateAnswerPackage, TicketBatchValidationError } from "../src/ticketBatch.js";

process.env.BOT_TOKEN ??= "123456:TEST_BOT_TOKEN";
const { loadHostConfig } = await import("../src/config.js");

const quickConfig = {
  version: 1,
  categories: [{ id: "support", title: " Support ", templates: [{ id: "reply", title: " Reply ", text: " Hello " }] }],
};

function withQuickConfig(value: unknown, verify: (file: string) => void): void {
  const folder = mkdtempSync(path.join(os.tmpdir(), "quick-validation-"));
  try {
    const file = path.join(folder, "quick.json");
    writeFileSync(file, JSON.stringify(value));
    verify(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function batchPackage(version: 1 | 2, answer: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    schema: "telegram_ticket_answer_package",
    version,
    export_id: "export",
    answer_package_id: "answers",
    created_at: "2026-11-16T12:00:00.000Z",
    answers: [
      {
        ticket_id: 1,
        snapshot_token: "snapshot",
        action: "reply_keep_open",
        reply_text: " Hello ",
        ...(version === 2 ? { follow_up_state: "NONE", internal_note: null, escalation_target: "NONE" } : {}),
        ...answer,
      },
    ],
    ...extra,
  };
}

function parseBatch(value: unknown, ticketId = 1) {
  return parseAndValidateAnswerPackage(JSON.stringify(value), "export", [{ ticketId, snapshotToken: "snapshot" }]);
}

test("host validation preserves coercion, trimming, defaults and optional empty values", () => {
  const config = loadHostConfig({
    envFile: false,
    env: {
      BOT_TOKEN: " token ",
      STAFF_CHAT_ID: "",
      BACKUP_ENABLED: " FALSE ",
      BACKUP_DIR: "  ",
      OPS_HTTP_PORT: "3210",
    },
  });
  assert.equal(config.botToken, "token");
  assert.equal(config.staffChatId, 0);
  assert.equal(config.backupEnabled, false);
  assert.equal(config.backupDir, null);
  assert.equal(config.opsHttpPort, 3210);
  assert.equal(config.opsHttpHost, "127.0.0.1");
  assert.equal(config.databaseUrl, "file:./data/support.db");
  assert.equal(config.backupIntervalHours, 24);
  assert.equal(loadHostConfig({ env: { BOT_TOKEN: "test", STAFF_CHAT_ID: "1e30" }, envFile: false }).staffChatId, 1e30);
});

test("host validation retains observable numeric, enum and required-field errors", () => {
  for (const [env, message] of [
    [{ BOT_TOKEN: "" }, "BOT_TOKEN: BOT_TOKEN is required"],
    [{ STAFF_CHAT_ID: "1.5" }, "STAFF_CHAT_ID: Expected integer, received float"],
    [{ OPS_HTTP_PORT: "0" }, "OPS_HTTP_PORT: Number must be greater than or equal to 1"],
    [{ OPS_HTTP_PORT: "NaN" }, "OPS_HTTP_PORT: Expected number, received nan"],
    [
      { BACKUP_ENABLED: "yes" },
      "BACKUP_ENABLED: Invalid enum value. Expected 'true' | 'false' | '1' | '0', received 'yes'",
    ],
  ] as const) {
    assert.throws(() => loadHostConfig({ env: { BOT_TOKEN: "test", ...env }, envFile: false }), {
      message: `Invalid host configuration: ${message}. Run npm run setup.`,
    });
  }
});

test("Quick Replies preserves version, required-field and maximum-length diagnostics", () => {
  for (const [input, problem] of [
    [{ ...quickConfig, version: 2 }, "version: Version must equal 1"],
    [{ version: 1 }, "categories: Required"],
    [
      { ...quickConfig, categories: [{ ...quickConfig.categories[0], title: "x".repeat(33) }] },
      "categories.0.title: String must contain at most 32 character(s)",
    ],
  ] as const) {
    withQuickConfig(input, (file) =>
      assert.throws(() => loadQuickRepliesRegistry(file), {
        name: "QuickRepliesConfigError",
        message: `Quick Replies configuration error in ${file}: validation failed: ${problem}. Correct the listed fields so the configuration satisfies the Quick Replies schema.`,
      })
    );
  }
});

test("Quick Replies retains trimming, unknown-key stripping and duplicate-ID refinements", () => {
  withQuickConfig({ ...quickConfig, extra: true }, (file) => {
    const category = loadQuickRepliesRegistry(file).listCategories()[0];
    assert.deepEqual(category, {
      id: "support",
      title: "Support",
      templates: [{ id: "reply", title: "Reply", text: "Hello" }],
    });
  });
  withQuickConfig({ ...quickConfig, categories: [quickConfig.categories[0], quickConfig.categories[0]] }, (file) => {
    assert.throws(
      () => loadQuickRepliesRegistry(file),
      (error: unknown) => {
        assert.ok(error instanceof QuickRepliesConfigError);
        assert.ok(error.message.includes('categories.1.id: Category id "support" must be unique'));
        assert.ok(error.message.includes('categories.1.templates.0.id: Template id "reply" must be globally unique'));
        return true;
      }
    );
  });
});

test("Quick Replies manager preserves invalid-input messages and valid trimmed writes", () => {
  withQuickConfig(quickConfig, (file) => {
    const db = new SupportDatabase(":memory:");
    try {
      const manager = createPersistentQuickRepliesRegistry(db, loadQuickRepliesRegistry(file));
      for (const [run, message] of [
        [() => manager.updateTemplate("reply", { title: " " }), "Template title must not be empty"],
        [
          () => manager.updateTemplate("reply", { title: "x".repeat(33) }),
          "String must contain at most 32 character(s)",
        ],
        [
          () => manager.createTemplate({ categoryId: "support", title: "New", text: "x".repeat(3501) }),
          "String must contain at most 3500 character(s)",
        ],
      ] as const) {
        assert.throws(run, (error: unknown) => {
          assert.ok(error instanceof z.ZodError);
          assert.deepEqual(
            error.issues.map((issue) => issue.message),
            [message]
          );
          return true;
        });
      }
      assert.deepEqual(manager.findTemplate("reply"), { id: "reply", title: "Reply", text: "Hello" });
      assert.equal(manager.updateTemplate("reply", { title: " Updated " })?.title, "Updated");
      const created = manager.createTemplate({ categoryId: "support", title: " New ", text: " Message " });
      assert.equal(created.title, "New");
      assert.equal(created.text, "Message");
    } finally {
      db.close();
    }
  });
});

for (const version of [1, 2] as const) {
  test(`Batch V${version} retains normalized valid output and nullable fields`, () => {
    const result = parseBatch(batchPackage(version));
    assert.deepEqual(result.answers[0], {
      ticket_id: 1,
      snapshot_token: "snapshot",
      action: "reply_keep_open",
      reply_text: " Hello ",
      follow_up_state: "NONE",
      internal_note: null,
      escalation_target: "NONE",
    });
    assert.equal(result.version, version);
    const noAction = parseBatch(batchPackage(version, { action: "no_action", reply_text: null }));
    assert.equal(noAction.answers[0]?.reply_text, null);
    assert.equal(
      parseBatch(batchPackage(version, {}, { created_at: "2026-11-16T12:00Z" })).created_at,
      "2026-11-16T12:00Z"
    );
  });

  test(`Batch V${version} preserves strict-key rejection and custom refinement wording`, () => {
    assert.throws(() => parseBatch(batchPackage(version, {}, { extra: true })), {
      name: "TicketBatchValidationError",
      message: "Answer package is invalid: Unrecognized key(s) in object: 'extra'",
    });
    assert.throws(() => parseBatch(batchPackage(version, { extra: true, reply_text: "" })), {
      name: "TicketBatchValidationError",
      message:
        version === 1
          ? "Answer package is invalid: Invalid input"
          : "Answer package is invalid: Unrecognized key(s) in object: 'extra' Reply actions require non-empty reply_text.",
    });
  });

  test(`Batch V${version} retains malformed-type and date errors`, () => {
    for (const value of [batchPackage(version, { reply_text: 123 }), batchPackage(version, {}, { version: 3 })]) {
      assert.throws(() => parseBatch(value), {
        name: "TicketBatchValidationError",
        message: "Answer package is invalid: Invalid input",
      });
    }
    assert.throws(() => parseBatch(batchPackage(version, {}, { created_at: "bad" })), {
      message: "Answer package is invalid: Invalid datetime",
    });
    assert.throws(
      () => parseBatch(batchPackage(version, {}, { created_at: "2026-02-30T00:00:00Z" })),
      TicketBatchValidationError
    );
    assert.throws(
      () => parseBatch(batchPackage(version, {}, { created_at: "2026-11-16T12:00:00+00:00" })),
      TicketBatchValidationError
    );
    assert.throws(() => parseBatch(batchPackage(version, {}, { answers: [] })), {
      message: "Answer package is invalid: Array must contain at least 1 element(s)",
    });
  });
}

test("host validation keeps nonfinite and multiple numeric diagnostics without leaking input", () => {
  assert.throws(() => loadHostConfig({ env: { BOT_TOKEN: "test", OPS_HTTP_PORT: "Infinity" }, envFile: false }), {
    message:
      "Invalid host configuration: OPS_HTTP_PORT: Expected integer, received float; OPS_HTTP_PORT: Number must be less than or equal to 65535. Run npm run setup.",
  });
  assert.throws(() => loadHostConfig({ env: { BOT_TOKEN: "test", OPS_HTTP_PORT: "-1.5" }, envFile: false }), {
    message:
      "Invalid host configuration: OPS_HTTP_PORT: Expected integer, received float; OPS_HTTP_PORT: Number must be greater than or equal to 1. Run npm run setup.",
  });
});

test("Batch JSON, enum, required nullable fields and version boundaries stay strict", () => {
  assert.throws(() => parseAndValidateAnswerPackage("{", "export", []), {
    name: "TicketBatchValidationError",
    message: "Answer package contains malformed JSON.",
  });
  for (const value of [
    batchPackage(1, { follow_up_state: "NONE" }),
    batchPackage(2, { internal_note: undefined }),
    batchPackage(2, { follow_up_state: "BAD" }),
    batchPackage(2, { reply_text: undefined }),
  ]) {
    assert.throws(() => parseBatch(value), TicketBatchValidationError);
  }
});

test("Batch V2 retains trimmed internal notes and closing-action constraints", () => {
  assert.equal(parseBatch(batchPackage(2, { internal_note: " note " })).answers[0]?.internal_note, "note");
  assert.throws(
    () => parseBatch(batchPackage(2, { action: "silent_close", reply_text: "bad", follow_up_state: "WAITING_USER" })),
    {
      message:
        "Answer package is invalid: silent_close requires reply_text to be null. silent_close requires follow_up_state NONE.",
    }
  );
  const id = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(parseBatch(batchPackage(2, { ticket_id: id }), id).answers[0]?.ticket_id, id);
});
