export type ApplicationLifecycleState = "RUNNING" | "SHUTTING_DOWN" | "STOPPED";

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
  pollingCompletion(): Promise<void> | null;
  stopBackgroundWork?(): void;
  backgroundTasks: BackgroundTaskTracker;
  stopAndDrainBackups?(): Promise<void>;
  closeDatabase(): void;
  closeOperationalServer?(): Promise<void>;
  onDrainFailure?(stage: "polling" | "background" | "backup" | "database" | "server", error: unknown): void;
}

export class ApplicationLifecycle {
  private state: ApplicationLifecycleState = "RUNNING";
  private shutdownPromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly dependencies: ApplicationLifecycleDependencies) {}

  getState(): ApplicationLifecycleState {
    return this.state;
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
    this.dependencies.backgroundTasks.stopAccepting();
    this.dependencies.stopBackgroundWork?.();
    const backupDrain = this.dependencies.stopAndDrainBackups?.();
    const polling = this.dependencies.pollingCompletion();
    if (stopPolling) {
      try {
        this.dependencies.stopPolling();
      } catch (error) {
        this.dependencies.onDrainFailure?.("polling", error);
      }
    }
    await this.drain("polling", async () => {
      if (polling) await polling;
    });
    await this.drain("background", () => this.dependencies.backgroundTasks.drain());
    await this.drain("backup", async () => {
      await backupDrain;
    });
    this.closeDatabase();
    await this.drain("server", async () => {
      await this.dependencies.closeOperationalServer?.();
    });
    this.state = "STOPPED";
  }

  async startupFailed(): Promise<void> {
    await this.shutdown();
  }

  private async drain(
    stage: "polling" | "background" | "backup" | "server",
    operation: () => Promise<void>
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.dependencies.onDrainFailure?.(stage, error);
    }
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
}

export async function awaitApplicationCompletion(
  polling: Promise<void>,
  lifecycle: ApplicationLifecycle
): Promise<void> {
  await polling;
  await lifecycle.completeAfterPolling();
}
