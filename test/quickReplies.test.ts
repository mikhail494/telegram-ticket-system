import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QUICK_REPLIES_CONFIG_PATH,
  QuickRepliesConfigError,
  loadQuickRepliesRegistry
} from "../src/quickReplies.js";

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  temporaryDirectories.clear();
});

function validCategories() {
  return [
    {
      id: "request_details",
      title: "Request details",
      templates: [
        {
          id: "ask_uid",
          title: "Ask for UID",
          text: "Please send your AgentOn UID."
        }
      ]
    },
    {
      id: "status",
      title: "Status updates",
      templates: [
        {
          id: "checking",
          title: "We are checking",
          text: "We are checking this issue."
        }
      ]
    }
  ];
}

function validConfig() {
  return {
    version: 1,
    categories: validCategories()
  };
}

function writeTemporaryJson(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "telegram-quick-replies-"));
  temporaryDirectories.add(directory);

  const configPath = join(directory, "quick-replies.json");
  writeFileSync(configPath, JSON.stringify(value), "utf8");
  return configPath;
}

function createMissingConfigPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "telegram-quick-replies-"));
  temporaryDirectories.add(directory);
  return join(directory, "missing.json");
}

function assertConfigError(configPath: string, issue: string): void {
  assert.throws(
    () => loadQuickRepliesRegistry(configPath),
    (error: unknown) => {
      assert.ok(error instanceof QuickRepliesConfigError);
      assert.ok(error.message.includes(configPath));
      assert.ok(error.message.includes(issue));
      return true;
    }
  );
}

describe("Quick Replies configuration loader", () => {
  it("loads the committed configuration", () => {
    const registry = loadQuickRepliesRegistry();

    assert.equal(QUICK_REPLIES_CONFIG_PATH.endsWith(join("config", "quick-replies.json")), true);
    assert.equal(registry.listCategories().length, 2);
  });

  it("contains the configured category and template counts", () => {
    const registry = loadQuickRepliesRegistry();
    const templateCount = registry.listCategories().reduce(
      (count, category) => count + registry.listTemplates(category.id).length,
      0
    );

    assert.equal(templateCount, 5);
  });

  it("provides category and template lookup", () => {
    const registry = loadQuickRepliesRegistry();
    const categories = registry.listCategories();

    assert.deepEqual(
      categories.map((category) => category.id),
      ["request_details", "status"]
    );
    assert.equal(registry.findCategory("request_details")?.title, "Request details");
    assert.deepEqual(
      registry.listTemplates("status").map((template) => template.id),
      ["checking", "need_more_time"]
    );
    assert.equal(registry.findTemplate("ask_uid")?.title, "Ask for UID");
    assert.deepEqual(registry.listTemplates("unknown"), []);
    assert.equal(registry.findTemplate("unknown"), undefined);
  });

  it("reports missing files with a clear configuration error", () => {
    const configPath = createMissingConfigPath();
    assertConfigError(configPath, "file could not be read");
  });

  it("reports malformed JSON with a clear configuration error", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-quick-replies-"));
    temporaryDirectories.add(directory);
    const configPath = join(directory, "malformed.json");
    writeFileSync(configPath, "{ malformed", "utf8");

    assertConfigError(configPath, "JSON is malformed");
  });

  for (const validationCase of [
    {
      name: "unsupported versions",
      config: { ...validConfig(), version: 2 },
      issue: "Version must equal 1"
    },
    {
      name: "empty category lists",
      config: { version: 1, categories: [] },
      issue: "At least one category is required"
    },
    {
      name: "duplicate category IDs",
      config: {
        version: 1,
        categories: [
          ...validCategories(),
          {
            id: "request_details",
            title: "Another category",
            templates: [{ id: "another_template", title: "Another", text: "Another reply" }]
          }
        ]
      },
      issue: 'Category id "request_details" must be unique'
    },
    {
      name: "duplicate template IDs across categories",
      config: {
        version: 1,
        categories: [
          {
            id: "one",
            title: "One",
            templates: [{ id: "duplicate", title: "One", text: "One" }]
          },
          {
            id: "two",
            title: "Two",
            templates: [{ id: "duplicate", title: "Two", text: "Two" }]
          }
        ]
      },
      issue: 'Template id "duplicate" must be globally unique'
    },
    {
      name: "invalid category slugs",
      config: {
        version: 1,
        categories: [{ id: "Invalid-slug", title: "Category", templates: [{ id: "template", title: "Reply", text: "Text" }] }]
      },
      issue: "Category id must use lowercase letters, numbers, and underscores only"
    },
    {
      name: "invalid template slugs",
      config: {
        version: 1,
        categories: [{ id: "category", title: "Category", templates: [{ id: "Invalid-slug", title: "Reply", text: "Text" }] }]
      },
      issue: "Template id must use lowercase letters, numbers, and underscores only"
    },
    {
      name: "category IDs longer than 24 characters",
      config: {
        version: 1,
        categories: [{ id: "a".repeat(25), title: "Category", templates: [{ id: "template", title: "Reply", text: "Text" }] }]
      },
      issue: "Category id maximum length is 24 characters"
    },
    {
      name: "template IDs longer than 24 characters",
      config: {
        version: 1,
        categories: [{ id: "category", title: "Category", templates: [{ id: "a".repeat(25), title: "Reply", text: "Text" }] }]
      },
      issue: "Template id maximum length is 24 characters"
    },
    {
      name: "empty category titles",
      config: {
        version: 1,
        categories: [{ id: "category", title: "", templates: [{ id: "template", title: "Reply", text: "Text" }] }]
      },
      issue: "Category title must not be empty"
    },
    {
      name: "category titles longer than 32 characters",
      config: {
        version: 1,
        categories: [{ id: "category", title: "a".repeat(33), templates: [{ id: "template", title: "Reply", text: "Text" }] }]
      },
      issue: "String must contain at most 32 character(s)"
    },
    {
      name: "empty template titles",
      config: {
        version: 1,
        categories: [{ id: "category", title: "Category", templates: [{ id: "template", title: "", text: "Text" }] }]
      },
      issue: "Template title must not be empty"
    },
    {
      name: "template titles longer than 32 characters",
      config: {
        version: 1,
        categories: [{ id: "category", title: "Category", templates: [{ id: "template", title: "a".repeat(33), text: "Text" }] }]
      },
      issue: "String must contain at most 32 character(s)"
    },
    {
      name: "empty template text",
      config: {
        version: 1,
        categories: [{ id: "category", title: "Category", templates: [{ id: "template", title: "Reply", text: "" }] }]
      },
      issue: "Template text must not be empty"
    },
    {
      name: "template text longer than 3500 characters",
      config: {
        version: 1,
        categories: [
          {
            id: "category",
            title: "Category",
            templates: [{ id: "template", title: "Reply", text: "a".repeat(3501) }]
          }
        ]
      },
      issue: "String must contain at most 3500 character(s)"
    },
    {
      name: "categories without templates",
      config: {
        version: 1,
        categories: [{ id: "category", title: "Category", templates: [] }]
      },
      issue: "Each category must contain at least one template"
    }
  ]) {
    it(`rejects ${validationCase.name}`, () => {
      assertConfigError(writeTemporaryJson(validationCase.config), validationCase.issue);
    });
  }

  it("returns immutable categories and templates", () => {
    const registry = loadQuickRepliesRegistry();
    const categories = registry.listCategories();
    const category = registry.findCategory("request_details");
    const templates = registry.listTemplates("request_details");
    const template = registry.findTemplate("ask_uid");

    assert.ok(category);
    assert.ok(template);

    assert.throws(() => Array.prototype.push.call(categories, category), TypeError);
    assert.throws(() => Array.prototype.push.call(templates, template), TypeError);
    assert.throws(() => Object.assign(category, { title: "Changed category" }), TypeError);
    assert.throws(() => Object.assign(template, { text: "Changed template" }), TypeError);

    assert.deepEqual(
      registry.listCategories().map((item) => item.id),
      ["request_details", "status"]
    );
    assert.equal(registry.findCategory("request_details")?.title, "Request details");
    assert.equal(registry.findTemplate("ask_uid")?.text, "Please send your AgentOn UID so we can check your account.");
  });
});
