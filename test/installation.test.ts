import test from "node:test";
import assert from "node:assert/strict";
import { SupportDatabase } from "../src/db.js";
import { InstallationService } from "../src/installation.js";

test("a new database starts in setup-required legacy authorization mode", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    assert.equal(service.getState().setupState, "SETUP_REQUIRED");
    assert.equal(service.getState().authorizationMode, "LEGACY_TRUSTED_GROUP");
    assert.equal(service.getStaffChatId(), null);
  } finally { db.close(); }
});

test("legacy workspace adoption is ready, idempotent, and does not activate RBAC", () => {
  const db = new SupportDatabase(":memory:");
  try {
    db.setSetting("support_logs_thread_id:-10042", "77");
    db.setSetting("staff_help_sent:-10042", "true");
    const service = new InstallationService(db);
    service.adoptLegacyInstallation(-10042);
    service.adoptLegacyInstallation(-10042);
    assert.deepEqual(service.getState(), {
      setupState: "READY",
      authorizationMode: "LEGACY_TRUSTED_GROUP",
      activeWorkspaceId: 1
    });
    assert.equal(service.getStaffChatId(), -10042);
    assert.equal(db.getSetting("support_logs_thread_id:-10042"), "77");
    assert.equal(db.getSetting("staff_help_sent:-10042"), "true");
    assert.equal(service.listWorkspaces().length, 1);
  } finally { db.close(); }
});

test("legacy adoption does not replace a workspace selected after initial import", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    service.adoptLegacyInstallation(-10042);
    service.activateWorkspace({ chatId: -10077, title: "Selected workspace" });

    const active = service.adoptLegacyInstallation(-10042);

    assert.equal(active.telegram_chat_id, -10077);
    assert.equal(service.getStaffChatId(), -10077);
    assert.equal(service.getState().setupState, "READY");
  } finally { db.close(); }
});

test("legacy adoption preserves operational settings and imports the moderation target", () => {
  const db = new SupportDatabase(":memory:");
  try {
    db.setSetting("language_moderation:target", "-10088");
    db.setSetting("language_moderation:enabled", "true");
    db.setSetting("language_moderation:warning_text", "Existing warning");
    db.setSetting("language_moderation:allowlist", '["uid"]');
    db.setSetting("support_logs_thread_id:-10042", "77");
    db.setSetting("staff_help_sent:-10042", "true");
    const service = new InstallationService(db);
    service.adoptLegacyInstallation(-10042);
    service.adoptLegacyInstallation(-10042);
    assert.equal(db.getSetting("language_moderation:enabled"), "true");
    assert.equal(db.getSetting("language_moderation:warning_text"), "Existing warning");
    assert.equal(db.getSetting("support_logs_thread_id:-10042"), "77");
    assert.equal(db.getInstallationOperationalCounts().publicChats, 1);
    const imported = db.getManagedPublicChat(-10088);
    assert.equal(imported?.moderation_enabled, 1);
    assert.equal(imported?.warning_text, "Existing warning");
    assert.deepEqual(imported?.allowlist, ["uid"]);
  } finally { db.close(); }
});

test("legacy adoption imports a missing moderation target for an existing active workspace", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    service.adoptLegacyInstallation(-10042);
    db.setSetting("language_moderation:target", "-10088");
    db.setSetting("language_moderation:enabled", "true");

    service.adoptLegacyInstallation(-10042);

    assert.equal(service.getStaffChatId(), -10042);
    assert.equal(db.getManagedPublicChat(-10088)?.moderation_enabled, 1);
    assert.equal(service.listWorkspaces().length, 1);
  } finally { db.close(); }
});

test("legacy adoption does not reactivate a deliberately removed moderation target", () => {
  const db = new SupportDatabase(":memory:");
  try {
    db.setSetting("language_moderation:target", "-10088");
    const service = new InstallationService(db);
    service.adoptLegacyInstallation(-10042);
    db.deactivateManagedPublicChat(-10088);

    service.adoptLegacyInstallation(-10042);

    assert.equal(db.getManagedPublicChat(-10088), undefined);
    assert.equal(db.getManagedPublicChat(-10088, true)?.active, 0);
  } finally { db.close(); }
});

test("owner pairing is single-use and creates exactly one active owner", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db, { now: () => new Date("2026-08-02T10:00:00Z") });
    const token = service.createOwnerPairingToken();
    assert.equal(service.consumeOwnerPairingToken(token, { telegramId: 10, username: "owner" }).kind, "PAIRED");
    assert.equal(service.consumeOwnerPairingToken(token, { telegramId: 11 }).kind, "INVALID");
    assert.equal(service.getOwner()?.userTelegramId, 10);
    assert.equal(service.listTeamMembers().filter((member) => member.role === "OWNER").length, 1);
  } finally { db.close(); }
});

test("owner pairing tokens cannot be reused as owner recovery tokens", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    const stale = service.createOwnerPairingToken();
    const current = service.createOwnerPairingToken();
    assert.equal(service.consumeOwnerPairingToken(stale, { telegramId: 9 }).kind, "INVALID");
    assert.equal(service.consumeOwnerPairingToken(current, { telegramId: 10 }).kind, "PAIRED");

    const pairingAfterOwner = service.createOwnerPairingToken();
    assert.equal(service.consumeOwnerPairingToken(pairingAfterOwner, { telegramId: 11 }).kind, "INVALID");
    assert.equal(service.getOwner()?.userTelegramId, 10);
  } finally { db.close(); }
});

test("expired owner pairing token is rejected", () => {
  const db = new SupportDatabase(":memory:");
  let now = new Date("2026-08-02T10:00:00Z");
  try {
    const service = new InstallationService(db, { now: () => now, tokenTtlMs: 1000 });
    const token = service.createOwnerPairingToken();
    now = new Date("2026-08-02T10:00:02Z");
    assert.equal(service.consumeOwnerPairingToken(token, { telegramId: 10 }).kind, "EXPIRED");
    assert.equal(service.getOwner(), null);
  } finally { db.close(); }
});

test("pairing an owner does not activate role-based access", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    service.adoptLegacyInstallation(-10042);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 10 });
    assert.equal(service.getState().authorizationMode, "LEGACY_TRUSTED_GROUP");
    const preview = service.previewRoleBasedAccessActivation();
    assert.equal(preview.ownerCount, 1);
    assert.equal(preview.activeRoleCount, 1);
    service.activateRoleBasedAccess(10, preview.confirmationToken);
    assert.equal(service.getState().authorizationMode, "RBAC_ACTIVE");
  } finally { db.close(); }
});

test("role permissions enforce owner/admin/agent boundaries", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 });
    service.assignRole(1, 2, "ADMIN");
    service.assignRole(2, 3, "SENIOR_AGENT");
    service.assignRole(2, 4, "AGENT");
    assert.equal(service.can(1, "MANAGE_ADMINS"), true);
    assert.equal(service.can(2, "MANAGE_ADMINS"), false);
    assert.equal(service.can(2, "MANAGE_TEAM"), true);
    assert.equal(service.can(4, "BAN_USERS"), false);
    assert.equal(service.can(4, "REPLY_TO_TICKETS"), true);
    assert.throws(() => service.assignRole(2, 5, "ADMIN"));
    assert.throws(() => service.revokeMember(2, 1));
  } finally { db.close(); }
});

test("team invitations are hashed, expiring, and single-use", () => {
  const db = new SupportDatabase(":memory:");
  let now = new Date("2026-08-02T10:00:00Z");
  try {
    const service = new InstallationService(db, { now: () => now, tokenTtlMs: 1000 });
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 });
    const token = service.createTeamInvitation(1, "AGENT");
    assert.equal(JSON.stringify(service.listTokenMetadata()).includes(token), false);
    assert.equal(service.consumeTeamInvitation(token, { telegramId: 2 }).kind, "JOINED");
    assert.equal(service.consumeTeamInvitation(token, { telegramId: 3 }).kind, "INVALID");
    const expiring = service.createTeamInvitation(1, "AGENT");
    now = new Date("2026-08-02T10:00:02Z");
    assert.equal(service.consumeTeamInvitation(expiring, { telegramId: 3 }).kind, "EXPIRED");
  } finally { db.close(); }
});

test("an active owner cannot be demoted by consuming a team invitation", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1, username: "owner" });
    const token = service.createTeamInvitation(1, "ADMIN");

    assert.equal(service.consumeTeamInvitation(token, { telegramId: 1, username: "owner" }).kind, "INVALID");
    assert.equal(service.getOwner()?.userTelegramId, 1);
    assert.equal(service.listTeamMembers().filter((member) => member.role === "OWNER").length, 1);
    assert.equal(service.consumeTeamInvitation(token, { telegramId: 2, username: "admin" }).kind, "JOINED");
    assert.equal(service.getMember(2)?.role, "ADMIN");
  } finally { db.close(); }
});

test("owner recovery keeps old owner until explicit private confirmation", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 });
    const token = service.createOwnerRecoveryToken();
    assert.equal(service.consumeOwnerPairingToken(token, { telegramId: 2 }).kind, "TRANSFER_CONFIRMATION_REQUIRED");
    assert.equal(service.getOwner()?.userTelegramId, 1);
    service.confirmOwnerTransfer(2);
    assert.equal(service.getOwner()?.userTelegramId, 2);
    assert.equal(service.listTeamMembers().filter((member) => member.role === "OWNER").length, 1);
  } finally { db.close(); }
});

test("onboarding state survives service recreation", () => {
  const db = new SupportDatabase(":memory:");
  try {
    const first = new InstallationService(db);
    first.saveOnboardingStage(1, "STAFF_WORKSPACE");
    const second = new InstallationService(db);
    assert.equal(second.getOnboardingSession(1)?.stage, "STAFF_WORKSPACE");
  } finally { db.close(); }
});
