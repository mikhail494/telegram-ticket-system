import test from "node:test";
import assert from "node:assert/strict";
import { SupportDatabase } from "../src/db.js";
import { InstallationService } from "../src/installation.js";
import { runWorkspaceStartup } from "../src/startup.js";

test("setup mode skips every staff-workspace startup task", async () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    service.activateWorkspace({ chatId: -10041, title: "Pending setup workspace" });
    const calls: string[] = [];
    const task = (name: string) => async () => { calls.push(name); };
    assert.equal(await runWorkspaceStartup(service, { initializeSupportLogs: task("logs"), recoverArchives: task("archives"), recoverModeration: task("moderation"), recoverBatch: task("batch"), sendLegacyStaffOnboarding: task("onboarding") }), "SETUP_REQUIRED");
    assert.deepEqual(calls, []);
  } finally { db.close(); }
});

test("legacy workspace starts recoveries without creating onboarding noise", async () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db); service.adoptLegacyInstallation(-10042);
    const calls: string[] = []; const task = (name: string) => async () => { calls.push(name); };
    assert.equal(await runWorkspaceStartup(service, { initializeSupportLogs: task("logs"), recoverArchives: task("archives"), recoverModeration: task("moderation"), recoverBatch: task("batch"), sendLegacyStaffOnboarding: task("onboarding") }), "READY");
    assert.deepEqual(calls, ["logs", "archives", "moderation", "batch"]);
  } finally { db.close(); }
});

test("ready startup automatically switches an adopted installation with an owner to role-based access", async () => {
  const db = new SupportDatabase(":memory:");
  try {
    const service = new InstallationService(db);
    service.consumeOwnerPairingToken(service.createOwnerPairingToken(), { telegramId: 1 });
    service.adoptLegacyInstallation(-10042);
    const task = async () => undefined;

    await runWorkspaceStartup(service, {
      initializeSupportLogs: task,
      recoverArchives: task,
      recoverModeration: task,
      recoverBatch: task,
      sendLegacyStaffOnboarding: task
    });

    assert.equal(service.getState().authorizationMode, "RBAC_ACTIVE");
  } finally { db.close(); }
});
