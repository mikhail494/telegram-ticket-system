import type { InstallationService } from "./installation.js";
import type { BackgroundTaskTracker } from "./lifecycle.js";

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
  madeProgress: boolean;
}

export async function runBoundedRecoveryPass<T>(
  candidates: readonly T[],
  budget: StartupRecoveryBudget,
  process: (candidate: T) => Promise<boolean | void>
): Promise<BoundedRecoveryPassResult> {
  let processed = 0;
  let madeProgress = false;
  for (let index = 0; index < candidates.length; index += 1) {
    if (!budget.tryStartItem()) return { processed, hasMore: true, madeProgress };
    if ((await process(candidates[index]!)) !== false) madeProgress = true;
    processed += 1;
  }
  return { processed, hasMore: false, madeProgress };
}

export interface StartupRecoveryContinuationResult {
  hasMore: boolean;
  madeProgress: boolean;
}

export interface StartupRecoveryContinuationDependencies {
  backgroundTasks: BackgroundTaskTracker;
  shouldContinue(): boolean;
  onFailure?(name: string, error: unknown): void;
  createTimer?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
}

type StartupRecoveryContinuationTask = () => Promise<StartupRecoveryContinuationResult>;

const STARTUP_RECOVERY_CONTINUATION_YIELD_MS = 250;
const STARTUP_RECOVERY_CONTINUATION_RETRY_MS = 30_000;

export class StartupRecoveryContinuation {
  private readonly pending = new Map<string, StartupRecoveryContinuationTask>();
  private started = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dependencies: StartupRecoveryContinuationDependencies) {}

  enqueue(name: string, task: StartupRecoveryContinuationTask): void {
    if (this.stopped) return;
    this.pending.set(name, task);
    if (this.started) this.schedule(STARTUP_RECOVERY_CONTINUATION_YIELD_MS);
  }

  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    this.schedule(STARTUP_RECOVERY_CONTINUATION_YIELD_MS);
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
    if (this.timer) {
      (this.dependencies.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.stopped || !this.dependencies.shouldContinue() || !this.pending.size) return;
    this.timer = (this.dependencies.createTimer ?? setTimeout)(() => {
      this.timer = null;
      const accepted = this.dependencies.backgroundTasks.run(() => this.runNextChunk());
      if (!accepted) this.stop();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runNextChunk(): Promise<void> {
    if (this.stopped || !this.dependencies.shouldContinue()) return;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    let delayMs = STARTUP_RECOVERY_CONTINUATION_YIELD_MS;
    for (const [name, task] of entries) {
      if (this.stopped || !this.dependencies.shouldContinue()) return;
      try {
        const result = await task();
        if (!result.hasMore) continue;
        this.pending.set(name, task);
        if (!result.madeProgress) delayMs = Math.max(delayMs, STARTUP_RECOVERY_CONTINUATION_RETRY_MS);
      } catch (error) {
        this.dependencies.onFailure?.(name, error);
        this.pending.set(name, task);
        delayMs = Math.max(delayMs, STARTUP_RECOVERY_CONTINUATION_RETRY_MS);
      }
    }
    this.schedule(delayMs);
  }
}

export interface WorkspaceStartupTasks {
  initializeSupportLogs(): Promise<void>;
  recoverArchives(): Promise<void>;
  recoverModeration(): Promise<void>;
  recoverBatch(): Promise<void>;
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
  if (!(await run(tasks.recoverBatch))) return "SHUTTING_DOWN";
  if (!workspace.imported_from_legacy && !(await run(tasks.sendLegacyStaffOnboarding))) return "SHUTTING_DOWN";
  return setupState;
}
