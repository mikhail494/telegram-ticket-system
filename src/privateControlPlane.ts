import { GrammyError, InlineKeyboard, Keyboard } from "grammy";
import type { Context } from "grammy";
import type { ManagedPublicChatRecord, SupportDatabase, TeamMemberRecord } from "./db.js";
import {
  DEFAULT_SUPPORT_EXPECTED_RESPONSE_TIME,
  DEFAULT_SUPPORT_TICKET_RECEIVED_TEMPLATE,
  formatTicketReceived,
  SUPPORT_RESPONSE_TIME_PLACEHOLDER,
  truncate,
  validateRenderedSupportAcknowledgement
} from "./format.js";
import { InstallationService } from "./installation.js";
import type { Permission } from "./installation.js";
import { logger } from "./logger.js";
import type { QuickRepliesManager } from "./quickReplies.js";
import {
  isPrivateInviteLink,
  parsePublicSupergroupReference
} from "./workspaceValidation.js";
import {
  formatPublicChatPermissionChecklist,
  validatePublicModerationChat
} from "./publicChatModeration.js";

export type PendingQuickReplyInput =
  | { kind: "EDIT_TITLE"; templateId: string }
  | { kind: "EDIT_TEXT"; templateId: string }
  | { kind: "ADD_TITLE"; categoryId: string }
  | { kind: "ADD_TEXT"; categoryId: string; title: string }
  | { kind: "ADD_PREVIEW"; categoryId: string; title: string; text: string };

export type PendingSupportSettingsInput = "RESPONSE_TIME" | "ACKNOWLEDGEMENT";

export type PublicChatConfigurationField = "warning" | "allowlist" | "cooldown" | "threshold" | "lookback";

type PrivateUiTarget = { chatId: number; messageId: number };

export interface PrivateControlPlaneOperatorDependencies {
  db: SupportDatabase;
  quickReplies: QuickRepliesManager;
  canConfigure: (ctx: Context) => Promise<boolean>;
  canUsePermission: (ctx: Context, permission: Permission) => Promise<boolean>;
  hasPrivateWorkspaceMembership: (ctx: Context) => Promise<boolean>;
  getPendingBatchExport: (userId: number) => string | undefined;
  onStartTestTicket: (ctx: Context) => Promise<void>;
  onShowWorkspace: (ctx: Context) => Promise<void>;
  onShowBatch: (ctx: Context) => Promise<void>;
  packageVersion: string;
  botUsername: () => string | undefined;
  botId: () => number | undefined;
}

/**
 * Telegram-facing state and lifecycle for the private operator UI. Domain
 * decisions remain with the installation, moderation, batch, and reply services.
 */
export class PrivateControlPlane {
  private readonly operatorCallbackNamespaces = new Set([
    "owner", "setup", "workspace", "dashboard", "batch-ui", "public", "quick", "support", "team", "rbac"
  ]);
  private readonly activeScreens = new Map<number, PrivateUiTarget>();
  private readonly temporaryScreens = new Map<number, PrivateUiTarget>();
  private readonly workspacePickerPrompts = new Map<number, PrivateUiTarget>();
  private readonly publicChatPickerPrompts = new Map<number, PrivateUiTarget>();
  private readonly pendingPublicChatSelections = new Set<number>();
  private readonly pendingPublicChatConfigurations = new Map<number, { chatId: number; field: PublicChatConfigurationField }>();
  private readonly pendingQuickReplyInputs = new Map<number, PendingQuickReplyInput>();
  private readonly pendingSupportSettingsInputs = new Map<number, PendingSupportSettingsInput>();
  private readonly pendingWorkspaceSelections = new Map<number, "SETUP" | "RECONFIGURE">();
  private operatorDependencies: PrivateControlPlaneOperatorDependencies | undefined;

  constructor(private readonly installation: InstallationService) {}

  configureOperatorUi(dependencies: PrivateControlPlaneOperatorDependencies): void {
    this.operatorDependencies = dependencies;
  }

  isObsoleteOperatorCallback(ctx: Context, namespace: string): boolean {
    if (!isPrivateChat(ctx) || !this.operatorCallbackNamespaces.has(namespace)) return false;
    const message = ctx.callbackQuery?.message;
    if (!ctx.from || message?.chat.type !== "private") return true;
    const current = this.persistedScreen(ctx.from.id);
    return current !== undefined && (current.chatId !== message.chat.id || current.messageId !== message.message_id);
  }

  hasOperatorNamespace(namespace: string): boolean {
    return this.operatorCallbackNamespaces.has(namespace);
  }

  clearSupportSettingsInput(userId: number): void {
    this.pendingSupportSettingsInputs.delete(userId);
  }

  getPendingSupportSettingsInput(userId: number): PendingSupportSettingsInput | undefined {
    return this.pendingSupportSettingsInputs.get(userId);
  }

  setPendingSupportSettingsInput(userId: number, input: PendingSupportSettingsInput): void {
    this.pendingSupportSettingsInputs.set(userId, input);
  }

  getPendingQuickReplyInput(userId: number): PendingQuickReplyInput | undefined {
    return this.pendingQuickReplyInputs.get(userId);
  }

  setPendingQuickReplyInput(userId: number, input: PendingQuickReplyInput): void {
    this.pendingQuickReplyInputs.set(userId, input);
  }

  clearPendingQuickReplyInput(userId: number): void {
    this.pendingQuickReplyInputs.delete(userId);
  }

  async showQuickRepliesManagement(ctx: Context): Promise<void> {
    const quickReplies = this.operatorDependenciesOrThrow().quickReplies;
    const categories = quickReplies.listCategories();
    const keyboard = new InlineKeyboard();
    for (const category of categories) {
      for (const template of category.templates) keyboard.text(template.title, `quick:view:${template.id}`).row();
    }
    keyboard.text("Add reply", "quick:add").row().text("Back", "dashboard:home");
    const count = categories.reduce((total, category) => total + category.templates.length, 0);
    await this.renderScreen(ctx, ["Quick replies", "", `${count} replies configured.`].join("\n"), keyboard);
  }

  async showQuickReplyDetail(ctx: Context, templateId: string, notice?: string): Promise<void> {
    const template = this.operatorDependenciesOrThrow().quickReplies.findTemplate(templateId);
    if (!template) {
      await this.renderScreen(ctx, "This Quick Reply is no longer available.", new InlineKeyboard().text("Back", "quick:list"));
      return;
    }
    await this.renderScreen(ctx, ["Quick reply", "", `Name: ${template.title}`, "", "Text:", template.text, ...(notice ? ["", notice] : [])].join("\n"), new InlineKeyboard()
      .text("Edit name", `quick:edit-name:${template.id}`)
      .text("Edit text", `quick:edit-text:${template.id}`)
      .row()
      .text("Delete", `quick:delete:${template.id}`)
      .row()
      .text("Back", "quick:list"));
  }

  async beginQuickReplyInput(ctx: Context, pending: Exclude<PendingQuickReplyInput, { kind: "ADD_PREVIEW" }>): Promise<void> {
    if (!ctx.from) return;
    this.setPendingQuickReplyInput(ctx.from.id, pending);
    await this.retireScreens(ctx);
    await this.sendFreshScreen(ctx, this.quickReplyInputPrompt(pending), new InlineKeyboard().text("Back", "quick:list"));
  }

  async showQuickReplyCategoryPicker(ctx: Context): Promise<void> {
    const keyboard = new InlineKeyboard();
    for (const category of this.operatorDependenciesOrThrow().quickReplies.listCategories()) keyboard.text(category.title, `quick:add-category:${category.id}`).row();
    keyboard.text("Back", "quick:list");
    await this.renderScreen(ctx, "Add Quick Reply\n\nChoose a category.", keyboard);
  }

  async consumeQuickReplyInput(ctx: Context, text: string): Promise<boolean> {
    if (!ctx.from) return false;
    const pending = this.getPendingQuickReplyInput(ctx.from.id);
    if (!pending) return false;
    const dependencies = this.operatorDependenciesOrThrow();
    if (!await dependencies.canConfigure(ctx)) return true;
    const trimmed = text.trim();
    const invalid = (maximum: number): string | undefined => !trimmed ? "value cannot be empty." : trimmed.length > maximum ? `use at most ${maximum} characters.` : undefined;
    if (pending.kind === "EDIT_TITLE" || pending.kind === "ADD_TITLE") {
      const error = invalid(32);
      if (error) {
        await this.renderScreen(ctx, this.quickReplyInputPrompt(pending, error), new InlineKeyboard().text("Back", "quick:list"));
        return true;
      }
      if (pending.kind === "EDIT_TITLE") {
        const updated = dependencies.quickReplies.updateTemplate(pending.templateId, { title: trimmed });
        this.clearPendingQuickReplyInput(ctx.from.id);
        await this.retireScreens(ctx);
        await this.showQuickReplyDetail(ctx, updated?.id ?? pending.templateId);
      } else {
        const next: PendingQuickReplyInput = { kind: "ADD_TEXT", categoryId: pending.categoryId, title: trimmed };
        this.setPendingQuickReplyInput(ctx.from.id, next);
        await this.renderScreen(ctx, this.quickReplyInputPrompt(next), new InlineKeyboard().text("Back", "quick:list"));
      }
      return true;
    }
    if (pending.kind === "EDIT_TEXT" || pending.kind === "ADD_TEXT") {
      const error = invalid(3500);
      if (error) {
        await this.renderScreen(ctx, this.quickReplyInputPrompt(pending, error), new InlineKeyboard().text("Back", "quick:list"));
        return true;
      }
      if (pending.kind === "EDIT_TEXT") {
        const updated = dependencies.quickReplies.updateTemplate(pending.templateId, { text: trimmed });
        this.clearPendingQuickReplyInput(ctx.from.id);
        await this.retireScreens(ctx);
        await this.showQuickReplyDetail(ctx, updated?.id ?? pending.templateId);
      } else {
        const next: PendingQuickReplyInput = { kind: "ADD_PREVIEW", categoryId: pending.categoryId, title: pending.title, text: trimmed };
        this.setPendingQuickReplyInput(ctx.from.id, next);
        await this.renderScreen(ctx, ["New Quick reply", "", `Name: ${next.title}`, "", "Text:", next.text].join("\n"), new InlineKeyboard()
          .text("Save", "quick:add-save")
          .text("Cancel", "quick:list"));
      }
    }
    return true;
  }

  async showSupportSettings(ctx: Context, notice?: string): Promise<void> {
    await this.renderScreen(ctx, this.supportSettingsText(notice), this.supportSettingsKeyboard());
  }

  async beginSupportResponseTimeInput(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    this.setPendingSupportSettingsInput(ctx.from.id, "RESPONSE_TIME");
    await this.renderScreen(ctx, this.supportResponseTimePrompt(), new InlineKeyboard().text("Back", "support:back"));
  }

  async beginSupportAcknowledgementInput(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    this.setPendingSupportSettingsInput(ctx.from.id, "ACKNOWLEDGEMENT");
    await this.renderScreen(ctx, this.supportAcknowledgementPrompt(), new InlineKeyboard().text("Back", "support:back"));
  }

  async consumeSupportSettingsInput(ctx: Context, text: string): Promise<boolean> {
    if (!ctx.from) return false;
    const pending = this.getPendingSupportSettingsInput(ctx.from.id);
    if (!pending) return false;
    await this.deleteConsumedSupportSettingsInput(ctx);
    const dependencies = this.operatorDependenciesOrThrow();
    if (!await dependencies.canConfigure(ctx)) return true;
    if (pending === "RESPONSE_TIME") {
      const normalized = this.normalizeSupportExpectedResponseTime(text);
      if (!normalized.value) {
        await this.renderScreen(ctx, this.supportResponseTimePrompt(normalized.error), new InlineKeyboard().text("Back", "support:back"));
        return true;
      }
      const rendered = validateRenderedSupportAcknowledgement(this.supportTicketReceivedTemplate(), normalized.value);
      if (rendered.error) {
        await this.renderScreen(ctx, this.supportResponseTimePrompt("that response time makes the current acknowledgement too long. Shorten it or edit the acknowledgement first."), new InlineKeyboard().text("Back", "support:back"));
        return true;
      }
      dependencies.db.setSetting("support_expected_response_time", normalized.value);
      this.clearSupportSettingsInput(ctx.from.id);
      await this.showSupportSettings(ctx, "Expected response time saved.");
      return true;
    }
    const normalized = this.normalizeSupportTicketReceivedTemplate(text);
    if (!normalized.value) {
      await this.renderScreen(ctx, this.supportAcknowledgementPrompt(normalized.error), new InlineKeyboard().text("Back", "support:back"));
      return true;
    }
    dependencies.db.setSetting("support_ticket_received_template", normalized.value);
    this.clearSupportSettingsInput(ctx.from.id);
    await this.showSupportSettings(ctx, "Acknowledgement saved.");
    return true;
  }

  async handlePrivateInput(ctx: Context, text: string): Promise<boolean> {
    if (await this.consumeQuickReplyInput(ctx, text)) return true;
    if (await this.consumeSupportSettingsInput(ctx, text)) return true;
    if (await this.consumePublicChatConfiguration(ctx, text)) return true;
    if (!ctx.from || !this.pendingPublicChatSelections.has(ctx.from.id)) return false;
    if (text === "Cancel public chat selection") {
      await this.clearPublicChatPicker(ctx);
      await this.showPublicChats(ctx, "Public chat selection cancelled.");
      return true;
    }
    if (isPrivateInviteLink(text)) {
      await this.clearPublicChatPicker(ctx);
      await this.showPublicChats(ctx, "The Bot API cannot inspect an inaccessible private invite link. Add the bot to the group, then use the Telegram public-chat picker. You do not need a numeric chat ID.");
      return true;
    }
    const reference = parsePublicSupergroupReference(text);
    if (!reference) return false;
    try {
      const chat = await ctx.api.getChat(reference);
      await this.inspectAndSavePublicChat(ctx, chat.id);
    } catch (error) {
      logger.warn({ err: error }, "Could not resolve public chat reference");
      await this.clearPublicChatPicker(ctx);
      await this.showPublicChats(ctx, "That public supergroup could not be validated. Check its public username and the bot permissions, or use the Telegram picker.");
    }
    return true;
  }

  async handleCallback(ctx: Context, data: string): Promise<boolean> {
    const [namespace, action, value, extra] = data.split(":");
    if (!namespace || !this.operatorCallbackNamespaces.has(namespace)) return false;
    if (namespace === "dashboard") return this.handleDashboardCallback(ctx, action);
    if (namespace === "public") return this.handlePublicChatCallback(ctx, action, value);
    if (namespace === "quick") return this.handleQuickRepliesCallback(ctx, action, value);
    if (namespace === "support") return this.handleSupportSettingsCallback(ctx, action);
    if (namespace === "team") return this.handleTeamCallback(ctx, action, value, extra);
    if (namespace === "rbac") {
      await ctx.answerCallbackQuery({ text: "Role-based access is automatic for ready installations.", show_alert: true });
      return true;
    }
    return false;
  }

  async showDashboard(ctx: Context, fresh = false): Promise<void> {
    if (!ctx.from) return;
    const member = this.installation.getMember(ctx.from.id);
    if (!member) return;
    if (!await this.operatorDependenciesOrThrow().hasPrivateWorkspaceMembership(ctx)) {
      await ctx.reply("Staff workspace membership required for role-based access.");
      return;
    }
    const render = fresh ? this.refreshScreen.bind(this) : this.renderScreen.bind(this);
    await render(ctx, this.dashboardText(ctx.from.id), this.dashboardKeyboard(ctx.from.id, member.role));
  }

  async showDashboardAfterStaffTestTicketClose(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const member = this.installation.getMember(ctx.from.id);
    if (!member) return;
    await this.retireTrackedScreens(ctx);
    await this.sendFreshScreen(ctx, this.dashboardText(ctx.from.id), this.dashboardKeyboard(ctx.from.id, member.role));
  }

  async showSystemStatus(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    await this.renderScreen(ctx, this.systemStatusText(), new InlineKeyboard().text("Back", "dashboard:home"));
  }

  async showModerationDashboard(ctx: Context): Promise<void> {
    const chats = this.operatorDependenciesOrThrow().db.listManagedPublicChats();
    const enabled = chats.filter((chat) => chat.moderation_enabled === 1).length;
    const unhealthy = chats.filter((chat) => chat.permission_status === "UNHEALTHY").length;
    const text = ["Moderation", "", `Managed public chats: ${chats.length}`, `Enabled: ${enabled}`, `Needs attention: ${unhealthy}`, "", "Manage each public chat's moderation settings and permission health."].join("\n");
    await this.renderScreen(ctx, text, new InlineKeyboard().text("Manage public chats", "dashboard:public").row().text("Back", "dashboard:home"));
  }

  async showPublicChats(ctx: Context, notice?: string): Promise<void> {
    const chats = this.operatorDependenciesOrThrow().db.listManagedPublicChats();
    const keyboard = new InlineKeyboard().text("Add public chat", "public:add").row();
    for (const chat of chats) keyboard.text(`Open settings: ${this.publicChatButtonLabel(chat)}`, `public:open:${chat.chat_id}`).row();
    keyboard.text("Back", "dashboard:home");
    const lines = chats.length
      ? chats.flatMap((chat) => ["", this.publicChatLabel(chat), chat.username ? `@${chat.username}` : "No public username", `Connected: ${this.publicChatConnectionLabel(chat)}`, `Moderation: ${chat.moderation_enabled ? "enabled" : "disabled"}`, `Permissions: ${chat.permission_status.toLowerCase()}`, `Reactions: ${chat.reaction_status.toLowerCase()} (advisory)`])
      : ["", "No public chats are configured."];
    await this.renderScreen(ctx, ["Public chats", ...(notice ? ["", notice] : []), ...lines].join("\n"), keyboard);
  }

  async showPublicChatSettings(ctx: Context, chatId: number, notice?: string): Promise<void> {
    const chat = this.operatorDependenciesOrThrow().db.getManagedPublicChat(chatId);
    if (!chat) {
      await this.renderScreen(ctx, "This public chat is not managed.", new InlineKeyboard().text("Back", "public:list"));
      return;
    }
    const keyboard = new InlineKeyboard()
      .text(chat.moderation_enabled ? "Disable moderation" : "Enable moderation", `public:${chat.moderation_enabled ? "disable" : "enable"}:${chat.chat_id}`).row()
      .text("Check permissions", `public:check:${chat.chat_id}`).row()
      .text("Warning message", `public:config-warning:${chat.chat_id}`).text("Allowed terms", `public:config-allowlist:${chat.chat_id}`).row()
      .text("Warning cooldown", `public:config-cooldown:${chat.chat_id}`).text("Message threshold", `public:config-threshold:${chat.chat_id}`).text("Violation window", `public:config-lookback:${chat.chat_id}`).row()
      .text("Remove chat", `public:remove:${chat.chat_id}`).row().text("Back", "public:list");
    await this.renderScreen(ctx, ["Public chat settings", "", ...(notice ? [notice, ""] : []), `Title: ${chat.title ?? "unknown"}`, `Username: ${chat.username ? `@${chat.username}` : "not available"}`, `Chat ID: ${chat.chat_id}`, `Forum topics: ${chat.is_forum ? "enabled" : "not enabled"}`, `Connected: ${this.publicChatConnectionLabel(chat)}`, `Moderation: ${chat.moderation_enabled ? "enabled" : "disabled"}`, `Permissions: ${chat.permission_status.toLowerCase()}`, `Reactions: ${chat.reaction_status.toLowerCase()} (advisory only)`, `Warning: ${chat.warning_text}`, `Allowed terms: ${chat.allowlist.length}`, `Warning cooldown: ${chat.warning_cooldown_minutes} minutes`, `Message threshold: ${chat.warning_message_threshold} messages`, `Violation window: ${chat.lookback_minutes} minutes`].join("\n"), keyboard);
  }

  async inspectAndSavePublicChat(ctx: Context, chatId: number, shared?: { title?: string; username?: string }): Promise<void> {
    if (!ctx.from) return;
    const dependencies = this.operatorDependenciesOrThrow();
    const botId = dependencies.botId();
    const workspace = this.installation.getActiveWorkspace();
    if (!workspace) {
      await this.clearPublicChatPicker(ctx);
      await this.showPublicChats(ctx, "Configure the staff workspace first.");
      return;
    }
    if (botId === undefined) throw new Error("Bot identity is unavailable.");
    const result = await validatePublicModerationChat(ctx.api, chatId, botId);
    dependencies.db.upsertManagedPublicChat({ chatId: result.chatId, workspaceId: workspace.id, title: result.title ?? shared?.title, username: result.username ?? shared?.username, isForum: result.isForum });
    dependencies.db.recordManagedPublicChatPermissionHealth({ chatId: result.chatId, healthy: result.valid, reactionsAvailable: result.reactionsAvailable, connected: true, title: result.title ?? shared?.title, username: result.username ?? shared?.username, isForum: result.isForum });
    await this.clearPublicChatPicker(ctx);
    await this.showPublicChatSettings(ctx, result.chatId, result.valid ? "Public chat saved. Moderation remains disabled until enabled explicitly." : `Public chat saved, but moderation needs attention:\n${formatPublicChatPermissionChecklist(result)}`);
  }

  getPendingPublicChatConfiguration(userId: number): { chatId: number; field: PublicChatConfigurationField } | undefined {
    return this.pendingPublicChatConfigurations.get(userId);
  }

  setPendingPublicChatConfiguration(userId: number, input: { chatId: number; field: PublicChatConfigurationField }): void {
    this.pendingPublicChatConfigurations.set(userId, input);
  }

  clearPendingPublicChatConfiguration(userId: number): void {
    this.pendingPublicChatConfigurations.delete(userId);
  }

  beginPublicChatSelection(userId: number): void {
    this.pendingPublicChatSelections.add(userId);
  }

  isPublicChatSelectionPending(userId: number): boolean {
    return this.pendingPublicChatSelections.has(userId);
  }

  clearPublicChatSelection(userId: number): boolean {
    return this.pendingPublicChatSelections.delete(userId);
  }

  getPendingWorkspaceSelection(userId: number): "SETUP" | "RECONFIGURE" | undefined {
    return this.pendingWorkspaceSelections.get(userId);
  }

  setPendingWorkspaceSelection(userId: number, mode: "SETUP" | "RECONFIGURE"): void {
    this.pendingWorkspaceSelections.set(userId, mode);
  }

  clearPendingWorkspaceSelection(userId: number): void {
    this.pendingWorkspaceSelections.delete(userId);
  }

  async renderScreen(ctx: Context, text: string, replyMarkup: InlineKeyboard): Promise<void> {
    const callbackMessage = ctx.callbackQuery?.message;
    const callbackTarget = callbackMessage?.chat.type === "private"
      ? { chatId: callbackMessage.chat.id, messageId: callbackMessage.message_id }
      : undefined;
    const target = (ctx.from ? this.activeScreens.get(ctx.from.id) : undefined) ?? (ctx.from ? this.persistedScreen(ctx.from.id) : undefined) ?? callbackTarget;
    const temporaryTarget = ctx.from ? this.temporaryScreens.get(ctx.from.id) : undefined;
    const isTemporaryTarget = target !== undefined && temporaryTarget?.chatId === target.chatId && temporaryTarget.messageId === target.messageId;
    if (target) {
      try {
        await ctx.api.editMessageText(target.chatId, target.messageId, text, { reply_markup: replyMarkup });
        if (ctx.from && isTemporaryTarget) this.temporaryScreens.delete(ctx.from.id);
        this.rememberScreen(ctx, target);
        return;
      } catch (error) {
        if (error instanceof GrammyError && error.description.includes("message is not modified")) {
          if (ctx.from && isTemporaryTarget) this.temporaryScreens.delete(ctx.from.id);
          this.rememberScreen(ctx, target);
          return;
        }
        logger.warn({ userId: ctx.from?.id }, "Could not replace private UI screen");
      }
    }
    if (target && isTemporaryTarget) {
      await this.retireScreenTarget(ctx, target);
      if (ctx.from) this.temporaryScreens.delete(ctx.from.id);
    }
    const sent = await ctx.reply(text, { reply_markup: replyMarkup });
    this.rememberScreen(ctx, { chatId: sent.chat.id, messageId: sent.message_id });
  }

  async sendFreshScreen(ctx: Context, text: string, replyMarkup: InlineKeyboard) {
    const sent = await ctx.reply(text, { reply_markup: replyMarkup });
    this.rememberScreen(ctx, { chatId: sent.chat.id, messageId: sent.message_id });
    return sent;
  }

  async refreshScreen(ctx: Context, text: string, replyMarkup: InlineKeyboard) {
    await this.retireScreens(ctx);
    return this.sendFreshScreen(ctx, text, replyMarkup);
  }

  async retireScreens(ctx: Context): Promise<void> {
    for (const target of this.screenTargets(ctx)) await this.retireScreenTarget(ctx, target);
    this.clearRememberedScreens(ctx.from?.id);
  }

  async retireTrackedScreens(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const targets = [
      this.activeScreens.get(ctx.from.id),
      this.temporaryScreens.get(ctx.from.id),
      this.persistedScreen(ctx.from.id)
    ].filter((target): target is PrivateUiTarget => Boolean(target))
      .filter((target, index, all) => all.findIndex((other) => other.chatId === target.chatId && other.messageId === target.messageId) === index);
    for (const target of targets) await this.retireScreenTarget(ctx, target);
    this.clearRememberedScreens(ctx.from.id);
  }

  async rememberWorkspacePickerPrompt(userId: number, target: PrivateUiTarget, api: Context["api"]): Promise<void> {
    await this.retireWorkspacePickerPrompt(userId, api);
    this.workspacePickerPrompts.set(userId, target);
  }

  async retireWorkspacePickerPrompt(userId: number | undefined, api?: Context["api"]): Promise<void> {
    if (userId === undefined) return;
    const prompt = this.workspacePickerPrompts.get(userId);
    this.workspacePickerPrompts.delete(userId);
    if (!prompt || !api) return;
    try {
      await api.deleteMessage(prompt.chatId, prompt.messageId);
    } catch {
      logger.warn({ userId }, "Could not delete workspace picker prompt");
    }
  }

  async rememberPublicChatPickerPrompt(userId: number, target: PrivateUiTarget, api: Context["api"]): Promise<void> {
    await this.retirePublicChatPickerPrompt(userId, api);
    this.publicChatPickerPrompts.set(userId, target);
  }

  async retirePublicChatPickerPrompt(userId: number | undefined, api?: Context["api"]): Promise<void> {
    if (userId === undefined) return;
    const prompt = this.publicChatPickerPrompts.get(userId);
    this.publicChatPickerPrompts.delete(userId);
    if (!prompt || !api) return;
    try {
      await api.deleteMessage(prompt.chatId, prompt.messageId);
    } catch {
      logger.warn({ userId }, "Could not delete public chat picker prompt");
    }
  }

  async clearPublicChatPicker(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const hadPendingSelection = this.clearPublicChatSelection(ctx.from.id);
    const hadPrompt = this.publicChatPickerPrompts.has(ctx.from.id);
    await this.retirePublicChatPickerPrompt(ctx.from.id, ctx.api);
    if (!hadPendingSelection && !hadPrompt) return;
    const sent = await ctx.reply("Updating...", { reply_markup: { remove_keyboard: true } });
    const target = { chatId: sent.chat.id, messageId: sent.message_id };
    this.temporaryScreens.set(ctx.from.id, target);
    this.rememberScreen(ctx, target);
  }

  private async handleDashboardCallback(ctx: Context, action: string | undefined): Promise<boolean> {
    if (!isPrivateChat(ctx) || !ctx.from) return false;
    const dependencies = this.operatorDependenciesOrThrow();
    if (!this.installation.getMember(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Staff access required.", show_alert: true });
      return true;
    }
    if (!await dependencies.hasPrivateWorkspaceMembership(ctx)) {
      await ctx.answerCallbackQuery({ text: "Staff workspace membership required.", show_alert: true });
      return true;
    }
    await ctx.answerCallbackQuery();
    if (action === "test-ticket") {
      await dependencies.onStartTestTicket(ctx);
      return true;
    }
    if (action === "status") {
      await this.showSystemStatus(ctx);
      return true;
    }
    if (action === "workspace") {
      if (!await dependencies.canConfigure(ctx)) return true;
      await dependencies.onShowWorkspace(ctx);
      return true;
    }
    if (action === "moderation") {
      if (!await dependencies.canUsePermission(ctx, "MODERATION_SETTINGS")) return true;
      await this.showModerationDashboard(ctx);
      return true;
    }
    if (action === "team") {
      if (!await dependencies.canUsePermission(ctx, "MANAGE_TEAM")) return true;
      await this.showTeam(ctx);
      return true;
    }
    if (action === "public") {
      if (!await dependencies.canConfigure(ctx)) return true;
      await this.showPublicChats(ctx);
      return true;
    }
    if (action === "quick") {
      if (!await dependencies.canConfigure(ctx)) return true;
      this.pendingQuickReplyInputs.delete(ctx.from.id);
      await this.showQuickRepliesManagement(ctx);
      return true;
    }
    if (action === "support") {
      if (!await dependencies.canConfigure(ctx)) return true;
      await this.showSupportSettings(ctx);
      return true;
    }
    if (action === "batch") {
      if (!await dependencies.canUsePermission(ctx, "BATCH_OPERATIONS")) return true;
      await dependencies.onShowBatch(ctx);
      return true;
    }
    await this.showDashboard(ctx);
    return true;
  }

  private async handlePublicChatCallback(ctx: Context, action: string | undefined, rawChatId: string | undefined): Promise<boolean> {
    if (!isPrivateChat(ctx) || !ctx.from || !this.installation.can(ctx.from.id, "CONFIGURE_INSTALLATION")) {
      if (isPrivateChat(ctx)) await ctx.answerCallbackQuery({ text: "Owner or administrator access required.", show_alert: true });
      return true;
    }
    const dependencies = this.operatorDependenciesOrThrow();
    if (!await dependencies.hasPrivateWorkspaceMembership(ctx)) {
      await ctx.answerCallbackQuery({ text: "Staff workspace membership required.", show_alert: true });
      return true;
    }
    if (action === "add") {
      await ctx.answerCallbackQuery();
      await this.sendPublicChatPicker(ctx);
      return true;
    }
    if (action === "list") {
      this.pendingPublicChatConfigurations.delete(ctx.from.id);
      await ctx.answerCallbackQuery();
      await this.showPublicChats(ctx);
      return true;
    }
    const chatId = Number(rawChatId);
    if (!Number.isSafeInteger(chatId)) {
      await ctx.answerCallbackQuery({ text: "Invalid public chat.", show_alert: true });
      return true;
    }
    const managed = dependencies.db.getManagedPublicChat(chatId);
    if (!managed) {
      await ctx.answerCallbackQuery({ text: "This public chat is not managed.", show_alert: true });
      return true;
    }
    if (action === "open") {
      this.pendingPublicChatConfigurations.delete(ctx.from.id);
      await ctx.answerCallbackQuery();
      await this.showPublicChatSettings(ctx, chatId);
      return true;
    }
    if (action?.startsWith("config-")) {
      const field = action.slice("config-".length);
      if (!isPublicChatConfigurationField(field)) {
        await ctx.answerCallbackQuery({ text: "Unknown configuration field.", show_alert: true });
        return true;
      }
      await ctx.answerCallbackQuery();
      await this.beginPublicChatConfiguration(ctx, managed, field);
      return true;
    }
    if (action === "disable") {
      dependencies.db.setManagedPublicChatModerationEnabled(chatId, false);
      await ctx.answerCallbackQuery({ text: "Moderation disabled." });
      await this.showPublicChatSettings(ctx, chatId);
      return true;
    }
    if (action === "remove") {
      await ctx.answerCallbackQuery();
      await this.renderScreen(ctx, `Remove ${this.publicChatLabel(managed)} from managed public chats? Historical moderation records will be preserved.`, new InlineKeyboard().text("Confirm removal", `public:confirm-remove:${chatId}`).row().text("Cancel", `public:open:${chatId}`));
      return true;
    }
    if (action === "confirm-remove") {
      dependencies.db.deactivateManagedPublicChat(chatId);
      await ctx.answerCallbackQuery({ text: "Public chat removed." });
      await this.showPublicChats(ctx);
      return true;
    }
    if (action === "check" || action === "enable") {
      try {
        const botId = dependencies.botId();
        if (botId === undefined) throw new Error("Bot identity is unavailable.");
        const result = await validatePublicModerationChat(ctx.api, chatId, botId);
        dependencies.db.recordManagedPublicChatPermissionHealth({ chatId, healthy: result.valid, reactionsAvailable: result.reactionsAvailable, connected: true, title: result.title, username: result.username, isForum: result.isForum });
        if (action === "enable" && result.valid) dependencies.db.setManagedPublicChatModerationEnabled(chatId, true);
        await ctx.answerCallbackQuery({ text: action === "enable" && result.valid ? "Moderation enabled." : result.valid ? "Permissions are healthy." : "Required permissions are missing.", show_alert: !result.valid });
        await this.showPublicChatSettings(ctx, chatId, action === "enable" && result.valid ? "Moderation enabled. Permissions are healthy." : result.valid ? "Permissions checked: healthy." : `Permissions need attention:\n${formatPublicChatPermissionChecklist(result)}`);
      } catch (error) {
        dependencies.db.recordManagedPublicChatUnreachable(chatId);
        logger.warn({ chatId, err: error }, "Could not validate managed public chat permissions");
        await ctx.answerCallbackQuery({ text: "The public chat could not be inspected.", show_alert: true });
        await this.showPublicChatSettings(ctx, chatId, "The public chat could not be inspected. Check the bot membership and permissions, then try again.");
      }
      return true;
    }
    await ctx.answerCallbackQuery({ text: "Unknown public chat action.", show_alert: true });
    return true;
  }

  private async handleQuickRepliesCallback(ctx: Context, action: string | undefined, value: string | undefined): Promise<boolean> {
    const dependencies = this.operatorDependenciesOrThrow();
    if (!await dependencies.canConfigure(ctx) || !ctx.from) return true;
    if (action === "list") { this.pendingQuickReplyInputs.delete(ctx.from.id); await ctx.answerCallbackQuery(); await this.showQuickRepliesManagement(ctx); return true; }
    if (action === "view" && value) { this.pendingQuickReplyInputs.delete(ctx.from.id); await ctx.answerCallbackQuery(); await this.showQuickReplyDetail(ctx, value); return true; }
    if ((action === "edit-name" || action === "edit-text") && value) {
      if (!dependencies.quickReplies.findTemplate(value)) { await ctx.answerCallbackQuery({ text: "This Quick Reply is no longer available.", show_alert: true }); return true; }
      await ctx.answerCallbackQuery();
      await this.beginQuickReplyInput(ctx, { kind: action === "edit-name" ? "EDIT_TITLE" : "EDIT_TEXT", templateId: value });
      return true;
    }
    if (action === "add") {
      await ctx.answerCallbackQuery();
      const categories = dependencies.quickReplies.listCategories();
      if (categories.length === 1) await this.beginQuickReplyInput(ctx, { kind: "ADD_TITLE", categoryId: categories[0]!.id });
      else await this.showQuickReplyCategoryPicker(ctx);
      return true;
    }
    if (action === "add-category" && value) {
      if (!dependencies.quickReplies.listCategories().some((category) => category.id === value)) { await ctx.answerCallbackQuery({ text: "This category is no longer available.", show_alert: true }); return true; }
      await ctx.answerCallbackQuery();
      await this.beginQuickReplyInput(ctx, { kind: "ADD_TITLE", categoryId: value });
      return true;
    }
    if (action === "add-save") {
      const pending = this.pendingQuickReplyInputs.get(ctx.from.id);
      if (!pending || pending.kind !== "ADD_PREVIEW") { await ctx.answerCallbackQuery({ text: "This reply draft is no longer active.", show_alert: true }); return true; }
      const template = dependencies.quickReplies.createTemplate(pending);
      this.pendingQuickReplyInputs.delete(ctx.from.id);
      await ctx.answerCallbackQuery({ text: "Quick Reply saved." });
      await this.retireScreens(ctx);
      await this.showQuickReplyDetail(ctx, template.id);
      return true;
    }
    if (action === "delete" && value) {
      const template = dependencies.quickReplies.findTemplate(value);
      if (!template) { await ctx.answerCallbackQuery({ text: "This Quick Reply is no longer available.", show_alert: true }); return true; }
      await ctx.answerCallbackQuery();
      await this.renderScreen(ctx, `Delete \"${template.title}\"?`, new InlineKeyboard().text("Delete", `quick:confirm-delete:${template.id}`).row().text("Cancel", `quick:view:${template.id}`));
      return true;
    }
    if (action === "confirm-delete" && value) {
      const result = dependencies.quickReplies.deleteTemplate(value);
      if (result === "LAST_TEMPLATE") { await ctx.answerCallbackQuery({ text: "Keep at least one reply in this category.", show_alert: true }); await this.showQuickReplyDetail(ctx, value); return true; }
      if (result === "NOT_FOUND") { await ctx.answerCallbackQuery({ text: "This Quick Reply is no longer available.", show_alert: true }); await this.showQuickRepliesManagement(ctx); return true; }
      await ctx.answerCallbackQuery({ text: "Quick Reply deleted." });
      await this.showQuickRepliesManagement(ctx);
      return true;
    }
    await ctx.answerCallbackQuery({ text: "Unknown Quick Replies action.", show_alert: true });
    return true;
  }

  private async handleSupportSettingsCallback(ctx: Context, action: string | undefined): Promise<boolean> {
    const dependencies = this.operatorDependenciesOrThrow();
    if (!await dependencies.canConfigure(ctx) || !ctx.from) return true;
    await ctx.answerCallbackQuery();
    if (action === "edit") { await this.beginSupportResponseTimeInput(ctx); return true; }
    if (action === "edit-acknowledgement") { await this.beginSupportAcknowledgementInput(ctx); return true; }
    if (action === "reset-response-time") {
      const rendered = validateRenderedSupportAcknowledgement(this.supportTicketReceivedTemplate(), DEFAULT_SUPPORT_EXPECTED_RESPONSE_TIME);
      if (rendered.error) { await this.showSupportSettings(ctx, "Cannot reset response time because the current acknowledgement would become too long. Shorten or reset the acknowledgement first."); return true; }
      dependencies.db.setSetting("support_expected_response_time", "");
      this.pendingSupportSettingsInputs.delete(ctx.from.id);
      await this.showSupportSettings(ctx, "Expected response time reset to default.");
      return true;
    }
    if (action === "reset-acknowledgement") {
      dependencies.db.setSetting("support_ticket_received_template", "");
      this.pendingSupportSettingsInputs.delete(ctx.from.id);
      await this.showSupportSettings(ctx, "Acknowledgement reset to default.");
      return true;
    }
    if (action === "back") { this.pendingSupportSettingsInputs.delete(ctx.from.id); await this.showDashboard(ctx); return true; }
    await ctx.answerCallbackQuery({ text: "Unknown support settings action.", show_alert: true });
    return true;
  }

  private async handleTeamCallback(ctx: Context, action: string | undefined, value: string | undefined, roleValue: string | undefined): Promise<boolean> {
    if (!isPrivateChat(ctx) || !ctx.from) { await ctx.answerCallbackQuery({ text: "Private staff dashboard only.", show_alert: true }); return true; }
    if (!await this.operatorDependenciesOrThrow().canUsePermission(ctx, "MANAGE_TEAM")) { await ctx.answerCallbackQuery({ text: "Your application role cannot manage the team.", show_alert: true }); return true; }
    try {
      if (action === "list") { await ctx.answerCallbackQuery(); await this.showTeam(ctx); return true; }
      if (action === "member") {
        const member = this.installation.getMember(Number(value));
        if (!member) throw new Error("This team member is no longer active.");
        await ctx.answerCallbackQuery(); await this.showTeamMember(ctx, member); return true;
      }
      if (action === "transfer") {
        if (this.installation.getMember(ctx.from.id)?.role !== "OWNER") throw new Error("Only the OWNER can transfer ownership.");
        const token = this.installation.createOwnerRecoveryToken();
        await ctx.answerCallbackQuery({ text: "Transfer link created." });
        await this.retireScreens(ctx);
        await ctx.reply(`One-use ownership transfer link (30 minutes):\nhttps://t.me/${this.operatorDependenciesOrThrow().botUsername()}?start=setup_${token}\n\nThe current OWNER remains active until the recipient confirms.`);
        await this.sendFreshScreen(ctx, "Team", this.teamKeyboard(ctx.from.id));
        return true;
      }
      if (action === "set") {
        this.installation.assignRole(ctx.from.id, Number(value), roleValue as "ADMIN" | "SENIOR_AGENT" | "AGENT");
        await ctx.answerCallbackQuery({ text: "Role updated." });
        const member = this.installation.getMember(Number(value)); if (member) await this.showTeamMember(ctx, member);
        return true;
      }
      if (action === "revoke") {
        this.installation.assignRole(ctx.from.id, Number(value), "AGENT");
        await ctx.answerCallbackQuery({ text: "Member kept as an agent." });
        const member = this.installation.getMember(Number(value)); if (member) await this.showTeamMember(ctx, member);
        return true;
      }
      const role = (value === "ADMIN" || value === "SENIOR_AGENT" || value === "AGENT") ? value : "AGENT";
      const token = this.installation.createTeamInvitation(ctx.from.id, role);
      await ctx.answerCallbackQuery({ text: "Invitation created." });
      await this.retireScreens(ctx);
      await ctx.reply(`One-use ${role} invitation (30 minutes):\nhttps://t.me/${this.operatorDependenciesOrThrow().botUsername()}?start=team_${token}`);
      await this.sendFreshScreen(ctx, "Team", this.teamKeyboard(ctx.from.id));
    } catch (error) { await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "Invitation denied.", show_alert: true }); }
    return true;
  }

  private async sendPublicChatPicker(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    await this.retireScreens(ctx);
    this.pendingPublicChatSelections.delete(ctx.from.id);
    await this.retirePublicChatPickerPrompt(ctx.from.id, ctx.api);
    this.pendingPublicChatSelections.add(ctx.from.id);
    const rights = { is_anonymous: false, can_manage_chat: true, can_delete_messages: true, can_manage_video_chats: false, can_restrict_members: true, can_promote_members: false, can_change_info: false, can_invite_users: true, can_post_stories: false, can_edit_stories: false, can_delete_stories: false, can_post_messages: false, can_edit_messages: false, can_pin_messages: false, can_manage_topics: false };
    const keyboard = new Keyboard().requestChat("Select public supergroup", 1400, { chat_is_channel: false, bot_is_member: true, request_title: true, request_username: true, request_photo: false, bot_administrator_rights: rights, user_administrator_rights: rights }).text("Cancel public chat selection").resized().oneTime();
    const prompt = await ctx.reply("Choose a public supergroup. You may also paste its public @username or t.me link.", { reply_markup: keyboard });
    await this.rememberPublicChatPickerPrompt(ctx.from.id, { chatId: prompt.chat.id, messageId: prompt.message_id }, ctx.api);
  }

  private async beginPublicChatConfiguration(ctx: Context, chat: ManagedPublicChatRecord, field: PublicChatConfigurationField): Promise<void> {
    if (!ctx.from) return;
    this.pendingPublicChatConfigurations.set(ctx.from.id, { chatId: chat.chat_id, field });
    await this.retireScreens(ctx);
    await this.sendFreshScreen(ctx, this.publicChatConfigurationPrompt(chat, field), new InlineKeyboard().text("Back to settings", `public:open:${chat.chat_id}`));
  }

  private async consumePublicChatConfiguration(ctx: Context, text: string): Promise<boolean> {
    if (!ctx.from) return false;
    const pending = this.pendingPublicChatConfigurations.get(ctx.from.id);
    if (!pending) return false;
    const dependencies = this.operatorDependenciesOrThrow();
    const chat = dependencies.db.getManagedPublicChat(pending.chatId);
    if (!chat) { this.pendingPublicChatConfigurations.delete(ctx.from.id); await this.renderScreen(ctx, "This public chat is no longer managed.", new InlineKeyboard().text("Back", "public:list")); return true; }
    let warningText = chat.warning_text;
    let allowlist = chat.allowlist;
    let warningCooldownMinutes = chat.warning_cooldown_minutes;
    let warningMessageThreshold = chat.warning_message_threshold;
    let lookbackMinutes = chat.lookback_minutes;
    const trimmed = text.trim();
    if (pending.field === "warning") {
      if (!trimmed || trimmed.length > 500) { await this.renderScreen(ctx, this.publicChatConfigurationPrompt(chat, pending.field, "use 1-500 characters."), new InlineKeyboard().text("Back to settings", `public:open:${chat.chat_id}`)); return true; }
      warningText = trimmed;
    } else if (pending.field === "allowlist") {
      const entries = trimmed === "-" ? [] : [...new Set(trimmed.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
      if (entries.length > 100 || entries.some((entry) => entry.length > 80)) { await this.renderScreen(ctx, this.publicChatConfigurationPrompt(chat, pending.field, "use at most 100 terms, each up to 80 characters."), new InlineKeyboard().text("Back to settings", `public:open:${chat.chat_id}`)); return true; }
      allowlist = entries;
    } else {
      const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
      const maximum = pending.field === "threshold" ? 10_000 : 1_440;
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) { await this.renderScreen(ctx, this.publicChatConfigurationPrompt(chat, pending.field, `enter a whole number from 1 to ${maximum}.`), new InlineKeyboard().text("Back to settings", `public:open:${chat.chat_id}`)); return true; }
      if (pending.field === "cooldown") warningCooldownMinutes = parsed;
      if (pending.field === "threshold") warningMessageThreshold = parsed;
      if (pending.field === "lookback") lookbackMinutes = parsed;
    }
    dependencies.db.updateManagedPublicChatConfig(chat.chat_id, { warningText, allowlist, warningCooldownMinutes, warningMessageThreshold, lookbackMinutes });
    this.pendingPublicChatConfigurations.delete(ctx.from.id);
    await this.retireScreens(ctx);
    await this.showPublicChatSettings(ctx, chat.chat_id);
    return true;
  }

  private dashboardText(userId: number): string {
    const member = this.installation.getMember(userId);
    const counts = this.operatorDependenciesOrThrow().db.getInstallationOperationalCounts();
    return [member?.role === "OWNER" ? "Owner dashboard" : `${member?.role.replace("_", " ") ?? "Staff"} dashboard`, "", this.installation.getState().setupState === "READY" ? "Support is ready." : "Finish setup to activate support.", `Public chats: ${counts.publicChats}`].join("\n");
  }

  private dashboardKeyboard(userId: number, role: string): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    if (role === "OWNER" || role === "ADMIN") {
      if (this.installation.getState().setupState !== "READY") keyboard.text("Continue setup", "setup:resume").row();
      const pendingBatch = this.operatorDependenciesOrThrow().getPendingBatchExport(userId);
      keyboard.text("Staff workspace", "dashboard:workspace").row().text("Public chats", "dashboard:public").text("Team", "dashboard:team").row().text("Moderation", "dashboard:moderation").text("Quick replies", "dashboard:quick").row().text("Support settings", "dashboard:support").row().text(pendingBatch ? "Continue batch" : "Export tickets", pendingBatch ? "batch-ui:continue" : "batch-ui:export").text("Batch status", "batch-ui:recent").row().text("System status", "dashboard:status").row();
    }
    return keyboard.text("Open test ticket as user", "dashboard:test-ticket");
  }

  private systemStatusText(): string {
    const dependencies = this.operatorDependenciesOrThrow();
    const workspace = this.installation.getActiveWorkspace();
    const counts = dependencies.db.getInstallationOperationalCounts();
    const roles = new Map<string, number>();
    for (const entry of this.installation.listTeamMembers()) roles.set(entry.role, (roles.get(entry.role) ?? 0) + 1);
    return ["System status", "", `Bot: @${dependencies.botUsername() ?? "loading"}`, `Version: ${dependencies.packageVersion}`, `Setup: ${this.installation.getState().setupState}`, `Authorization: ${this.installation.getState().authorizationMode}`, `Owner: ${this.installation.getOwner()?.username ? `@${this.installation.getOwner()?.username}` : this.installation.getOwner()?.userTelegramId ?? "not paired"}`, `Staff workspace: ${workspace?.title ?? workspace?.telegram_chat_id ?? "not configured"}`, `Support Logs: ${workspace && dependencies.db.getSetting(`support_logs_message_thread_id:${workspace.telegram_chat_id}`) ? "configured" : "not configured"}`, `Public chats: ${counts.publicChats}`, `Team: OWNER ${roles.get("OWNER") ?? 0}, ADMIN ${roles.get("ADMIN") ?? 0}, SENIOR_AGENT ${roles.get("SENIOR_AGENT") ?? 0}, AGENT ${roles.get("AGENT") ?? 0}`, `Moderation enabled: ${counts.moderationEnabled}/${counts.publicChats}`, `Unhealthy moderation chats: ${counts.unhealthyModerationChats}`, `Pending moderation cleanup: ${counts.pendingCleanup}`, `Pending archives: ${counts.pendingArchives}`, `Pending batch staff operations: ${counts.pendingBatchStaffOperations}`, "Database: available"].join("\n");
  }

  private publicChatLabel(chat: ManagedPublicChatRecord | undefined): string { return chat?.title ?? (chat?.username ? `@${chat.username}` : chat ? String(chat.chat_id) : "Unknown public chat"); }
  private publicChatButtonLabel(chat: ManagedPublicChatRecord): string { const label = this.publicChatLabel(chat); return label.length > 40 ? `${label.slice(0, 39)}...` : label; }
  private publicChatConnectionLabel(chat: ManagedPublicChatRecord): string { return chat.connection_status === "CONNECTED" ? "yes" : chat.connection_status === "UNREACHABLE" ? "no" : "unknown"; }

  private publicChatConfigurationPrompt(chat: ManagedPublicChatRecord, field: PublicChatConfigurationField, error?: string): string {
    const details: Record<PublicChatConfigurationField, string> = {
      warning: ["Warning message", "Shown when the bot sends a first-strike warning in this public chat.", `Current value: ${chat.warning_text}`, "Valid: 1-500 characters.", "Example: Please use English in this chat."].join("\n"),
      allowlist: ["Allowed terms", "Terms removed before language analysis. Messages containing only these terms stay exempt.", `Current value: ${chat.allowlist.length ? chat.allowlist.join(", ") : "none"}`, "Valid: comma-separated terms, up to 100 terms of 80 characters each; send - to clear.", "Example: productname, ticker"].join("\n"),
      cooldown: ["Warning cooldown", "Minimum time after a warning before another first-strike warning can appear. The message threshold must also be met.", `Current value: ${chat.warning_cooldown_minutes} minutes`, "Valid: whole number from 1 to 1440 minutes.", "Example: 30"].join("\n"),
      threshold: ["Message threshold", "Incoming messages in this chat or topic after a warning before another first-strike warning can appear. All messages count.", `Current value: ${chat.warning_message_threshold} messages`, "Valid: whole number from 1 to 10000 messages.", "Example: 20"].join("\n"),
      lookback: ["Violation window", "First violations in the same chat or topic during this window are grouped into one warning.", `Current value: ${chat.lookback_minutes} minutes`, "Valid: whole number from 1 to 1440 minutes.", "Example: 10"].join("\n")
    };
    return [details[field], "", error ? `Invalid: ${error}` : "Send the new value."].join("\n");
  }

  private teamMemberLabel(member: TeamMemberRecord): string { return member.username ? `@${member.username}` : member.display_name?.trim() || "Unnamed member"; }
  private teamRoleLabel(role: TeamMemberRecord["role"]): string { return ({ OWNER: "Owner", ADMIN: "Admin", SENIOR_AGENT: "Senior agent", AGENT: "Agent" })[role]; }
  private teamKeyboard(actorId: number): InlineKeyboard {
    const keyboard = new InlineKeyboard().text("Invite member", "team:invite").row();
    for (const member of this.installation.listTeamMembers()) keyboard.text(`${this.teamRoleLabel(member.role)}: ${this.teamMemberLabel(member)}`, `team:member:${member.user_telegram_id}`).row();
    if (this.installation.getMember(actorId)?.role === "OWNER") keyboard.text("Transfer ownership", "team:transfer").row();
    return keyboard.text("Back", "dashboard:home");
  }
  private async showTeam(ctx: Context): Promise<void> { if (!ctx.from) return; const members = this.installation.listTeamMembers(); await this.renderScreen(ctx, ["Team", "", ...members.map((member) => `${this.teamRoleLabel(member.role)}: ${this.teamMemberLabel(member)}`)].join("\n"), this.teamKeyboard(ctx.from.id)); }
  private async showTeamMember(ctx: Context, member: TeamMemberRecord): Promise<void> {
    if (!ctx.from) return;
    const actor = this.installation.getMember(ctx.from.id); const keyboard = new InlineKeyboard(); const text = ["Team member", "", `Member: ${this.teamMemberLabel(member)}`, `Role: ${this.teamRoleLabel(member.role)}`, "Staff workspace membership is required for access."];
    if (member.role === "OWNER") text.push("", "The OWNER cannot be changed through ordinary team controls.");
    else if (actor?.role === "OWNER" || (actor?.role === "ADMIN" && member.role !== "ADMIN")) { if (actor.role === "OWNER") keyboard.text("Make admin", `team:set:${member.user_telegram_id}:ADMIN`).row(); keyboard.text("Make senior agent", `team:set:${member.user_telegram_id}:SENIOR_AGENT`).row(); keyboard.text("Make agent", `team:set:${member.user_telegram_id}:AGENT`).row(); }
    keyboard.text("Back to team", "team:list").row().text("Back to dashboard", "dashboard:home");
    await this.renderScreen(ctx, text.join("\n"), keyboard);
  }

  private persistedScreen(userId: number): PrivateUiTarget | undefined {
    const session = this.installation.getOnboardingSession(userId);
    if (!session || session.primary_message_chat_id === null || session.primary_message_id === null) return undefined;
    return { chatId: session.primary_message_chat_id, messageId: session.primary_message_id };
  }

  private operatorDependenciesOrThrow(): PrivateControlPlaneOperatorDependencies {
    if (!this.operatorDependencies) throw new Error("Private operator UI dependencies have not been configured.");
    return this.operatorDependencies;
  }

  private quickReplyInputPrompt(pending: Exclude<PendingQuickReplyInput, { kind: "ADD_PREVIEW" }>, error?: string): string {
    const prompt = pending.kind === "EDIT_TITLE" ? "Send the new reply name (1-32 characters)."
      : pending.kind === "EDIT_TEXT" ? "Send the new reply text (1-3500 characters)."
        : pending.kind === "ADD_TITLE" ? "Send the new reply name (1-32 characters)."
          : "Send the reply text (1-3500 characters).";
    return ["Quick replies", "", ...(error ? [`Invalid: ${error}`, ""] : []), prompt].join("\n");
  }

  private supportExpectedResponseTime(): string {
    return this.operatorDependenciesOrThrow().db.getSetting("support_expected_response_time")?.trim() || DEFAULT_SUPPORT_EXPECTED_RESPONSE_TIME;
  }

  private supportTicketReceivedTemplate(): string {
    return this.operatorDependenciesOrThrow().db.getSetting("support_ticket_received_template")?.trim() || DEFAULT_SUPPORT_TICKET_RECEIVED_TEMPLATE;
  }

  private supportSettingsText(notice?: string): string {
    return ["Support settings", "", ...(notice ? [notice, ""] : []), "Expected response time:", this.supportExpectedResponseTime(), "", "New-ticket acknowledgement preview:", truncate(formatTicketReceived(this.supportTicketReceivedTemplate(), this.supportExpectedResponseTime()), 1200), "", "Shown to users when a new support ticket is created."].join("\n");
  }

  private supportSettingsKeyboard(): InlineKeyboard {
    return new InlineKeyboard().text("Edit response time", "support:edit").row().text("Edit acknowledgement", "support:edit-acknowledgement").row().text("Reset response time", "support:reset-response-time").text("Reset acknowledgement", "support:reset-acknowledgement").row().text("Back", "dashboard:home");
  }

  private supportResponseTimePrompt(error?: string): string {
    return ["Expected response time", "", ...(error ? [`Invalid: ${error}`, ""] : []), "Current value:", this.supportExpectedResponseTime(), "", "Send the new value.", "", "Example:", "1-3 business days"].join("\n");
  }

  private normalizeSupportExpectedResponseTime(value: string): { value?: string; error?: string } {
    const trimmed = value.trim();
    if (!trimmed) return { error: "value cannot be empty." };
    if (trimmed.length > 80) return { error: "use at most 80 characters." };
    if (/\r|\n|[\u0000-\u001f\u007f]/.test(value)) return { error: "use one line without control characters." };
    return { value: trimmed };
  }

  private supportAcknowledgementPrompt(error?: string): string {
    return ["New-ticket acknowledgement", "", ...(error ? [`Invalid: ${error}`, ""] : []), `Use ${SUPPORT_RESPONSE_TIME_PLACEHOLDER} anywhere you want the response time to appear.`, "Messages without this placeholder are allowed and will be sent exactly as written.", "", "Current template:", truncate(this.supportTicketReceivedTemplate(), 2600), "", "Send the complete new acknowledgement."].join("\n");
  }

  private normalizeSupportTicketReceivedTemplate(value: string): { value?: string; error?: string } {
    const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
    if (!normalized) return { error: "message cannot be empty." };
    if (normalized.length > 3500) return { error: "use at most 3500 characters." };
    if (/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) return { error: "remove unsafe control characters." };
    const rendered = validateRenderedSupportAcknowledgement(normalized, this.supportExpectedResponseTime());
    return rendered.error ? { error: rendered.error } : { value: normalized };
  }

  private async deleteConsumedSupportSettingsInput(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message) return;
    try {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    } catch {
      logger.warn({ userId: ctx.from?.id, messageId: ctx.message.message_id }, "Could not delete consumed support settings input");
    }
  }

  private rememberScreen(ctx: Context, target: PrivateUiTarget): void {
    if (!ctx.from) return;
    this.activeScreens.set(ctx.from.id, target);
    if (!this.installation.getOnboardingSession(ctx.from.id)) this.installation.saveOnboardingStage(ctx.from.id, "WELCOME", "COMPLETED");
    this.installation.setOnboardingPrimaryMessage(ctx.from.id, target.chatId, target.messageId);
  }

  private screenTargets(ctx: Context): PrivateUiTarget[] {
    const callbackMessage = ctx.callbackQuery?.message;
    const callbackTarget = callbackMessage?.chat.type === "private"
      ? { chatId: callbackMessage.chat.id, messageId: callbackMessage.message_id }
      : undefined;
    const trackedTarget = ctx.from ? this.activeScreens.get(ctx.from.id) : undefined;
    const temporaryTarget = ctx.from ? this.temporaryScreens.get(ctx.from.id) : undefined;
    const persistedTarget = ctx.from ? this.persistedScreen(ctx.from.id) : undefined;
    return [callbackTarget, trackedTarget, temporaryTarget, persistedTarget]
      .filter((target): target is PrivateUiTarget => Boolean(target))
      .filter((target, index, targets) => targets.findIndex((other) => other.chatId === target.chatId && other.messageId === target.messageId) === index);
  }

  private async retireScreenTarget(ctx: Context, target: PrivateUiTarget): Promise<void> {
    try {
      await ctx.api.deleteMessage(target.chatId, target.messageId);
    } catch {
      try {
        await ctx.api.editMessageReplyMarkup(target.chatId, target.messageId, { reply_markup: { inline_keyboard: [] } });
      } catch {
        logger.warn({ userId: ctx.from?.id }, "Could not retire private UI screen");
      }
    }
  }

  private clearRememberedScreens(userId: number | undefined): void {
    if (userId === undefined) return;
    this.activeScreens.delete(userId);
    this.temporaryScreens.delete(userId);
    this.installation.setOnboardingPrimaryMessage(userId, null, null);
  }
}

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

function isPublicChatConfigurationField(value: string): value is PublicChatConfigurationField {
  return value === "warning" || value === "allowlist" || value === "cooldown" || value === "threshold" || value === "lookback";
}
