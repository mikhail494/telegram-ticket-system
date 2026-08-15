import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { InstallationRepository } from "./persistence/installationRepository.js";
import { ModerationRepository } from "./persistence/moderationRepository.js";
import { QuickRepliesRepository } from "./persistence/quickRepliesRepository.js";
import { TicketBatchRepository } from "./persistence/ticketBatchRepository.js";
import { TicketRepository } from "./persistence/ticketsRepository.js";
import { now } from "./persistence/helpers.js";
import type { NormalizedDeliveryError } from "./deliveryDiagnostics.js";
import type { AddMessageInput, BanUserInput, BannedUserRecord, CloseTicketInput, CreateTicketBatchAnswerPackageInput, CreateTicketBatchExportInput, EntityNotificationPublicationState, InstallationStateRecord, LanguageModerationCleanupJob, LanguageModerationUserState, LanguageModerationViolation, LanguageModerationViolationCleanupState, LanguageModerationWarningState, ManagedPublicChatRecord, OnboardingSessionRecord, QuickReplyCategoryRecord, QuickReplyTemplateRecord, SecureTokenRecord, TeamMemberRecord, TeamRole, TicketBatchAnswerItemRecord, TicketBatchAnswerItemState, TicketBatchAnswerPackageRecord, TicketBatchDeliveryFailureContext, TicketBatchExportItemRecord, TicketBatchExportRecord, TicketBatchFailureEventState, TicketBatchRecoveryAudit, TicketBatchStaffSyncContext, TicketBatchSummaryDeliveryState, TicketBatchTopicEchoState, TicketEscalationTarget, TicketFollowUpHistoryRecord, TicketFollowUpState, TicketMessageRecord, TicketRecord, TicketStatus, TicketWithUser, UserInput, UserRecord, WorkspaceRecord } from "./persistence/types.js";
export type * from "./persistence/types.js";
interface TableColumnInfo { name: string; }
interface Migration { id: number; name: string; up: () => void; }
export function resolveDatabasePath(databaseUrl: string): string { const value = databaseUrl.trim(); if (value === ":memory:") return value; if (value.startsWith("file://")) { const url = new URL(value); const pathname = decodeURIComponent(url.pathname); return process.platform === "win32" && /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname; } if (value.startsWith("file:")) return value.slice("file:".length); if (value.startsWith("sqlite://")) { const url = new URL(value); const pathname = decodeURIComponent(url.pathname); return process.platform === "win32" && /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname; } return value; }
function ensureDirectoryForDatabase(databasePath: string): void { if (databasePath === ":memory:") return; const directory = path.dirname(databasePath); if (directory && directory !== ".") fs.mkdirSync(directory, { recursive: true }); }
export class SupportDatabase {
  private readonly db: Database.Database;
  private readonly tickets: TicketRepository;
  private readonly batch: TicketBatchRepository;
  private readonly installation: InstallationRepository;
  private readonly moderation: ModerationRepository;
  private readonly quickReplies: QuickRepliesRepository;
  readonly databasePath: string;
  constructor(databaseUrl: string) {
    const databasePath = resolveDatabasePath(databaseUrl);
    ensureDirectoryForDatabase(databasePath);
    this.databasePath = databasePath;
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // Migration 20 reads legacy settings through the public facade.
    this.installation = new InstallationRepository(this.db);
    this.migrate();
    this.tickets = new TicketRepository(this.db);
    this.batch = new TicketBatchRepository(this.db);
    this.moderation = new ModerationRepository(this.db);
    this.quickReplies = new QuickRepliesRepository(this.db);
  }
  close(): void { this.db.close(); }
  ping(): boolean { this.db.prepare("SELECT 1").get(); return true; }
  backupTo(destination: string): Promise<Database.BackupMetadata> { return this.db.backup(destination); }
  upsertUser(user: UserInput): void
  {
    return this.tickets.upsertUser(user);
  }

  getUser(telegramId: number): UserRecord | undefined
  {
    return this.tickets.getUser(telegramId);
  }

  createTicket(userTelegramId: number, staffChatId: number): TicketRecord
  {
    return this.tickets.createTicket(userTelegramId, staffChatId);
  }

  getTicket(ticketId: number): TicketRecord | undefined
  {
    return this.tickets.getTicket(ticketId);
  }

  getTicketWithUser(ticketId: number): TicketWithUser | undefined
  {
    return this.tickets.getTicketWithUser(ticketId);
  }

  findActiveTicketForUser(userTelegramId: number, staffChatId: number): TicketRecord | undefined
  {
    return this.tickets.findActiveTicketForUser(userTelegramId, staffChatId);
  }

  getLatestTicketForUser(userTelegramId: number, staffChatId: number): TicketRecord | undefined
  {
    return this.tickets.getLatestTicketForUser(userTelegramId, staffChatId);
  }

  listTicketsForUser(userTelegramId: number, staffChatId: number, limit = 10): TicketRecord[]
  {
    return this.tickets.listTicketsForUser(userTelegramId, staffChatId, limit);
  }

  findTicketByStaffThread(staffChatId: number, messageThreadId: number): TicketWithUser | undefined
  {
    return this.tickets.findTicketByStaffThread(staffChatId, messageThreadId);
  }

  closeOtherActiveTicketsForUserInStaffChat(
    userTelegramId: number,
    staffChatId: number,
    keepTicketId: number
  ): number
  {
    return this.tickets.closeOtherActiveTicketsForUserInStaffChat(userTelegramId, staffChatId, keepTicketId);
  }

  updateTicketStaffMessage(ticketId: number, staffChatId: number, staffMessageId: number): void
  {
    return this.tickets.updateTicketStaffMessage(ticketId, staffChatId, staffMessageId);
  }

  updateTicketForumTopic(ticketId: number, staffChatId: number, messageThreadId: number): void
  {
    return this.tickets.updateTicketForumTopic(ticketId, staffChatId, messageThreadId);
  }

  updateTicketStatus(ticketId: number, status: TicketStatus): TicketRecord | undefined
  {
    return this.tickets.updateTicketStatus(ticketId, status);
  }

  listActiveTicketsForStaffChat(staffChatId: number): TicketWithUser[]
  {
    return this.tickets.listActiveTicketsForStaffChat(staffChatId);
  }

  closeTicketRecord(ticketId: number, input: CloseTicketInput): TicketRecord | undefined
  {
    return this.tickets.closeTicketRecord(ticketId, input);
  }

  markTicketArchivedAndDeleteMessages(
    ticketId: number,
    logsMessageId: number,
    transcriptMessageId: number
  ): void
  {
    return this.tickets.markTicketArchivedAndDeleteMessages(ticketId, logsMessageId, transcriptMessageId);
  }

  addMessage(input: AddMessageInput): number
  {
    return this.tickets.addMessage(input);
  }

  listMessages(ticketId: number, limit = 10): TicketMessageRecord[]
  {
    return this.tickets.listMessages(ticketId, limit);
  }

  listMessagesChronological(ticketId: number): TicketMessageRecord[]
  {
    return this.tickets.listMessagesChronological(ticketId);
  }

  deleteMessagesForTicket(ticketId: number): number
  {
    return this.tickets.deleteMessagesForTicket(ticketId);
  }

  listClosedTicketsPendingArchive(staffChatId: number, limit = 1000): TicketWithUser[]
  {
    return this.tickets.listClosedTicketsPendingArchive(staffChatId, limit);
  }

  createTicketBatchExport(input: CreateTicketBatchExportInput): void
  {
    return this.batch.createTicketBatchExport(input);
  }

  getTicketBatchExport(exportId: string, staffChatId: number): TicketBatchExportRecord | undefined
  {
    return this.batch.getTicketBatchExport(exportId, staffChatId);
  }

  listTicketBatchExportItems(exportId: string): TicketBatchExportItemRecord[]
  {
    return this.batch.listTicketBatchExportItems(exportId);
  }

  markTicketBatchExportDelivered(exportId: string, staffChatId: number, deliveryMessageId: number): void
  {
    return this.batch.markTicketBatchExportDelivered(exportId, staffChatId, deliveryMessageId);
  }

  markTicketBatchExportFailed(exportId: string, staffChatId: number, error: string): void
  {
    return this.batch.markTicketBatchExportFailed(exportId, staffChatId, error);
  }

  markTicketBatchExportUnknownDelivery(exportId: string, staffChatId: number, error: string): void
  {
    return this.batch.markTicketBatchExportUnknownDelivery(exportId, staffChatId, error);
  }

  getTicketBatchAnswerPackage(answerPackageId: string, staffChatId: number): TicketBatchAnswerPackageRecord | undefined
  {
    return this.batch.getTicketBatchAnswerPackage(answerPackageId, staffChatId);
  }

  getTicketBatchAnswerPackageByHash(packageHash: string, staffChatId: number): TicketBatchAnswerPackageRecord | undefined
  {
    return this.batch.getTicketBatchAnswerPackageByHash(packageHash, staffChatId);
  }

  getTicketBatchAnswerPackageByPreviewToken(previewToken: string, staffChatId: number): TicketBatchAnswerPackageRecord | undefined
  {
    return this.batch.getTicketBatchAnswerPackageByPreviewToken(previewToken, staffChatId);
  }

  createTicketBatchAnswerPackage(input: CreateTicketBatchAnswerPackageInput): TicketBatchAnswerPackageRecord
  {
    return this.batch.createTicketBatchAnswerPackage(input);
  }

  listTicketBatchAnswerItems(answerPackageId: string): TicketBatchAnswerItemRecord[]
  {
    return this.batch.listTicketBatchAnswerItems(answerPackageId);
  }

  getLatestTicketBatchDeliveryFailure(ticketId: number, staffChatId: number): TicketBatchDeliveryFailureContext | undefined
  {
    return this.batch.getLatestTicketBatchDeliveryFailure(ticketId, staffChatId);
  }

  getLatestTicketBatchStaffSyncContext(ticketId: number, staffChatId: number): TicketBatchStaffSyncContext | undefined
  {
    return this.batch.getLatestTicketBatchStaffSyncContext(ticketId, staffChatId);
  }

  setTicketBatchAnswerPackagePreview(answerPackageId: string, staffChatId: number, preview: { token: string; chatId: number; messageId: number; page: number }): boolean
  {
    return this.batch.setTicketBatchAnswerPackagePreview(answerPackageId, staffChatId, preview);
  }

  updateTicketBatchAnswerPackagePreviewPage(answerPackageId: string, staffChatId: number, page: number): void
  {
    return this.batch.updateTicketBatchAnswerPackagePreviewPage(answerPackageId, staffChatId, page);
  }

  clearTicketBatchAnswerPackagePreview(answerPackageId: string, staffChatId: number): void
  {
    return this.batch.clearTicketBatchAnswerPackagePreview(answerPackageId, staffChatId);
  }

  claimTicketBatchAnswerPackage(answerPackageId: string, staffChatId: number): TicketBatchAnswerPackageRecord | undefined
  {
    return this.batch.claimTicketBatchAnswerPackage(answerPackageId, staffChatId);
  }

  cancelTicketBatchAnswerPackage(answerPackageId: string, staffChatId: number): boolean
  {
    return this.batch.cancelTicketBatchAnswerPackage(answerPackageId, staffChatId);
  }

  claimTicketBatchAnswerItem(answerPackageId: string, ticketId: number): boolean
  {
    return this.batch.claimTicketBatchAnswerItem(answerPackageId, ticketId);
  }

  updateTicketBatchAnswerItem(answerPackageId: string, ticketId: number, state: TicketBatchAnswerItemState, options: { deliveryMessageId?: number | null; lastError?: string | null; applied?: boolean } = {}): void
  {
    return this.batch.updateTicketBatchAnswerItem(answerPackageId, ticketId, state, options);
  }

  recordTicketBatchDeliveryFailure(
    answerPackageId: string,
    ticketId: number,
    state: "FAILED" | "UNKNOWN_DELIVERY",
    diagnostic: NormalizedDeliveryError
  ): void
  {
    return this.batch.recordTicketBatchDeliveryFailure(answerPackageId, ticketId, state, diagnostic);
  }

  recordTicketBatchFailureEvent(
    answerPackageId: string,
    ticketId: number,
    state: TicketBatchFailureEventState,
    messageId?: number | null,
    options: { nextRetryAt?: string | null; incrementAttempt?: boolean } = {}
  ): void
  {
    return this.batch.recordTicketBatchFailureEvent(answerPackageId, ticketId, state, messageId, options);
  }

  listPendingTicketBatchFailureEvents(staffChatId: number, at: string, limit = 20): TicketBatchAnswerItemRecord[]
  {
    return this.batch.listPendingTicketBatchFailureEvents(staffChatId, at, limit);
  }

  recordTicketBatchSummaryDelivery(answerPackageId: string, staffChatId: number, state: TicketBatchSummaryDeliveryState, error: string | null = null): void
  {
    return this.batch.recordTicketBatchSummaryDelivery(answerPackageId, staffChatId, state, error);
  }

  queueTicketBatchFinalSummary(
    answerPackageId: string,
    staffChatId: number,
    input: { text: string; chatId: number; originChatId?: number | null; originMessageId?: number | null }
  ): void
  {
    return this.batch.queueTicketBatchFinalSummary(answerPackageId, staffChatId, input);
  }

  queueTicketBatchFinalSummaryRefresh(answerPackageId: string, staffChatId: number, text: string): boolean
  {
    return this.batch.queueTicketBatchFinalSummaryRefresh(answerPackageId, staffChatId, text);
  }

  listPendingTicketBatchFinalSummaries(staffChatId: number, at: string, limit = 20): TicketBatchAnswerPackageRecord[]
  {
    return this.batch.listPendingTicketBatchFinalSummaries(staffChatId, at, limit);
  }

  recordTicketBatchFinalSummaryAttempt(answerPackageId: string, staffChatId: number): void
  {
    return this.batch.recordTicketBatchFinalSummaryAttempt(answerPackageId, staffChatId);
  }

  recordTicketBatchFinalSummarySent(answerPackageId: string, staffChatId: number, messageId: number): void
  {
    return this.batch.recordTicketBatchFinalSummarySent(answerPackageId, staffChatId, messageId);
  }

  recordTicketBatchFinalSummaryFailure(answerPackageId: string, staffChatId: number, state: "FAILED" | "UNKNOWN_DELIVERY", error: string, nextRetryAt: string | null): void
  {
    return this.batch.recordTicketBatchFinalSummaryFailure(answerPackageId, staffChatId, state, error, nextRetryAt);
  }

  recordTicketBatchTopicEcho(answerPackageId: string, ticketId: number, state: TicketBatchTopicEchoState, options: { chatId?: number | null; threadId?: number | null; messageId?: number | null; lastError?: string | null; nextRetryAt?: string | null; incrementAttempt?: boolean; diagnostic?: NormalizedDeliveryError } = {}): void
  {
    return this.batch.recordTicketBatchTopicEcho(answerPackageId, ticketId, state, options);
  }

  listPendingTicketBatchTopicEchoes(staffChatId: number, at: string, limit = 20): TicketBatchAnswerItemRecord[]
  {
    return this.batch.listPendingTicketBatchTopicEchoes(staffChatId, at, limit);
  }

  listClosedTicketBatchReplyAndClosePendingEchoes(staffChatId: number, limit = 20): TicketBatchAnswerItemRecord[]
  {
    return this.batch.listClosedTicketBatchReplyAndClosePendingEchoes(staffChatId, limit);
  }

  setTicketBatchPostDeliveryRetry(answerPackageId: string, ticketId: number, nextRetryAt: string | null, lastError: string | null): void
  {
    return this.batch.setTicketBatchPostDeliveryRetry(answerPackageId, ticketId, nextRetryAt, lastError);
  }

  listPendingTicketBatchReplyAndCloseContinuations(staffChatId: number, at: string, limit = 20): TicketBatchAnswerItemRecord[]
  {
    return this.batch.listPendingTicketBatchReplyAndCloseContinuations(staffChatId, at, limit);
  }

  getNextTicketBatchStaffRetryAt(staffChatId: number): string | undefined
  {
    return this.batch.getNextTicketBatchStaffRetryAt(staffChatId);
  }

  listInvalidTicketBatchSuccessEchoes(staffChatId: number, limit = 20): TicketBatchAnswerItemRecord[]
  {
    return this.batch.listInvalidTicketBatchSuccessEchoes(staffChatId, limit);
  }

  getTicketBatchRecoveryAudit(staffChatId: number, at: string): TicketBatchRecoveryAudit
  {
    return this.batch.getTicketBatchRecoveryAudit(staffChatId, at);
  }

  setTicketFollowUpContext(ticketId: number, input: { followUpState: TicketFollowUpState; internalNote: string | null; escalationTarget: TicketEscalationTarget; sourceAnswerPackageId?: string | null }): TicketRecord | undefined
  {
    return this.tickets.setTicketFollowUpContext(ticketId, input);
  }

  clearWaitingUserFollowUp(ticketId: number): TicketRecord | undefined
  {
    return this.tickets.clearWaitingUserFollowUp(ticketId);
  }

  listTicketFollowUpHistory(ticketId: number): TicketFollowUpHistoryRecord[]
  {
    return this.tickets.listTicketFollowUpHistory(ticketId);
  }

  finalizeTicketBatchAnswerPackage(answerPackageId: string, staffChatId: number): TicketBatchAnswerPackageRecord | undefined
  {
    return this.batch.finalizeTicketBatchAnswerPackage(answerPackageId, staffChatId);
  }

  getLanguageModerationUserState(chatId: number, userId: number): LanguageModerationUserState | undefined
  {
    return this.moderation.getLanguageModerationUserState(chatId, userId);
  }

  upsertLanguageModerationUserState(input: Omit<LanguageModerationUserState, "updated_at">): void
  {
    return this.moderation.upsertLanguageModerationUserState(input);
  }

  addLanguageModerationViolation(input: Pick<LanguageModerationViolation, "chat_id" | "user_telegram_id" | "message_id" | "username" | "cycle_tier"> & { message_thread_id?: number | null }): boolean
  {
    return this.moderation.addLanguageModerationViolation(input);
  }

  listLanguageModerationViolations(chatId: number, since: string): LanguageModerationViolation[]
  {
    return this.moderation.listLanguageModerationViolations(chatId, since);
  }

  claimLanguageModerationFirstStrikes(chatId: number, since: string, messageThreadId: number | null = null): Array<{ userId: number; username: string | null; messageId: number }>
  {
    return this.moderation.claimLanguageModerationFirstStrikes(chatId, since, messageThreadId);
  }

  clearLanguageModerationViolations(chatId: number, userId: number): void
  {
    return this.moderation.clearLanguageModerationViolations(chatId, userId);
  }

  listLanguageModerationCycleViolations(chatId: number, userId: number, cycleTier: number): LanguageModerationViolation[]
  {
    return this.moderation.listLanguageModerationCycleViolations(chatId, userId, cycleTier);
  }

  listPendingLanguageModerationCycleViolations(chatId: number, userId: number, cycleTier: number): LanguageModerationViolation[]
  {
    return this.moderation.listPendingLanguageModerationCycleViolations(chatId, userId, cycleTier);
  }

  assignLanguageModerationViolationCycle(chatId: number, userId: number, cycleTier: number, cycleId: string): number
  {
    return this.moderation.assignLanguageModerationViolationCycle(chatId, userId, cycleTier, cycleId);
  }

  listLanguageModerationCleanupCycleViolations(chatId: number, userId: number, cycleId: string): LanguageModerationViolation[]
  {
    return this.moderation.listLanguageModerationCleanupCycleViolations(chatId, userId, cycleId);
  }

  listPendingLanguageModerationCleanupCycleViolations(chatId: number, userId: number, cycleId: string): LanguageModerationViolation[]
  {
    return this.moderation.listPendingLanguageModerationCleanupCycleViolations(chatId, userId, cycleId);
  }

  recordLanguageModerationViolationCleanupResult(input: {
    chatId: number;
    userId: number;
    messageId: number;
    state: LanguageModerationViolationCleanupState;
    errorCategory?: string | null;
    errorCode?: number | null;
    errorDescription?: string | null;
  }): void
  {
    return this.moderation.recordLanguageModerationViolationCleanupResult(input);
  }

  clearLanguageModerationCycleViolations(chatId: number, userId: number, cycleTier: number): void
  {
    return this.moderation.clearLanguageModerationCycleViolations(chatId, userId, cycleTier);
  }

  clearLanguageModerationCleanupCycleViolations(chatId: number, userId: number, cycleId: string): void
  {
    return this.moderation.clearLanguageModerationCleanupCycleViolations(chatId, userId, cycleId);
  }

  getLanguageModerationChatState(chatId: number): LanguageModerationWarningState | undefined
  {
    return this.moderation.getLanguageModerationChatState(chatId);
  }

  upsertLanguageModerationChatState(chatId: number, values: { lastWarningMessageId?: number | null; lastWarningAt?: string | null; ordinaryMessagesSinceWarning: number; pendingWarningDueAt?: string | null; pendingWarningStartedAt?: string | null }): void
  {
    return this.moderation.upsertLanguageModerationChatState(chatId, values);
  }

  getLanguageModerationWarningState(chatId: number, messageThreadId: number | null): LanguageModerationWarningState | undefined
  {
    return this.moderation.getLanguageModerationWarningState(chatId, messageThreadId);
  }

  upsertLanguageModerationWarningState(
    chatId: number,
    messageThreadId: number | null,
    values: { lastWarningMessageId?: number | null; lastWarningAt?: string | null; ordinaryMessagesSinceWarning: number; pendingWarningDueAt?: string | null; pendingWarningStartedAt?: string | null }
  ): void
  {
    return this.moderation.upsertLanguageModerationWarningState(chatId, messageThreadId, values);
  }

  createLanguageModerationCleanupJob(input: Omit<LanguageModerationCleanupJob, "id" | "state" | "created_at" | "updated_at">): number
  {
    return this.moderation.createLanguageModerationCleanupJob(input);
  }

  getLanguageModerationCleanupJob(jobId: number): LanguageModerationCleanupJob | undefined
  {
    return this.moderation.getLanguageModerationCleanupJob(jobId);
  }

  listLanguageModerationRecoveryJobs(staffChatId: number, nowIso: string): LanguageModerationCleanupJob[]
  {
    return this.moderation.listLanguageModerationRecoveryJobs(staffChatId, nowIso);
  }

  updateLanguageModerationCleanupJob(id: number, state: LanguageModerationCleanupJob["state"]): void
  {
    return this.moderation.updateLanguageModerationCleanupJob(id, state);
  }

  claimEntityNotificationPublication(input: { provider: string; entityType: string; entityId: string; eventType: "created"; observedAt: string; targetChatId: number }): EntityNotificationPublicationState
  {
    return this.installation.claimEntityNotificationPublication(input);
  }

  recordEntityNotificationPublished(provider: string, entityType: string, entityId: string, eventType: "created", telegramMessageId: number): void
  {
    return this.installation.recordEntityNotificationPublished(provider, entityType, entityId, eventType, telegramMessageId);
  }

  recordEntityNotificationFailure(provider: string, entityType: string, entityId: string, eventType: "created", error: string): void
  {
    return this.installation.recordEntityNotificationFailure(provider, entityType, entityId, eventType, error);
  }

  countEntityNotificationPublications(state?: EntityNotificationPublicationState): number
  {
    return this.installation.countEntityNotificationPublications(state);
  }

  getSetting(key: string): string | undefined
  {
    return this.installation.getSetting(key);
  }

  setSetting(key: string, value: string): void
  {
    return this.installation.setSetting(key, value);
  }

  seedQuickReplies(categories: ReadonlyArray<{ id: string; title: string; templates: ReadonlyArray<{ id: string; title: string; text: string }> }>): void
  {
    return this.quickReplies.seedQuickReplies(categories);
  }

  listQuickReplyCategories(): QuickReplyCategoryRecord[]
  {
    return this.quickReplies.listQuickReplyCategories();
  }

  listQuickReplyTemplates(categoryId: string): QuickReplyTemplateRecord[]
  {
    return this.quickReplies.listQuickReplyTemplates(categoryId);
  }

  getQuickReplyTemplate(templateId: string): QuickReplyTemplateRecord | undefined
  {
    return this.quickReplies.getQuickReplyTemplate(templateId);
  }

  updateQuickReplyTemplate(templateId: string, input: { title: string; text: string }): QuickReplyTemplateRecord | undefined
  {
    return this.quickReplies.updateQuickReplyTemplate(templateId, input);
  }

  createQuickReplyTemplate(input: { id: string; categoryId: string; title: string; text: string }): QuickReplyTemplateRecord
  {
    return this.quickReplies.createQuickReplyTemplate(input);
  }

  deleteQuickReplyTemplate(templateId: string): "DELETED" | "NOT_FOUND" | "LAST_TEMPLATE"
  {
    return this.quickReplies.deleteQuickReplyTemplate(templateId);
  }

  getInstallationState(): InstallationStateRecord
  {
    return this.installation.getInstallationState();
  }

  setInstallationState(input: Partial<Pick<InstallationStateRecord, "setup_state" | "authorization_mode" | "active_workspace_id">>): void
  {
    return this.installation.setInstallationState(input);
  }

  upsertWorkspace(input: { telegramChatId: number; title?: string | null; username?: string | null; importedFromLegacy?: boolean }): WorkspaceRecord
  {
    return this.installation.upsertWorkspace(input);
  }

  getWorkspaceByChatId(chatId: number): WorkspaceRecord | undefined
  {
    return this.installation.getWorkspaceByChatId(chatId);
  }

  getActiveWorkspace(): WorkspaceRecord | undefined
  {
    return this.installation.getActiveWorkspace();
  }

  listWorkspaces(): WorkspaceRecord[]
  {
    return this.installation.listWorkspaces();
  }

  importManagedPublicChat(chatId: number, workspaceId: number): void
  {
    return this.installation.importManagedPublicChat(chatId, workspaceId);
  }

  upsertManagedPublicChat(input: {
    chatId: number;
    workspaceId?: number | null;
    title?: string | null;
    username?: string | null;
    isForum?: boolean;
  }): ManagedPublicChatRecord
  {
    return this.installation.upsertManagedPublicChat(input);
  }

  getManagedPublicChat(chatId: number, includeInactive = false): ManagedPublicChatRecord | undefined
  {
    return this.installation.getManagedPublicChat(chatId, includeInactive);
  }

  listManagedPublicChats(includeInactive = false): ManagedPublicChatRecord[]
  {
    return this.installation.listManagedPublicChats(includeInactive);
  }

  updateManagedPublicChatConfig(chatId: number, input: {
    warningText: string;
    allowlist: readonly string[];
    warningCooldownMinutes: number;
    warningMessageThreshold: number;
    lookbackMinutes: number;
  }): boolean
  {
    return this.installation.updateManagedPublicChatConfig(chatId, input);
  }

  setManagedPublicChatModerationEnabled(chatId: number, enabled: boolean): boolean
  {
    return this.installation.setManagedPublicChatModerationEnabled(chatId, enabled);
  }

  recordManagedPublicChatPermissionHealth(input: {
    chatId: number;
    healthy: boolean;
    reactionsAvailable: boolean | null;
    connected?: boolean;
    title?: string | null;
    username?: string | null;
    isForum?: boolean;
  }): boolean
  {
    return this.installation.recordManagedPublicChatPermissionHealth(input);
  }

  recordManagedPublicChatUnreachable(chatId: number): boolean
  {
    return this.installation.recordManagedPublicChatUnreachable(chatId);
  }

  deactivateManagedPublicChat(chatId: number): boolean
  {
    return this.installation.deactivateManagedPublicChat(chatId);
  }

  getTeamMember(userId: number): TeamMemberRecord | undefined
  {
    return this.installation.getTeamMember(userId);
  }

  listTeamMembers(): TeamMemberRecord[]
  {
    return this.installation.listTeamMembers();
  }

  upsertTeamMember(input: { userId: number; username?: string | null; displayName?: string | null; role: TeamRole; addedBy?: number | null }): void
  {
    return this.installation.upsertTeamMember(input);
  }

  revokeTeamMember(userId: number): boolean
  {
    return this.installation.revokeTeamMember(userId);
  }

  transferOwner(newOwnerId: number): void
  {
    return this.installation.transferOwner(newOwnerId);
  }

  invalidateUnconsumedTokens(kind: SecureTokenRecord["kind"]): void
  {
    return this.installation.invalidateUnconsumedTokens(kind);
  }

  insertSecureToken(input: { tokenHash: string; kind: SecureTokenRecord["kind"]; role?: TeamRole | null; createdBy?: number | null; expiresAt: string }): void
  {
    return this.installation.insertSecureToken(input);
  }

  listUnconsumedTokens(kind?: SecureTokenRecord["kind"]): SecureTokenRecord[]
  {
    return this.installation.listUnconsumedTokens(kind);
  }

  consumeOwnerTokenAndCreateOwner(tokenId: number, user: UserInput, at: string): "PAIRED" | "TRANSFER_PENDING" | "INVALID"
  {
    return this.installation.consumeOwnerTokenAndCreateOwner(tokenId, user, at);
  }

  invalidateTokenAndAssignMember(tokenId: number, user: UserInput, role: TeamRole, at: string): void
  {
    return this.installation.invalidateTokenAndAssignMember(tokenId, user, role, at);
  }

  hasPendingOwnerTransfer(userId: number): boolean
  {
    return this.installation.hasPendingOwnerTransfer(userId);
  }

  confirmOwnerTransfer(userId: number): void
  {
    return this.installation.confirmOwnerTransfer(userId);
  }

  saveOnboardingSession(userId: number, stage: string, state = "ACTIVE", candidateChatId?: number | null): void
  {
    return this.installation.saveOnboardingSession(userId, stage, state, candidateChatId);
  }

  getOnboardingSession(userId: number): OnboardingSessionRecord | undefined
  {
    return this.installation.getOnboardingSession(userId);
  }

  setOnboardingPrimaryMessage(userId: number, chatId: number | null, messageId: number | null): void
  {
    return this.installation.setOnboardingPrimaryMessage(userId, chatId, messageId);
  }

  getInstallationOperationalCounts(): { publicChats: number; moderationEnabled: number; unhealthyModerationChats: number; pendingCleanup: number; pendingArchives: number; pendingBatchStaffOperations: number }
  {
    return this.installation.getInstallationOperationalCounts();
  }

  getBannedUser(userTelegramId: number): BannedUserRecord | undefined
  {
    return this.tickets.getBannedUser(userTelegramId);
  }

  banUser(input: BanUserInput): void
  {
    return this.tickets.banUser(input);
  }

  unbanUser(userTelegramId: number): boolean
  {
    return this.tickets.unbanUser(userTelegramId);
  }

  listBannedUsers(limit = 50): BannedUserRecord[]
  {
    return this.tickets.listBannedUsers(limit);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const migrations: Migration[] = [
      {
        id: 1,
        name: "create_core_tables",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
              telegram_id INTEGER PRIMARY KEY,
              username TEXT,
              first_name TEXT,
              last_name TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tickets (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_telegram_id INTEGER NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('OPEN', 'WAITING_USER', 'IN_PROGRESS', 'CLOSED')),
              staff_chat_id INTEGER,
              message_thread_id INTEGER,
              staff_message_id INTEGER,
              logs_message_id INTEGER,
              transcript_message_id INTEGER,
              archived_at TEXT,
              closed_by_type TEXT CHECK(closed_by_type IN ('USER', 'STAFF', 'SYSTEM')),
              closed_by_display_name TEXT,
              closed_by_username TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              closed_at TEXT,
              FOREIGN KEY(user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ticket_id INTEGER NOT NULL,
              direction TEXT NOT NULL CHECK(direction IN ('USER_TO_STAFF', 'STAFF_TO_USER', 'SYSTEM')),
              source_chat_id INTEGER,
              source_message_id INTEGER,
              delivery_chat_id INTEGER,
              delivery_message_id INTEGER,
              from_telegram_id INTEGER,
              from_username TEXT,
              sender_type TEXT CHECK(sender_type IN ('USER', 'STAFF', 'SYSTEM')),
              sender_display_name TEXT,
              sender_username TEXT,
              text TEXT,
              media_type TEXT,
              filename TEXT,
              file_id TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
          `);
        }
      },
      {
        id: 2,
        name: "ensure_ticket_topic_columns",
        up: () => {
          this.addColumnIfMissing("tickets", "staff_chat_id", "INTEGER");
          this.addColumnIfMissing("tickets", "message_thread_id", "INTEGER");
          this.addColumnIfMissing("tickets", "staff_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "closed_at", "TEXT");
          this.addColumnIfMissing("tickets", "logs_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "transcript_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "archived_at", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_type", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_display_name", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_username", "TEXT");
        }
      },
      {
        id: 3,
        name: "create_banned_users",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS banned_users (
              user_telegram_id INTEGER PRIMARY KEY,
              username TEXT,
              reason TEXT NOT NULL,
              banned_by INTEGER,
              created_at TEXT NOT NULL
            );
          `);
        }
      },
      {
        id: 4,
        name: "create_indexes",
        up: () => {
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_tickets_user_status
              ON tickets(user_telegram_id, status);

            CREATE INDEX IF NOT EXISTS idx_tickets_user_staff_status
              ON tickets(user_telegram_id, staff_chat_id, status);

            CREATE INDEX IF NOT EXISTS idx_tickets_staff_thread
              ON tickets(staff_chat_id, message_thread_id);

            CREATE INDEX IF NOT EXISTS idx_tickets_staff_message
              ON tickets(staff_chat_id, staff_message_id);

            CREATE INDEX IF NOT EXISTS idx_messages_ticket_created
              ON messages(ticket_id, created_at);
          `);
        }
      },
      {
        id: 5,
        name: "enforce_single_active_ticket_per_staff_chat",
        up: () => {
          const timestamp = now();
          this.db
            .prepare(
              `
              UPDATE tickets
              SET status = 'CLOSED',
                  updated_at = ?,
                  closed_at = COALESCE(closed_at, ?)
              WHERE status != 'CLOSED'
                AND id NOT IN (
                  SELECT MAX(id)
                  FROM tickets
                  WHERE status != 'CLOSED'
                  GROUP BY user_telegram_id, staff_chat_id
                )
            `
            )
            .run(timestamp, timestamp);

          this.db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_ticket_user_staff
              ON tickets(user_telegram_id, staff_chat_id)
              WHERE status != 'CLOSED';
          `);
        }
      },
      {
        id: 6,
        name: "harden_existing_forum_topic_schema",
        up: () => {
          const timestamp = now();
          this.db
            .prepare(
              `
              UPDATE tickets
              SET status = 'CLOSED',
                  updated_at = ?,
                  closed_at = COALESCE(closed_at, ?)
              WHERE status != 'CLOSED'
                AND (staff_chat_id IS NULL OR message_thread_id IS NULL)
            `
            )
            .run(timestamp, timestamp);

          if (this.hasTable("staff_message_links")) {
            this.db.exec(`
              DELETE FROM staff_message_links
              WHERE id NOT IN (
                SELECT MIN(id)
                FROM staff_message_links
                GROUP BY staff_chat_id, staff_message_id
              );

              CREATE UNIQUE INDEX IF NOT EXISTS uniq_staff_message_links_staff_message
                ON staff_message_links(staff_chat_id, staff_message_id);
            `);
          }
        }
      },
      {
        id: 7,
        name: "add_archive_settings_and_transcript_columns",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
          `);

          this.addColumnIfMissing("tickets", "logs_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "transcript_message_id", "INTEGER");
          this.addColumnIfMissing("tickets", "archived_at", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_type", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_display_name", "TEXT");
          this.addColumnIfMissing("tickets", "closed_by_username", "TEXT");

          this.addColumnIfMissing("messages", "sender_type", "TEXT");
          this.addColumnIfMissing("messages", "sender_display_name", "TEXT");
          this.addColumnIfMissing("messages", "sender_username", "TEXT");
          this.addColumnIfMissing("messages", "filename", "TEXT");

          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_tickets_archive_pending
              ON tickets(staff_chat_id, status, archived_at);
          `);
        }
      },
      {
        id: 8,
        name: "create_ticket_batch_exports",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS ticket_batch_exports (
              export_id TEXT PRIMARY KEY,
              staff_chat_id INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              selection_mode TEXT NOT NULL,
              ticket_count INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ticket_batch_export_items (
              export_id TEXT NOT NULL,
              ticket_id INTEGER NOT NULL,
              snapshot_token TEXT NOT NULL,
              PRIMARY KEY (export_id, ticket_id),
              FOREIGN KEY (export_id) REFERENCES ticket_batch_exports(export_id) ON DELETE CASCADE
            );
          `);
        }
      },
      {
        id: 9,
        name: "create_ticket_batch_answer_packages",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS ticket_batch_answer_packages (
              answer_package_id TEXT PRIMARY KEY, export_id TEXT NOT NULL, staff_chat_id INTEGER NOT NULL,
              package_hash TEXT NOT NULL, source_chat_id INTEGER, source_message_id INTEGER,
              package_created_at TEXT NOT NULL, imported_at TEXT NOT NULL, status TEXT NOT NULL,
              started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
              FOREIGN KEY (export_id) REFERENCES ticket_batch_exports(export_id) ON DELETE CASCADE,
              UNIQUE (staff_chat_id, package_hash)
            );
            CREATE TABLE IF NOT EXISTS ticket_batch_answer_items (
              answer_package_id TEXT NOT NULL, ticket_id INTEGER NOT NULL, snapshot_token TEXT NOT NULL,
              action TEXT NOT NULL, reply_text TEXT, state TEXT NOT NULL, delivery_message_id INTEGER,
              applied_at TEXT, last_error TEXT, updated_at TEXT NOT NULL,
              PRIMARY KEY (answer_package_id, ticket_id),
              FOREIGN KEY (answer_package_id) REFERENCES ticket_batch_answer_packages(answer_package_id) ON DELETE CASCADE
            );
          `);
        }
      },
      {
        id: 10,
        name: "create_language_moderation_state",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS language_moderation_user_state (
              chat_id INTEGER NOT NULL, user_telegram_id INTEGER NOT NULL, username TEXT,
              current_strikes INTEGER NOT NULL DEFAULT 0 CHECK(current_strikes BETWEEN 0 AND 2),
              sanction_tier INTEGER NOT NULL DEFAULT 0 CHECK(sanction_tier BETWEEN 0 AND 3),
              first_strike_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(chat_id, user_telegram_id)
            );
            CREATE TABLE IF NOT EXISTS language_moderation_chat_state (
              chat_id INTEGER PRIMARY KEY, last_warning_message_id INTEGER, last_warning_at TEXT,
              ordinary_messages_since_warning INTEGER NOT NULL DEFAULT 0, pending_warning_due_at TEXT, pending_warning_started_at TEXT, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS language_moderation_violations (
              chat_id INTEGER NOT NULL, user_telegram_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
              username TEXT, detected_at TEXT NOT NULL, cycle_tier INTEGER NOT NULL,
              moderation_cycle_id TEXT,
              cleanup_state TEXT NOT NULL DEFAULT 'PENDING' CHECK(cleanup_state IN ('PENDING','DELETED','ALREADY_ABSENT','TERMINAL_FAILED')),
              cleanup_attempt_count INTEGER NOT NULL DEFAULT 0, cleanup_last_error_category TEXT, cleanup_last_error_code INTEGER,
              cleanup_last_error_description TEXT, cleanup_completed_at TEXT,
              PRIMARY KEY(chat_id, message_id)
            );
            CREATE INDEX IF NOT EXISTS idx_language_moderation_violations_lookup
              ON language_moderation_violations(chat_id, detected_at, user_telegram_id);
            CREATE TABLE IF NOT EXISTS language_moderation_cleanup_jobs (
              id INTEGER PRIMARY KEY AUTOINCREMENT, staff_chat_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, user_telegram_id INTEGER NOT NULL,
              username TEXT, chat_title TEXT, sanction_tier INTEGER NOT NULL, sanction_kind TEXT NOT NULL,
              violation_cycle_id TEXT,
              cleanup_due_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','CLEANING','LOG_PENDING','COMPLETED')),
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_language_moderation_cleanup_due
              ON language_moderation_cleanup_jobs(staff_chat_id, state, cleanup_due_at);
          `);
        }
      },
      {
        id: 11,
        name: "scope_language_moderation_cleanup_jobs_to_staff_chat",
        up: () => {
          this.addColumnIfMissing("language_moderation_cleanup_jobs", "staff_chat_id", "INTEGER");
          this.db.exec(`
            DROP INDEX IF EXISTS idx_language_moderation_cleanup_due;
            CREATE INDEX idx_language_moderation_cleanup_due
              ON language_moderation_cleanup_jobs(staff_chat_id, state, cleanup_due_at);
          `);
        }
      },
      {
        id: 12,
        name: "create_entity_notification_publications",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS entity_notification_publications (
              provider TEXT NOT NULL,
              entity_type TEXT NOT NULL,
              entity_id TEXT NOT NULL,
              event_type TEXT NOT NULL CHECK(event_type = 'created'),
              observed_at TEXT NOT NULL,
              target_chat_id INTEGER,
              state TEXT NOT NULL CHECK(state IN ('CLAIMED', 'PUBLISHED', 'FAILED', 'UNKNOWN_DELIVERY')),
              telegram_message_id INTEGER,
              first_seen_at TEXT NOT NULL,
              published_at TEXT,
              updated_at TEXT NOT NULL,
              last_error TEXT,
              PRIMARY KEY(provider, entity_type, entity_id, event_type)
            );
            CREATE INDEX IF NOT EXISTS idx_entity_notification_publications_state
              ON entity_notification_publications(state, updated_at);
          `);
        }
      },
      {
        id: 13,
        name: "track_ticket_batch_delivery_and_preview",
        up: () => {
          this.addColumnIfMissing("ticket_batch_exports", "delivery_state", "TEXT NOT NULL DEFAULT 'DELIVERED'");
          this.addColumnIfMissing("ticket_batch_exports", "delivery_message_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_exports", "delivered_at", "TEXT");
          this.addColumnIfMissing("ticket_batch_exports", "last_error", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_packages", "preview_token", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_packages", "preview_chat_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "preview_message_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "preview_page", "INTEGER");
          this.db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_ticket_batch_preview_token
              ON ticket_batch_answer_packages(preview_token)
              WHERE preview_token IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_ticket_batch_exports_delivery
              ON ticket_batch_exports(staff_chat_id, delivery_state, created_at);
          `);
        }
      },
      {
        id: 14,
        name: "add_ticket_follow_up_history_and_batch_topic_echoes",
        up: () => {
          this.addColumnIfMissing("tickets", "follow_up_state", "TEXT NOT NULL DEFAULT 'NONE' CHECK(follow_up_state IN ('NONE','WAITING_USER','WAITING_DEVS','WAITING_QUEST_OWNER','MONITORING'))");
          this.addColumnIfMissing("tickets", "internal_note", "TEXT");
          this.addColumnIfMissing("tickets", "escalation_target", "TEXT NOT NULL DEFAULT 'NONE' CHECK(escalation_target IN ('NONE','DEVS','PAYMENTS','SECURITY','QUEST_OWNER','SUPPORT'))");
          this.addColumnIfMissing("tickets", "follow_up_updated_at", "TEXT");
          this.addColumnIfMissing("tickets", "follow_up_source_answer_package_id", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "follow_up_state", "TEXT NOT NULL DEFAULT 'NONE'");
          this.addColumnIfMissing("ticket_batch_answer_items", "internal_note", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "escalation_target", "TEXT NOT NULL DEFAULT 'NONE'");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_chat_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_thread_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_message_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_state", "TEXT NOT NULL DEFAULT 'PENDING'");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_last_error", "TEXT");
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS ticket_follow_up_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ticket_id INTEGER NOT NULL,
              follow_up_state TEXT NOT NULL CHECK(follow_up_state IN ('NONE','WAITING_USER','WAITING_DEVS','WAITING_QUEST_OWNER','MONITORING')),
              internal_note TEXT,
              escalation_target TEXT NOT NULL CHECK(escalation_target IN ('NONE','DEVS','PAYMENTS','SECURITY','QUEST_OWNER','SUPPORT')),
              source_answer_package_id TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_ticket_follow_up_history_ticket
              ON ticket_follow_up_history(ticket_id, id);
            CREATE INDEX IF NOT EXISTS idx_ticket_batch_answer_item_echo
              ON ticket_batch_answer_items(answer_package_id, topic_echo_state, ticket_id);
          `);
        }
      },
      {
        id: 15,
        name: "add_batch_delivery_diagnostics",
        up: () => {
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_error_category", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_error_permanence", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_error_code", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_http_status", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_error_method", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_retry_after_seconds", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_error_description", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_failed_at", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_attempt_count", "INTEGER NOT NULL DEFAULT 0");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_failure_event_state", "TEXT NOT NULL DEFAULT 'NOT_REQUIRED'");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_failure_event_message_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "summary_delivery_state", "TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED'");
          this.addColumnIfMissing("ticket_batch_answer_packages", "summary_delivery_error", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_packages", "summary_delivery_attempted_at", "TEXT");
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_ticket_batch_answer_items_delivery_failure
              ON ticket_batch_answer_items(answer_package_id, delivery_error_permanence, ticket_id);
          `);
        }
      },
      {
        id: 16,
        name: "make_ticket_batch_staff_finalization_retryable",
        up: () => {
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_state", "TEXT NOT NULL DEFAULT 'NOT_PENDING'");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_text", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_chat_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_origin_chat_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_origin_message_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_message_id", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_attempt_count", "INTEGER NOT NULL DEFAULT 0");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_next_retry_at", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_last_error", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_packages", "final_summary_delivered_at", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_attempt_count", "INTEGER NOT NULL DEFAULT 0");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_next_retry_at", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_failure_event_attempt_count", "INTEGER NOT NULL DEFAULT 0");
          this.addColumnIfMissing("ticket_batch_answer_items", "delivery_failure_event_next_retry_at", "TEXT");
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_ticket_batch_final_summary_recovery
              ON ticket_batch_answer_packages(staff_chat_id, final_summary_state, final_summary_next_retry_at);
            CREATE INDEX IF NOT EXISTS idx_ticket_batch_topic_echo_recovery
              ON ticket_batch_answer_items(topic_echo_state, topic_echo_next_retry_at, answer_package_id);
            UPDATE ticket_batch_answer_packages
            SET final_summary_state = 'PENDING',
                final_summary_chat_id = staff_chat_id,
                final_summary_next_retry_at = COALESCE(final_summary_next_retry_at, updated_at)
            WHERE final_summary_state = 'NOT_PENDING'
              AND status IN ('COMPLETED', 'PARTIAL')
              AND summary_delivery_state = 'FAILED';
            UPDATE ticket_batch_answer_items
            SET topic_echo_state = 'NOT_REQUIRED',
                topic_echo_last_error = 'Success echo is not applicable after an unconfirmed user delivery.',
                topic_echo_next_retry_at = NULL
            WHERE action IN ('reply_keep_open', 'reply_and_close')
              AND delivery_message_id IS NULL
              AND delivery_error_category IS NOT NULL
              AND topic_echo_state IN ('PENDING', 'FAILED');
            UPDATE ticket_batch_answer_items
            SET topic_echo_next_retry_at = COALESCE(topic_echo_next_retry_at, updated_at)
            WHERE topic_echo_state IN ('PENDING', 'FAILED');
            UPDATE ticket_batch_answer_items
            SET delivery_failure_event_next_retry_at = COALESCE(delivery_failure_event_next_retry_at, updated_at)
            WHERE delivery_failure_event_state IN ('PENDING', 'FAILED')
              AND delivery_error_category IS NOT NULL;
          `);
        }
      },
      {
        id: 17,
        name: "classify_terminal_ticket_batch_staff_events",
        up: () => {
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_error_category", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_error_code", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_http_status", "INTEGER");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_error_method", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_error_description", "TEXT");
          this.addColumnIfMissing("ticket_batch_answer_items", "topic_echo_terminal_at", "TEXT");
          this.db.exec(`
            UPDATE ticket_batch_answer_items
            SET topic_echo_state = 'TERMINAL_FAILED',
                topic_echo_error_category = CASE
                  WHEN topic_echo_error_category IS NOT NULL THEN topic_echo_error_category
                  WHEN topic_echo_last_error IN ('USER_BLOCKED_BOT', 'USER_DEACTIVATED', 'CHAT_UNAVAILABLE', 'FORBIDDEN', 'RATE_LIMITED', 'TELEGRAM_BAD_REQUEST', 'TELEGRAM_SERVER_ERROR', 'NETWORK_TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN_TELEGRAM_ERROR') THEN topic_echo_last_error
                  ELSE NULL
                END,
                topic_echo_terminal_at = COALESCE(topic_echo_terminal_at, updated_at), topic_echo_next_retry_at = NULL
            WHERE topic_echo_state = 'FAILED' AND topic_echo_next_retry_at = '9999-12-31T23:59:59.999Z';
            UPDATE ticket_batch_answer_items
            SET topic_echo_state = 'NOT_REQUIRED', topic_echo_next_retry_at = NULL,
                topic_echo_last_error = 'Staff topic event is no longer needed for a closed ticket.'
            WHERE topic_echo_state IN ('PENDING', 'FAILED')
              AND ticket_id IN (SELECT id FROM tickets WHERE status = 'CLOSED');
            UPDATE ticket_batch_answer_items
            SET topic_echo_state = 'NOT_REQUIRED', topic_echo_next_retry_at = NULL,
                topic_echo_last_error = 'No staff topic event was requested.'
            WHERE topic_echo_state IN ('PENDING', 'FAILED') AND action = 'no_action'
              AND follow_up_state = 'NONE' AND internal_note IS NULL AND escalation_target = 'NONE';
            UPDATE ticket_batch_answer_items
            SET delivery_failure_event_state = 'NOT_REQUIRED', delivery_failure_event_next_retry_at = NULL
            WHERE delivery_failure_event_state IN ('PENDING', 'FAILED')
              AND ticket_id IN (SELECT id FROM tickets WHERE status = 'CLOSED');
          `);
        }
      },
      {
        id: 18,
        name: "persist_language_moderation_violation_cleanup_progress",
        up: () => {
          if (!this.hasTable("language_moderation_violations")) {
            return;
          }
          this.addColumnIfMissing("language_moderation_violations", "cleanup_state", "TEXT NOT NULL DEFAULT 'PENDING'");
          this.addColumnIfMissing("language_moderation_violations", "cleanup_attempt_count", "INTEGER NOT NULL DEFAULT 0");
          this.addColumnIfMissing("language_moderation_violations", "cleanup_last_error_category", "TEXT");
          this.addColumnIfMissing("language_moderation_violations", "cleanup_last_error_code", "INTEGER");
          this.addColumnIfMissing("language_moderation_violations", "cleanup_last_error_description", "TEXT");
          this.addColumnIfMissing("language_moderation_violations", "cleanup_completed_at", "TEXT");
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_language_moderation_violations_cleanup
              ON language_moderation_violations(chat_id, user_telegram_id, cycle_tier, cleanup_state, message_id);
          `);
        }
      },
      {
        id: 19,
        name: "bind_language_moderation_cleanup_jobs_to_violation_cycles",
        up: () => {
          if (!this.hasTable("language_moderation_violations") || !this.hasTable("language_moderation_cleanup_jobs")) {
            return;
          }
          this.addColumnIfMissing("language_moderation_violations", "moderation_cycle_id", "TEXT");
          this.addColumnIfMissing("language_moderation_cleanup_jobs", "violation_cycle_id", "TEXT");
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_language_moderation_violations_cycle
              ON language_moderation_violations(chat_id, user_telegram_id, moderation_cycle_id, cleanup_state, message_id);
          `);
        }
      },
      {
        id: 20,
        name: "create_guided_installation_and_team_foundation",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS installation_state (
              id INTEGER PRIMARY KEY CHECK(id = 1),
              setup_state TEXT NOT NULL CHECK(setup_state IN ('SETUP_REQUIRED','READY')),
              authorization_mode TEXT NOT NULL CHECK(authorization_mode IN ('LEGACY_TRUSTED_GROUP','RBAC_ACTIVE')),
              active_workspace_id INTEGER,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(active_workspace_id) REFERENCES workspaces(id)
            );
            CREATE TABLE IF NOT EXISTS workspaces (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              telegram_chat_id INTEGER NOT NULL UNIQUE,
              title TEXT,
              username TEXT,
              active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
              imported_from_legacy INTEGER NOT NULL DEFAULT 0 CHECK(imported_from_legacy IN (0,1)),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS team_members (
              user_telegram_id INTEGER PRIMARY KEY,
              username TEXT,
              display_name TEXT,
              role TEXT NOT NULL CHECK(role IN ('OWNER','ADMIN','SENIOR_AGENT','AGENT')),
              active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
              added_by INTEGER,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_installation_owner
              ON team_members(role) WHERE role = 'OWNER' AND active = 1;
            CREATE TABLE IF NOT EXISTS secure_setup_tokens (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              token_hash TEXT NOT NULL UNIQUE,
              kind TEXT NOT NULL CHECK(kind IN ('OWNER_PAIRING','OWNER_RECOVERY','TEAM_INVITE')),
              role TEXT CHECK(role IN ('OWNER','ADMIN','SENIOR_AGENT','AGENT')),
              created_by INTEGER,
              claimed_by INTEGER,
              expires_at TEXT NOT NULL,
              consumed_at TEXT,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_secure_setup_tokens_active
              ON secure_setup_tokens(kind, consumed_at, expires_at);
            CREATE TABLE IF NOT EXISTS owner_transfer_confirmations (
              claimant_telegram_id INTEGER PRIMARY KEY,
              token_id INTEGER NOT NULL UNIQUE,
              created_at TEXT NOT NULL,
              FOREIGN KEY(token_id) REFERENCES secure_setup_tokens(id)
            );
            CREATE TABLE IF NOT EXISTS onboarding_sessions (
              user_telegram_id INTEGER PRIMARY KEY,
              stage TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('ACTIVE','EXITED','COMPLETED')),
              candidate_chat_id INTEGER,
              primary_message_chat_id INTEGER,
              primary_message_id INTEGER,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS managed_public_chats (
              chat_id INTEGER PRIMARY KEY,
              workspace_id INTEGER,
              title TEXT,
              username TEXT,
              active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
              imported_from_legacy INTEGER NOT NULL DEFAULT 0 CHECK(imported_from_legacy IN (0,1)),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
            );
          `);
          this.db.prepare(`INSERT OR IGNORE INTO installation_state (id, setup_state, authorization_mode, active_workspace_id, updated_at)
            VALUES (1, 'SETUP_REQUIRED', 'LEGACY_TRUSTED_GROUP', NULL, ?)`).run(now());
        }
      },
      {
        id: 21,
        name: "add_multi_chat_topic_aware_moderation",
        up: () => {
          if (!this.hasTable("managed_public_chats")) return;
          this.addColumnIfMissing("managed_public_chats", "is_forum", "INTEGER NOT NULL DEFAULT 0 CHECK(is_forum IN (0,1))");
          this.addColumnIfMissing("managed_public_chats", "moderation_enabled", "INTEGER NOT NULL DEFAULT 0 CHECK(moderation_enabled IN (0,1))");
          this.addColumnIfMissing("managed_public_chats", "warning_text", "TEXT NOT NULL DEFAULT 'Please use English in the main chat. Further violations may be reviewed by an authorized moderator under the current community policy.'");
          this.addColumnIfMissing("managed_public_chats", "allowlist_json", "TEXT NOT NULL DEFAULT '[]'");
          this.addColumnIfMissing("managed_public_chats", "warning_cooldown_minutes", "INTEGER NOT NULL DEFAULT 10 CHECK(warning_cooldown_minutes > 0)");
          this.addColumnIfMissing("managed_public_chats", "warning_message_threshold", "INTEGER NOT NULL DEFAULT 15 CHECK(warning_message_threshold > 0)");
          this.addColumnIfMissing("managed_public_chats", "lookback_minutes", "INTEGER NOT NULL DEFAULT 5 CHECK(lookback_minutes > 0)");
          this.addColumnIfMissing("managed_public_chats", "permission_status", "TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(permission_status IN ('UNKNOWN','HEALTHY','UNHEALTHY'))");
          this.addColumnIfMissing("managed_public_chats", "reaction_status", "TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(reaction_status IN ('UNKNOWN','AVAILABLE','UNAVAILABLE'))");
          this.addColumnIfMissing("managed_public_chats", "connection_status", "TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(connection_status IN ('UNKNOWN','CONNECTED','UNREACHABLE'))");
          this.addColumnIfMissing("managed_public_chats", "permissions_checked_at", "TEXT");

          if (this.hasTable("language_moderation_violations")) {
            this.addColumnIfMissing("language_moderation_violations", "message_thread_id", "INTEGER");
          }
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS language_moderation_warning_state (
              chat_id INTEGER NOT NULL,
              message_thread_id INTEGER NOT NULL DEFAULT 0,
              last_warning_message_id INTEGER,
              last_warning_at TEXT,
              ordinary_messages_since_warning INTEGER NOT NULL DEFAULT 0,
              pending_warning_due_at TEXT,
              pending_warning_started_at TEXT,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(chat_id, message_thread_id)
            );
            CREATE INDEX IF NOT EXISTS idx_language_moderation_warning_due
              ON language_moderation_warning_state(pending_warning_due_at, chat_id, message_thread_id);
          `);
          if (this.hasTable("language_moderation_violations")) {
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_language_moderation_violations_topic
              ON language_moderation_violations(chat_id, message_thread_id, detected_at, user_telegram_id);`);
          }
          if (this.hasTable("language_moderation_chat_state")) {
            this.db.exec(`INSERT OR IGNORE INTO language_moderation_warning_state (
                chat_id, message_thread_id, last_warning_message_id, last_warning_at, ordinary_messages_since_warning,
                pending_warning_due_at, pending_warning_started_at, updated_at
              ) SELECT chat_id, 0, last_warning_message_id, last_warning_at, ordinary_messages_since_warning,
                pending_warning_due_at, pending_warning_started_at, updated_at FROM language_moderation_chat_state;`);
          }

          const target = this.hasTable("settings") ? Number(this.getSetting("language_moderation:target")) : Number.NaN;
          if (Number.isSafeInteger(target) && target !== 0) {
            const legacy = this.installation.getLegacyManagedPublicChatConfig();
            this.db.prepare(`UPDATE managed_public_chats SET moderation_enabled = ?, warning_text = ?, allowlist_json = ?,
              warning_cooldown_minutes = ?, warning_message_threshold = ?, lookback_minutes = ?, updated_at = ?
              WHERE chat_id = ? AND imported_from_legacy = 1`)
              .run(legacy.enabled ? 1 : 0, legacy.warningText, JSON.stringify(legacy.allowlist), legacy.warningCooldownMinutes,
                legacy.warningMessageThreshold, legacy.lookbackMinutes, now(), target);
          }
        }
      },
      {
        id: 22,
        name: "add_persistent_quick_replies",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS quick_reply_categories (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 32),
              sort_order INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS quick_reply_templates (
              id TEXT PRIMARY KEY,
              category_id TEXT NOT NULL,
              title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 32),
              text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 3500),
              sort_order INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(category_id) REFERENCES quick_reply_categories(id) ON DELETE RESTRICT
            );
            CREATE INDEX IF NOT EXISTS idx_quick_reply_templates_category_order
              ON quick_reply_templates(category_id, sort_order, id);
          `);
        }
      }
    ];

    for (const migration of migrations) {
      if (this.hasMigration(migration.id)) {
        continue;
      }

      const applyMigration = this.db.transaction(() => {
        migration.up();
        this.db
          .prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.id, migration.name, now());
      });

      applyMigration();
    }
  }

  private hasMigration(id: number): boolean {
    const row = this.db
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(id) as { id: number } | undefined;

    return Boolean(row);
  }

  private hasColumn(tableName: "tickets" | "messages" | "language_moderation_cleanup_jobs" | "language_moderation_violations" | "language_moderation_chat_state" | "managed_public_chats" | "ticket_batch_exports" | "ticket_batch_answer_packages" | "ticket_batch_answer_items", columnName: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as TableColumnInfo[];
    return rows.some((row) => row.name === columnName);
  }

  private hasTable(tableName: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { name: string } | undefined;

    return Boolean(row);
  }

  private addColumnIfMissing(
    tableName: "tickets" | "messages" | "language_moderation_cleanup_jobs" | "language_moderation_violations" | "language_moderation_chat_state" | "managed_public_chats" | "ticket_batch_exports" | "ticket_batch_answer_packages" | "ticket_batch_answer_items",
    columnName: string,
    columnDefinition: string
  ): void {
    if (this.hasColumn(tableName, columnName)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
  }
}

function parseJsonStringArray(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function normalizeManagedChatAllowlist(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function positiveIntegerOr(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
