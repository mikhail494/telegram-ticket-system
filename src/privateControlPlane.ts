import { GrammyError, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { SupportDatabase } from "./db.js";
import {
  DEFAULT_SUPPORT_EXPECTED_RESPONSE_TIME,
  DEFAULT_SUPPORT_TICKET_RECEIVED_TEMPLATE,
  formatTicketReceived,
  SUPPORT_RESPONSE_TIME_PLACEHOLDER,
  truncate,
  validateRenderedSupportAcknowledgement
} from "./format.js";
import { InstallationService } from "./installation.js";
import { logger } from "./logger.js";
import type { QuickRepliesManager } from "./quickReplies.js";

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
