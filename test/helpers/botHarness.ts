import type { ApiCallFn, Bot, Context, Transformer } from "grammy";
import type { Update, User, UserFromGetMe } from "grammy/types";
import type { QuickRepliesRegistry } from "../../src/quickReplies.js";
import type { ModerationCleanupScheduler } from "../../src/languageModeration.js";
import type { EntityNotificationProviderRegistry } from "../../src/entityNotifications.js";
import type {
  SupportDatabase as SupportDatabaseType,
  TicketStatus,
  TicketWithUser
} from "../../src/db.js";

process.env.NODE_ENV = "test";
process.env.BOT_TOKEN = "123456:TEST_BOT_TOKEN";
process.env.STAFF_CHAT_ID = "-100900";
process.env.DATABASE_URL = ":memory:";
process.env.LOG_LEVEL = "silent";

const [{ SupportDatabase }, { loadQuickRepliesRegistry }, { createBot }] = await Promise.all([
  import("../../src/db.js"),
  import("../../src/quickReplies.js"),
  import("../../src/bot.js")
]);

export const TEST_STAFF_CHAT_ID = -100900;
export const TEST_USER_ID = 123;

export const TEST_BOT_IDENTITY: UserFromGetMe = {
  id: 777,
  is_bot: true,
  first_name: "Test Support Bot",
  username: "test_support_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false
};

export interface RecordedApiCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface ApiMockSuccess {
  ok: true;
  result: unknown;
}

export interface ApiMockFailure {
  ok: false;
  error_code: number;
  description: string;
}

export type ApiMockResponse = ApiMockSuccess | ApiMockFailure;

export type ApiResponseOverride = (
  call: RecordedApiCall,
  defaultResponse: ApiMockSuccess
) => ApiMockResponse | undefined;

export interface TelegramUserFixture {
  id?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface SeedTicketOptions {
  user?: TelegramUserFixture;
  staffChatId?: number;
  messageThreadId?: number;
  status?: TicketStatus;
  staffMessageId?: number;
}

export interface StaffTopicUpdateOptions {
  updateId?: number;
  chatId?: number;
  messageThreadId?: number;
  messageId?: number;
  staff?: TelegramUserFixture;
  text?: string;
}

export interface StaffCallbackUpdateOptions extends StaffTopicUpdateOptions {
  callbackId?: string;
  callbackData?: string;
}

export type StaffMediaType =
  | "photo"
  | "document"
  | "video"
  | "animation"
  | "audio"
  | "voice"
  | "video_note";

export interface StaffMediaUpdateOptions extends StaffTopicUpdateOptions {
  mediaType?: StaffMediaType;
  fileId?: string;
  fileName?: string;
}

export interface StaffDocumentUpdateOptions extends Omit<StaffTopicUpdateOptions, "messageThreadId"> {
  messageThreadId?: number;
  fileId?: string;
  fileName?: string;
  fileSize?: number;
}

export interface BotHarnessOptions {
  quickRepliesRegistry?: QuickRepliesRegistry;
  moderationNow?: () => Date;
  scheduleModerationCleanup?: ModerationCleanupScheduler;
  entityNotificationProviders?: EntityNotificationProviderRegistry;
}

export interface BotHarness {
  db: SupportDatabaseType;
  registry: QuickRepliesRegistry;
  bot: Bot<Context>;
  apiCalls: RecordedApiCall[];
  scheduledModerationCleanupJobIds: number[];
  cleanup(): void;
  seedTicket(options?: SeedTicketOptions): TicketWithUser;
  setApiResponseOverride(method: string, override: ApiResponseOverride): void;
  failNextApiCall(method: string, description?: string, errorCode?: number): void;
  clearApiOverrides(): void;
  findApiCalls(method: string): RecordedApiCall[];
  countApiCalls(method: string): number;
  clearApiCalls(): void;
  setDownloadResponse(body: string, status?: number): void;
  failNextDownload(status?: number): void;
}

export function createBotHarness(options: BotHarnessOptions = {}): BotHarness {
  const db = new SupportDatabase(":memory:");
  const registry = options.quickRepliesRegistry ?? loadQuickRepliesRegistry();
  let downloadResponse: { body: string; status: number } = { body: "{}", status: 200 };
  const scheduledModerationCleanupJobIds: number[] = [];
  const scheduleCleanup: ModerationCleanupScheduler = options.scheduleModerationCleanup ?? ((_api, _db, jobId) => {
    scheduledModerationCleanupJobIds.push(jobId);
  });
  const bot = createBot(db, registry, {
    fetch: async () => new Response(downloadResponse.body, { status: downloadResponse.status }),
    now: options.moderationNow,
    scheduleModerationCleanup: scheduleCleanup,
    entityNotificationProviders: options.entityNotificationProviders
  });
  const apiCalls: RecordedApiCall[] = [];
  const responseOverrides = new Map<string, ApiResponseOverride>();
  const pendingFailures = new Map<string, ApiMockFailure[]>();
  let nextMessageId = 1000;
  let closed = false;

  bot.botInfo = TEST_BOT_IDENTITY;

  const transformer: Transformer = async (_previous, method, payload) => {
    const call: RecordedApiCall = {
      method,
      payload: toRecordedPayload(payload)
    };
    apiCalls.push(call);

    const defaultResponse = createDefaultSuccessResponse(method, call.payload, nextMessageId);
    if (usesGeneratedMessageId(method)) {
      nextMessageId += 1;
    }

    const failure = pendingFailures.get(method)?.shift();
    const response = failure ?? responseOverrides.get(method)?.(call, defaultResponse) ?? defaultResponse;

    return toMockedTransformerResponse(response);
  };

  bot.api.config.use(transformer);

  return {
    db,
    registry,
    bot,
    apiCalls,
    scheduledModerationCleanupJobIds,
    cleanup: () => {
      if (closed) {
        return;
      }

      closed = true;
      responseOverrides.clear();
      pendingFailures.clear();
      apiCalls.length = 0;
      db.close();
    },
    seedTicket: (seedOptions = {}) => seedTicket(db, seedOptions),
    setApiResponseOverride: (method, override) => {
      responseOverrides.set(method, override);
    },
    failNextApiCall: (method, description = "Test API failure", errorCode = 500) => {
      const failures = pendingFailures.get(method) ?? [];
      failures.push({ ok: false, error_code: errorCode, description });
      pendingFailures.set(method, failures);
    },
    clearApiOverrides: () => {
      responseOverrides.clear();
      pendingFailures.clear();
    },
    findApiCalls: (method) => apiCalls.filter((call) => call.method === method),
    countApiCalls: (method) => apiCalls.filter((call) => call.method === method).length,
    clearApiCalls: () => {
      apiCalls.length = 0;
    },
    setDownloadResponse: (body, status = 200) => {
      downloadResponse = { body, status };
    },
    failNextDownload: (status = 500) => {
      downloadResponse = { body: "", status };
    }
  };
}

export function buildStaffCallbackUpdate(options: StaffCallbackUpdateOptions = {}): Update {
  const message = buildStaffTopicMessage(options);

  return {
    update_id: options.updateId ?? 1,
    callback_query: {
      id: options.callbackId ?? "test-callback",
      from: message.from,
      chat_instance: "test-chat-instance",
      data: options.callbackData ?? "qr:open:1",
      message: {
        message_id: message.message_id,
        date: message.date,
        chat: message.chat,
        message_thread_id: message.message_thread_id,
        text: message.text
      }
    }
  };
}

export function buildStaffTextMessageUpdate(options: StaffTopicUpdateOptions = {}): Update {
  return {
    update_id: options.updateId ?? 1,
    message: buildStaffTopicMessage(options)
  };
}

export function buildStaffMediaMessageUpdate(options: StaffMediaUpdateOptions = {}): Update {
  const { text: _text, ...message } = buildStaffTopicMessage(options);
  const mediaType = options.mediaType ?? "photo";
  const fileId = options.fileId ?? `test-${mediaType}-file`;
  const caption = options.text ?? "Test media caption";

  if (mediaType === "photo") {
    return {
      update_id: options.updateId ?? 1,
      message: {
        ...message,
        caption,
        photo: [{ file_id: fileId, file_unique_id: `${fileId}-unique`, width: 1, height: 1 }]
      }
    };
  }

  if (mediaType === "document") {
    return {
      update_id: options.updateId ?? 1,
      message: {
        ...message,
        caption,
        document: {
          file_id: fileId,
          file_unique_id: `${fileId}-unique`,
          file_name: options.fileName ?? "test-document.txt"
        }
      }
    };
  }

  if (mediaType === "video") {
    return {
      update_id: options.updateId ?? 1,
      message: {
        ...message,
        caption,
        video: { file_id: fileId, file_unique_id: `${fileId}-unique`, width: 1, height: 1, duration: 1 }
      }
    };
  }

  if (mediaType === "animation") {
    return {
      update_id: options.updateId ?? 1,
      message: {
        ...message,
        caption,
        animation: {
          file_id: fileId,
          file_unique_id: `${fileId}-unique`,
          width: 1,
          height: 1,
          duration: 1
        }
      }
    };
  }

  if (mediaType === "audio") {
    return {
      update_id: options.updateId ?? 1,
      message: {
        ...message,
        caption,
        audio: { file_id: fileId, file_unique_id: `${fileId}-unique`, duration: 1 }
      }
    };
  }

  if (mediaType === "voice") {
    return {
      update_id: options.updateId ?? 1,
      message: {
        ...message,
        caption,
        voice: { file_id: fileId, file_unique_id: `${fileId}-unique`, duration: 1 }
      }
    };
  }

  return {
    update_id: options.updateId ?? 1,
    message: {
      ...message,
      video_note: { file_id: fileId, file_unique_id: `${fileId}-unique`, length: 1, duration: 1 }
    }
  };
}

export function buildStaffDocumentUpdate(options: StaffDocumentUpdateOptions = {}): Update {
  const staff = toTelegramUser(options.staff);
  const message = {
    message_id: options.messageId ?? 7001,
    date: 1,
    from: staff,
    chat: { id: options.chatId ?? TEST_STAFF_CHAT_ID, type: "supergroup" as const, title: "Test Staff Chat" },
    document: {
      file_id: options.fileId ?? "answer-package-file",
      file_unique_id: "answer-package-unique",
      file_name: options.fileName ?? "ticket-answers_export_test.json",
      file_size: options.fileSize ?? 100
    }
  };
  return {
    update_id: options.updateId ?? 1,
    message: options.messageThreadId === undefined ? message : { ...message, message_thread_id: options.messageThreadId }
  };
}

function seedTicket(db: SupportDatabaseType, options: SeedTicketOptions): TicketWithUser {
  const user = options.user ?? {};
  const userTelegramId = user.id ?? TEST_USER_ID;
  const staffChatId = options.staffChatId ?? TEST_STAFF_CHAT_ID;
  const messageThreadId = options.messageThreadId ?? 5000;

  db.upsertUser({
    telegramId: userTelegramId,
    username: user.username ?? "test_customer",
    firstName: user.firstName ?? "Test Customer",
    lastName: user.lastName ?? null
  });

  const ticket = db.createTicket(userTelegramId, staffChatId);
  db.updateTicketForumTopic(ticket.id, staffChatId, messageThreadId);

  if (options.staffMessageId !== undefined) {
    db.updateTicketStaffMessage(ticket.id, staffChatId, options.staffMessageId);
  }

  if (options.status && options.status !== "OPEN") {
    db.updateTicketStatus(ticket.id, options.status);
  }

  const ticketWithUser = db.getTicketWithUser(ticket.id);
  if (!ticketWithUser) {
    throw new Error(`Test ticket #${ticket.id} could not be loaded`);
  }

  return ticketWithUser;
}

function buildStaffTopicMessage(options: StaffTopicUpdateOptions) {
  const staff = toTelegramUser(options.staff);

  return {
    message_id: options.messageId ?? 7001,
    date: 1,
    from: staff,
    chat: {
      id: options.chatId ?? TEST_STAFF_CHAT_ID,
      type: "supergroup" as const,
      title: "Test Staff Chat"
    },
    message_thread_id: options.messageThreadId ?? 5000,
    text: options.text ?? "Test staff reply"
  };
}

function toTelegramUser(fixture: TelegramUserFixture | undefined): User {
  return {
    id: fixture?.id ?? 42,
    is_bot: false,
    first_name: fixture?.firstName ?? "Test Staff",
    last_name: fixture?.lastName,
    username: fixture?.username ?? "test_staff"
  };
}

function createDefaultSuccessResponse(
  method: string,
  payload: Record<string, unknown>,
  messageId: number
): ApiMockSuccess {
  if (method === "getMe") {
    return { ok: true, result: TEST_BOT_IDENTITY };
  }

  if (method === "sendMessage" || method === "sendDocument") {
    const chatId = numericPayloadValue(payload, "chat_id");
    return {
      ok: true,
      result: {
        message_id: messageId,
        date: 1,
        chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
        text: stringPayloadValue(payload, "text")
      }
    };
  }

  if (method === "copyMessage") {
    return { ok: true, result: { message_id: messageId } };
  }

  if (method === "getFile") {
    return {
      ok: true,
      result: {
        file_id: stringPayloadValue(payload, "file_id") ?? "test-file",
        file_path: "test/answer.json"
      }
    };
  }

  if (method === "createForumTopic") {
    return {
      ok: true,
      result: {
        message_thread_id: messageId,
        name: stringPayloadValue(payload, "name") ?? "Test topic",
        icon_color: 0x6fb9f0
      }
    };
  }

  return { ok: true, result: true };
}

function usesGeneratedMessageId(method: string): boolean {
  return method === "sendMessage" || method === "sendDocument" || method === "copyMessage" || method === "createForumTopic";
}

function toRecordedPayload(payload: unknown): Record<string, unknown> {
  return isRecord(payload) ? { ...payload } : {};
}

function numericPayloadValue(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === "number" ? value : 0;
}

function stringPayloadValue(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toMockedTransformerResponse(
  response: ApiMockResponse
): Awaited<ReturnType<ApiCallFn>> {
  // The mock deliberately supports only the API response shapes exercised by
  // tests. grammY's generic transformer result is therefore narrowed here,
  // at the boundary between the generic API client and the controlled mock.
  return response as Awaited<ReturnType<ApiCallFn>>;
}
