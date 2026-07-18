import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const SLUG_PATTERN = /^[a-z0-9_]+$/;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export const QUICK_REPLIES_CONFIG_PATH = resolve(
  moduleDirectory,
  "..",
  "config",
  "quick-replies.json"
);

const templateSchema = z.object({
  id: z
    .string()
    .regex(SLUG_PATTERN, "Template id must use lowercase letters, numbers, and underscores only")
    .max(24, "Template id maximum length is 24 characters"),
  title: z.string().trim().min(1, "Template title must not be empty").max(32),
  text: z.string().trim().min(1, "Template text must not be empty").max(3500)
});

const quickRepliesConfigSchema = z
  .object({
    version: z.literal(1, { errorMap: () => ({ message: "Version must equal 1" }) }),
    categories: z
      .array(
        z.object({
          id: z
            .string()
            .regex(SLUG_PATTERN, "Category id must use lowercase letters, numbers, and underscores only")
            .max(24, "Category id maximum length is 24 characters"),
          title: z.string().trim().min(1, "Category title must not be empty").max(32),
          templates: z.array(templateSchema).min(1, "Each category must contain at least one template")
        })
      )
      .min(1, "At least one category is required")
  })
  .superRefine((config, context) => {
    const categoryIds = new Set<string>();
    const templateIds = new Set<string>();

    for (const [categoryIndex, category] of config.categories.entries()) {
      if (categoryIds.has(category.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["categories", categoryIndex, "id"],
          message: `Category id "${category.id}" must be unique`
        });
      }

      categoryIds.add(category.id);

      for (const [templateIndex, template] of category.templates.entries()) {
        if (templateIds.has(template.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["categories", categoryIndex, "templates", templateIndex, "id"],
            message: `Template id "${template.id}" must be globally unique`
          });
        }

        templateIds.add(template.id);
      }
    }
  });

type ValidatedQuickRepliesConfig = z.infer<typeof quickRepliesConfigSchema>;

export type QuickReplyTemplate = Readonly<{
  id: string;
  title: string;
  text: string;
}>;

export type QuickReplyCategory = Readonly<{
  id: string;
  title: string;
  templates: readonly QuickReplyTemplate[];
}>;

export interface QuickRepliesRegistry {
  listCategories(): readonly QuickReplyCategory[];
  findCategory(categoryId: string): QuickReplyCategory | undefined;
  listTemplates(categoryId: string): readonly QuickReplyTemplate[];
  findTemplate(templateId: string): QuickReplyTemplate | undefined;
}

export class QuickRepliesConfigError extends Error {
  public constructor(configPath: string, problem: string, correction: string) {
    super(`Quick Replies configuration error in ${configPath}: ${problem}. Correct ${correction}.`);
    this.name = "QuickRepliesConfigError";
  }
}

const EMPTY_TEMPLATES: readonly QuickReplyTemplate[] = Object.freeze([]);

export function loadQuickRepliesRegistry(
  configPath: string = QUICK_REPLIES_CONFIG_PATH
): QuickRepliesRegistry {
  const parsedConfig = parseConfigFile(configPath);
  const categories = Object.freeze(
    parsedConfig.categories.map((category) => {
      const templates = Object.freeze(
        category.templates.map((template) =>
          Object.freeze({
            id: template.id,
            title: template.title,
            text: template.text
          })
        )
      );

      return Object.freeze({
        id: category.id,
        title: category.title,
        templates
      });
    })
  );

  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const templateById = new Map(
    categories.flatMap((category) =>
      category.templates.map((template) => [template.id, template] as const)
    )
  );

  return Object.freeze({
    listCategories: () => categories,
    findCategory: (categoryId: string) => categoryById.get(categoryId),
    listTemplates: (categoryId: string) => categoryById.get(categoryId)?.templates ?? EMPTY_TEMPLATES,
    findTemplate: (templateId: string) => templateById.get(templateId)
  });
}

function parseConfigFile(configPath: string): ValidatedQuickRepliesConfig {
  let rawConfig: string;

  try {
    rawConfig = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new QuickRepliesConfigError(
      configPath,
      `the file could not be read (${errorMessage(error)})`,
      "the file path and make sure config/quick-replies.json exists and is readable"
    );
  }

  let json: unknown;

  try {
    json = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    throw new QuickRepliesConfigError(
      configPath,
      `the JSON is malformed (${errorMessage(error)})`,
      "the JSON syntax in config/quick-replies.json"
    );
  }

  const result = quickRepliesConfigSchema.safeParse(json);

  if (!result.success) {
    throw new QuickRepliesConfigError(
      configPath,
      `validation failed: ${formatValidationIssues(result.error)}`,
      "the listed fields so the configuration satisfies the Quick Replies schema"
    );
  }

  return result.data;
}

function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "configuration"}: ${issue.message}`)
    .join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
