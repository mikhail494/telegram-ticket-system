const REDACTED = "[REDACTED]";
const secretField = /^(token|bot_?token|pairing_?token|recovery_?token|invite_?token|authorization)$/i;
const botToken = /\b\d{5,}:[A-Za-z0-9_-]{10,}\b/g;
const apiUrl = /(https:\/\/api\.telegram\.org\/bot)[^/\s]+/gi;
const deepLink = /\b(setup|recovery|invite)_[A-Za-z0-9_-]{8,}\b/gi;

export function sanitizeLogString(value: string): string {
  return value.replace(apiUrl, "$1[REDACTED]").replace(deepLink, "$1_[REDACTED]").replace(botToken, REDACTED);
}

export function sanitizeLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeLogString(value);
  if (value instanceof Error) return { type: value.name, message: sanitizeLogString(value.message), stack: value.stack ? sanitizeLogString(value.stack) : undefined, ...Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, secretField.test(key) ? REDACTED : sanitizeLogValue(nested, seen)])) };
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item, seen));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, secretField.test(key) ? REDACTED : sanitizeLogValue(nested, seen)]));
}
