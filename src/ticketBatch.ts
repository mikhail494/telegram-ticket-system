import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import type { TicketBatchExportItemRecord, TicketMessageRecord, TicketWithUser } from "./db.js";

const MAX_ANSWER_TEXT_CHARACTERS = 3500;

export interface TicketBatchSource {
  ticket: TicketWithUser;
  messages: TicketMessageRecord[];
}

export interface TicketBatchAttachmentCopy {
  messageId: number;
  copiedStaffMessageId: number | null;
}

export interface TicketBatchExportSnapshotInput {
  exportId: string;
  createdAt: string;
  staffChatId: number;
  tickets: TicketBatchSource[];
  attachmentCopies?: TicketBatchAttachmentCopy[];
  failedAttachmentCount?: number;
}

export interface TicketBatchExportRecord {
  ticket: {
    id: number;
    user_telegram_id: number;
    status: TicketWithUser["status"];
    staff_chat_id: number | null;
    message_thread_id: number | null;
    created_at: string;
    updated_at: string;
  };
  user: {
    telegram_id: number;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
  };
  snapshot_token: string;
  messages: Array<TicketMessageRecord & {
    attachment_copy_staff_message_id: number | null;
    attachment: {
      file_unique_id: null;
      mime_type: null;
      size: null;
    } | null;
  }>;
}

export interface TicketBatchExportSnapshot {
  exportId: string;
  manifest: {
    schema: "telegram_ticket_export_manifest";
    version: 1;
    export_id: string;
    created_at: string;
    staff_chat_id: number;
    selection: { mode: "all_active" };
    ticket_count: number;
    tickets_file: "tickets.jsonl";
    attachments_mode: "separate_telegram_messages" | "metadata_only";
    attachment_count: number;
    notes: string | null;
  };
  records: TicketBatchExportRecord[];
  attachmentSources: Array<{ ticketId: number; messageId: number; sourceChatId: number | null; sourceMessageId: number | null }>;
}

export interface TemporaryTicketBatchZip {
  directory: string;
  filePath: string;
  filename: string;
}

const answerSchema = z
  .object({
    ticket_id: z.number().int().min(1),
    snapshot_token: z.string().min(1).max(256),
    action: z.enum(["reply_keep_open", "reply_and_close", "no_action"]),
    reply_text: z.string().nullable()
  })
  .strict()
  .superRefine((answer, ctx) => {
    if ((answer.action === "reply_keep_open" || answer.action === "reply_and_close") && !answer.reply_text?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reply_text"], message: "Reply actions require non-empty reply_text." });
    }
    if (answer.action === "no_action" && answer.reply_text !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reply_text"], message: "no_action requires reply_text to be null." });
    }
    if (answer.reply_text !== null && Array.from(answer.reply_text).length > MAX_ANSWER_TEXT_CHARACTERS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reply_text"], message: `reply_text must not exceed ${MAX_ANSWER_TEXT_CHARACTERS} Unicode characters.` });
    }
  });

const answerPackageSchema = z
  .object({
    schema: z.literal("telegram_ticket_answer_package"),
    version: z.literal(1),
    export_id: z.string().min(1),
    answer_package_id: z.string().min(1),
    created_at: z.string().datetime(),
    answers: z.array(answerSchema).min(1)
  })
  .strict();

export type TicketAnswerPackage = z.infer<typeof answerPackageSchema>;

export class TicketBatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketBatchValidationError";
  }
}

export function getAnswerPackageHash(answerPackage: TicketAnswerPackage): string {
  const canonical = {
    schema: answerPackage.schema,
    version: answerPackage.version,
    export_id: answerPackage.export_id,
    answer_package_id: answerPackage.answer_package_id,
    created_at: answerPackage.created_at,
    answers: [...answerPackage.answers]
      .sort((left, right) => left.ticket_id - right.ticket_id)
      .map((answer) => ({
        ticket_id: answer.ticket_id,
        snapshot_token: answer.snapshot_token,
        action: answer.action,
        reply_text: answer.reply_text
      }))
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

export function getTicketSnapshotToken(ticket: TicketWithUser, messages: TicketMessageRecord[]): string {
  const canonical = {
    ticket_id: ticket.id,
    status: ticket.status,
    staff_chat_id: ticket.staff_chat_id,
    message_thread_id: ticket.message_thread_id,
    updated_at: ticket.updated_at,
    messages: messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      source_chat_id: message.source_chat_id,
      source_message_id: message.source_message_id,
      delivery_chat_id: message.delivery_chat_id,
      delivery_message_id: message.delivery_message_id,
      from_telegram_id: message.from_telegram_id,
      from_username: message.from_username,
      sender_type: message.sender_type,
      sender_display_name: message.sender_display_name,
      sender_username: message.sender_username,
      text: message.text,
      media_type: message.media_type,
      filename: message.filename,
      file_id: message.file_id,
      created_at: message.created_at
    }))
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

export function buildTicketBatchExportSnapshot(input: TicketBatchExportSnapshotInput): TicketBatchExportSnapshot {
  const copies = new Map(input.attachmentCopies?.map((copy) => [copy.messageId, copy.copiedStaffMessageId]) ?? []);
  const tickets = [...input.tickets].sort((left, right) => left.ticket.id - right.ticket.id);
  const attachmentSources: TicketBatchExportSnapshot["attachmentSources"] = [];
  const records = tickets.map(({ ticket, messages }) => {
    const orderedMessages = [...messages].sort(compareMessages);
    for (const message of orderedMessages) {
      if (message.media_type) {
        attachmentSources.push({
          ticketId: ticket.id,
          messageId: message.id,
          sourceChatId: message.source_chat_id,
          sourceMessageId: message.source_message_id
        });
      }
    }
    return {
      ticket: {
        id: ticket.id,
        user_telegram_id: ticket.user_telegram_id,
        status: ticket.status,
        staff_chat_id: ticket.staff_chat_id,
        message_thread_id: ticket.message_thread_id,
        created_at: ticket.created_at,
        updated_at: ticket.updated_at
      },
      user: {
        telegram_id: ticket.user_telegram_id,
        username: ticket.username,
        first_name: ticket.first_name,
        last_name: ticket.last_name
      },
      snapshot_token: getTicketSnapshotToken(ticket, orderedMessages),
      messages: orderedMessages.map((message) => ({
        ...message,
        attachment_copy_staff_message_id: message.media_type ? copies.get(message.id) ?? null : null,
        attachment: message.media_type
          ? { file_unique_id: null, mime_type: null, size: null }
          : null
      }))
    };
  });
  const attachmentCount = attachmentSources.length;
  const failedAttachmentCount = input.failedAttachmentCount ?? 0;
  return {
    exportId: input.exportId,
    manifest: {
      schema: "telegram_ticket_export_manifest",
      version: 1,
      export_id: input.exportId,
      created_at: input.createdAt,
      staff_chat_id: input.staffChatId,
      selection: { mode: "all_active" },
      ticket_count: records.length,
      tickets_file: "tickets.jsonl",
      attachments_mode: attachmentCount ? "separate_telegram_messages" : "metadata_only",
      attachment_count: attachmentCount,
      notes: failedAttachmentCount ? `${failedAttachmentCount} attachment copies could not be created.` : null
    },
    records,
    attachmentSources
  };
}

export async function createTicketBatchZip(snapshot: TicketBatchExportSnapshot): Promise<TemporaryTicketBatchZip> {
  const filename = `ticket-export_${snapshot.exportId}.zip`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-ticket-export-"));
  const filePath = path.join(directory, filename);
  try {
    const archive = zipSync(
      {
        "manifest.json": strToU8(`${JSON.stringify(snapshot.manifest, null, 2)}\n`),
        "tickets.jsonl": strToU8(`${snapshot.records.map((record) => JSON.stringify(record)).join("\n")}\n`)
      },
      { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") }
    );
    await fs.writeFile(filePath, archive);
    return { directory, filePath, filename };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupTicketBatchZip(zip: TemporaryTicketBatchZip): Promise<void> {
  await fs.rm(zip.directory, { recursive: true, force: true });
}

export function parseAndValidateAnswerPackage(
  raw: string,
  expectedExportId: string,
  exportedItems: ReadonlyArray<Pick<TicketBatchExportItemRecord, "ticket_id" | "snapshot_token"> | { ticketId: number; snapshotToken: string }>
): TicketAnswerPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TicketBatchValidationError("Answer package contains malformed JSON.");
  }
  const result = answerPackageSchema.safeParse(parsed);
  if (!result.success) {
    throw new TicketBatchValidationError(`Answer package is invalid: ${result.error.issues.map((issue) => issue.message).join(" ")}`);
  }
  const value = result.data;
  if (value.export_id !== expectedExportId) {
    throw new TicketBatchValidationError("Answer package export_id does not match the uploaded export.");
  }
  const expectedIds = new Set(exportedItems.map(itemTicketId));
  const seen = new Set<number>();
  for (const answer of value.answers) {
    if (seen.has(answer.ticket_id)) {
      throw new TicketBatchValidationError(`Answer package has a duplicate ticket_id: ${answer.ticket_id}.`);
    }
    seen.add(answer.ticket_id);
    if (!expectedIds.has(answer.ticket_id)) {
      throw new TicketBatchValidationError(`Answer package includes ticket #${answer.ticket_id}, which was not exported.`);
    }
  }
  if (seen.size !== expectedIds.size) {
    throw new TicketBatchValidationError("Answer package is missing one or more exported tickets.");
  }
  return value;
}

export interface TicketBatchPreview {
  lines: string[];
  totals: {
    readyReplyKeepOpen: number;
    readyReplyClose: number;
    noAction: number;
    staleChanged: number;
    inactiveClosed: number;
  };
}

export function buildAnswerPackagePreview(
  answerPackage: TicketAnswerPackage,
  exportedItems: ReadonlyArray<Pick<TicketBatchExportItemRecord, "ticket_id" | "snapshot_token"> | { ticketId: number; snapshotToken: string }>,
  currentTicket: (ticketId: number) => { status: string; snapshotToken: string } | null
): TicketBatchPreview {
  const tokens = new Map(exportedItems.map((item) => [itemTicketId(item), itemSnapshotToken(item)]));
  const totals = { readyReplyKeepOpen: 0, readyReplyClose: 0, noAction: 0, staleChanged: 0, inactiveClosed: 0 };
  const lines = answerPackage.answers.map((answer) => {
    const current = currentTicket(answer.ticket_id);
    if (!current || current.status === "CLOSED") {
      totals.inactiveClosed += 1;
      return `#${answer.ticket_id} - inactive/closed`;
    }
    if (current.snapshotToken !== tokens.get(answer.ticket_id) || answer.snapshot_token !== tokens.get(answer.ticket_id)) {
      totals.staleChanged += 1;
      return `#${answer.ticket_id} - stale/changed`;
    }
    if (answer.action === "reply_keep_open") {
      totals.readyReplyKeepOpen += 1;
      return `#${answer.ticket_id} - reply, keep open`;
    }
    if (answer.action === "reply_and_close") {
      totals.readyReplyClose += 1;
      return `#${answer.ticket_id} - reply, close`;
    }
    totals.noAction += 1;
    return `#${answer.ticket_id} - no action`;
  });
  return { lines, totals };
}

function compareMessages(left: TicketMessageRecord, right: TicketMessageRecord): number {
  return left.created_at.localeCompare(right.created_at) || left.id - right.id;
}

function itemTicketId(item: Pick<TicketBatchExportItemRecord, "ticket_id"> | { ticketId: number }): number {
  return "ticket_id" in item ? item.ticket_id : item.ticketId;
}

function itemSnapshotToken(item: Pick<TicketBatchExportItemRecord, "snapshot_token"> | { snapshotToken: string }): string {
  return "snapshot_token" in item ? item.snapshot_token : item.snapshotToken;
}
