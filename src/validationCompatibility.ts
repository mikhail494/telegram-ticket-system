import { z } from "zod";

// Preserve the public validation messages used by our configuration/package
// parsers without changing Zod's process-wide configuration.
function receivedType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isNaN(value)) return "nan";
  return typeof value;
}

function expectedType(expected: string, input: unknown): string {
  return input === undefined ? "Required" : `Expected ${expected}, received ${receivedType(input)}`;
}

export const validationError: z.core.$ZodErrorMap = (issue) => {
  if (issue.code === "invalid_type") return expectedType(issue.expected, issue.input);
  if (issue.code === "unrecognized_keys") {
    return `Unrecognized key(s) in object: ${issue.keys.map((key) => `'${key}'`).join(", ")}`;
  }
  if (issue.code === "too_small" || issue.code === "too_big") {
    const small = issue.code === "too_small";
    const bound = small ? issue.minimum : issue.maximum;
    if (issue.origin === "string") return `String must contain at ${small ? "least" : "most"} ${bound} character(s)`;
    if (issue.origin === "array") return `Array must contain at ${small ? "least" : "most"} ${bound} element(s)`;
    if (issue.origin === "number") return `Number must be ${small ? "greater" : "less"} than or equal to ${bound}`;
  }
  return undefined;
};

export function validationEnum<const Values extends readonly string[]>(values: Values) {
  const expected = values.map((value) => `'${value}'`).join(" | ");
  return z.enum(values, {
    error: (issue) =>
      typeof issue.input === "string"
        ? `Invalid enum value. Expected ${expected}, received '${issue.input}'`
        : expectedType(expected, issue.input),
  });
}

// Zod 4 int() adds a safe-integer restriction and aborts after fractional input.
// The existing parsers accept any integral Number and collect range errors too.
export function validationInteger(options: { coerce?: boolean; min?: number; max?: number } = {}) {
  const number = z
    .custom<number>((value) => typeof value === "number" && !Number.isNaN(value), {
      error: (issue) => expectedType("number", issue.input),
    })
    .superRefine((value, ctx) => {
      if (!Number.isInteger(value)) ctx.addIssue({ code: "custom", message: "Expected integer, received float" });
      if (options.min !== undefined && value < options.min)
        ctx.addIssue({ code: "custom", message: `Number must be greater than or equal to ${options.min}` });
      if (options.max !== undefined && value > options.max)
        ctx.addIssue({ code: "custom", message: `Number must be less than or equal to ${options.max}` });
    });
  return z.preprocess((value) => (options.coerce ? Number(value) : value), number);
}
