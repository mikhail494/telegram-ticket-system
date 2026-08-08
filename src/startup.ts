import type { InstallationService } from "./installation.js";

export interface WorkspaceStartupTasks {
  initializeSupportLogs(): Promise<void>;
  recoverArchives(): Promise<void>;
  recoverModeration(): Promise<void>;
  recoverBatch(): Promise<void>;
  sendLegacyStaffOnboarding(): Promise<void>;
}

export async function runWorkspaceStartup(installation: InstallationService, tasks: WorkspaceStartupTasks): Promise<"SETUP_REQUIRED" | "READY"> {
  const setupState = installation.getState().setupState;
  const workspace = installation.getActiveWorkspace();
  if (setupState !== "READY" || !workspace) return "SETUP_REQUIRED";
  await tasks.initializeSupportLogs();
  await tasks.recoverArchives();
  await tasks.recoverModeration();
  await tasks.recoverBatch();
  if (!workspace.imported_from_legacy) await tasks.sendLegacyStaffOnboarding();
  return setupState;
}
