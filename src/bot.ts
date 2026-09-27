import { Bot, GrammyError, HttpError, InlineKeyboard, Keyboard } from "grammy";
import type { CommandContext, Context } from "grammy";
import type { User } from "grammy/types";
import packageMetadata from "../package.json" with { type: "json" };
import {
  getSupportLogsTopicInfo,
  initializeSupportLogsTopic,
  logBanEvent,
  setSupportLogsTopicOverride,
  type SupportLogsTopicInfo,
  type ArchiveActor,
} from "./archive.js";
import { config, hostConfig } from "./config.js";
import { SupportDatabase, type TicketStatus } from "./db.js";
import {
  CLOSED_TEXT,
  START_TEXT,
  formatStatus,
  formatTicketDetails,
  formatWhois,
  formatUserTicketList,
  truncate,
} from "./format.js";
import { logger } from "./logger.js";
import { createQuickRepliesManager, type QuickRepliesRegistry } from "./quickReplies.js";
import { createTicketBatchTelegramSurface } from "./ticketBatchTelegram.js";
import {
  createPublicModerationTelegramSurface,
  PendingWarningScheduler,
  processPendingWarning,
} from "./publicModerationTelegram.js";
import { displayTelegramUser, isCommandText, usernameOf } from "./telegram.js";
import { createQuickRepliesTelegramSurface, quickRepliesOpenCallbackData } from "./quickRepliesTelegram.js";
import { createModerationCleanupScheduler, type ModerationCleanupScheduler } from "./languageModeration.js";
import type { EntityNotificationProviderRegistry } from "./entityNotifications.js";
import { normalizeTelegramDeliveryError } from "./deliveryDiagnostics.js";
import {
  StaffChatDeliveryCoordinator,
  type StaffChatDeliveryOptions,
  type StaffChatOperationOptions,
} from "./staffChatDelivery.js";
import { InstallationService, type Permission } from "./installation.js";
import { BackgroundTaskRegistry, type BackgroundTaskTracker } from "./lifecycle.js";
import { SupportIngressLimiter, type SupportIngressDecision } from "./supportIngressLimiter.js";
import {
  formatWorkspaceChecklist,
  isPrivateInviteLink,
  parsePublicSupergroupReference,
  validateStaffWorkspace,
  type WorkspaceValidationResult,
} from "./workspaceValidation.js";
import { PrivateControlPlane } from "./privateControlPlane.js";
import type { RuntimeHealthRegistry, UpdateErrorCategory } from "./runtimeObservability.js";
import { TicketBatchRuntime, TicketBatchStaffOperationError } from "./ticketBatchRuntime.js";
import type { TicketBatchResourceLimits } from "./ticketBatchResourceLimits.js";
import { TicketRoutingService } from "./ticketRouting.js";

export { PendingWarningScheduler, processPendingWarning };

const STAFF_ONLY_TEXT = "This command is only available for staff.";
const BANNED_TEXT = "You are currently restricted from opening support tickets.";
const SUPPORT_INGRESS_THROTTLED_TEXT =
  "You're sending messages too quickly.\n\nSome recent messages were not added to your ticket. Please wait a few seconds, then resend anything that did not go through.";
const DEFAULT_BAN_REASON = "No reason provided.";
const STAFF_HELP_SENT_SETTING_PREFIX = "staff_help_sent";
const ENTITY_NOTIFICATION_SETTING_PREFIX = "entity_notifications";
const SUPPORT_EXPECTED_RESPONSE_TIME_SETTING_KEY = "support_expected_response_time";
const SUPPORT_TICKET_RECEIVED_TEMPLATE_SETTING_KEY = "support_ticket_received_template";
const STAFF_TEST_TICKET_MODE_SETTING_PREFIX = "staff_test_ticket_mode:";
const STAFF_TEST_TICKET_ID_SETTING_PREFIX = "staff_test_ticket_id:";
export const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query", "chat_member", "message_reaction"] as const;
const USER_HELP_TEXT = [
  "Support help",
  "",
  "Send one message here to open a ticket. You can include your AgentOn UID, wallet address, quest link, screenshots, documents, or transaction hash.",
  "",
  "Only one open ticket is active at a time. While it is open, keep sending messages in this chat and they will be added to the same ticket.",
  "",
  "Use the Close ticket button when the issue is solved. After the ticket is closed, your next message opens a new ticket.",
  "",
  "Commands:",
  "/start - show the initial instructions",
  "/status - show your latest ticket status",
  "/mytickets - show your recent tickets",
  "/help - show this help",
].join("\n");

const STAFF_HELP_TEXT = [
  "Staff help",
  "",
  "Workflow:",
  "- One ticket = one forum topic.",
  "- The first ticket message contains metadata and controls.",
  "- Follow-up user messages are compact.",
  "- Staff replies in the ticket topic are forwarded to the user.",
  "- Users only get automatic messages when a ticket opens and closes.",
  "- Closed tickets are archived to Support Logs as a .txt transcript.",
  "- Ticket topics are deleted or closed after archive when Telegram allows it.",
  "- Support Logs are scoped per STAFF_CHAT_ID.",
  "- If Support Logs is missing, the bot creates it automatically.",
  "",
  "Staff commands:",
  "/help - show this help",
  "/chatid - show current chat id",
  "/whois - show current ticket/user info inside a ticket topic",
  "/ticket <id> - show ticket details",
  "/close <id> - close ticket",
  "/ban <telegram_id> [reason] - ban user from opening tickets",
  "/unban <telegram_id> - unban user",
  "/bans - list banned users",
  "/setlogs - use current topic as Support Logs",
  "/logs - show/create current Support Logs topic status",
  "/exporttickets - export active tickets for an answer package",
  "Upload a validated answer package in the staff group to preview and apply its replies.",
  "/moderation <subcommand> - configure public English-only moderation",
  "/questnotify <subcommand> - configure new-entity notifications",
  "",
  "OWNER/ADMIN setup, team invitations, and role-based access are managed from the private staff dashboard.",
].join("\n");

const STAFF_ONBOARDING_TEXT = [
  "Support bot is configured for this staff group.",
  "",
  "Key workflow:",
  "- One ticket = one forum topic.",
  "- Staff replies inside a ticket topic are forwarded to the user.",
  "- Follow-up user messages stay compact in the same topic.",
  "- Users only receive automatic messages when a ticket opens and closes.",
  "- Closed tickets are archived to Support Logs as .txt transcripts.",
  "",
  "Commands:",
  "/help, /chatid, /whois, /ticket <id>, /close <id>",
  "/ban <telegram_id> [reason], /unban <telegram_id>, /bans",
  "/setlogs, /logs",
  "/exporttickets, /moderation status",
  "/questnotify status|target|provider|enable|disable|help",
  "",
  "Run /setlogs inside any topic to make it Support Logs.",
  "Run /logs to show or create the current Support Logs topic.",
  "",
  "This onboarding message is sent only once per STAFF_CHAT_ID.",
].join("\n");

type BotApi = Context["api"];

interface BanCommand {
  userId: number;
  reason: string;
}

interface BotRuntimeDependencies {
  fetch?: typeof fetch;
  ticketBatchResourceLimits?: Partial<TicketBatchResourceLimits>;
  now?: () => Date;
  scheduleModerationCleanup?: ModerationCleanupScheduler;
  entityNotificationProviders?: EntityNotificationProviderRegistry;
  staffChatDelivery?: StaffChatDeliveryOptions;
  installationService?: InstallationService;
  backgroundTasks?: BackgroundTaskTracker;
  supportIngressLimiter?: SupportIngressLimiter;
  pendingWarningScheduler?: PendingWarningScheduler;
  runtimeHealth?: RuntimeHealthRegistry;
}

export type SupportBot = Bot<Context> & {
  recoverPendingTicketBatchStaffOperations(): Promise<void>;
  stopBackgroundWork(): void;
};

export function createBot(
  db: SupportDatabase,
  quickRepliesRegistry: QuickRepliesRegistry,
  runtime: BotRuntimeDependencies = {}
): SupportBot {
  const bot = new Bot<Context>(config.botToken);
  const installation = runtime.installationService ?? new InstallationService(db);
  if (!runtime.installationService && !installation.getActiveWorkspace()) {
    if (hostConfig.staffChatId !== null) {
      installation.adoptLegacyInstallation(hostConfig.staffChatId);
    }
  }
  bot.use(async (_ctx, next) => {
    try {
      await next();
      runtime.runtimeHealth?.recordUpdateSuccess();
    } catch (error) {
      runtime.runtimeHealth?.recordUpdateError(updateErrorCategory(error));
      throw error;
    }
  });
  bot.use(async (ctx, next) => {
    const messageUpdate = "message" in ctx.update ? ctx.update.message : undefined;
    const senderChatMessage = Boolean(messageUpdate && "sender_chat" in messageUpdate && messageUpdate.sender_chat);
    if (
      !senderChatMessage &&
      ctx.from &&
      !ctx.from.is_bot &&
      installation.getState().setupState === "READY" &&
      ctx.chat?.id === installation.getStaffChatId()
    ) {
      installation.ensureBaselineAgent({
        telegramId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      });
    }
    await next();
  });
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  const moderationNow = runtime.now ?? (() => new Date());
  const backgroundTasks = runtime.backgroundTasks ?? new BackgroundTaskRegistry();
  const supportIngressLimiter = runtime.supportIngressLimiter ?? new SupportIngressLimiter();
  const moderationCleanupScheduler =
    runtime.scheduleModerationCleanup ??
    createModerationCleanupScheduler(() => installation.getStaffChatId(), { backgroundTasks });
  const entityNotificationProviders = runtime.entityNotificationProviders ?? new Map();
  const staffChatDelivery = new StaffChatDeliveryCoordinator(runtime.staffChatDelivery);
  const quickRepliesManager = createQuickRepliesManager(db, quickRepliesRegistry);
  const privateControlPlane = new PrivateControlPlane(installation);
  const pendingWarnings = runtime.pendingWarningScheduler ?? new PendingWarningScheduler(backgroundTasks);

  const requireStaffChatId = (): number => installation.requireStaffChatId();
  const isConfiguredStaffWorkspace = (ctx: Context): boolean => ctx.chat?.id === installation.getStaffChatId();
  const isStaffChat = (ctx: Context): boolean => {
    const staffChatId = installation.getStaffChatId();
    const messageUpdate = "message" in ctx.update ? ctx.update.message : undefined;
    const senderChatMessage = Boolean(messageUpdate && "sender_chat" in messageUpdate && messageUpdate.sender_chat);
    return Boolean(
      !senderChatMessage &&
      staffChatId !== null &&
      ctx.chat?.id === staffChatId &&
      ctx.from &&
      !ctx.from.is_bot &&
      installation.isStaffAuthorized(ctx.from.id, staffChatId)
    );
  };
  const hasApplicationPermission = (ctx: Context, permission: Permission): boolean =>
    Boolean(
      ctx.from &&
      (installation.getState().authorizationMode === "LEGACY_TRUSTED_GROUP" ||
        installation.can(ctx.from.id, permission))
    );

  const requirePermission = async (ctx: Context, permission: Permission): Promise<boolean> => {
    if (!isStaffChat(ctx) || !ctx.from) return false;
    if (
      installation.getState().authorizationMode === "LEGACY_TRUSTED_GROUP" ||
      installation.can(ctx.from.id, permission)
    )
      return true;
    await ctx.reply(
      `Your application role does not allow this action (${permission.toLowerCase().replaceAll("_", " ")}).`
    );
    return false;
  };

  const hasRequiredPrivateWorkspaceMembership = async (ctx: Context): Promise<boolean> => {
    if (installation.getState().authorizationMode !== "RBAC_ACTIVE") return true;
    if (!ctx.from) return false;
    const staffChatId = installation.getStaffChatId();
    if (staffChatId === null) return false;
    try {
      const member = await ctx.api.getChatMember(staffChatId, ctx.from.id);
      return member.status !== "left" && member.status !== "kicked";
    } catch {
      return false;
    }
  };

  const enrollBaselineStaffMember = (user: User | undefined): boolean => {
    if (!user || user.is_bot || installation.getState().setupState !== "READY") return false;
    return (
      installation.ensureBaselineAgent({
        telegramId: user.id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
      }) !== null
    );
  };

  const enrollPrivateWorkspaceMember = async (ctx: Context): Promise<boolean> => {
    if (
      !ctx.from ||
      ctx.from.is_bot ||
      installation.getMember(ctx.from.id) ||
      installation.getState().setupState !== "READY"
    )
      return Boolean(ctx.from && installation.getMember(ctx.from.id));
    const staffChatId = installation.getStaffChatId();
    if (staffChatId === null) return false;
    try {
      const member = await ctx.api.getChatMember(staffChatId, ctx.from.id);
      if (member.status === "left" || member.status === "kicked") return false;
      return enrollBaselineStaffMember(ctx.from);
    } catch {
      return false;
    }
  };

  const requirePrivatePermission = async (ctx: Context, permission: Permission): Promise<boolean> => {
    if (!isPrivateChat(ctx) || !ctx.from || ctx.from.is_bot || !installation.can(ctx.from.id, permission)) {
      if (isPrivateChat(ctx)) await ctx.reply("Your application role does not allow this action.");
      return false;
    }
    if (!(await hasRequiredPrivateWorkspaceMembership(ctx))) {
      await ctx.reply("Staff workspace membership required for role-based access.");
      return false;
    }
    return true;
  };

  const moderationSurface = createPublicModerationTelegramSurface({
    bot,
    db,
    installation,
    now: moderationNow,
    cleanupScheduler: moderationCleanupScheduler,
    pendingWarnings,
    requireStaffChatId,
    isStaffChat,
    isPrivateChat,
    requirePermission,
    staffOnlyText: STAFF_ONLY_TEXT,
  });

  async function runStaffChatOperation<T>(
    operation: () => Promise<T>,
    options: StaffChatOperationOptions,
    chatId = requireStaffChatId()
  ): Promise<T> {
    const outcome = await staffChatDelivery.run(chatId, operation, options);
    if (outcome.value !== undefined) return outcome.value;
    throw new TicketBatchStaffOperationError(
      outcome.diagnostic ?? normalizeTelegramDeliveryError(new Error("Staff operation failed")),
      outcome.retryAt
    );
  }

  const ticketRouting = new TicketRoutingService({
    db,
    api: bot.api,
    installation,
    staffTicketKeyboard,
    userTicketKeyboard,
    bannedText: BANNED_TEXT,
    supportExpectedResponseTimeSettingKey: SUPPORT_EXPECTED_RESPONSE_TIME_SETTING_KEY,
    supportTicketReceivedTemplateSettingKey: SUPPORT_TICKET_RECEIVED_TEMPLATE_SETTING_KEY,
  });

  const ticketBatchRuntime = new TicketBatchRuntime({
    db,
    api: bot.api,
    installation,
    backgroundTasks,
    runStaffChatOperation,
    deliverUserReply: ticketRouting.deliverAndRecordStaffTextReply.bind(ticketRouting),
    closeTicket: async (ticketId, options, staffChatId) => {
      await ticketRouting.closeTicket(ticketId, options, staffChatId);
    },
    staffActor,
    refreshTicket: (ticketId, staffChatId) => ticketRouting.refreshTicket(ticketId, staffChatId),
  });

  const ticketBatchSurface = createTicketBatchTelegramSurface({
    bot,
    db,
    installation,
    ticketBatchRuntime,
    fetchImpl,
    resourceLimits: runtime.ticketBatchResourceLimits,
    runStaffChatOperation,
    requireStaffChatId,
    isStaffChat,
    isPrivateChat,
    requirePermission,
    requirePrivatePermission,
    staffOnlyText: STAFF_ONLY_TEXT,
    privateControlPlane,
  });
  privateControlPlane.configureOperatorUi({
    db,
    quickReplies: quickRepliesManager,
    canConfigure: (ctx) => requirePrivatePermission(ctx, "CONFIGURE_INSTALLATION"),
    canUsePermission: requirePrivatePermission,
    hasPrivateWorkspaceMembership: hasRequiredPrivateWorkspaceMembership,
    getPendingBatchExport: ticketBatchSurface.getPendingPrivateBatchExport,
    onStartTestTicket: async (ctx) => {
      if (!ctx.from) return;
      setStaffTestTicketId(ctx.from.id, undefined);
      db.setSetting(`${STAFF_TEST_TICKET_MODE_SETTING_PREFIX}${ctx.from.id}`, "true");
      await privateControlPlane.refreshScreen(
        ctx,
        "Test-ticket mode enabled for your next message. Send harmless test content now.",
        new InlineKeyboard().text("Cancel", "dashboard:home")
      );
    },
    onShowWorkspace: (ctx) => showStaffWorkspaceSettings(ctx),
    onShowBatch: async (ctx) => {
      if (!ctx.from) return;
      const exportId = ticketBatchSurface.getPendingPrivateBatchExport(ctx.from.id);
      if (exportId) await ticketBatchSurface.showPrivateBatchWaiting(ctx, exportId);
      else await privateControlPlane.showDashboard(ctx);
    },
    onContinueReconciledArchive: (ticketId, staffChatId) =>
      ticketRouting.finalizeReconciledArchive(ticketId, staffChatId),
    onContinueReconciledBatch: (answerPackageId, staffChatId) =>
      ticketBatchRuntime.recoverPendingStaffOperationsForWorkspace(answerPackageId, staffChatId),
    onRefreshReconciledTicket: (ticketId, staffChatId) => ticketRouting.refreshTicket(ticketId, staffChatId),
    onContinueReconciledInbound: (sourceChatId, sourceMessageId, staffChatId, operationIdentity) =>
      ticketRouting.continueReconciledInbound(sourceChatId, sourceMessageId, staffChatId, operationIdentity),
    packageVersion: packageMetadata.version,
    botUsername: () => bot.botInfo?.username,
    botId: () => bot.botInfo?.id,
  });

  const quickRepliesSurface = createQuickRepliesTelegramSurface({
    db,
    registry: quickRepliesRegistry,
    ticketRouting,
    requireStaffChatId,
    isStaffChat,
    hasApplicationPermission,
    parseTicketId: parseUserId,
    describeError,
  });
  const renderPrivateScreen = privateControlPlane.renderScreen.bind(privateControlPlane);
  const refreshPrivateScreen = privateControlPlane.refreshScreen.bind(privateControlPlane);
  const retireTrackedPrivateScreens = privateControlPlane.retireTrackedScreens.bind(privateControlPlane);

  function clearStaffTestTicketMode(userId: number | undefined): void {
    if (userId === undefined) return;
    if (db.getSetting(`${STAFF_TEST_TICKET_MODE_SETTING_PREFIX}${userId}`) === "true") {
      db.setSetting(`${STAFF_TEST_TICKET_MODE_SETTING_PREFIX}${userId}`, "false");
    }
  }

  function staffTestTicketId(userId: number): number | undefined {
    const ticketId = Number(db.getSetting(`${STAFF_TEST_TICKET_ID_SETTING_PREFIX}${userId}`));
    return Number.isInteger(ticketId) && ticketId > 0 ? ticketId : undefined;
  }

  function setStaffTestTicketId(userId: number, ticketId: number | undefined): void {
    db.setSetting(`${STAFF_TEST_TICKET_ID_SETTING_PREFIX}${userId}`, ticketId === undefined ? "" : String(ticketId));
  }

  const clearPublicChatPicker = privateControlPlane.clearPublicChatPicker.bind(privateControlPlane);

  const showDashboard = privateControlPlane.showDashboard.bind(privateControlPlane);
  const showDashboardAfterStaffTestTicketClose =
    privateControlPlane.showDashboardAfterStaffTestTicketClose.bind(privateControlPlane);
  async function showStaffWorkspaceSettings(ctx: Context, notice?: string, refresh = false): Promise<void> {
    const workspace = installation.getActiveWorkspace();
    const current = workspace
      ? [
          workspace.title ?? "Unnamed workspace",
          workspace.username ? `@${workspace.username}` : String(workspace.telegram_chat_id),
        ].join("\n")
      : "Not configured";
    const render = refresh ? refreshPrivateScreen : renderPrivateScreen;
    await render(
      ctx,
      ["Staff workspace", "", `Current:\n${current}`, ...(notice ? ["", notice] : [])].join("\n"),
      new InlineKeyboard().text("Choose staff workspace", "workspace:select").row().text("Back", "dashboard:home")
    );
  }

  const onboardingStages = [
    "WELCOME",
    "BOT_IDENTITY",
    "STAFF_WORKSPACE",
    "WORKSPACE_PERMISSIONS",
    "SUPPORT_LOGS",
    "PUBLIC_CHAT",
    "TEAM_ROLES",
    "SUMMARY",
    "ACTIVATE_SUPPORT",
  ] as const;
  async function showOnboarding(ctx: Context, stage: (typeof onboardingStages)[number]): Promise<void> {
    if (!ctx.from) return;
    if (installation.getState().setupState === "READY") {
      installation.saveOnboardingStage(ctx.from.id, "ACTIVATE_SUPPORT", "COMPLETED");
      await showDashboard(ctx);
      return;
    }
    installation.saveOnboardingStage(ctx.from.id, stage);
    const copy: Record<(typeof onboardingStages)[number], string> = {
      WELCOME: "Welcome. Host secrets stay local; product configuration is stored in SQLite.",
      BOT_IDENTITY: `Bot identity verified: @${bot.botInfo?.username ?? "bot"}.`,
      STAFF_WORKSPACE: "Select the Telegram forum supergroup that staff will use.",
      WORKSPACE_PERMISSIONS: "The selected workspace must pass every permissions check.",
      SUPPORT_LOGS: "Support Logs will be validated or initialized after the workspace is accepted.",
      PUBLIC_CHAT: "Public-chat moderation is optional and can be configured later.",
      TEAM_ROLES: "Invite team roles before activating role-based access.",
      SUMMARY: "Review the workspace and team. Legacy trusted-group access remains active until explicit activation.",
      ACTIVATE_SUPPORT: "Activate support when the mandatory workspace is ready.",
    };
    const index = onboardingStages.indexOf(stage);
    const keyboard = new InlineKeyboard();
    if (index > 0) keyboard.text("Back", `setup:stage:${onboardingStages[index - 1]}`).row();
    if (stage === "STAFF_WORKSPACE") {
      if (installation.getActiveWorkspace()?.imported_from_legacy)
        keyboard.text("Use existing staff workspace", "setup:use-existing").row();
      keyboard.text("Choose staff workspace", "setup:workspace").row();
    } else if (stage === "ACTIVATE_SUPPORT") keyboard.text("Activate support", "setup:activate").row();
    else
      keyboard
        .text("Continue", `setup:stage:${onboardingStages[Math.min(index + 1, onboardingStages.length - 1)]}`)
        .row();
    if (stage === "PUBLIC_CHAT") keyboard.text("Skip optional step", "setup:stage:TEAM_ROLES").row();
    keyboard.text("Exit setup", "setup:exit");
    const text = `Setup ${index + 1}/9\n\n${copy[stage]}`;
    await renderPrivateScreen(ctx, text, keyboard);
  }

  async function sendWorkspacePicker(ctx: Context, mode: "SETUP" | "RECONFIGURE" = "SETUP"): Promise<void> {
    if (ctx.from) privateControlPlane.setPendingWorkspaceSelection(ctx.from.id, mode);
    const rights = {
      is_anonymous: false,
      can_manage_chat: true,
      can_delete_messages: true,
      can_manage_video_chats: false,
      can_restrict_members: false,
      can_promote_members: false,
      can_change_info: false,
      can_invite_users: true,
      can_post_stories: false,
      can_edit_stories: false,
      can_delete_stories: false,
      can_post_messages: false,
      can_edit_messages: false,
      can_pin_messages: true,
      can_manage_topics: true,
      can_send_welcome_messages: false,
    };
    const keyboard = new Keyboard()
      .requestChat("Select forum staff group", 1300, {
        chat_is_channel: false,
        chat_is_forum: true,
        bot_is_member: true,
        request_title: true,
        request_username: true,
        bot_administrator_rights: rights,
        user_administrator_rights: rights,
      })
      .text("Cancel workspace selection")
      .resized()
      .oneTime();
    const prompt = await ctx.reply(
      "Choose the staff forum group by title. You can also paste a public @username or t.me link.",
      { reply_markup: keyboard }
    );
    if (ctx.from)
      await privateControlPlane.rememberWorkspacePickerPrompt(
        ctx.from.id,
        { chatId: prompt.chat.id, messageId: prompt.message_id },
        ctx.api
      );
  }

  async function completeWorkspaceSelection(
    ctx: Context,
    result: WorkspaceValidationResult,
    mode: "SETUP" | "RECONFIGURE",
    fallback?: { title?: string; username?: string }
  ): Promise<void> {
    if (!ctx.from) return;
    privateControlPlane.clearPendingWorkspaceSelection(ctx.from.id);
    await privateControlPlane.retireWorkspacePickerPrompt(ctx.from.id, ctx.api);
    if (!result.valid) {
      const notice = `Staff workspace is not ready:\n${formatWorkspaceChecklist(result)}`;
      if (mode === "RECONFIGURE") {
        await showStaffWorkspaceSettings(ctx, notice, true);
      } else {
        await renderPrivateScreen(
          ctx,
          notice,
          new InlineKeyboard().text("Retry", "setup:workspace").row().text("Back", "setup:stage:STAFF_WORKSPACE")
        );
      }
      return;
    }
    installation.activateWorkspace({
      chatId: result.chatId,
      title: result.title ?? fallback?.title,
      username: result.username ?? fallback?.username,
    });
    if (mode === "RECONFIGURE") {
      if (!db.getSetting(`support_logs_message_thread_id:${result.chatId}`))
        await initializeSupportLogsTopic(ctx.api, db, result.chatId);
      await showStaffWorkspaceSettings(ctx, `Workspace validated:\n${formatWorkspaceChecklist(result)}`, true);
      return;
    }
    installation.saveOnboardingStage(ctx.from.id, "WORKSPACE_PERMISSIONS");
    await initializeSupportLogsTopic(ctx.api, db, result.chatId);
    await renderPrivateScreen(
      ctx,
      `Staff workspace validated:\n${formatWorkspaceChecklist(result)}`,
      new InlineKeyboard().text("Continue", "setup:stage:SUPPORT_LOGS")
    );
  }

  bot.command("start", async (ctx) => {
    if (!isPrivateChat(ctx)) {
      await moderationSurface.handlePublicMessage(ctx);
      return;
    }

    privateControlPlane.clearSupportSettingsInput(ctx.from?.id ?? -1);
    persistUserFromContext(db, ctx);
    const startParameter = ctx.match.trim();
    if (startParameter.startsWith("setup_") && ctx.from) {
      const result = installation.consumeOwnerPairingToken(startParameter.slice(6), {
        telegramId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      });
      if (result.kind === "PAIRED") {
        await showOnboarding(ctx, "WELCOME");
        return;
      }
      if (result.kind === "TRANSFER_CONFIRMATION_REQUIRED") {
        await ctx.reply("Confirm ownership transfer. The current OWNER remains active until confirmation.", {
          reply_markup: new InlineKeyboard().text("Confirm ownership transfer", "owner:confirm-transfer"),
        });
        return;
      }
      await ctx.reply(
        result.kind === "EXPIRED"
          ? "This setup link has expired. Generate a new link locally."
          : "This setup link is invalid or already used."
      );
      return;
    }
    if (startParameter.startsWith("team_") && ctx.from) {
      const result = installation.consumeTeamInvitation(startParameter.slice(5), {
        telegramId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      });
      if (result.kind === "JOINED") {
        let joined = false;
        const chatId = installation.getStaffChatId();
        if (chatId !== null) {
          try {
            const member = await ctx.api.getChatMember(chatId, ctx.from.id);
            joined = member.status !== "left" && member.status !== "kicked";
          } catch {}
        }
        await ctx.reply(
          `Team invitation accepted. Role: ${result.role}.${joined ? "" : " Join the configured staff workspace before using staff commands."}`
        );
        if (joined || installation.getState().authorizationMode !== "RBAC_ACTIVE") await showDashboard(ctx);
        return;
      }
      await ctx.reply(
        result.kind === "EXPIRED"
          ? "This team invitation has expired."
          : "This team invitation is invalid or already used."
      );
      return;
    }
    if (await replyIfBanned(db, ctx)) {
      return;
    }

    if (ctx.from && installation.getMember(ctx.from.id)) await clearPublicChatPicker(ctx);
    if (await enrollPrivateWorkspaceMember(ctx)) {
      clearStaffTestTicketMode(ctx.from?.id);
      await showDashboard(ctx, true);
      return;
    }
    if (installation.getState().setupState === "SETUP_REQUIRED") {
      await ctx.reply("Support has not been configured yet. Please try again later.");
      return;
    }
    await ctx.reply(START_TEXT);
  });

  bot.command("help", async (ctx) => {
    if (isPrivateChat(ctx)) {
      privateControlPlane.clearSupportSettingsInput(ctx.from?.id ?? -1);
      if (await enrollPrivateWorkspaceMember(ctx)) {
        clearStaffTestTicketMode(ctx.from?.id);
        await showDashboard(ctx);
      } else
        await ctx.reply(
          installation.getState().setupState === "READY" ? USER_HELP_TEXT : "Support has not been configured yet."
        );
      return;
    }

    if (!isStaffChat(ctx)) {
      return;
    }

    const helpText =
      installation.getState().authorizationMode === "RBAC_ACTIVE"
        ? STAFF_HELP_TEXT.replace(
            "/exporttickets - export active tickets for an answer package\nUpload a validated answer package in the staff group to preview and apply its replies.",
            "Batch operations are available to OWNER and ADMIN in the bot's private chat."
          )
        : STAFF_HELP_TEXT;
    await ctx.reply(helpText, {
      message_thread_id: ctx.message?.message_thread_id,
    });
  });

  bot.command("chatid", async (ctx) => {
    if (isPrivateChat(ctx)) {
      if (await replyIfBanned(db, ctx)) {
        return;
      }

      await ctx.reply(STAFF_ONLY_TEXT);
      return;
    }

    if (!isStaffChat(ctx) || !ctx.chat) {
      return;
    }

    await ctx.reply(`Chat ID: ${ctx.chat.id}`);
  });

  bot.command("setlogs", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!(await requirePermission(ctx, "SUPPORT_LOGS"))) return;
    const messageThreadId = ctx.message?.message_thread_id;
    if (typeof messageThreadId !== "number") {
      await ctx.reply("Please run /setlogs inside the forum topic you want to use as Support Logs.");
      return;
    }

    if (db.findTicketByStaffThread(requireStaffChatId(), messageThreadId)) {
      await ctx.reply("This topic belongs to a support ticket and cannot be used as Support Logs.", {
        message_thread_id: messageThreadId,
      });
      return;
    }

    setSupportLogsTopicOverride(db, requireStaffChatId(), messageThreadId);
    await ctx.reply("This topic is now used as Support Logs.", {
      message_thread_id: messageThreadId,
    });
  });

  bot.command("logs", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!(await requirePermission(ctx, "SUPPORT_LOGS"))) return;
    const topic = await getSupportLogsTopicInfo(ctx.api, db, requireStaffChatId());
    await ctx.reply(formatSupportLogsTopicInfo(topic, requireStaffChatId()), {
      message_thread_id: ctx.message?.message_thread_id,
    });
  });

  ticketBatchSurface.registerExportCommand();

  moderationSurface.registerCommand();

  bot.command("questnotify", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) await ctx.reply(STAFF_ONLY_TEXT);
      return;
    }

    if (!(await requirePermission(ctx, "CONFIGURE_INSTALLATION"))) return;
    const [, action = "status", ...args] = (ctx.message?.text ?? "").trim().split(/\s+/);
    if (action === "help") {
      await ctx.reply(
        "Usage: /questnotify status | target <chat_id> | provider <provider_key> | enable | disable | help"
      );
      return;
    }
    if (action === "status") {
      await ctx.reply(await formatEntityNotificationStatus(ctx.api, db, entityNotificationProviders));
      return;
    }
    if (action === "target") {
      const targetChatId = Number(args[0]);
      if (!Number.isSafeInteger(targetChatId) || targetChatId === 0) {
        await ctx.reply("Usage: /questnotify target <chat_id>");
        return;
      }
      try {
        await ctx.api.getChat(targetChatId);
      } catch {
        await ctx.reply("The notification target is not reachable by this bot.");
        return;
      }
      db.setSetting(entityNotificationSettingKey("target_chat_id"), String(targetChatId));
      await ctx.reply(
        `Entity notification target set to ${targetChatId}. It remains disabled until /questnotify enable succeeds.`
      );
      return;
    }
    if (action === "provider") {
      const providerKey = args[0]?.trim();
      const provider = providerKey ? entityNotificationProviders.get(providerKey) : undefined;
      if (!provider) {
        await ctx.reply("That entity notification provider is not registered.");
        return;
      }
      if (!provider.authoritative) {
        await ctx.reply("That entity notification provider is not authoritative.");
        return;
      }
      if (!isEntityNotificationProviderAvailable(provider)) {
        await ctx.reply(entityNotificationProviderStatus(provider));
        return;
      }
      db.setSetting(entityNotificationSettingKey("provider"), provider.key);
      await ctx.reply(`Entity notification provider set to ${provider.key}.`);
      return;
    }
    if (action === "enable") {
      const targetChatId = parseStoredEntityNotificationTarget(
        db.getSetting(entityNotificationSettingKey("target_chat_id"))
      );
      if (targetChatId === null) {
        await ctx.reply("Entity notifications remain disabled: configure a reachable target first.");
        return;
      }
      try {
        await ctx.api.getChat(targetChatId);
      } catch {
        await ctx.reply("Entity notifications remain disabled: the configured target is not reachable.");
        return;
      }
      const providerKey = db.getSetting(entityNotificationSettingKey("provider"));
      const provider = providerKey ? entityNotificationProviders.get(providerKey) : undefined;
      if (!provider) {
        await ctx.reply("Entity notifications remain disabled: configure a registered provider first.");
        return;
      }
      if (!provider.authoritative) {
        await ctx.reply("Entity notifications remain disabled: the provider is not authoritative.");
        return;
      }
      if (!isEntityNotificationProviderAvailable(provider)) {
        await ctx.reply(`Entity notifications remain disabled: ${entityNotificationProviderStatus(provider)}`);
        return;
      }
      db.setSetting(entityNotificationSettingKey("enabled"), "true");
      await ctx.reply("Entity notifications enabled.");
      return;
    }
    if (action === "disable") {
      db.setSetting(entityNotificationSettingKey("enabled"), "false");
      await ctx.reply("Entity notifications disabled. Target, provider, and publication history were preserved.");
      return;
    }
    await ctx.reply(
      "Usage: /questnotify status | target <chat_id> | provider <provider_key> | enable | disable | help"
    );
  });

  bot.command("status", async (ctx) => {
    if (!isPrivateChat(ctx) || !ctx.from) {
      return;
    }

    if (installation.getState().setupState === "SETUP_REQUIRED") {
      await ctx.reply("Support has not been configured yet.");
      return;
    }
    persistUserFromContext(db, ctx);
    if (await replyIfBanned(db, ctx)) {
      return;
    }

    const ticket = db.getLatestTicketForUser(ctx.from.id, requireStaffChatId());
    if (!ticket) {
      await ctx.reply("You do not have any tickets yet. Send a message here to create one.");
      return;
    }

    await ctx.reply(`Your latest ticket is #${ticket.id}.\nStatus: ${formatStatus(ticket.status)}`);
  });

  bot.command("mytickets", async (ctx) => {
    if (!isPrivateChat(ctx) || !ctx.from) {
      return;
    }

    if (installation.getState().setupState === "SETUP_REQUIRED") {
      await ctx.reply("Support has not been configured yet.");
      return;
    }
    persistUserFromContext(db, ctx);
    if (await replyIfBanned(db, ctx)) {
      return;
    }

    await ctx.reply(formatUserTicketList(db.listTicketsForUser(ctx.from.id, requireStaffChatId())));
  });

  bot.command("ticket", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!(await requirePermission(ctx, "VIEW_TICKETS"))) return;

    const ticketId = parseTicketId(ctx);
    if (!ticketId) {
      await ctx.reply("Usage: /ticket ID");
      return;
    }

    const ticket = db.getTicketWithUser(ticketId);
    if (!ticket || ticket.staff_chat_id !== requireStaffChatId()) {
      await ctx.reply(`Ticket #${ticketId} was not found in this staff chat.`);
      return;
    }

    await ctx.reply(formatTicketDetails(ticket, db.listMessages(ticketId, 8)), {
      reply_markup: ticket.status === "CLOSED" ? undefined : staffTicketKeyboard(ticket.id, ticket.status),
    });
  });

  bot.command("close", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!(await requirePermission(ctx, "CLOSE_TICKETS"))) return;

    const ticketId = parseTicketId(ctx);
    if (!ticketId) {
      await ctx.reply("Usage: /close ID");
      return;
    }

    const result = await ticketRouting.closeTicket(ticketId, {
      notifyUser: true,
      staffNotice: "Ticket closed by staff.",
      closedBy: staffActor(ctx.from),
    });
    await notifyStaff(ctx.api, requireStaffChatId(), result);
  });

  bot.command("ban", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!(await requirePermission(ctx, "BAN_USERS"))) return;
    const command = parseBanCommand(ctx);
    if (!command) {
      await ctx.reply("Usage: /ban USER_ID reason");
      return;
    }

    await ticketRouting.banUserById(command.userId, command.reason, staffActor(ctx.from));
    await notifyStaff(ctx.api, requireStaffChatId(), `User ${command.userId} has been banned.`);
  });

  bot.command("unban", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!(await requirePermission(ctx, "BAN_USERS"))) return;
    const userId = parseUserId(ctx.match.trim());
    if (!userId) {
      await ctx.reply("Usage: /unban USER_ID");
      return;
    }

    const ban = db.getBannedUser(userId);
    const removed = db.unbanUser(userId);
    if (removed) {
      const user = db.getUser(userId);
      await logBanEvent(ctx.api, db, requireStaffChatId(), {
        action: "UNBANNED",
        userTelegramId: userId,
        username: ban?.username ?? user?.username ?? null,
        performedBy: staffActor(ctx.from),
      });
    }

    await ctx.reply(removed ? `User ${userId} has been unbanned.` : `User ${userId} is not banned.`);
  });

  bot.command("bans", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!(await requirePermission(ctx, "BAN_USERS"))) return;
    const bans = db.listBannedUsers();
    if (!bans.length) {
      await ctx.reply("There are no banned users.");
      return;
    }

    await ctx.reply(
      [
        "Banned users:",
        ...bans.map((ban) => {
          const username = ban.username ? `@${ban.username}` : "no username";
          return `${ban.user_telegram_id} (${username}) - ${ban.reason}`;
        }),
      ].join("\n")
    );
  });

  bot.command("whois", async (ctx) => {
    if (!isStaffChat(ctx)) {
      if (isPrivateChat(ctx)) {
        await ctx.reply(STAFF_ONLY_TEXT);
      }
      return;
    }

    if (!(await requirePermission(ctx, "VIEW_TICKETS"))) return;

    const messageThreadId = ctx.message?.message_thread_id;
    if (typeof messageThreadId !== "number") {
      await ctx.reply("Use /whois inside a ticket topic.");
      return;
    }

    const ticket = db.findTicketByStaffThread(requireStaffChatId(), messageThreadId);
    if (!ticket) {
      await ctx.reply("This topic is not linked to a ticket.");
      return;
    }

    await ctx.reply(formatWhois(ticket, db.getBannedUser(ticket.user_telegram_id)), {
      message_thread_id: messageThreadId,
    });
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [namespace] = data.split(":");

    if (privateControlPlane.isObsoleteOperatorCallback(ctx, namespace ?? "")) {
      await ctx.answerCallbackQuery({ text: "This screen is no longer active. Use /start.", show_alert: true });
      return;
    }

    if (
      isPrivateChat(ctx) &&
      ctx.from &&
      installation.getMember(ctx.from.id) &&
      privateControlPlane.hasOperatorNamespace(namespace ?? "") &&
      data !== "dashboard:test-ticket"
    ) {
      clearStaffTestTicketMode(ctx.from.id);
    }
    if (isPrivateChat(ctx) && ctx.from && namespace !== "support") {
      privateControlPlane.clearSupportSettingsInput(ctx.from.id);
    }
    if (isPrivateChat(ctx) && ctx.from && namespace !== "delivery") {
      privateControlPlane.clearDeliveryReconciliationInput(ctx.from.id);
    }

    if (await privateControlPlane.handleCallback(ctx, data)) return;

    if (namespace === "owner" && data === "owner:confirm-transfer") {
      if (!isPrivateChat(ctx) || !ctx.from || !db.hasPendingOwnerTransfer(ctx.from.id)) {
        await ctx.answerCallbackQuery({ text: "No pending owner transfer.", show_alert: true });
        return;
      }
      if (!(await hasRequiredPrivateWorkspaceMembership(ctx))) {
        await ctx.answerCallbackQuery({ text: "Staff workspace membership required.", show_alert: true });
        return;
      }
      installation.confirmOwnerTransfer(ctx.from.id);
      await ctx.answerCallbackQuery({ text: "Ownership transferred." });
      await showOnboarding(ctx, "WELCOME");
      return;
    }

    if (namespace === "setup") {
      if (!isPrivateChat(ctx) || !ctx.from || !installation.can(ctx.from.id, "CONFIGURE_INSTALLATION")) {
        await ctx.answerCallbackQuery({ text: "Owner or administrator access required.", show_alert: true });
        return;
      }
      if (!(await hasRequiredPrivateWorkspaceMembership(ctx))) {
        await ctx.answerCallbackQuery({ text: "Staff workspace membership required.", show_alert: true });
        return;
      }
      const [, action, value] = data.split(":");
      await ctx.answerCallbackQuery();
      if (installation.getState().setupState === "READY") {
        installation.saveOnboardingStage(ctx.from.id, "ACTIVATE_SUPPORT", "COMPLETED");
        await showDashboard(ctx);
        return;
      }
      if (action === "workspace") {
        await sendWorkspacePicker(ctx);
        return;
      }
      if (action === "use-existing") {
        const workspace = installation.getActiveWorkspace();
        if (!workspace) {
          await renderPrivateScreen(
            ctx,
            "No existing staff workspace is available.",
            new InlineKeyboard().text("Back", "setup:stage:STAFF_WORKSPACE")
          );
          return;
        }
        const result = await validateStaffWorkspace(ctx.api, workspace.telegram_chat_id, ctx.from.id);
        await completeWorkspaceSelection(ctx, result, "SETUP");
        return;
      }
      if (action === "exit") {
        const stage = installation.getOnboardingSession(ctx.from.id)?.stage as
          (typeof onboardingStages)[number] | undefined;
        installation.saveOnboardingStage(ctx.from.id, stage ?? "WELCOME", "EXITED");
        await renderPrivateScreen(
          ctx,
          "Setup paused. Resume when you are ready.",
          new InlineKeyboard().text("Resume setup", "setup:resume")
        );
        return;
      }
      if (action === "resume") {
        const stage = installation.getOnboardingSession(ctx.from.id)?.stage as
          (typeof onboardingStages)[number] | undefined;
        await showOnboarding(ctx, stage ?? "WELCOME");
        return;
      }
      if (action === "stage" && onboardingStages.includes(value as (typeof onboardingStages)[number])) {
        await showOnboarding(ctx, value as (typeof onboardingStages)[number]);
        return;
      }
      if (action === "activate") {
        try {
          const chatId = installation.getStaffChatId();
          if (chatId === null) throw new Error("A validated staff workspace is required before activation.");
          await initializeSupportLogsTopic(ctx.api, db, chatId);
          installation.markReady();
          installation.saveOnboardingStage(ctx.from.id, "ACTIVATE_SUPPORT", "COMPLETED");
          await showDashboard(ctx);
        } catch (error) {
          await renderPrivateScreen(
            ctx,
            error instanceof Error ? error.message : "Support could not be activated.",
            new InlineKeyboard().text("Retry activation", "setup:activate").row().text("Back", "setup:stage:SUMMARY")
          );
        }
        return;
      }
      return;
    }

    if (namespace === "workspace") {
      if (!isPrivateChat(ctx) || !ctx.from || !installation.can(ctx.from.id, "CONFIGURE_INSTALLATION")) {
        await ctx.answerCallbackQuery({ text: "Owner or administrator access required.", show_alert: true });
        return;
      }
      if (!(await hasRequiredPrivateWorkspaceMembership(ctx))) {
        await ctx.answerCallbackQuery({ text: "Staff workspace membership required.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery();
      if (data === "workspace:select") await sendWorkspacePicker(ctx, "RECONFIGURE");
      else await showStaffWorkspaceSettings(ctx);
      return;
    }

    if (namespace === "batch-ui") {
      await ticketBatchSurface.handlePrivateWorkflowCallback(ctx, data, namespace);
      return;
    }
    if (namespace === "user") {
      await handleUserCallback(db, ctx, installation, ticketRouting, data, async (ticketId) => {
        if (!ctx.from || staffTestTicketId(ctx.from.id) !== ticketId) return;
        setStaffTestTicketId(ctx.from.id, undefined);
        await showDashboardAfterStaffTestTicketClose(ctx);
      });
      return;
    }

    if (namespace === "ticket") {
      await handleStaffCallback(db, ctx, installation, ticketRouting, data);
      return;
    }

    if (namespace === "qr") {
      await quickRepliesSurface.handleCallback(ctx, data);
      return;
    }

    if (namespace === "batch") {
      if (isPrivateChat(ctx)) {
        if (!(await requirePrivatePermission(ctx, "BATCH_OPERATIONS"))) {
          await ctx.answerCallbackQuery({ text: "Batch operations require OWNER or ADMIN.", show_alert: true });
          return;
        }
      } else if (!isStaffChat(ctx)) {
        await ctx.answerCallbackQuery({
          text: "Batch operations are available in the private staff dashboard.",
          show_alert: true,
        });
        return;
      } else if (installation.getState().authorizationMode === "RBAC_ACTIVE") {
        await ctx.answerCallbackQuery({
          text: "Batch operations are available to OWNER and ADMIN in the bot's private chat.",
          show_alert: true,
        });
        return;
      } else if (!ctx.from || !hasApplicationPermission(ctx, "BATCH_OPERATIONS")) {
        await ctx.answerCallbackQuery({ text: "Batch operations require OWNER or ADMIN.", show_alert: true });
        return;
      }
      await ticketBatchSurface.handleTicketBatchCallback(ctx, data);
      return;
    }

    await ctx.answerCallbackQuery({ text: "Unknown action." });
  });

  bot.on("message:chat_shared", async (ctx) => {
    if (!ctx.from || !isPrivateChat(ctx) || !installation.can(ctx.from.id, "CONFIGURE_INSTALLATION")) return;
    if (!(await hasRequiredPrivateWorkspaceMembership(ctx))) {
      await ctx.reply("Staff workspace membership required for role-based access.");
      return;
    }
    const shared = ctx.message.chat_shared;
    if (shared.request_id === 1400) {
      try {
        await privateControlPlane.inspectAndSavePublicChat(ctx, shared.chat_id, {
          title: shared.title,
          username: shared.username,
        });
      } catch (error) {
        logger.warn({ chatId: shared.chat_id, err: error }, "Could not add selected public chat");
        await clearPublicChatPicker(ctx);
        await privateControlPlane.showPublicChats(
          ctx,
          "The selected public chat could not be inspected. Add the bot as an administrator, then retry."
        );
      }
      return;
    }
    if (shared.request_id !== 1300) return;
    try {
      const result = await validateStaffWorkspace(ctx.api, shared.chat_id, ctx.from.id);
      const mode = privateControlPlane.getPendingWorkspaceSelection(ctx.from.id) ?? "SETUP";
      await completeWorkspaceSelection(ctx, result, mode, { title: shared.title, username: shared.username });
    } catch {
      const mode = privateControlPlane.getPendingWorkspaceSelection(ctx.from.id) ?? "SETUP";
      if (mode === "RECONFIGURE")
        await showStaffWorkspaceSettings(
          ctx,
          "The selected group could not be inspected. Add the bot as administrator, enable Topics, then retry.",
          true
        );
      else
        await renderPrivateScreen(
          ctx,
          "The selected group could not be inspected. Add the bot as administrator, enable Topics, then retry.",
          new InlineKeyboard().text("Retry", "setup:workspace").row().text("Back", "setup:stage:STAFF_WORKSPACE")
        );
    }
  });

  bot.on("chat_member", async (ctx) => {
    if (!isConfiguredStaffWorkspace(ctx)) return;
    const member = ctx.chatMember.new_chat_member;
    if (member.status === "left" || member.status === "kicked") return;
    enrollBaselineStaffMember(member.user);
  });

  moderationSurface.registerManualReaction();

  bot.on("message", async (ctx) => {
    if (isConfiguredStaffWorkspace(ctx)) {
      const senderChatMessage = "sender_chat" in ctx.message && Boolean(ctx.message.sender_chat);
      if (!senderChatMessage) enrollBaselineStaffMember(ctx.from);
      if (!isStaffChat(ctx)) return;
      if (ticketBatchSurface.isTicketAnswerPackageDocument(ctx.message)) {
        if (typeof ctx.message.message_thread_id === "number") {
          await ctx.reply("Upload ticket answer packages outside ticket topics.");
          return;
        }
        if (installation.getState().authorizationMode === "RBAC_ACTIVE") {
          await ctx.reply("Batch operations are available to OWNER and ADMIN in the bot's private chat.");
          return;
        }
        if (!(await requirePermission(ctx, "BATCH_OPERATIONS"))) return;
        await ticketBatchSurface.handleTicketAnswerPackageUpload(ctx);
        return;
      }
      await ticketRouting.handleStaffGroupMessage(ctx, () => hasApplicationPermission(ctx, "REPLY_TO_TICKETS"));
      return;
    }

    if (!isPrivateChat(ctx)) {
      await moderationSurface.handlePublicMessage(ctx);
      return;
    }

    if (ctx.from && !installation.getMember(ctx.from.id)) await enrollPrivateWorkspaceMember(ctx);

    if (
      ctx.from &&
      installation.getMember(ctx.from.id) &&
      ticketBatchSurface.getPendingPrivateBatchExport(ctx.from.id) &&
      ticketBatchSurface.isTicketAnswerPackageDocument(ctx.message)
    ) {
      if (!(await requirePrivatePermission(ctx, "BATCH_OPERATIONS"))) return;
      const exportId = ticketBatchSurface.getPendingPrivateBatchExport(ctx.from.id)!;
      const filename = ctx.message.document?.file_name ?? "";
      if (filename.toLowerCase() !== `ticket-answers_${exportId}.json`.toLowerCase()) {
        await ticketBatchSurface.showPrivateBatchWaiting(
          ctx,
          exportId,
          true,
          "This answer package belongs to a different export."
        );
        return;
      }
      await ticketBatchSurface.handleTicketAnswerPackageUpload(ctx, exportId);
      return;
    }

    if (
      ctx.from &&
      installation.getMember(ctx.from.id) &&
      db.getSetting(`staff_test_ticket_mode:${ctx.from.id}`) !== "true"
    ) {
      const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
      if (text && (await privateControlPlane.handlePrivateInput(ctx, text))) return;
      const session = installation.getOnboardingSession(ctx.from.id);
      const workspaceMode =
        privateControlPlane.getPendingWorkspaceSelection(ctx.from.id) ??
        (session?.state === "ACTIVE" && session.stage === "STAFF_WORKSPACE" ? "SETUP" : undefined);
      if (workspaceMode && text) {
        if (workspaceMode === "RECONFIGURE" && text === "Cancel workspace selection") {
          privateControlPlane.clearPendingWorkspaceSelection(ctx.from.id);
          await privateControlPlane.retireWorkspacePickerPrompt(ctx.from.id, ctx.api);
          await ctx.reply("Workspace selection cancelled.", { reply_markup: { remove_keyboard: true } });
          await showStaffWorkspaceSettings(ctx, undefined, true);
          return;
        }
        if (isPrivateInviteLink(text)) {
          const retry = workspaceMode === "RECONFIGURE" ? "workspace:select" : "setup:workspace";
          await renderPrivateScreen(
            ctx,
            "The bot cannot inspect an inaccessible private invite link. Add the bot to that group, then use the Telegram group picker.",
            new InlineKeyboard().text("Choose group", retry)
          );
          return;
        }
        const reference = parsePublicSupergroupReference(text);
        if (reference) {
          try {
            const chat = await ctx.api.getChat(reference);
            const result = await validateStaffWorkspace(ctx.api, chat.id, ctx.from.id);
            await completeWorkspaceSelection(ctx, result, workspaceMode);
          } catch {
            if (workspaceMode === "RECONFIGURE")
              await showStaffWorkspaceSettings(
                ctx,
                "That public supergroup could not be validated. Check the username and bot permissions.",
                true
              );
            else
              await renderPrivateScreen(
                ctx,
                "That public supergroup could not be validated. Check the username and bot permissions.",
                new InlineKeyboard().text("Retry", "setup:workspace").row().text("Back", "setup:stage:STAFF_WORKSPACE")
              );
          }
          return;
        }
      }
      await showDashboard(ctx);
      return;
    }
    const staffTestTicketMode = Boolean(
      ctx.from &&
      installation.getMember(ctx.from.id) &&
      db.getSetting(`${STAFF_TEST_TICKET_MODE_SETTING_PREFIX}${ctx.from.id}`) === "true"
    );
    clearStaffTestTicketMode(ctx.from?.id);
    if (!staffTestTicketMode && ctx.from) {
      const ingressDecision = supportIngressLimiter.check(ctx.from.id);
      if (!ingressDecision.allowed) {
        await warnThrottledCustomerIngress(ctx, ingressDecision);
        return;
      }
    }
    if (installation.getState().setupState === "SETUP_REQUIRED") {
      await ctx.reply("Support has not been configured yet. Please try again later.");
      return;
    }
    if (await replyIfBanned(db, ctx)) {
      return;
    }

    if (ctx.message && "text" in ctx.message && isCommandText(ctx.message.text)) {
      await ctx.reply(START_TEXT);
      return;
    }

    if (staffTestTicketMode) await retireTrackedPrivateScreens(ctx);
    await ticketRouting.handlePrivateUserMessage(ctx);
    if (staffTestTicketMode && ctx.from) {
      const activeTicket = db.findActiveTicketForUser(ctx.from.id, requireStaffChatId());
      if (activeTicket) {
        setStaffTestTicketId(ctx.from.id, activeTicket.id);
      } else {
        await showDashboardAfterStaffTestTicketClose(ctx);
      }
    }
  });

  bot.catch(async (error) => {
    const ctx = error.ctx;
    logger.error({ err: error.error, updateId: ctx.update.update_id }, "Bot failed while processing an update");

    const staffChatId = installation.getStaffChatId();
    if (staffChatId !== null && ctx.chat?.id === staffChatId) {
      await notifyStaff(
        ctx.api,
        staffChatId,
        `Bot error while processing update ${ctx.update.update_id}: ${describeError(error.error)}`,
        ctx.msg?.message_thread_id
      );
    }
  });

  const supportBot = bot as SupportBot;
  supportBot.recoverPendingTicketBatchStaffOperations = () => ticketBatchRuntime.recoverPendingStaffOperations();
  supportBot.stopBackgroundWork = () => {
    ticketBatchRuntime.stop();
    pendingWarnings.stop();
  };
  return supportBot;
}

function updateErrorCategory(error: unknown): UpdateErrorCategory {
  if (error instanceof GrammyError) return "telegram";
  if (error instanceof HttpError) return "http";
  return "unknown";
}

export async function setBotCommands(bot: Bot<Context>, installation: InstallationService): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Start support" },
    { command: "status", description: "Show your latest ticket status" },
    { command: "mytickets", description: "Show your recent tickets" },
    { command: "help", description: "Show help" },
  ]);

  const staffChatId = installation.getStaffChatId();
  if (staffChatId === null) return;
  await bot.api.setMyCommands(
    [
      { command: "help", description: "Show staff help" },
      { command: "chatid", description: "Show this chat id" },
      { command: "ticket", description: "Show ticket details" },
      { command: "close", description: "Close a ticket" },
      { command: "ban", description: "Ban a user from support" },
      { command: "unban", description: "Unban a user" },
      { command: "bans", description: "List banned users" },
      { command: "whois", description: "Show ticket user details" },
      { command: "exporttickets", description: "Export active tickets" },
      { command: "moderation", description: "Manage public chat moderation" },
      { command: "questnotify", description: "Manage new-entity notifications" },
      { command: "logs", description: "Show Support Logs topic status" },
      { command: "setlogs", description: "Use this topic as Support Logs" },
    ],
    { scope: { type: "chat", chat_id: staffChatId } }
  );
}

export async function sendStaffOnboardingIfNeeded(
  api: BotApi,
  db: SupportDatabase,
  installation: InstallationService
): Promise<void> {
  const staffChatId = installation.getStaffChatId();
  if (staffChatId === null) return;
  const settingKey = staffHelpSentSettingKey(staffChatId);
  if (db.getSetting(settingKey) === "true") {
    return;
  }

  try {
    await api.sendMessage(staffChatId, STAFF_ONBOARDING_TEXT);
    db.setSetting(settingKey, "true");
  } catch (error) {
    logger.warn({ err: error, staffChatId }, "Could not send staff onboarding message");
  }
}

async function handleUserCallback(
  db: SupportDatabase,
  ctx: Context,
  installation: InstallationService,
  ticketRouting: TicketRoutingService,
  data: string,
  onStaffTestTicketClosed?: (ticketId: number) => Promise<void>
): Promise<void> {
  if (!isPrivateChat(ctx) || !ctx.from) {
    await ctx.answerCallbackQuery({
      text: "This action is only available in private chat.",
      show_alert: true,
    });
    return;
  }

  const [, action, rawTicketId] = data.split(":");
  if (action !== "close") {
    await ctx.answerCallbackQuery({ text: "Unknown action." });
    return;
  }

  const ticketId = Number(rawTicketId);
  if (!Number.isInteger(ticketId)) {
    await ctx.answerCallbackQuery({ text: "Invalid ticket." });
    return;
  }

  const ticket = db.getTicketWithUser(ticketId);
  if (
    !ticket ||
    ticket.user_telegram_id !== ctx.from.id ||
    ticket.staff_chat_id !== installation.requireStaffChatId()
  ) {
    await ctx.answerCallbackQuery({ text: "Ticket not found.", show_alert: true });
    return;
  }

  if (ticket.status === "CLOSED") {
    await ctx.answerCallbackQuery({ text: "Ticket is already closed." });
    return;
  }

  await ticketRouting.closeTicket(ticket.id, {
    notifyUser: false,
    staffNotice: "User closed this ticket.",
    closedBy: userActor(ctx.from),
  });
  await ctx.answerCallbackQuery({ text: "Ticket closed." });
  await ctx.reply(CLOSED_TEXT);
  await onStaffTestTicketClosed?.(ticket.id);
}

async function warnThrottledCustomerIngress(
  ctx: Context,
  decision: Extract<SupportIngressDecision, { allowed: false }>
): Promise<void> {
  if (!decision.shouldWarn || !ctx.from) return;

  logger.warn(
    {
      userId: ctx.from.id,
      category: "CUSTOMER_INGRESS_THROTTLED",
      retryAfterSeconds: Math.ceil(decision.retryAfterMs / 1_000),
    },
    "Customer support ingress throttled"
  );
  try {
    await ctx.reply(SUPPORT_INGRESS_THROTTLED_TEXT);
  } catch (error) {
    logger.warn(
      { err: error, userId: ctx.from.id, category: "CUSTOMER_INGRESS_THROTTLED_WARNING" },
      "Could not send customer ingress throttle warning"
    );
  }
}

async function handleStaffCallback(
  db: SupportDatabase,
  ctx: Context,
  installation: InstallationService,
  ticketRouting: TicketRoutingService,
  data: string
): Promise<void> {
  if (!isStaffChat(ctx, installation)) {
    await ctx.answerCallbackQuery({ text: "Staff only.", show_alert: true });
    return;
  }

  const [, action, rawTicketId, rawStatus, rawExpectedStatus] = data.split(":");
  const ticketId = Number(rawTicketId);
  if (!Number.isInteger(ticketId)) {
    await ctx.answerCallbackQuery({ text: "Invalid ticket." });
    return;
  }

  const ticket = db.getTicketWithUser(ticketId);
  if (!ticket || ticket.staff_chat_id !== installation.requireStaffChatId()) {
    await ctx.answerCallbackQuery({ text: "Ticket not found in this staff chat." });
    return;
  }

  if (action === "close") {
    if (!hasApplicationPermission(ctx, installation, "CLOSE_TICKETS")) {
      await ctx.answerCallbackQuery({ text: "Your application role cannot close tickets.", show_alert: true });
      return;
    }
    const result = await ticketRouting.closeTicket(ticket.id, {
      notifyUser: true,
      staffNotice: "Ticket closed by staff.",
      closedBy: staffActor(ctx.from),
    });
    await ctx.answerCallbackQuery({ text: result });
    return;
  }

  if (action === "status" && isTicketStatus(rawStatus) && isTicketStatus(rawExpectedStatus)) {
    if (!hasApplicationPermission(ctx, installation, "CLOSE_TICKETS")) {
      await ctx.answerCallbackQuery({ text: "Your application role cannot update tickets.", show_alert: true });
      return;
    }
    const transition = db.transitionTicketStatusIfCurrent(
      ticket.id,
      installation.requireStaffChatId(),
      rawExpectedStatus,
      rawStatus
    );
    if (transition.outcome === "NOT_FOUND") {
      await ctx.answerCallbackQuery({ text: "Ticket not found in this staff chat.", show_alert: true });
      return;
    }
    if (transition.outcome === "CONFLICT") {
      await ctx.answerCallbackQuery({
        text: "Ticket changed. Refresh it before applying another status.",
        show_alert: true,
      });
      return;
    }
    if (transition.outcome === "APPLIED") {
      await ticketRouting.refreshTicket(ticket.id, installation.requireStaffChatId());
      await ticketRouting.sendStaffTopicNotice(
        ctx.api,
        installation.requireStaffChatId(),
        transition.ticket ?? ticket,
        `Ticket marked ${formatStatus(rawStatus)}.`
      );
    }
    await ctx.answerCallbackQuery({
      text:
        transition.outcome === "IDEMPOTENT"
          ? `Already ${formatStatus(rawStatus)}.`
          : `Marked ${formatStatus(rawStatus)}.`,
    });
    return;
  }

  if (action === "status" && isTicketStatus(rawStatus)) {
    await ctx.answerCallbackQuery({
      text: "Ticket action is stale. Refresh it before applying another status.",
      show_alert: true,
    });
    return;
  }

  if (action === "ban") {
    if (!ctx.from || !hasApplicationPermission(ctx, installation, "BAN_USERS")) {
      await ctx.answerCallbackQuery({ text: "Your role cannot ban users.", show_alert: true });
      return;
    }
    await ticketRouting.banUserForTicket(ticket, staffActor(ctx.from), `Banned from ticket #${ticket.id}`);
    await ctx.answerCallbackQuery({ text: `User ${ticket.user_telegram_id} banned.` });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action." });
}

async function notifyStaff(
  api: BotApi,
  staffChatId: number,
  text: string,
  messageThreadId?: number | null
): Promise<void> {
  try {
    await api.sendMessage(staffChatId, truncate(text, 3500), {
      message_thread_id: messageThreadId ?? undefined,
    });
  } catch (error) {
    logger.error({ err: error }, "Could not send log message to staff chat");
  }
}
function staffTicketKeyboard(ticketId: number, expectedStatus: TicketStatus = "OPEN"): InlineKeyboard {
  return new InlineKeyboard()
    .text("Close ticket", `ticket:close:${ticketId}`)
    .row()
    .text("Mark waiting user", `ticket:status:${ticketId}:WAITING_USER:${expectedStatus}`)
    .row()
    .text("Mark in progress", `ticket:status:${ticketId}:IN_PROGRESS:${expectedStatus}`)
    .row()
    .text("Ban user", `ticket:ban:${ticketId}`)
    .row()
    .text("Quick replies", quickRepliesOpenCallbackData(ticketId));
}

function userTicketKeyboard(ticketId: number): InlineKeyboard {
  return new InlineKeyboard().text("Close ticket", `user:close:${ticketId}`);
}

function formatSupportLogsTopicInfo(topic: SupportLogsTopicInfo, staffChatId: number): string {
  const lines = [
    "Support Logs topic",
    "",
    "Staff chat ID:",
    String(staffChatId),
    "",
    "Thread ID:",
    String(topic.threadId),
    "",
    "Status:",
    topic.state,
  ];

  if (topic.previousThreadId !== null) {
    lines.push("", "Previous thread ID:", String(topic.previousThreadId));
  }

  return lines.join("\n");
}

function staffHelpSentSettingKey(staffChatId: number): string {
  return `${STAFF_HELP_SENT_SETTING_PREFIX}:${staffChatId}`;
}

function staffActor(user: Context["from"]): ArchiveActor {
  if (!user) {
    return systemActor();
  }

  return {
    type: "STAFF",
    displayName: displayTelegramUser(user),
    username: usernameOf(user),
    telegramId: user.id,
  };
}

function userActor(user: NonNullable<Context["from"]>): ArchiveActor {
  return {
    type: "USER",
    displayName: "user",
    username: usernameOf(user),
    telegramId: user.id,
  };
}

function systemActor(): ArchiveActor {
  return {
    type: "SYSTEM",
    displayName: "system",
    username: null,
    telegramId: null,
  };
}

function persistUserFromContext(db: SupportDatabase, ctx: Context): void {
  if (!ctx.from) {
    return;
  }

  db.upsertUser({
    telegramId: ctx.from.id,
    username: ctx.from.username ?? null,
    firstName: ctx.from.first_name ?? null,
    lastName: ctx.from.last_name ?? null,
  });
}

async function replyIfBanned(db: SupportDatabase, ctx: Context): Promise<boolean> {
  if (!ctx.from || !isPrivateChat(ctx)) {
    return false;
  }

  const ban = db.getBannedUser(ctx.from.id);
  if (!ban) {
    return false;
  }

  await ctx.reply(BANNED_TEXT);
  return true;
}

function entityNotificationSettingKey(name: string): string {
  return `${ENTITY_NOTIFICATION_SETTING_PREFIX}:${name}`;
}

function parseStoredEntityNotificationTarget(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

async function formatEntityNotificationStatus(
  api: BotApi,
  db: SupportDatabase,
  providers: EntityNotificationProviderRegistry
): Promise<string> {
  const targetChatId = parseStoredEntityNotificationTarget(
    db.getSetting(entityNotificationSettingKey("target_chat_id"))
  );
  let target = "not configured";
  let targetReachable = false;
  if (targetChatId !== null) {
    try {
      const chat = await api.getChat(targetChatId);
      targetReachable = true;
      const title =
        typeof chat === "object" && chat !== null && "title" in chat && typeof chat.title === "string"
          ? ` (${chat.title})`
          : "";
      target = `${targetChatId}${title}`;
    } catch {
      target = `${targetChatId} (unreachable)`;
    }
  }
  const providerKey = db.getSetting(entityNotificationSettingKey("provider"));
  const provider = providerKey ? providers.get(providerKey) : undefined;
  const providerRegistered = Boolean(provider);
  const providerAuthoritative = provider?.authoritative ?? false;
  const providerAvailable = provider ? isEntityNotificationProviderAvailable(provider) : false;
  const canPublish =
    db.getSetting(entityNotificationSettingKey("enabled")) === "true" &&
    targetChatId !== null &&
    targetReachable &&
    providerRegistered &&
    providerAuthoritative &&
    providerAvailable;
  return [
    `Entity notifications: ${db.getSetting(entityNotificationSettingKey("enabled")) === "true" ? "enabled" : "disabled"}`,
    `Target: ${target}`,
    `Provider: ${providerKey ?? "not configured"}`,
    `Provider registered: ${providerRegistered ? "yes" : "no"}`,
    `Authoritative: ${providerAuthoritative ? "yes" : "no"}`,
    `Available: ${providerAvailable ? "yes" : "no"}`,
    `Publication can run: ${canPublish ? "yes" : "no"}`,
    `Published events: ${db.countEntityNotificationPublications("PUBLISHED")}`,
  ].join("\n");
}

function isEntityNotificationProviderAvailable(provider: { isAvailable(): boolean }): boolean {
  try {
    return provider.isAvailable();
  } catch {
    return false;
  }
}

function entityNotificationProviderStatus(provider: { status?(): string }): string {
  try {
    return provider.status?.() || "That entity notification provider is unavailable.";
  } catch {
    return "That entity notification provider is unavailable.";
  }
}

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

function isStaffChat(ctx: Context, installation: InstallationService): boolean {
  if (!isConfiguredStaffWorkspace(ctx, installation)) return false;
  const staffChatId = installation.getStaffChatId();
  if (staffChatId === null) return false;
  if (!ctx.from || ctx.from.is_bot) return false;
  return installation.isStaffAuthorized(ctx.from.id, staffChatId);
}

function isConfiguredStaffWorkspace(ctx: Context, installation: InstallationService): boolean {
  const staffChatId = installation.getStaffChatId();
  return staffChatId !== null && ctx.chat?.id === staffChatId;
}

function hasApplicationPermission(ctx: Context, installation: InstallationService, permission: Permission): boolean {
  if (!ctx.from || ctx.from.is_bot) return false;
  return (
    installation.getState().authorizationMode === "LEGACY_TRUSTED_GROUP" || installation.can(ctx.from.id, permission)
  );
}

function isTicketStatus(value: string | undefined): value is TicketStatus {
  return value === "OPEN" || value === "WAITING_USER" || value === "IN_PROGRESS" || value === "CLOSED";
}

function parseTicketId(ctx: CommandContext<Context>): number | null {
  return parseUserId(ctx.match.trim());
}

function parseUserId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseBanCommand(ctx: CommandContext<Context>): BanCommand | null {
  const raw = ctx.match.trim();
  if (!raw) {
    return null;
  }

  const [rawUserId, ...reasonParts] = raw.split(/\s+/);
  const userId = parseUserId(rawUserId ?? "");
  if (!userId) {
    return null;
  }

  return {
    userId,
    reason: reasonParts.join(" ").trim() || DEFAULT_BAN_REASON,
  };
}

function describeError(error: unknown): string {
  if (error instanceof GrammyError) {
    return `${error.error_code}: ${error.description}`;
  }

  if (error instanceof HttpError) {
    return `HTTP error: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
