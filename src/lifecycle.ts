export type ApplicationLifecycleState = "RUNNING" | "SHUTTING_DOWN" | "STOPPED";

export interface BackgroundTaskTracker {
  run(task: () => Promise<void>): boolean;
  stopAccepting(): void;
  drain(): Promise<void>;
}

export class BackgroundTaskRegistry implements BackgroundTaskTracker {
  private accepting = true;
  private readonly tasks = new Set<Promise<void>>();

  run(task: () => Promise<void>): boolean {
    if (!this.accepting) return false;
    const pending = Promise.resolve().then(task);
    this.tasks.add(pending);
    void pending.finally(() => this.tasks.delete(pending)).catch(() => undefined);
    return true;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  async drain(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }
}

export interface ApplicationLifecycleDependencies {
  stopPolling(): void;
  pollingCompletion(): Promise<void> | null;
  stopBackgroundWork?(): void;
  backgroundTasks: BackgroundTaskTracker;
  stopAndDrainBackups?(): Promise<void>;
  closeDatabase(): void;
  onDrainFailure?(stage: "polling" | "background" | "backup", error: unknown): void;
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
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    this.state = "SHUTTING_DOWN";
    this.dependencies.backgroundTasks.stopAccepting();
    this.dependencies.stopBackgroundWork?.();
    const backupDrain = this.dependencies.stopAndDrainBackups?.();
    const polling = this.dependencies.pollingCompletion();
    try {
      this.dependencies.stopPolling();
    } catch (error) {
      this.dependencies.onDrainFailure?.("polling", error);
    }
    await this.drain("polling", async () => { if (polling) await polling; });
    await this.drain("background", () => this.dependencies.backgroundTasks.drain());
    await this.drain("backup", async () => { await backupDrain; });
    this.closeDatabase();
    this.state = "STOPPED";
  }

  async startupFailed(): Promise<void> {
    await this.shutdown();
  }

  private async drain(stage: "polling" | "background" | "backup", operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.dependencies.onDrainFailure?.(stage, error);
    }
  }

  private closeDatabase(): void {
    if (this.closed) return;
    this.closed = true;
    this.dependencies.closeDatabase();
  }
}
