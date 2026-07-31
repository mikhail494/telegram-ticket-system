import type { Context } from "grammy";
import type { SupportDatabase } from "./db.js";

const MAX_PROVIDER_LENGTH = 64;
const MAX_ENTITY_TYPE_LENGTH = 64;
const MAX_ENTITY_ID_LENGTH = 256;
const MAX_EVENT_TYPE_LENGTH = 32;
const MAX_QUEST_FIELD_LENGTH = 500;
const MAX_LINK_LENGTH = 2048;
const TELEGRAM_MESSAGE_LIMIT = 4096;

const QUEST_FIELDS = new Set([
  "title",
  "objective",
  "publisher",
  "reward",
  "deadline",
  "displayedCapacity",
  "settlementLabel",
  "requirements",
  "canonicalLink"
]);

export interface EntityNotificationEventInput {
  provider: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  observed_at: string;
  payload: Record<string, unknown>;
}

export interface QuestNotificationPayload {
  title?: string;
  objective?: string;
  publisher?: string;
  reward?: string;
  deadline?: string;
  displayedCapacity?: string;
  settlementLabel?: string;
  requirements?: string;
  canonicalLink?: string;
}

export interface ValidatedEntityNotificationEvent {
  provider: string;
  entityType: string;
  entityId: string;
  eventType: string;
  observedAt: string;
  payload: QuestNotificationPayload;
}

export interface EntityNotificationProvider {
  key: string;
  authoritative: boolean;
  isAvailable(): boolean;
  status?(): string;
}

export type EntityNotificationProviderRegistry = ReadonlyMap<string, EntityNotificationProvider>;

export interface EntityNotificationSettings {
  enabled: boolean;
  targetChatId: number | null;
  providerKey: string | null;
  providers: EntityNotificationProviderRegistry;
}

export type EntityNotificationResultStatus =
  | "PUBLISHED"
  | "DUPLICATE"
  | "IN_FLIGHT"
  | "UNKNOWN_DELIVERY"
  | "FAILED"
  | "DISABLED"
  | "SKIPPED"
  | "UNAVAILABLE"
  | "INVALID"
  | "IGNORED";

export interface EntityNotificationResult {
  status: EntityNotificationResultStatus;
  reason?: string;
  telegramMessageId?: number;
}

export class EntityNotificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityNotificationValidationError";
  }
}

export function createEntityNotificationProviderRegistry(
  providers: readonly EntityNotificationProvider[]
): EntityNotificationProviderRegistry {
  const registry = new Map<string, EntityNotificationProvider>();
  for (const provider of providers) {
    if (!provider.key.trim() || registry.has(provider.key)) {
      throw new Error(`Duplicate or empty entity notification provider key: ${provider.key}`);
    }
    registry.set(provider.key, provider);
  }
  return registry;
}

export function validateEntityNotificationEvent(input: unknown): ValidatedEntityNotificationEvent {
  if (!isRecord(input)) throw new EntityNotificationValidationError("Event must be an object.");
  const provider = requiredString(input.provider, "provider", MAX_PROVIDER_LENGTH);
  const entityType = requiredString(input.entity_type, "entity_type", MAX_ENTITY_TYPE_LENGTH);
  const entityId = requiredString(input.entity_id, "entity_id", MAX_ENTITY_ID_LENGTH);
  const eventType = requiredString(input.event_type, "event_type", MAX_EVENT_TYPE_LENGTH);
  const observedAt = requiredString(input.observed_at, "observed_at", 64);
  if (!/T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(observedAt) || Number.isNaN(Date.parse(observedAt))) {
    throw new EntityNotificationValidationError("observed_at must be a valid ISO UTC timestamp ending in Z.");
  }
  if (!isRecord(input.payload) || Array.isArray(input.payload)) {
    throw new EntityNotificationValidationError("payload must be an object.");
  }

  if (entityType !== "quest") {
    return { provider, entityType, entityId, eventType, observedAt, payload: {} };
  }

  const payload: QuestNotificationPayload = {};
  for (const [key, value] of Object.entries(input.payload)) {
    if (!QUEST_FIELDS.has(key)) {
      throw new EntityNotificationValidationError(`payload.${key} is not a supported quest display field.`);
    }
    const limit = key === "canonicalLink" ? MAX_LINK_LENGTH : MAX_QUEST_FIELD_LENGTH;
    const text = requiredString(value, `payload.${key}`, limit);
    if (key === "canonicalLink") {
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        throw new EntityNotificationValidationError("payload.canonicalLink must be a valid HTTP(S) URL.");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new EntityNotificationValidationError("payload.canonicalLink must be a valid HTTP(S) URL.");
      }
    }
    (payload as Record<string, string>)[key] = text;
  }
  return { provider, entityType, entityId, eventType, observedAt, payload };
}

export function renderEntityNotification(event: ValidatedEntityNotificationEvent): string {
  const lines = event.entityType === "quest" ? ["New quest created"] : [`New ${event.entityType} created`];
  const labels: Array<[keyof QuestNotificationPayload, string]> = [
    ["title", "Title"],
    ["objective", "Objective"],
    ["publisher", "Publisher"],
    ["reward", "Reward"],
    ["deadline", "Deadline"],
    ["displayedCapacity", "Displayed capacity"],
    ["settlementLabel", "Settlement"],
    ["requirements", "Requirements"],
    ["canonicalLink", "Link"]
  ];
  for (const [key, label] of labels) {
    const value = event.payload[key];
    if (value) lines.push(`${label}: ${value}`);
  }
  const rendered = lines.join("\n");
  if (rendered.length > TELEGRAM_MESSAGE_LIMIT) {
    throw new EntityNotificationValidationError(`Rendered notification exceeds Telegram's ${TELEGRAM_MESSAGE_LIMIT}-character message limit.`);
  }
  return rendered;
}

export async function processEntityNotificationEvent(
  api: Context["api"],
  db: SupportDatabase,
  input: unknown,
  settings: EntityNotificationSettings
): Promise<EntityNotificationResult> {
  let event: ValidatedEntityNotificationEvent;
  try {
    event = validateEntityNotificationEvent(input);
  } catch (error) {
    return { status: "INVALID", reason: error instanceof Error ? error.message : "Invalid event." };
  }
  if (event.eventType !== "created") return { status: "IGNORED", reason: "Only created events are publishable." };
  if (!settings.enabled) return { status: "DISABLED", reason: "Entity notifications are disabled." };
  if (settings.targetChatId === null) return { status: "SKIPPED", reason: "No notification target is configured." };
  if (!settings.providerKey) return { status: "UNAVAILABLE", reason: "No notification provider is configured." };
  if (event.provider !== settings.providerKey) return { status: "UNAVAILABLE", reason: "Event provider does not match the active provider." };
  const provider = settings.providers.get(settings.providerKey);
  if (!provider) return { status: "UNAVAILABLE", reason: "Configured notification provider is not registered." };
  if (!provider.authoritative) return { status: "UNAVAILABLE", reason: "Configured notification provider is not authoritative." };
  let available = false;
  try {
    available = provider.isAvailable();
  } catch {
    available = false;
  }
  if (!available) return { status: "UNAVAILABLE", reason: safeProviderStatus(provider) };

  const claimed = db.claimEntityNotificationPublication({
    provider: event.provider,
    entityType: event.entityType,
    entityId: event.entityId,
    eventType: event.eventType,
    observedAt: event.observedAt,
    targetChatId: settings.targetChatId
  });
  if (claimed === "PUBLISHED") return { status: "DUPLICATE" };
  if (claimed === "UNKNOWN_DELIVERY") return { status: "IN_FLIGHT" };
  if (claimed !== "CLAIMED") return { status: claimed };

  let rendered: string;
  try {
    rendered = renderEntityNotification(event);
  } catch (error) {
    db.recordEntityNotificationFailure(event.provider, event.entityType, event.entityId, event.eventType, conciseError(error));
    return { status: "INVALID", reason: error instanceof Error ? error.message : "Notification rendering failed." };
  }
  try {
    const sent = await api.sendMessage(settings.targetChatId, rendered);
    db.recordEntityNotificationPublished(event.provider, event.entityType, event.entityId, event.eventType, sent.message_id);
    return { status: "PUBLISHED", telegramMessageId: sent.message_id };
  } catch (error) {
    const reason = conciseError(error);
    db.recordEntityNotificationFailure(event.provider, event.entityType, event.entityId, event.eventType, reason);
    return { status: "FAILED", reason };
  }
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new EntityNotificationValidationError(`${field} must be a non-empty string.`);
  if (value.length > maxLength) throw new EntityNotificationValidationError(`${field} must be at most ${maxLength} characters.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Telegram delivery failed.";
  return message.replace(/[\r\n]+/g, " ").slice(0, 160);
}

function safeProviderStatus(provider: EntityNotificationProvider): string {
  try {
    return provider.status?.() || "Configured notification provider is unavailable.";
  } catch {
    return "Configured notification provider is unavailable.";
  }
}
