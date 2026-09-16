export type ApplicationLifecycleState = "RUNNING" | "SHUTTING_DOWN" | "STOPPED";
export type ShutdownStage = "startup" | "polling" | "background" | "backup" | "server" | "database";

export const GRACEFUL_SHUTDOWN_DEADLINE_MS = 30_000;

export interface BackgroundTaskTracker {
  run(task: () => Promise<void>): boolean;
  stopAccepting(): void;
  drain(): Promise<void>;
}

export interface BackgroundTaskSnapshot {
  accepting: boolean;
  inFlight: number;
  acceptedTotal: number;
  rejectedTotal: number;
  completedTotal: number;
  failedTotal: number;
}

export class BackgroundTaskRegistry implements BackgroundTaskTracker {
  private accepting = true;
  private readonly tasks = new Set<Promise<void>>();
  private acceptedTotal = 0;
  private rejectedTotal = 0;
  private completedTotal = 0;
  private failedTotal = 0;

  run(task: () => Promise<void>): boolean {
    if (!this.accepting) {
      this.rejectedTotal += 1;
      return false;
    }
    this.acceptedTotal += 1;
    const pending = Promise.resolve().then(task);
    this.tasks.add(pending);
    void pending
      .then(
        () => {
          this.completedTotal += 1;
        },
        () => {
          this.completedTotal += 1;
          this.failedTotal += 1;
        }
      )
      .finally(() => this.tasks.delete(pending))
      .catch(() => undefined);
    return true;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  async drain(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  snapshot(): BackgroundTaskSnapshot {
    return {
      accepting: this.accepting,
      inFlight: this.tasks.size,
      acceptedTotal: this.acceptedTotal,
      rejectedTotal: this.rejectedTotal,
      completedTotal: this.completedTotal,
      failedTotal: this.failedTotal,
    };
  }
}

export interface ApplicationLifecycleDependencies {
  stopPolling(): void;
  startupCompletion?(): Promise<void> | null;
  pollingCompletion(): Promise<void> | null;
  stopBackgroundWork?(): void;
  backgroundTasks: BackgroundTaskTracker;
  stopAndDrainBackups?(): Promise<void>;
  closeDatabase(): void;
  closeOperationalServer?(): Promise<void>;
  shutdownDeadlineMs?: number;
  createShutdownDeadlineTimer?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearShutdownDeadlineTimer?(timer: ReturnType<typeof setTimeout>): void;
  terminalExit?(code: number): void;
  onShutdownDeadline?(stage: ShutdownStage, deadlineMs: number): void;
  onDrainFailure?(stage: ShutdownStage, error: unknown): void;
}

export class ApplicationLifecycle {
  private state: ApplicationLifecycleState = "RUNNING";
  private shutdownPromise: Promise<void> | null = null;
  private closed = false;
  private deadlineExpired = false;
  private activeStage: ShutdownStage = "polling";

  constructor(private readonly dependencies: ApplicationLifecycleDependencies) {}

  getState(): ApplicationLifecycleState {
    return this.state;
  }

  isRunning(): boolean {
    return this.state === "RUNNING";
  }

  shutdown(): Promise<void> {
    return this.finish(true);
  }

  completeAfterPolling(): Promise<void> {
    return this.finish(false);
  }

  private finish(stopPolling: boolean): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.finishInternal(stopPolling);
    return this.shutdownPromise;
  }

  private async finishInternal(stopPolling: boolean): Promise<void> {
    this.state = "SHUTTING_DOWN";
    const deadline = this.createShutdownDeadline();
    this.dependencies.backgroundTasks.stopAccepting();
    this.dependencies.stopBackgroundWork?.();
    const backupDrain = this.dependencies.stopAndDrainBackups?.();
    const startup = this.dependencies.startupCompletion?.() ?? null;
    const polling = this.dependencies.pollingCompletion();
    if (stopPolling) {
      try {
        this.dependencies.stopPolling();
      } catch (error) {
        this.dependencies.onDrainFailure?.("polling", error);
      }
    }

    const completed = this.finishOrderly(startup, polling, backupDrain);
    const outcome = await Promise.race([
      completed.then(() => "completed" as const),
      deadline.promise.then(() => "deadline" as const),
    ]);
    deadline.clear();
    if (outcome === "deadline") {
      this.dependencies.onShutdownDeadline?.(this.activeStage, deadline.delayMs);
      this.dependencies.terminalExit?.(1);
      return;
    }
    this.state = "STOPPED";
  }

  async startupFailed(): Promise<void> {
    await this.shutdown();
  }

  private async finishOrderly(
    startup: Promise<void> | null,
    polling: Promise<void> | null,
    backupDrain: Promise<void> | undefined
  ): Promise<void> {
    if (
      !(await this.drain("startup", async () => {
        if (startup) await startup;
      }))
    )
      return;
    if (
      !(await this.drain("polling", async () => {
        if (polling) await polling;
      }))
    )
      return;
    if (!(await this.drain("background", () => this.dependencies.backgroundTasks.drain()))) return;
    if (
      !(await this.drain("backup", async () => {
        if (backupDrain) await backupDrain;
      }))
    )
      return;
    if (
      !(await this.drain("server", async () => {
        await this.dependencies.closeOperationalServer?.();
      }))
    )
      return;
    if (this.deadlineExpired) return;
    this.activeStage = "database";
    this.closeDatabase();
  }

  private async drain(stage: Exclude<ShutdownStage, "database">, operation: () => Promise<void>): Promise<boolean> {
    if (this.deadlineExpired) return false;
    this.activeStage = stage;
    try {
      await operation();
    } catch (error) {
      this.dependencies.onDrainFailure?.(stage, error);
    }
    return !this.deadlineExpired;
  }

  private closeDatabase(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.dependencies.closeDatabase();
    } catch (error) {
      this.dependencies.onDrainFailure?.("database", error);
    }
  }

  private createShutdownDeadline(): { delayMs: number; promise: Promise<void>; clear(): void } {
    const delayMs = this.dependencies.shutdownDeadlineMs ?? GRACEFUL_SHUTDOWN_DEADLINE_MS;
    if (!Number.isInteger(delayMs) || delayMs < 1_000 || delayMs > 120_000)
      throw new Error("shutdownDeadlineMs must be an integer between 1000 and 120000 milliseconds.");
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const createTimer = this.dependencies.createShutdownDeadlineTimer ?? setTimeout;
    const clearTimer = this.dependencies.clearShutdownDeadlineTimer ?? clearTimeout;
    const timer = createTimer(() => {
      this.deadlineExpired = true;
      resolve();
    }, delayMs);
    return {
      delayMs,
      promise,
      clear: () => {
        if (timer) clearTimer(timer);
      },
    };
  }
}

export interface ShutdownSignalRegistrar {
  once(signal: NodeJS.Signals, handler: () => void): unknown;
}

export function installShutdownSignalHandlers(
  lifecycle: ApplicationLifecycle,
  registrar: ShutdownSignalRegistrar = { once: (signal, handler) => process.once(signal, handler) }
): void {
  const shutdown = () => {
    void lifecycle.shutdown().catch(() => undefined);
  };
  registrar.once("SIGINT", shutdown);
  registrar.once("SIGTERM", shutdown);
}

export async function awaitApplicationCompletion(
  polling: Promise<void>,
  lifecycle: ApplicationLifecycle
): Promise<void> {
  await polling;
  await lifecycle.completeAfterPolling();
}
