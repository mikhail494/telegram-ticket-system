import type { InstallationService } from "./installation.js";

export const STARTUP_RECOVERY_MAX_ITEMS = 50;
export const STARTUP_RECOVERY_MAX_DURATION_MS = 10_000;

export interface StartupRecoveryBudgetOptions {
  maxItems?: number;
  maxDurationMs?: number;
  now?: () => number;
  shouldContinue?: () => boolean;
}

export class StartupRecoveryBudget {
  private readonly maxItems: number;
  private readonly maxDurationMs: number;
  private readonly now: () => number;
  private readonly shouldContinue: () => boolean;
  private readonly startedAt: number;
  private startedItems = 0;

  constructor(options: StartupRecoveryBudgetOptions = {}) {
    this.maxItems = options.maxItems ?? STARTUP_RECOVERY_MAX_ITEMS;
    this.maxDurationMs = options.maxDurationMs ?? STARTUP_RECOVERY_MAX_DURATION_MS;
    this.now = options.now ?? Date.now;
    this.shouldContinue = options.shouldContinue ?? (() => true);
    this.startedAt = this.now();
  }

  tryStartItem(): boolean {
    if (
      !this.shouldContinue() ||
      this.startedItems >= this.maxItems ||
      this.now() - this.startedAt >= this.maxDurationMs
    )
      return false;
    this.startedItems += 1;
    return true;
  }

  remainingItemCapacity(): number {
    return Math.max(0, this.maxItems - this.startedItems);
  }
}

export interface BoundedRecoveryPassResult {
  processed: number;
  hasMore: boolean;
}

export async function runBoundedRecoveryPass<T>(
  candidates: readonly T[],
  budget: StartupRecoveryBudget,
  process: (candidate: T) => Promise<void>
): Promise<BoundedRecoveryPassResult> {
  let processed = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    if (!budget.tryStartItem()) return { processed, hasMore: true };
    await process(candidates[index]!);
    processed += 1;
  }
  return { processed, hasMore: false };
}

export interface WorkspaceStartupTasks {
  initializeSupportLogs(): Promise<void>;
  recoverArchives(): Promise<void>;
  recoverModeration(): Promise<void>;
  sendLegacyStaffOnboarding(): Promise<void>;
  discoverStaffWorkspaceMembers?(): Promise<void>;
}

export interface WorkspaceStartupOptions {
  shouldContinue?: () => boolean;
}

export async function runWorkspaceStartup(
  installation: InstallationService,
  tasks: WorkspaceStartupTasks,
  options: WorkspaceStartupOptions = {}
): Promise<"SETUP_REQUIRED" | "READY" | "SHUTTING_DOWN"> {
  const setupState = installation.getState().setupState;
  const workspace = installation.getActiveWorkspace();
  if (setupState !== "READY" || !workspace) return "SETUP_REQUIRED";
  const shouldContinue = options.shouldContinue ?? (() => true);
  const run = async (task: () => Promise<void>): Promise<boolean> => {
    if (!shouldContinue()) return false;
    await task();
    return shouldContinue();
  };
  installation.activateReadyRoleBasedAccess();
  if (tasks.discoverStaffWorkspaceMembers && !(await run(tasks.discoverStaffWorkspaceMembers))) return "SHUTTING_DOWN";
  if (!(await run(tasks.initializeSupportLogs))) return "SHUTTING_DOWN";
  if (!(await run(tasks.recoverArchives))) return "SHUTTING_DOWN";
  if (!(await run(tasks.recoverModeration))) return "SHUTTING_DOWN";
  if (!workspace.imported_from_legacy && !(await run(tasks.sendLegacyStaffOnboarding))) return "SHUTTING_DOWN";
  return setupState;
}
