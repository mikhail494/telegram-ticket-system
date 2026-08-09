import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AuthorizationMode,
  InstallationSetupState,
  OnboardingSessionRecord,
  SupportDatabase,
  TeamMemberRecord,
  TeamRole,
  UserInput,
  WorkspaceRecord
} from "./db.js";

export type Permission =
  | "CONFIGURE_INSTALLATION" | "MANAGE_TEAM" | "MANAGE_ADMINS" | "BATCH_OPERATIONS"
  | "MODERATION_SETTINGS" | "SUPPORT_LOGS" | "BAN_USERS" | "REPLY_TO_TICKETS"
  | "CLOSE_TICKETS" | "VIEW_TICKETS";

export type OnboardingStage =
  | "WELCOME" | "BOT_IDENTITY" | "STAFF_WORKSPACE" | "WORKSPACE_PERMISSIONS"
  | "SUPPORT_LOGS" | "PUBLIC_CHAT" | "TEAM_ROLES" | "SUMMARY" | "ACTIVATE_SUPPORT";

export interface InstallationState {
  setupState: InstallationSetupState;
  authorizationMode: AuthorizationMode;
  activeWorkspaceId: number | null;
}

interface InstallationOptions { now?: () => Date; tokenTtlMs?: number; }

const ROLE_PERMISSIONS: Readonly<Record<TeamRole, ReadonlySet<Permission>>> = {
  OWNER: new Set(["CONFIGURE_INSTALLATION", "MANAGE_TEAM", "MANAGE_ADMINS", "BATCH_OPERATIONS", "MODERATION_SETTINGS", "SUPPORT_LOGS", "BAN_USERS", "REPLY_TO_TICKETS", "CLOSE_TICKETS", "VIEW_TICKETS"]),
  ADMIN: new Set(["CONFIGURE_INSTALLATION", "MANAGE_TEAM", "BATCH_OPERATIONS", "MODERATION_SETTINGS", "SUPPORT_LOGS", "BAN_USERS", "REPLY_TO_TICKETS", "CLOSE_TICKETS", "VIEW_TICKETS"]),
  SENIOR_AGENT: new Set(["BAN_USERS", "REPLY_TO_TICKETS", "CLOSE_TICKETS", "VIEW_TICKETS"]),
  AGENT: new Set(["REPLY_TO_TICKETS", "CLOSE_TICKETS", "VIEW_TICKETS"])
};

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export class InstallationService {
  private readonly now: () => Date;
  private readonly tokenTtlMs: number;
  private activationNonce: string | null = null;

  constructor(private readonly db: SupportDatabase, options: InstallationOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.tokenTtlMs = options.tokenTtlMs ?? 30 * 60_000;
  }

  getState(): InstallationState {
    const row = this.db.getInstallationState();
    return { setupState: row.setup_state, authorizationMode: row.authorization_mode, activeWorkspaceId: row.active_workspace_id };
  }

  getStaffChatId(): number | null { return this.db.getActiveWorkspace()?.telegram_chat_id ?? null; }
  getActiveWorkspace(): WorkspaceRecord | null { return this.db.getActiveWorkspace() ?? null; }
  listWorkspaces(): WorkspaceRecord[] { return this.db.listWorkspaces(); }
  listTeamMembers(): TeamMemberRecord[] { return this.db.listTeamMembers(); }
  getMember(userId: number): TeamMemberRecord | null { return this.db.getTeamMember(userId) ?? null; }
  getOwner(): { userTelegramId: number; username: string | null } | null {
    const owner = this.db.listTeamMembers().find((member) => member.role === "OWNER");
    return owner ? { userTelegramId: owner.user_telegram_id, username: owner.username } : null;
  }

  adoptLegacyInstallation(staffChatId: number): WorkspaceRecord {
    const activeWorkspace = this.getActiveWorkspace();
    const workspace = activeWorkspace ?? this.db.upsertWorkspace({ telegramChatId: staffChatId, importedFromLegacy: true });
    if (!activeWorkspace) this.db.setInstallationState({ setup_state: "READY", active_workspace_id: workspace.id });
    const moderationTarget = Number(this.db.getSetting("language_moderation:target"));
    if (Number.isSafeInteger(moderationTarget) && moderationTarget !== 0 && !this.db.getManagedPublicChat(moderationTarget, true)) {
      this.db.importManagedPublicChat(moderationTarget, workspace.id);
    }
    return workspace;
  }

  activateWorkspace(input: { chatId: number; title?: string | null; username?: string | null }): WorkspaceRecord {
    const workspace = this.db.upsertWorkspace({ telegramChatId: input.chatId, title: input.title, username: input.username });
    this.db.setInstallationState({ active_workspace_id: workspace.id });
    return workspace;
  }

  markReady(): void {
    if (!this.getActiveWorkspace()) throw new Error("A validated staff workspace is required before activation.");
    this.db.setInstallationState({ setup_state: "READY" });
  }

  createOwnerPairingToken(): string {
    this.db.invalidateUnconsumedTokens("OWNER_PAIRING");
    return this.createToken("OWNER_PAIRING");
  }
  createOwnerRecoveryToken(): string {
    this.db.invalidateUnconsumedTokens("OWNER_PAIRING");
    this.db.invalidateUnconsumedTokens("OWNER_RECOVERY");
    return this.createToken("OWNER_RECOVERY");
  }

  consumeOwnerPairingToken(token: string, user: UserInput): { kind: "PAIRED" | "TRANSFER_CONFIRMATION_REQUIRED" | "INVALID" | "EXPIRED" } {
    const matched = this.findToken(token, ["OWNER_PAIRING", "OWNER_RECOVERY"]);
    if (!matched) return { kind: "INVALID" };
    if (Date.parse(matched.expires_at) <= this.now().getTime()) return { kind: "EXPIRED" };
    if (matched.kind === "OWNER_PAIRING" && this.getOwner()) return { kind: "INVALID" };
    const result = this.db.consumeOwnerTokenAndCreateOwner(matched.id, user, this.now().toISOString());
    if (result === "INVALID") return { kind: "INVALID" };
    if (result === "TRANSFER_PENDING") return { kind: "TRANSFER_CONFIRMATION_REQUIRED" };
    this.saveOnboardingStage(user.telegramId, "WELCOME");
    return { kind: "PAIRED" };
  }

  confirmOwnerTransfer(userId: number): void { this.db.confirmOwnerTransfer(userId); this.saveOnboardingStage(userId, "WELCOME"); }

  createTeamInvitation(actorId: number, role: Exclude<TeamRole, "OWNER">): string {
    if (!this.mayAssign(actorId, role)) throw new Error("Your role cannot create this invitation.");
    return this.createToken("TEAM_INVITE", role, actorId);
  }

  consumeTeamInvitation(token: string, user: UserInput): { kind: "JOINED" | "INVALID" | "EXPIRED"; role?: TeamRole } {
    const matched = this.findToken(token, ["TEAM_INVITE"]);
    if (!matched) return { kind: "INVALID" };
    if (Date.parse(matched.expires_at) <= this.now().getTime()) return { kind: "EXPIRED" };
    if (this.getMember(user.telegramId)?.role === "OWNER") return { kind: "INVALID" };
    this.db.invalidateTokenAndAssignMember(matched.id, user, matched.role!, this.now().toISOString());
    return { kind: "JOINED", role: matched.role! };
  }

  assignRole(actorId: number, userId: number, role: Exclude<TeamRole, "OWNER">): void {
    if (!this.mayAssign(actorId, role)) throw new Error("Your role cannot assign this role.");
    const target = this.getMember(userId);
    if (target?.role === "OWNER" || (target?.role === "ADMIN" && this.getMember(actorId)?.role !== "OWNER")) throw new Error("Your role cannot modify this member.");
    this.db.upsertTeamMember({ userId, role, addedBy: actorId });
  }

  revokeMember(actorId: number, userId: number): void {
    const actor = this.getMember(actorId); const target = this.getMember(userId);
    if (!actor || !target || target.role === "OWNER" || (target.role === "ADMIN" && actor.role !== "OWNER") || !this.can(actorId, "MANAGE_TEAM")) throw new Error("Your role cannot revoke this member.");
    this.db.revokeTeamMember(userId);
  }

  can(userId: number, permission: Permission): boolean { const role = this.getMember(userId)?.role; return role ? ROLE_PERMISSIONS[role].has(permission) : false; }
  isStaffAuthorized(userId: number, chatId: number): boolean {
    if (chatId !== this.getStaffChatId()) return false;
    return this.getState().authorizationMode === "LEGACY_TRUSTED_GROUP" || this.getMember(userId) !== null;
  }

  previewRoleBasedAccessActivation(): { ownerCount: number; activeRoleCount: number; confirmationToken: string } {
    this.activationNonce = randomBytes(12).toString("base64url");
    const members = this.listTeamMembers();
    return { ownerCount: members.filter((member) => member.role === "OWNER").length, activeRoleCount: members.length, confirmationToken: this.activationNonce };
  }

  cancelRoleBasedAccessActivation(): void { this.activationNonce = null; }

  activateRoleBasedAccess(ownerId: number, confirmationToken: string): void {
    if (!this.can(ownerId, "MANAGE_ADMINS") || !this.activationNonce || confirmationToken !== this.activationNonce) throw new Error("Role-based access activation was not confirmed.");
    this.db.setInstallationState({ authorization_mode: "RBAC_ACTIVE" });
    this.activationNonce = null;
  }

  saveOnboardingStage(userId: number, stage: OnboardingStage, state = "ACTIVE"): void { this.db.saveOnboardingSession(userId, stage, state); }
  getOnboardingSession(userId: number): OnboardingSessionRecord | null { return this.db.getOnboardingSession(userId) ?? null; }
  setOnboardingPrimaryMessage(userId: number, chatId: number, messageId: number): void { this.db.setOnboardingPrimaryMessage(userId, chatId, messageId); }
  listTokenMetadata(): Array<{ kind: string; expiresAt: string }> { return this.db.listUnconsumedTokens().map((row) => ({ kind: row.kind, expiresAt: row.expires_at })); }

  private mayAssign(actorId: number, role: Exclude<TeamRole, "OWNER">): boolean {
    const actor = this.getMember(actorId)?.role;
    return actor === "OWNER" || (actor === "ADMIN" && (role === "SENIOR_AGENT" || role === "AGENT"));
  }

  private createToken(kind: "OWNER_PAIRING" | "OWNER_RECOVERY" | "TEAM_INVITE", role?: TeamRole, createdBy?: number): string {
    const token = randomBytes(32).toString("base64url");
    this.db.insertSecureToken({ tokenHash: hashToken(token).toString("hex"), kind, role, createdBy, expiresAt: new Date(this.now().getTime() + this.tokenTtlMs).toISOString() });
    return token;
  }

  private findToken(token: string, kinds: Array<"OWNER_PAIRING" | "OWNER_RECOVERY" | "TEAM_INVITE">) {
    const candidateHash = hashToken(token);
    for (const row of this.db.listUnconsumedTokens()) {
      if (!kinds.includes(row.kind)) continue;
      const storedHash = Buffer.from(row.token_hash, "hex");
      if (storedHash.length === candidateHash.length && timingSafeEqual(storedHash, candidateHash)) return row;
    }
    return undefined;
  }
}
