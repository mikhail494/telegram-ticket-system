const REDACTED = "[REDACTED]";
const secretField = /^(token|bot_?token|pairing_?token|recovery_?token|invite_?token|authorization)$/i;
const botToken = /(?<![A-Za-z0-9_-])\d{5,}:[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g;
const apiUrl = /(https:\/\/api\.telegram\.org\/bot)[^/\s]+/gi;
const deepLink = /(?<![A-Za-z0-9_-])(setup|recovery|invite)_[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/gi;
const bearer = /\b(?:Authorization\s*:\s*)?Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function sanitizeLogString(value: string): string {
  return value.replace(apiUrl, "$1[REDACTED]").replace(deepLink, "$1_[REDACTED]").replace(bearer, (match) => match.startsWith("Authorization") ? "Authorization: Bearer [REDACTED]" : "Bearer [REDACTED]").replace(botToken, REDACTED);
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
