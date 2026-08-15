import Database from "better-sqlite3";
import { normalizeManagedChatAllowlist, now, parseJsonStringArray, positiveIntegerOr } from "./helpers.js";
import type { EntityNotificationPublicationState, InstallationStateRecord, ManagedPublicChatRecord, OnboardingSessionRecord, SecureTokenRecord, TeamMemberRecord, TeamRole, UserInput, WorkspaceRecord } from "./types.js";
export class InstallationRepository {
  constructor(private readonly db: Database.Database) {}
  private upsertUserForControl(user: UserInput): void {
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO users (telegram_id, username, first_name, last_name, created_at, updated_at)
        VALUES (@telegramId, @username, @firstName, @lastName, @createdAt, @updatedAt)
        ON CONFLICT(telegram_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          updated_at = excluded.updated_at
      `)
      .run({
        telegramId: user.telegramId,
        username: user.username ?? null,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        createdAt: timestamp,
        updatedAt: timestamp
      });
  }

  private hydrateManagedPublicChat(row: Omit<ManagedPublicChatRecord, "allowlist">): ManagedPublicChatRecord {
    return { ...row, allowlist: normalizeManagedChatAllowlist(parseJsonStringArray(row.allowlist_json)) };
  }

  getLegacyManagedPublicChatConfig(): {
    enabled: boolean;
    warningText: string;
    allowlist: readonly string[];
    warningCooldownMinutes: number;
    warningMessageThreshold: number;
    lookbackMinutes: number;
  } {
    return {
      enabled: this.getSetting("language_moderation:enabled") === "true",
      warningText:
        this.getSetting("language_moderation:warning_text")?.trim() ||
        "Please use English in the main chat. Further violations may be reviewed by an authorized moderator under the current community policy.",
      allowlist: normalizeManagedChatAllowlist(
        parseJsonStringArray(this.getSetting("language_moderation:allowlist") ?? "[]")
      ),
      warningCooldownMinutes: positiveIntegerOr(
        this.getSetting("language_moderation:warning_cooldown_minutes"),
        10
      ),
      warningMessageThreshold: positiveIntegerOr(
        this.getSetting("language_moderation:warning_message_threshold"),
        15
      ),
      lookbackMinutes: positiveIntegerOr(this.getSetting("language_moderation:lookback_minutes"), 5)
    };
  }
  claimEntityNotificationPublication(input: { provider: string; entityType: string; entityId: string; eventType: "created"; observedAt: string; targetChatId: number }): EntityNotificationPublicationState {
    const timestamp = now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO entity_notification_publications (provider, entity_type, entity_id, event_type, observed_at, target_chat_id, state, first_seen_at, updated_at)
      VALUES (?, ?, ?, 'created', ?, ?, 'CLAIMED', ?, ?)`).run(input.provider, input.entityType, input.entityId, input.observedAt, input.targetChatId, timestamp, timestamp);
    if (result.changes === 1) return "CLAIMED";

    const existing = this.db.prepare("SELECT state FROM entity_notification_publications WHERE provider = ? AND entity_type = ? AND entity_id = ? AND event_type = 'created'")
      .get(input.provider, input.entityType, input.entityId) as { state: EntityNotificationPublicationState } | undefined;
    if (existing?.state === "FAILED") {
      const retry = this.db.prepare("UPDATE entity_notification_publications SET state = 'CLAIMED', observed_at = ?, target_chat_id = ?, updated_at = ?, last_error = NULL WHERE provider = ? AND entity_type = ? AND entity_id = ? AND event_type = 'created' AND state = 'FAILED'")
        .run(input.observedAt, input.targetChatId, timestamp, input.provider, input.entityType, input.entityId);
      if (retry.changes === 1) return "CLAIMED";
    }
    if (existing?.state === "CLAIMED") return "UNKNOWN_DELIVERY";
    return existing?.state ?? "UNKNOWN_DELIVERY";
  }

  recordEntityNotificationPublished(provider: string, entityType: string, entityId: string, eventType: "created", telegramMessageId: number): void {
    this.db.prepare("UPDATE entity_notification_publications SET state = 'PUBLISHED', telegram_message_id = ?, published_at = ?, updated_at = ?, last_error = NULL WHERE provider = ? AND entity_type = ? AND entity_id = ? AND event_type = 'created' AND state = 'CLAIMED'")
      .run(telegramMessageId, now(), now(), provider, entityType, entityId);
  }

  recordEntityNotificationFailure(provider: string, entityType: string, entityId: string, eventType: "created", error: string): void {
    this.db.prepare("UPDATE entity_notification_publications SET state = 'FAILED', last_error = ?, updated_at = ? WHERE provider = ? AND entity_type = ? AND entity_id = ? AND event_type = 'created' AND state = 'CLAIMED'")
      .run(error.slice(0, 160), now(), provider, entityType, entityId);
  }

  countEntityNotificationPublications(state?: EntityNotificationPublicationState): number {
    const row = state
      ? this.db.prepare("SELECT COUNT(*) AS count FROM entity_notification_publications WHERE state = ?").get(state) as { count: number }
      : this.db.prepare("SELECT COUNT(*) AS count FROM entity_notification_publications").get() as { count: number };
    return row.count;
  }

  getSetting(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;

    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `
      )
      .run(key, value, now());
  }

  getInstallationState(): InstallationStateRecord {
    return this.db.prepare("SELECT setup_state, authorization_mode, active_workspace_id, updated_at FROM installation_state WHERE id = 1")
      .get() as InstallationStateRecord;
  }

  setInstallationState(input: Partial<Pick<InstallationStateRecord, "setup_state" | "authorization_mode" | "active_workspace_id">>): void {
    const current = this.getInstallationState();
    this.db.prepare(`UPDATE installation_state SET setup_state = ?, authorization_mode = ?, active_workspace_id = ?, updated_at = ? WHERE id = 1`)
      .run(input.setup_state ?? current.setup_state, input.authorization_mode ?? current.authorization_mode,
        input.active_workspace_id === undefined ? current.active_workspace_id : input.active_workspace_id, now());
  }

  upsertWorkspace(input: { telegramChatId: number; title?: string | null; username?: string | null; importedFromLegacy?: boolean }): WorkspaceRecord {
    const timestamp = now();
    this.db.prepare(`INSERT INTO workspaces (telegram_chat_id, title, username, active, imported_from_legacy, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(telegram_chat_id) DO UPDATE SET title = COALESCE(excluded.title, workspaces.title), username = COALESCE(excluded.username, workspaces.username), active = 1, updated_at = excluded.updated_at`)
      .run(input.telegramChatId, input.title ?? null, input.username ?? null, input.importedFromLegacy ? 1 : 0, timestamp, timestamp);
    return this.getWorkspaceByChatId(input.telegramChatId)!;
  }

  getWorkspaceByChatId(chatId: number): WorkspaceRecord | undefined {
    return this.db.prepare("SELECT * FROM workspaces WHERE telegram_chat_id = ?").get(chatId) as WorkspaceRecord | undefined;
  }

  getActiveWorkspace(): WorkspaceRecord | undefined {
    return this.db.prepare(`SELECT w.* FROM workspaces w JOIN installation_state i ON i.active_workspace_id = w.id WHERE i.id = 1 AND w.active = 1`).get() as WorkspaceRecord | undefined;
  }

  listWorkspaces(): WorkspaceRecord[] {
    return this.db.prepare("SELECT * FROM workspaces ORDER BY id").all() as WorkspaceRecord[];
  }

  importManagedPublicChat(chatId: number, workspaceId: number): void {
    const legacy = this.getLegacyManagedPublicChatConfig();
    const timestamp = now();
    this.db.prepare(`INSERT INTO managed_public_chats (
        chat_id, workspace_id, active, imported_from_legacy, moderation_enabled, warning_text, allowlist_json,
        warning_cooldown_minutes, warning_message_threshold, lookback_minutes, created_at, updated_at
      ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        workspace_id = COALESCE(managed_public_chats.workspace_id, excluded.workspace_id),
        active = 1, updated_at = excluded.updated_at`)
      .run(chatId, workspaceId, legacy.enabled ? 1 : 0, legacy.warningText, JSON.stringify(legacy.allowlist),
        legacy.warningCooldownMinutes, legacy.warningMessageThreshold, legacy.lookbackMinutes, timestamp, timestamp);
  }

  upsertManagedPublicChat(input: {
    chatId: number;
    workspaceId?: number | null;
    title?: string | null;
    username?: string | null;
    isForum?: boolean;
  }): ManagedPublicChatRecord {
    const timestamp = now();
    this.db.prepare(`INSERT INTO managed_public_chats (chat_id, workspace_id, title, username, is_forum, active, imported_from_legacy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET workspace_id = COALESCE(excluded.workspace_id, managed_public_chats.workspace_id),
        title = COALESCE(excluded.title, managed_public_chats.title), username = COALESCE(excluded.username, managed_public_chats.username),
        is_forum = excluded.is_forum, active = 1, updated_at = excluded.updated_at`)
      .run(input.chatId, input.workspaceId ?? null, input.title ?? null, input.username ?? null, input.isForum ? 1 : 0, timestamp, timestamp);
    return this.getManagedPublicChat(input.chatId, true)!;
  }

  getManagedPublicChat(chatId: number, includeInactive = false): ManagedPublicChatRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM managed_public_chats WHERE chat_id = ?${includeInactive ? "" : " AND active = 1"}`)
      .get(chatId) as Omit<ManagedPublicChatRecord, "allowlist"> | undefined;
    return row ? this.hydrateManagedPublicChat(row) : undefined;
  }

  listManagedPublicChats(includeInactive = false): ManagedPublicChatRecord[] {
    const rows = this.db.prepare(`SELECT * FROM managed_public_chats${includeInactive ? "" : " WHERE active = 1"} ORDER BY title COLLATE NOCASE, chat_id`)
      .all() as Array<Omit<ManagedPublicChatRecord, "allowlist">>;
    return rows.map((row) => this.hydrateManagedPublicChat(row));
  }

  updateManagedPublicChatConfig(chatId: number, input: {
    warningText: string;
    allowlist: readonly string[];
    warningCooldownMinutes: number;
    warningMessageThreshold: number;
    lookbackMinutes: number;
  }): boolean {
    const result = this.db.prepare(`UPDATE managed_public_chats SET warning_text = ?, allowlist_json = ?,
      warning_cooldown_minutes = ?, warning_message_threshold = ?, lookback_minutes = ?, updated_at = ?
      WHERE chat_id = ? AND active = 1`)
      .run(input.warningText.trim(), JSON.stringify(normalizeManagedChatAllowlist(input.allowlist)), input.warningCooldownMinutes,
        input.warningMessageThreshold, input.lookbackMinutes, now(), chatId);
    return result.changes === 1;
  }

  setManagedPublicChatModerationEnabled(chatId: number, enabled: boolean): boolean {
    return this.db.prepare("UPDATE managed_public_chats SET moderation_enabled = ?, updated_at = ? WHERE chat_id = ? AND active = 1")
      .run(enabled ? 1 : 0, now(), chatId).changes === 1;
  }

  recordManagedPublicChatPermissionHealth(input: {
    chatId: number;
    healthy: boolean;
    reactionsAvailable: boolean | null;
    connected?: boolean;
    title?: string | null;
    username?: string | null;
    isForum?: boolean;
  }): boolean {
    return this.db.prepare(`UPDATE managed_public_chats SET permission_status = ?, reaction_status = ?,
      connection_status = COALESCE(?, connection_status),
      title = CASE WHEN ? = 1 THEN ? ELSE title END,
      username = CASE WHEN ? = 1 THEN ? ELSE username END,
      is_forum = CASE WHEN ? = 1 THEN ? ELSE is_forum END,
      permissions_checked_at = ?, updated_at = ? WHERE chat_id = ? AND active = 1`)
      .run(input.healthy ? "HEALTHY" : "UNHEALTHY", input.reactionsAvailable === null ? "UNKNOWN" : input.reactionsAvailable ? "AVAILABLE" : "UNAVAILABLE",
        input.connected === undefined ? null : input.connected ? "CONNECTED" : "UNREACHABLE",
        input.title === undefined ? 0 : 1, input.title ?? null,
        input.username === undefined ? 0 : 1, input.username ?? null,
        input.isForum === undefined ? 0 : 1, input.isForum ? 1 : 0,
        now(), now(), input.chatId).changes === 1;
  }

  recordManagedPublicChatUnreachable(chatId: number): boolean {
    return this.db.prepare(`UPDATE managed_public_chats SET connection_status = 'UNREACHABLE',
      permission_status = 'UNHEALTHY', permissions_checked_at = ?, updated_at = ? WHERE chat_id = ? AND active = 1`)
      .run(now(), now(), chatId).changes === 1;
  }

  deactivateManagedPublicChat(chatId: number): boolean {
    return this.db.prepare("UPDATE managed_public_chats SET active = 0, moderation_enabled = 0, updated_at = ? WHERE chat_id = ? AND active = 1")
      .run(now(), chatId).changes === 1;
  }

  getTeamMember(userId: number): TeamMemberRecord | undefined {
    return this.db.prepare("SELECT * FROM team_members WHERE user_telegram_id = ? AND active = 1").get(userId) as TeamMemberRecord | undefined;
  }

  listTeamMembers(): TeamMemberRecord[] {
    return this.db.prepare("SELECT * FROM team_members WHERE active = 1 ORDER BY CASE role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 WHEN 'SENIOR_AGENT' THEN 2 ELSE 3 END, user_telegram_id").all() as TeamMemberRecord[];
  }

  upsertTeamMember(input: { userId: number; username?: string | null; displayName?: string | null; role: TeamRole; addedBy?: number | null }): void {
    const timestamp = now();
    this.db.prepare(`INSERT INTO team_members (user_telegram_id, username, display_name, role, active, added_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(user_telegram_id) DO UPDATE SET username = COALESCE(excluded.username, team_members.username), display_name = COALESCE(excluded.display_name, team_members.display_name), role = excluded.role, active = 1, added_by = excluded.added_by, updated_at = excluded.updated_at`)
      .run(input.userId, input.username ?? null, input.displayName ?? null, input.role, input.addedBy ?? null, timestamp, timestamp);
  }

  revokeTeamMember(userId: number): boolean {
    return this.db.prepare("UPDATE team_members SET active = 0, updated_at = ? WHERE user_telegram_id = ? AND active = 1 AND role != 'OWNER'").run(now(), userId).changes > 0;
  }

  transferOwner(newOwnerId: number): void {
    this.db.transaction(() => {
      const oldOwner = this.db.prepare("SELECT user_telegram_id FROM team_members WHERE role = 'OWNER' AND active = 1").get() as { user_telegram_id: number } | undefined;
      if (!oldOwner) throw new Error("An active owner is required for transfer.");
      const timestamp = now();
      this.db.prepare("UPDATE team_members SET role = 'ADMIN', updated_at = ? WHERE user_telegram_id = ?").run(timestamp, oldOwner.user_telegram_id);
      this.db.prepare(`INSERT INTO team_members (user_telegram_id, role, active, created_at, updated_at) VALUES (?, 'OWNER', 1, ?, ?)
        ON CONFLICT(user_telegram_id) DO UPDATE SET role = 'OWNER', active = 1, updated_at = excluded.updated_at`).run(newOwnerId, timestamp, timestamp);
    })();
  }

  invalidateUnconsumedTokens(kind: SecureTokenRecord["kind"]): void {
    this.db.prepare("UPDATE secure_setup_tokens SET consumed_at = ? WHERE kind = ? AND consumed_at IS NULL").run(now(), kind);
  }

  insertSecureToken(input: { tokenHash: string; kind: SecureTokenRecord["kind"]; role?: TeamRole | null; createdBy?: number | null; expiresAt: string }): void {
    this.db.prepare(`INSERT INTO secure_setup_tokens (token_hash, kind, role, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.tokenHash, input.kind, input.role ?? null, input.createdBy ?? null, input.expiresAt, now());
  }

  listUnconsumedTokens(kind?: SecureTokenRecord["kind"]): SecureTokenRecord[] {
    return (kind
      ? this.db.prepare("SELECT * FROM secure_setup_tokens WHERE kind = ? AND consumed_at IS NULL").all(kind)
      : this.db.prepare("SELECT * FROM secure_setup_tokens WHERE consumed_at IS NULL").all()) as SecureTokenRecord[];
  }

  consumeOwnerTokenAndCreateOwner(tokenId: number, user: UserInput, at: string): "PAIRED" | "TRANSFER_PENDING" | "INVALID" {
    return this.db.transaction(() => {
      const token = this.db.prepare("SELECT * FROM secure_setup_tokens WHERE id = ? AND consumed_at IS NULL AND expires_at > ?").get(tokenId, at) as SecureTokenRecord | undefined;
      if (!token || (token.kind !== "OWNER_PAIRING" && token.kind !== "OWNER_RECOVERY")) return "INVALID";
      const existing = this.db.prepare("SELECT user_telegram_id FROM team_members WHERE role = 'OWNER' AND active = 1").get() as { user_telegram_id: number } | undefined;
      const timestamp = now();
      this.db.prepare("UPDATE secure_setup_tokens SET consumed_at = ?, claimed_by = ? WHERE id = ? AND consumed_at IS NULL").run(timestamp, user.telegramId, tokenId);
      this.upsertUserForControl(user);
      if (existing) {
        this.db.prepare("INSERT OR REPLACE INTO owner_transfer_confirmations (claimant_telegram_id, token_id, created_at) VALUES (?, ?, ?)").run(user.telegramId, tokenId, timestamp);
        return "TRANSFER_PENDING";
      }
      this.upsertTeamMember({ userId: user.telegramId, username: user.username, displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || null, role: "OWNER" });
      this.db.prepare("UPDATE secure_setup_tokens SET consumed_at = ? WHERE kind IN ('OWNER_PAIRING','OWNER_RECOVERY') AND consumed_at IS NULL").run(timestamp);
      return "PAIRED";
    })();
  }

  invalidateTokenAndAssignMember(tokenId: number, user: UserInput, role: TeamRole, at: string): void {
    this.db.transaction(() => {
      const token = this.db.prepare("SELECT id FROM secure_setup_tokens WHERE id = ? AND kind = 'TEAM_INVITE' AND consumed_at IS NULL AND expires_at > ?").get(tokenId, at);
      if (!token) throw new Error("Invitation is no longer available.");
      this.upsertUserForControl(user);
      this.upsertTeamMember({ userId: user.telegramId, username: user.username, displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || null, role });
      this.db.prepare("UPDATE secure_setup_tokens SET consumed_at = ?, claimed_by = ? WHERE id = ? AND consumed_at IS NULL").run(now(), user.telegramId, tokenId);
    })();
  }

  hasPendingOwnerTransfer(userId: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM owner_transfer_confirmations WHERE claimant_telegram_id = ?").get(userId));
  }

  confirmOwnerTransfer(userId: number): void {
    this.db.transaction(() => {
      if (!this.hasPendingOwnerTransfer(userId)) throw new Error("No pending owner transfer exists.");
      this.transferOwner(userId);
      this.db.prepare("DELETE FROM owner_transfer_confirmations").run();
    })();
  }

  saveOnboardingSession(userId: number, stage: string, state = "ACTIVE", candidateChatId?: number | null): void {
    this.db.prepare(`INSERT INTO onboarding_sessions (user_telegram_id, stage, state, candidate_chat_id, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_telegram_id) DO UPDATE SET stage = excluded.stage, state = excluded.state, candidate_chat_id = COALESCE(excluded.candidate_chat_id, onboarding_sessions.candidate_chat_id), updated_at = excluded.updated_at`)
      .run(userId, stage, state, candidateChatId ?? null, now());
  }

  getOnboardingSession(userId: number): OnboardingSessionRecord | undefined {
    return this.db.prepare("SELECT * FROM onboarding_sessions WHERE user_telegram_id = ?").get(userId) as OnboardingSessionRecord | undefined;
  }

  setOnboardingPrimaryMessage(userId: number, chatId: number | null, messageId: number | null): void {
    this.db.prepare("UPDATE onboarding_sessions SET primary_message_chat_id = ?, primary_message_id = ?, updated_at = ? WHERE user_telegram_id = ?")
      .run(chatId, messageId, now(), userId);
  }

  getInstallationOperationalCounts(): { publicChats: number; moderationEnabled: number; unhealthyModerationChats: number; pendingCleanup: number; pendingArchives: number; pendingBatchStaffOperations: number } {
    const scalar = (sql: string): number => (this.db.prepare(sql).get() as { count: number }).count;
    return {
      publicChats: scalar("SELECT COUNT(*) AS count FROM managed_public_chats WHERE active = 1"),
      moderationEnabled: scalar("SELECT COUNT(*) AS count FROM managed_public_chats WHERE active = 1 AND moderation_enabled = 1"),
      unhealthyModerationChats: scalar("SELECT COUNT(*) AS count FROM managed_public_chats WHERE active = 1 AND permission_status = 'UNHEALTHY'"),
      pendingCleanup: scalar("SELECT COUNT(*) AS count FROM language_moderation_cleanup_jobs WHERE state != 'COMPLETED'"),
      pendingArchives: scalar("SELECT COUNT(*) AS count FROM tickets WHERE status = 'CLOSED' AND archived_at IS NULL"),
      pendingBatchStaffOperations: scalar("SELECT COUNT(*) AS count FROM ticket_batch_answer_packages WHERE final_summary_state IN ('PENDING','FAILED')")
    };
  }


}
