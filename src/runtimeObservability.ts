import type { BackgroundTaskSnapshot, BackgroundTaskTracker } from "./lifecycle.js";
import { logger } from "./logger.js";

export type OperationalRuntimeState = "STARTING" | "READY" | "SHUTTING_DOWN" | "STOPPED";
export type UpdateErrorCategory = "telegram" | "http" | "unknown";
export type OperationalAlertCondition = "DATABASE_UNHEALTHY" | "POLLING_TERMINATED" | "BACKUP_FAILURE" | "BACKUP_STALE";

const ONE_HOUR_MS = 3_600_000;
const DATABASE_ALERT_FAILURE_THRESHOLD = 3;
export const RUNTIME_HEALTH_EVALUATION_INTERVAL_MS = 60_000;

export interface RuntimeHealthSnapshot {
  runtimeState: OperationalRuntimeState;
  processStartedAt: Date;
  processUptimeSeconds: number;
  databaseReady: boolean;
  databaseConsecutiveFailures: number;
  lastDatabaseSuccessAt: Date | null;
  lastDatabaseFailureAt: Date | null;
  pollingActive: boolean;
  pollingUnexpectedlyTerminated: boolean;
  pollingStartedAt: Date | null;
  pollingTerminatedAt: Date | null;
  pollingUnexpectedTerminationsTotal: number;
  updatesProcessedTotal: number;
  updateErrorsTotal: number;
  updateErrorsByCategory: Readonly<Record<UpdateErrorCategory, number>>;
  lastUpdateSuccessAt: Date | null;
  lastUpdateErrorAt: Date | null;
  backgroundTasksAccepting: boolean;
  backgroundTasksInFlight: number;
  backgroundTasksAcceptedTotal: number;
  backgroundTasksRejectedTotal: number;
  backgroundTasksCompletedTotal: number;
  backgroundTasksFailedTotal: number;
  backupEnabled: boolean;
  backupSuccessTotal: number;
  backupFailureTotal: number;
  backupConsecutiveFailures: number;
  backupLastSuccessAt: Date | null;
  backupLastFailureAt: Date | null;
  backupLastSizeBytes: number;
  backupRetentionDeletedTotal: number;
  backupRetentionFailuresTotal: number;
  backupTempCleanupFailuresTotal: number;
  backupAgeSeconds: number;
  backupStale: boolean;
  alertDeliveryFailuresTotal: number;
}

interface RuntimeHealthOptions {
  backupEnabled: boolean;
  backupIntervalMs: number;
  now?: () => Date;
  processStartedAt?: Date;
}

interface BackupObservation {
  size: number;
  retentionDeleted: number;
  retentionFailed: number;
  tempCleanupFailed: number;
}

const EMPTY_BACKGROUND_TASKS: BackgroundTaskSnapshot = {
  accepting: true,
  inFlight: 0,
  acceptedTotal: 0,
  rejectedTotal: 0,
  completedTotal: 0,
  failedTotal: 0,
};

function copyDate(value: Date | null): Date | null {
  return value ? new Date(value) : null;
}

export class RuntimeHealthRegistry {
  private readonly now: () => Date;
  private readonly startedAt: Date;
  private readonly backupStaleAfterMs: number;
  private runtimeState: OperationalRuntimeState = "STARTING";
  private databaseReady = false;
  private databaseConsecutiveFailures = 0;
  private lastDatabaseSuccessAt: Date | null = null;
  private lastDatabaseFailureAt: Date | null = null;
  private pollingActive = false;
  private pollingUnexpectedlyTerminated = false;
  private pollingStartedAt: Date | null = null;
  private pollingTerminatedAt: Date | null = null;
  private pollingUnexpectedTerminationsTotal = 0;
  private updatesProcessedTotal = 0;
  private updateErrorsTotal = 0;
  private readonly updateErrorsByCategory: Record<UpdateErrorCategory, number> = {
    telegram: 0,
    http: 0,
    unknown: 0,
  };
  private lastUpdateSuccessAt: Date | null = null;
  private lastUpdateErrorAt: Date | null = null;
  private backupSuccessTotal = 0;
  private backupFailureTotal = 0;
  private backupConsecutiveFailures = 0;
  private backupLastSuccessAt: Date | null = null;
  private backupLastFailureAt: Date | null = null;
  private backupLastSizeBytes = 0;
  private backupRetentionDeletedTotal = 0;
  private backupRetentionFailuresTotal = 0;
  private backupTempCleanupFailuresTotal = 0;
  private alertDeliveryFailuresTotal = 0;

  constructor(private readonly options: RuntimeHealthOptions) {
    this.now = options.now ?? (() => new Date());
    const observedNow = this.now();
    this.startedAt = options.processStartedAt
      ? new Date(options.processStartedAt)
      : new Date(observedNow.getTime() - process.uptime() * 1000);
    this.backupStaleAfterMs = Math.max(2 * options.backupIntervalMs, options.backupIntervalMs + ONE_HOUR_MS);
  }

  setRuntimeState(state: OperationalRuntimeState): void {
    this.runtimeState = state;
  }

  getRuntimeState(): OperationalRuntimeState {
    return this.runtimeState;
  }

  recordDatabaseProbe(ready: boolean): void {
    this.databaseReady = ready;
    if (ready) {
      this.lastDatabaseSuccessAt = new Date(this.now());
      this.databaseConsecutiveFailures = 0;
    } else {
      this.lastDatabaseFailureAt = new Date(this.now());
      this.databaseConsecutiveFailures += 1;
    }
  }

  markPollingStarted(): void {
    this.pollingActive = true;
    this.pollingUnexpectedlyTerminated = false;
    this.pollingStartedAt = new Date(this.now());
  }

  markPollingStopped(): void {
    this.pollingActive = false;
    this.pollingTerminatedAt = new Date(this.now());
  }

  recordUnexpectedPollingTermination(): void {
    this.markPollingStopped();
    this.pollingUnexpectedlyTerminated = true;
    this.pollingUnexpectedTerminationsTotal += 1;
  }

  recordUpdateSuccess(): void {
    this.updatesProcessedTotal += 1;
    this.lastUpdateSuccessAt = new Date(this.now());
  }

  recordUpdateError(category: UpdateErrorCategory): void {
    this.updateErrorsTotal += 1;
    this.updateErrorsByCategory[category] += 1;
    this.lastUpdateErrorAt = new Date(this.now());
  }

  recordBackupSuccess(result: BackupObservation): void {
    this.backupSuccessTotal += 1;
    this.backupConsecutiveFailures = 0;
    this.backupLastSuccessAt = new Date(this.now());
    this.backupLastSizeBytes = result.size;
    this.backupRetentionDeletedTotal += result.retentionDeleted;
    this.backupRetentionFailuresTotal += result.retentionFailed;
    this.backupTempCleanupFailuresTotal += result.tempCleanupFailed;
  }

  recordExistingBackup(backup: { size: number; modifiedAt: Date }): void {
    this.backupLastSuccessAt = new Date(backup.modifiedAt);
    this.backupLastSizeBytes = backup.size;
  }

  recordBackupFailure(): void {
    this.backupFailureTotal += 1;
    this.backupConsecutiveFailures += 1;
    this.backupLastFailureAt = new Date(this.now());
  }

  recordAlertDeliveryFailure(): void {
    this.alertDeliveryFailuresTotal += 1;
  }

  snapshot(backgroundTasks: BackgroundTaskSnapshot = EMPTY_BACKGROUND_TASKS): RuntimeHealthSnapshot {
    const now = this.now().getTime();
    const backupReference = this.backupLastSuccessAt?.getTime() ?? this.startedAt.getTime();
    const backupAgeSeconds =
      this.options.backupEnabled && this.backupLastSuccessAt
        ? Math.max(0, Math.floor((now - backupReference) / 1000))
        : 0;
    const backupStale = this.options.backupEnabled && now - backupReference >= this.backupStaleAfterMs;
    return {
      runtimeState: this.runtimeState,
      processStartedAt: new Date(this.startedAt),
      processUptimeSeconds: Math.max(0, (now - this.startedAt.getTime()) / 1000),
      databaseReady: this.databaseReady,
      databaseConsecutiveFailures: this.databaseConsecutiveFailures,
      lastDatabaseSuccessAt: copyDate(this.lastDatabaseSuccessAt),
      lastDatabaseFailureAt: copyDate(this.lastDatabaseFailureAt),
      pollingActive: this.pollingActive,
      pollingUnexpectedlyTerminated: this.pollingUnexpectedlyTerminated,
      pollingStartedAt: copyDate(this.pollingStartedAt),
      pollingTerminatedAt: copyDate(this.pollingTerminatedAt),
      pollingUnexpectedTerminationsTotal: this.pollingUnexpectedTerminationsTotal,
      updatesProcessedTotal: this.updatesProcessedTotal,
      updateErrorsTotal: this.updateErrorsTotal,
      updateErrorsByCategory: { ...this.updateErrorsByCategory },
      lastUpdateSuccessAt: copyDate(this.lastUpdateSuccessAt),
      lastUpdateErrorAt: copyDate(this.lastUpdateErrorAt),
      backgroundTasksAccepting: backgroundTasks.accepting,
      backgroundTasksInFlight: backgroundTasks.inFlight,
      backgroundTasksAcceptedTotal: backgroundTasks.acceptedTotal,
      backgroundTasksRejectedTotal: backgroundTasks.rejectedTotal,
      backgroundTasksCompletedTotal: backgroundTasks.completedTotal,
      backgroundTasksFailedTotal: backgroundTasks.failedTotal,
      backupEnabled: this.options.backupEnabled,
      backupSuccessTotal: this.backupSuccessTotal,
      backupFailureTotal: this.backupFailureTotal,
      backupConsecutiveFailures: this.backupConsecutiveFailures,
      backupLastSuccessAt: copyDate(this.backupLastSuccessAt),
      backupLastFailureAt: copyDate(this.backupLastFailureAt),
      backupLastSizeBytes: this.backupLastSizeBytes,
      backupRetentionDeletedTotal: this.backupRetentionDeletedTotal,
      backupRetentionFailuresTotal: this.backupRetentionFailuresTotal,
      backupTempCleanupFailuresTotal: this.backupTempCleanupFailuresTotal,
      backupAgeSeconds,
      backupStale,
      alertDeliveryFailuresTotal: this.alertDeliveryFailuresTotal,
    };
  }
}

interface AlertCoordinatorOptions {
  health: RuntimeHealthRegistry;
  backgroundTasks: BackgroundTaskTracker;
  getStaffChatId(): number | null;
  sendMessage(chatId: number, text: string): Promise<unknown>;
  now?: () => Date;
}

const ALERT_DETAILS: Readonly<Record<OperationalAlertCondition, string>> = {
  DATABASE_UNHEALTHY: "SQLite readiness probe failed repeatedly.",
  POLLING_TERMINATED: "Telegram polling terminated unexpectedly.",
  BACKUP_FAILURE: "The scheduled SQLite backup could not be completed.",
  BACKUP_STALE: "No successful SQLite backup exists within the configured freshness window.",
};

export class OperationalAlertCoordinator {
  private readonly now: () => Date;
  private deliveryTail: Promise<void> = Promise.resolve();
  private readonly firing: Record<OperationalAlertCondition, boolean> = {
    DATABASE_UNHEALTHY: false,
    POLLING_TERMINATED: false,
    BACKUP_FAILURE: false,
    BACKUP_STALE: false,
  };

  constructor(private readonly options: AlertCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  evaluate(snapshot = this.options.health.snapshot()): void {
    this.transition("DATABASE_UNHEALTHY", snapshot.databaseConsecutiveFailures >= DATABASE_ALERT_FAILURE_THRESHOLD);
    this.transition("POLLING_TERMINATED", snapshot.pollingUnexpectedlyTerminated);
    this.transition("BACKUP_FAILURE", snapshot.backupEnabled && snapshot.backupConsecutiveFailures > 0);
    this.transition("BACKUP_STALE", snapshot.backupStale);
  }

  private transition(condition: OperationalAlertCondition, nextFiring: boolean): void {
    if (this.firing[condition] === nextFiring) return;
    this.firing[condition] = nextFiring;
    const status = nextFiring ? "FIRING" : "RECOVERED";
    logger.info(
      { condition, status },
      nextFiring ? "Operational alert condition entered" : "Operational alert recovered"
    );
    const accepted = this.options.backgroundTasks.run(async () => {
      const previous = this.deliveryTail;
      let release!: () => void;
      this.deliveryTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        await this.deliver(condition, status, nextFiring);
      } finally {
        release();
      }
    });
    if (!accepted) logger.debug({ condition, status }, "Operational alert dropped during shutdown");
  }

  private async deliver(
    condition: OperationalAlertCondition,
    status: "FIRING" | "RECOVERED",
    firing: boolean
  ): Promise<void> {
    const staffChatId = this.options.getStaffChatId();
    if (staffChatId === null) {
      this.options.health.recordAlertDeliveryFailure();
      logger.warn({ condition, status }, "Operational alert has no configured staff workspace destination");
      return;
    }
    const heading = firing ? "Support bot operational alert" : "Support bot operational recovery";
    const text = [
      heading,
      "",
      `Condition: ${condition}`,
      `Status: ${status}`,
      `UTC: ${this.now().toISOString()}`,
      `Details: ${ALERT_DETAILS[condition]}`,
    ].join("\n");
    try {
      await this.options.sendMessage(staffChatId, text);
      logger.info({ condition, status }, "Operational alert delivered");
    } catch {
      this.options.health.recordAlertDeliveryFailure();
      logger.warn({ condition, status }, "Operational alert delivery failed");
    }
  }
}

interface TimerHandle {
  unref(): unknown;
}

interface RuntimeHealthEvaluatorOptions {
  health: RuntimeHealthRegistry;
  checkDatabase(): boolean;
  evaluateAlerts(): void;
  intervalMs?: number;
  setTimer?: (handler: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

export class RuntimeHealthEvaluator {
  private readonly intervalMs: number;
  private readonly setTimer: (handler: () => void, delay: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private timer: TimerHandle | null = null;
  private stopped = true;
  private evaluating = false;

  constructor(private readonly options: RuntimeHealthEvaluatorOptions) {
    this.intervalMs = options.intervalMs ?? RUNTIME_HEALTH_EVALUATION_INTERVAL_MS;
    this.setTimer = options.setTimer ?? ((handler, delay) => setTimeout(handler, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  evaluateNow(): void {
    if (this.stopped || this.evaluating) return;
    this.evaluating = true;
    try {
      let databaseReady = false;
      try {
        databaseReady = this.options.checkDatabase();
      } catch {
        databaseReady = false;
      }
      this.options.health.recordDatabaseProbe(databaseReady);
      this.options.evaluateAlerts();
    } catch (error) {
      logger.warn({ stage: "evaluation", errorType: typeof error }, "Runtime health evaluator failed");
    } finally {
      this.evaluating = false;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.stopped) return;
      this.evaluateNow();
      this.schedule();
    }, this.intervalMs);
    this.timer.unref();
  }
}

interface PollingObservationOptions {
  health: RuntimeHealthRegistry;
  isExpectedTermination(): boolean;
  onUnexpectedTermination(outcome: "resolved" | "rejected"): void;
}

export function observePollingCompletion(polling: Promise<void>, options: PollingObservationOptions): Promise<void> {
  return polling.then(
    () => {
      if (options.isExpectedTermination()) options.health.markPollingStopped();
      else {
        options.health.recordUnexpectedPollingTermination();
        options.onUnexpectedTermination("resolved");
      }
    },
    (error: unknown) => {
      if (options.isExpectedTermination()) options.health.markPollingStopped();
      else {
        options.health.recordUnexpectedPollingTermination();
        options.onUnexpectedTermination("rejected");
      }
      throw error;
    }
  );
}
