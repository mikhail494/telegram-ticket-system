import type { DeliveryErrorCategory, DeliveryErrorPermanence } from "../deliveryDiagnostics.js";

export type TicketStatus = "OPEN" | "WAITING_USER" | "IN_PROGRESS" | "CLOSED";
export type MessageDirection = "USER_TO_STAFF" | "STAFF_TO_USER" | "SYSTEM";
export type MessageSenderType = "USER" | "STAFF" | "SYSTEM";
export type InstallationSetupState = "SETUP_REQUIRED" | "READY";
export type AuthorizationMode = "LEGACY_TRUSTED_GROUP" | "RBAC_ACTIVE";
export type TeamRole = "OWNER" | "ADMIN" | "SENIOR_AGENT" | "AGENT";

export interface InstallationStateRecord {
  setup_state: InstallationSetupState;
  authorization_mode: AuthorizationMode;
  active_workspace_id: number | null;
  updated_at: string;
}

export interface WorkspaceRecord {
  id: number; telegram_chat_id: number; title: string | null; username: string | null;
  active: number; imported_from_legacy: number; created_at: string; updated_at: string;
}

export type ManagedPublicChatPermissionStatus = "UNKNOWN" | "HEALTHY" | "UNHEALTHY";
export type ManagedPublicChatReactionStatus = "UNKNOWN" | "AVAILABLE" | "UNAVAILABLE";
export type ManagedPublicChatConnectionStatus = "UNKNOWN" | "CONNECTED" | "UNREACHABLE";

export interface ManagedPublicChatRecord {
  chat_id: number;
  workspace_id: number | null;
  title: string | null;
  username: string | null;
  is_forum: number;
  active: number;
  imported_from_legacy: number;
  moderation_enabled: number;
  warning_text: string;
  allowlist_json: string;
  warning_cooldown_minutes: number;
  warning_message_threshold: number;
  lookback_minutes: number;
  permission_status: ManagedPublicChatPermissionStatus;
  reaction_status: ManagedPublicChatReactionStatus;
  connection_status: ManagedPublicChatConnectionStatus;
  permissions_checked_at: string | null;
  created_at: string;
  updated_at: string;
  allowlist: readonly string[];
}

export interface TeamMemberRecord {
  user_telegram_id: number; username: string | null; display_name: string | null;
  role: TeamRole; active: number; added_by: number | null; created_at: string; updated_at: string;
}

export interface SecureTokenRecord {
  id: number; token_hash: string; kind: "OWNER_PAIRING" | "OWNER_RECOVERY" | "TEAM_INVITE";
  role: TeamRole | null; created_by: number | null; claimed_by: number | null;
  expires_at: string; consumed_at: string | null; created_at: string;
}

export interface OnboardingSessionRecord {
  user_telegram_id: number; stage: string; state: string; candidate_chat_id: number | null;
  primary_message_chat_id: number | null; primary_message_id: number | null; updated_at: string;
}

export interface UserRecord {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketRecord {
  id: number;
  user_telegram_id: number;
  status: TicketStatus;
  staff_chat_id: number | null;
  message_thread_id: number | null;
  staff_message_id: number | null;
  logs_message_id: number | null;
  transcript_message_id: number | null;
  archived_at: string | null;
  closed_by_type: MessageSenderType | null;
  closed_by_display_name: string | null;
  closed_by_username: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  follow_up_state: TicketFollowUpState;
  internal_note: string | null;
  escalation_target: TicketEscalationTarget;
  follow_up_updated_at: string | null;
  follow_up_source_answer_package_id: string | null;
}

export type TicketFollowUpState = "NONE" | "WAITING_USER" | "WAITING_DEVS" | "WAITING_QUEST_OWNER" | "MONITORING";
export type TicketEscalationTarget = "NONE" | "DEVS" | "PAYMENTS" | "SECURITY" | "QUEST_OWNER" | "SUPPORT";

export interface TicketFollowUpHistoryRecord {
  id: number;
  ticket_id: number;
  follow_up_state: TicketFollowUpState;
  internal_note: string | null;
  escalation_target: TicketEscalationTarget;
  source_answer_package_id: string | null;
  created_at: string;
}

export interface TicketWithUser extends TicketRecord {
  username: string | null;
  first_name: string | null;
  last_name: string | null;
}

export interface TicketMessageRecord {
  id: number;
  ticket_id: number;
  direction: MessageDirection;
  source_chat_id: number | null;
  source_message_id: number | null;
  delivery_chat_id: number | null;
  delivery_message_id: number | null;
  from_telegram_id: number | null;
  from_username: string | null;
  sender_type: MessageSenderType | null;
  sender_display_name: string | null;
  sender_username: string | null;
  text: string | null;
  media_type: string | null;
  filename: string | null;
  file_id: string | null;
  created_at: string;
}

export interface BannedUserRecord {
  user_telegram_id: number;
  username: string | null;
  reason: string;
  banned_by: number | null;
  created_at: string;
}

export interface UserInput {
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface AddMessageInput {
  ticketId: number;
  direction: MessageDirection;
  sourceChatId?: number | null;
  sourceMessageId?: number | null;
  deliveryChatId?: number | null;
  deliveryMessageId?: number | null;
  fromTelegramId?: number | null;
  fromUsername?: string | null;
  senderType?: MessageSenderType | null;
  senderDisplayName?: string | null;
  senderUsername?: string | null;
  text?: string | null;
  mediaType?: string | null;
  filename?: string | null;
  fileId?: string | null;
}

export interface BanUserInput {
  userTelegramId: number;
  username?: string | null;
  reason: string;
  bannedBy?: number | null;
}

export interface CloseTicketInput {
  type: MessageSenderType;
  displayName: string;
  username?: string | null;
}

export interface TicketBatchExportRecord {
  export_id: string;
  staff_chat_id: number;
  created_at: string;
  selection_mode: string;
  ticket_count: number;
  delivery_state: TicketBatchExportDeliveryState;
  delivery_message_id: number | null;
  delivered_at: string | null;
  last_error: string | null;
}

export type TicketBatchExportDeliveryState = "PREPARING" | "DELIVERED" | "FAILED" | "UNKNOWN_DELIVERY";

export interface TicketBatchExportItemRecord {
  export_id: string;
  ticket_id: number;
  snapshot_token: string;
}

export interface TicketBatchDeliveryFailureContext {
  category: DeliveryErrorCategory;
  permanence: DeliveryErrorPermanence;
  occurred_at: string;
  retry_after_seconds: number | null;
  staff_failure_event_posted: boolean;
}

export interface TicketBatchStaffSyncContext {
  state: TicketBatchTopicEchoState;
  delivered: boolean;
  terminal_failure_category: DeliveryErrorCategory | null;
  intended_follow_up_state: TicketFollowUpState;
  intended_escalation_target: TicketEscalationTarget;
  internal_context_available: boolean;
}

export interface CreateTicketBatchExportInput {
  exportId: string;
  staffChatId: number;
  createdAt: string;
  selectionMode: "all_active";
  ticketCount: number;
  items: Array<{ ticketId: number; snapshotToken: string }>;
  deliveryState?: TicketBatchExportDeliveryState;
}

export type TicketBatchAnswerPackageStatus = "PENDING" | "APPLYING" | "COMPLETED" | "PARTIAL" | "CANCELLED";
export type TicketBatchAnswerItemState = "PENDING" | "APPLYING" | "REPLY_SENT" | "STAFF_SYNC_PENDING" | "COMPLETED" | "NO_ACTION" | "STALE" | "INACTIVE" | "FAILED" | "UNKNOWN_DELIVERY";
export type TicketBatchTopicEchoState = "NOT_REQUIRED" | "PENDING" | "SENT" | "FAILED" | "TERMINAL_FAILED";
export type TicketBatchFailureEventState = "NOT_REQUIRED" | "PENDING" | "SENT" | "FAILED";
export type TicketBatchSummaryDeliveryState = "NOT_ATTEMPTED" | "SENT" | "FAILED";
export type TicketBatchFinalSummaryState = "NOT_PENDING" | "PENDING" | "SENT" | "FAILED" | "UNKNOWN_DELIVERY";

export interface TicketBatchAnswerPackageRecord {
  answer_package_id: string; export_id: string; staff_chat_id: number; package_hash: string;
  source_chat_id: number | null; source_message_id: number | null; package_created_at: string;
  imported_at: string; status: TicketBatchAnswerPackageStatus; started_at: string | null;
  completed_at: string | null; updated_at: string;
  preview_token: string | null; preview_chat_id: number | null; preview_message_id: number | null; preview_page: number | null;
  summary_delivery_state: TicketBatchSummaryDeliveryState; summary_delivery_error: string | null; summary_delivery_attempted_at: string | null;
  final_summary_state: TicketBatchFinalSummaryState; final_summary_text: string | null;
  final_summary_chat_id: number | null; final_summary_origin_chat_id: number | null; final_summary_origin_message_id: number | null;
  final_summary_message_id: number | null; final_summary_attempt_count: number; final_summary_next_retry_at: string | null;
  final_summary_last_error: string | null; final_summary_delivered_at: string | null;
}

export interface TicketBatchAnswerItemRecord {
  answer_package_id: string; ticket_id: number; snapshot_token: string; action: "reply_keep_open" | "reply_and_close" | "no_action";
  reply_text: string | null; state: TicketBatchAnswerItemState; delivery_message_id: number | null;
  applied_at: string | null; last_error: string | null; updated_at: string;
  follow_up_state: TicketFollowUpState; internal_note: string | null; escalation_target: TicketEscalationTarget;
  topic_echo_chat_id: number | null; topic_echo_thread_id: number | null; topic_echo_message_id: number | null;
  topic_echo_state: TicketBatchTopicEchoState; topic_echo_last_error: string | null;
  topic_echo_attempt_count: number; topic_echo_next_retry_at: string | null;
  topic_echo_error_category: DeliveryErrorCategory | null; topic_echo_error_code: number | null;
  topic_echo_http_status: number | null; topic_echo_error_method: string | null;
  topic_echo_error_description: string | null; topic_echo_terminal_at: string | null;
  delivery_error_category: DeliveryErrorCategory | null; delivery_error_permanence: DeliveryErrorPermanence | null;
  delivery_error_code: number | null; delivery_http_status: number | null; delivery_error_method: string | null;
  delivery_retry_after_seconds: number | null; delivery_error_description: string | null; delivery_failed_at: string | null;
  delivery_attempt_count: number; delivery_failure_event_state: TicketBatchFailureEventState;
  delivery_failure_event_message_id: number | null; delivery_failure_event_attempt_count: number;
  delivery_failure_event_next_retry_at: string | null;
}

export interface TicketBatchRecoveryAudit {
  successTopicEchoes: number;
  failureEvents: number;
  noActionFollowUpEvents: number;
  finalSummaries: number;
  invalidSuccessEchoes: number;
  terminalStaffFailures: number;
  userFacingCandidates: number;
}

export interface CreateTicketBatchAnswerPackageInput {
  answerPackageId: string; exportId: string; staffChatId: number; packageHash: string;
  sourceChatId?: number | null; sourceMessageId?: number | null; packageCreatedAt: string;
  items: Array<Pick<TicketBatchAnswerItemRecord, "ticket_id" | "snapshot_token" | "action" | "reply_text"> & Partial<Pick<TicketBatchAnswerItemRecord, "follow_up_state" | "internal_note" | "escalation_target">>>;
}

export interface LanguageModerationUserState {
  chat_id: number; user_telegram_id: number; username: string | null; current_strikes: number;
  sanction_tier: number; first_strike_at: string | null; updated_at: string;
}

export interface LanguageModerationViolation {
  chat_id: number; user_telegram_id: number; message_id: number; username: string | null;
  message_thread_id: number | null;
  detected_at: string; cycle_tier: number; moderation_cycle_id: string | null; cleanup_state: LanguageModerationViolationCleanupState;
  cleanup_attempt_count: number; cleanup_last_error_category: string | null; cleanup_last_error_code: number | null;
  cleanup_last_error_description: string | null; cleanup_completed_at: string | null;
}

export interface LanguageModerationWarningState {
  chat_id: number;
  message_thread_id: number;
  last_warning_message_id: number | null;
  last_warning_at: string | null;
  ordinary_messages_since_warning: number;
  pending_warning_due_at: string | null;
  pending_warning_started_at: string | null;
  updated_at: string;
}

export type LanguageModerationViolationCleanupState = "PENDING" | "DELETED" | "ALREADY_ABSENT" | "TERMINAL_FAILED";

export interface LanguageModerationCleanupJob {
  id: number; staff_chat_id: number | null; chat_id: number; user_telegram_id: number; username: string | null; chat_title: string | null;
  sanction_tier: number; sanction_kind: string; violation_cycle_id: string | null; cleanup_due_at: string; state: "PENDING" | "CLEANING" | "LOG_PENDING" | "COMPLETED";
  created_at: string; updated_at: string;
}

export type EntityNotificationPublicationState = "CLAIMED" | "PUBLISHED" | "FAILED" | "UNKNOWN_DELIVERY";

export interface EntityNotificationPublication {
  provider: string;
  entity_type: string;
  entity_id: string;
  event_type: "created";
  observed_at: string;
  target_chat_id: number | null;
  state: EntityNotificationPublicationState;
  telegram_message_id: number | null;
  first_seen_at: string;
  published_at: string | null;
  updated_at: string;
  last_error: string | null;
}

export interface QuickReplyCategoryRecord {
  id: string;
  title: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface QuickReplyTemplateRecord {
  id: string;
  category_id: string;
  title: string;
  text: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}
