import type { MessageDirection, MessageSenderType, TicketStatus } from "./types.js";
export const ticketStatuses: readonly TicketStatus[] = ["OPEN", "WAITING_USER", "IN_PROGRESS", "CLOSED"];
export function now(): string { return new Date().toISOString(); }
export function senderTypeForDirection(direction: MessageDirection): MessageSenderType { if (direction === "USER_TO_STAFF") return "USER"; if (direction === "STAFF_TO_USER") return "STAFF"; return "SYSTEM"; }
export function parseJsonStringArray(value: string): readonly string[] { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []; } catch { return []; } }
export function normalizeManagedChatAllowlist(values: readonly string[]): readonly string[] { return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]; }
export function positiveIntegerOr(value: string | undefined, fallback: number): number { if (!value || !/^\d+$/.test(value)) return fallback; const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }