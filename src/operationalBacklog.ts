export interface AgedBacklog {
  count: number;
  oldestAgeSeconds: number;
}

export interface DueBacklog {
  count: number;
  oldestOverdueSeconds: number;
}

export interface OperationalBacklogObservation {
  staffChatId: number;
  observedAt: string;
  deliveryReview: AgedBacklog;
  unknownDeliveryCount: number;
  batchRecovery: DueBacklog;
  moderationCleanup: DueBacklog;
  archiveRecovery: AgedBacklog;
  batchExportUnknownDeliveryCount: number;
}

export function backlogAgeSeconds(at: string, oldest: string | null): number {
  if (oldest === null) return 0;
  const delta = Date.parse(at) - Date.parse(oldest);
  return Number.isFinite(delta) ? Math.max(0, Math.floor(delta / 1000)) : 0;
}

export const BACKLOG_OBSERVATION_FRESHNESS_MS = 120_000;

export interface OperationalBacklogHealthSnapshot {
  workspaceConfigured: boolean | null;
  sampleAvailable: boolean;
  observationSuccess: boolean;
  fresh: boolean;
  observationFailuresTotal: number;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  observationAgeSeconds: number;
  observation: OperationalBacklogObservation | null;
}

export class OperationalBacklogRegistry {
  private observation: OperationalBacklogObservation | null = null;
  private lastAttemptAt: Date | null = null;
  private lastAttemptSucceeded = false;
  private lastObservedWorkspace: number | null = null;
  private failures = 0;

  constructor(
    private readonly now: () => Date,
    private readonly getWorkspace?: () => number | null
  ) {}

  record(observation: OperationalBacklogObservation | null): void {
    if (observation && !Number.isFinite(Date.parse(observation.observedAt))) {
      throw new Error("Backlog observation timestamp is invalid.");
    }
    this.lastAttemptAt = new Date(this.now());
    this.lastAttemptSucceeded = observation !== null;
    this.lastObservedWorkspace = observation?.staffChatId ?? null;
    if (observation) this.observation = structuredClone(observation);
  }

  recordFailure(): void {
    this.lastAttemptAt = new Date(this.now());
    this.lastAttemptSucceeded = false;
    this.failures += 1;
  }

  invalidate(): void {
    this.lastAttemptSucceeded = false;
  }

  snapshot(): OperationalBacklogHealthSnapshot {
    let workspace: number | null = this.lastObservedWorkspace;
    let workspaceKnown = true;
    try {
      if (this.getWorkspace) workspace = this.getWorkspace();
    } catch {
      workspaceKnown = false;
    }
    const available = workspaceKnown && workspace !== null && this.observation?.staffChatId === workspace;
    const observation = available ? structuredClone(this.observation) : null;
    const lastSuccessAt = observation ? new Date(observation.observedAt) : null;
    const age = lastSuccessAt ? Math.max(0, this.now().getTime() - lastSuccessAt.getTime()) : NaN;
    return {
      workspaceConfigured: workspaceKnown ? workspace !== null : null,
      sampleAvailable: available,
      observationSuccess: available && this.lastAttemptSucceeded,
      fresh: available && this.lastAttemptSucceeded && age <= BACKLOG_OBSERVATION_FRESHNESS_MS,
      observationFailuresTotal: this.failures,
      lastAttemptAt: this.lastAttemptAt ? new Date(this.lastAttemptAt) : null,
      lastSuccessAt,
      observationAgeSeconds: Number.isFinite(age) ? Math.floor(age / 1000) : NaN,
      observation,
    };
  }
}

export function operationalBacklogMetrics(snapshot: OperationalBacklogHealthSnapshot): string[] {
  const observed = snapshot.observation;
  const values: Array<[string, string, number, ("gauge" | "counter")?]> = [
    [
      "backlog_workspace_configured",
      "Whether a staff workspace is configured; NaN when its scope cannot be checked.",
      snapshot.workspaceConfigured === null ? NaN : Number(snapshot.workspaceConfigured),
    ],
    [
      "backlog_sample_available",
      "Whether a cached backlog sample belongs to the current staff workspace.",
      Number(snapshot.sampleAvailable),
    ],
    [
      "backlog_sample_success",
      "Whether the latest health evaluation obtained a successful backlog sample for the current workspace.",
      Number(snapshot.observationSuccess),
    ],
    [
      "backlog_observation_failures_total",
      "Failed durable backlog observation attempts; skipped observations after failed SQLite probes are excluded.",
      snapshot.observationFailuresTotal,
      "counter",
    ],
    [
      "backlog_last_attempt_unixtime",
      "Unix time of the latest backlog observation attempt.",
      snapshot.lastAttemptAt ? Math.floor(snapshot.lastAttemptAt.getTime() / 1000) : 0,
    ],
    [
      "backlog_last_success_unixtime",
      "Unix time of the last successful backlog sample for the current workspace.",
      snapshot.lastSuccessAt ? Math.floor(snapshot.lastSuccessAt.getTime() / 1000) : 0,
    ],
    [
      "backlog_observation_age_seconds",
      "Seconds since the cached backlog observation; NaN without a current-workspace sample.",
      snapshot.observationAgeSeconds,
    ],
    [
      "delivery_review_cases",
      "Open Delivery Review cases, including inbound READY, FAILED and RETRY_REQUIRED.",
      observed?.deliveryReview.count ?? NaN,
    ],
    [
      "delivery_review_oldest_update_age_seconds",
      "Age since the oldest last state update among open Delivery Review cases, measured at observation.",
      observed?.deliveryReview.oldestAgeSeconds ?? NaN,
    ],
    [
      "unknown_delivery_count",
      "Actual UNKNOWN_DELIVERY operations in review, Batch outbound intents and final summaries, deduplicated; exports separate.",
      observed?.unknownDeliveryCount ?? NaN,
    ],
    [
      "batch_recovery_due_count",
      "Runnable Batch staff recovery items and final summaries; each answer item counted once.",
      observed?.batchRecovery.count ?? NaN,
    ],
    [
      "batch_recovery_oldest_overdue_seconds",
      "Overdue seconds since the oldest explicit due retry timestamp; null dates and local echo normalization contribute no overdue age.",
      observed?.batchRecovery.oldestOverdueSeconds ?? NaN,
    ],
    [
      "moderation_cleanup_due_count",
      "Due PENDING, CLEANING and LOG_PENDING moderation cleanup jobs.",
      observed?.moderationCleanup.count ?? NaN,
    ],
    [
      "moderation_cleanup_oldest_overdue_seconds",
      "Overdue seconds since the oldest due moderation cleanup_due_at.",
      observed?.moderationCleanup.oldestOverdueSeconds ?? NaN,
    ],
    [
      "archive_recovery_eligible_count",
      "Closed unarchived tickets with history and no unresolved delivery or live archive claim blocking recovery.",
      observed?.archiveRecovery.count ?? NaN,
    ],
    [
      "archive_recovery_oldest_closed_age_seconds",
      "Age since closed_at of the oldest eligible archive ticket, not time since it became eligible.",
      observed?.archiveRecovery.oldestAgeSeconds ?? NaN,
    ],
    [
      "batch_export_unknown_delivery_count",
      "Batch exports in UNKNOWN_DELIVERY; independent of the Delivery Review queue.",
      observed?.batchExportUnknownDeliveryCount ?? NaN,
    ],
  ];
  return values.flatMap(([suffix, help, value, type]) => {
    const name = `telegram_support_${suffix}`;
    return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type ?? "gauge"}`, `${name} ${value}`];
  });
}
