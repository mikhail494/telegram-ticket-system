import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedDeliveryError } from "../src/deliveryDiagnostics.js";
import type { SupportDatabase } from "../src/db.js";
import type { InstallationService } from "../src/installation.js";
import {
  TicketBatchExportInProgressError,
  TicketBatchRuntime,
  TicketBatchStaffOperationError,
  type TicketBatchRuntimeDependencies,
} from "../src/ticketBatchRuntime.js";

const temporaryDiagnostic: NormalizedDeliveryError = {
  category: "RATE_LIMITED",
  permanence: "TEMPORARY",
  method: "sendMessage",
  telegramErrorCode: 429,
  httpStatus: 429,
  retryAfterSeconds: 1,
  description: "Too Many Requests",
  occurredAt: "2026-01-01T00:00:00.000Z",
};

function createRuntime(
  timers: Array<{ callback: () => void; delayMs: number; unref(): void }>,
  cleared: unknown[]
): TicketBatchRuntime {
  return new TicketBatchRuntime({
    createRecoveryTimer: (callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs, unref: () => undefined };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearRecoveryTimer: (timer: ReturnType<typeof setTimeout>) => cleared.push(timer),
  } as unknown as TicketBatchRuntimeDependencies);
}

describe("ticket batch runtime ownership", () => {
  it("keeps recovery timers isolated between coordinator instances", () => {
    const firstTimers: Array<{ callback: () => void; delayMs: number; unref(): void }> = [];
    const secondTimers: Array<{ callback: () => void; delayMs: number; unref(): void }> = [];
    const firstCleared: unknown[] = [];
    const secondCleared: unknown[] = [];
    const first = createRuntime(firstTimers, firstCleared);
    const second = createRuntime(secondTimers, secondCleared);
    const failure = new TicketBatchStaffOperationError(temporaryDiagnostic, "2026-01-01T00:01:00.000Z");

    first.scheduleRecoveryForStaffOperation(failure);
    second.scheduleRecoveryForStaffOperation(failure);
    assert.equal(firstTimers.length, 1);
    assert.equal(secondTimers.length, 1);

    first.stop();
    assert.deepEqual(firstCleared, [firstTimers[0]]);
    assert.deepEqual(secondCleared, []);

    second.stop();
    assert.deepEqual(secondCleared, [secondTimers[0]]);
  });

  it("keeps export serialization local to one coordinator instance", async () => {
    const first = createRuntime([], []);
    const second = createRuntime([], []);
    let releaseFirst!: () => void;
    const firstExport = first.runExport(
      -1001,
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve("first");
        })
    );

    await assert.rejects(
      first.runExport(-1001, async () => "duplicate"),
      TicketBatchExportInProgressError
    );
    assert.equal(await second.runExport(-1001, async () => "second"), "second");
    releaseFirst();
    assert.equal(await firstExport, "first");
  });

  it("resolves the active staff workspace dynamically for each coordinator instance", async () => {
    const firstCalls: number[] = [];
    const secondCalls: number[] = [];
    let firstWorkspace = -1001;
    const secondWorkspace = -1002;
    const recoveryDependencies = (workspace: () => number, calls: number[]): TicketBatchRuntimeDependencies => {
      const database = {
        listInvalidTicketBatchSuccessEchoes: (chatId: number) => {
          calls.push(chatId);
          return [];
        },
        listClosedTicketBatchReplyAndClosePendingEchoes: (chatId: number) => {
          calls.push(chatId);
          return [];
        },
        listPendingTicketBatchFailureEvents: (chatId: number) => {
          calls.push(chatId);
          return [];
        },
        listPendingTicketBatchTopicEchoes: (chatId: number) => {
          calls.push(chatId);
          return [];
        },
        listPendingTicketBatchReplyAndCloseContinuations: (chatId: number) => {
          calls.push(chatId);
          return [];
        },
        listPendingTicketBatchSilentCloseContinuations: (chatId: number) => {
          calls.push(chatId);
          return [];
        },
        listPendingTicketBatchFinalSummaries: (chatId: number) => {
          calls.push(chatId);
          return [];
        },
        getNextTicketBatchStaffRetryAt: (chatId: number) => {
          calls.push(chatId);
          return null;
        },
      } as unknown as SupportDatabase;
      return {
        db: database,
        installation: { requireStaffChatId: workspace } as unknown as InstallationService,
      } as TicketBatchRuntimeDependencies;
    };
    const first = new TicketBatchRuntime(recoveryDependencies(() => firstWorkspace, firstCalls));
    const second = new TicketBatchRuntime(recoveryDependencies(() => secondWorkspace, secondCalls));

    await first.recoverPendingStaffOperations();
    await second.recoverPendingStaffOperations();
    firstWorkspace = -1003;
    await first.recoverPendingStaffOperations();

    assert.equal(firstCalls.includes(-1002), false);
    assert.equal(secondCalls.includes(-1001), false);
    assert.equal(firstCalls.includes(-1003), true);
    assert.deepEqual(new Set(secondCalls), new Set([-1002]));
  });

  it("abandons a recovery pass when its workspace changes during staff delivery", async () => {
    const calls: number[] = [];
    const topicEchoes: Array<{ chatId: number; state: string }> = [];
    const timers: Array<{ callback: () => void; delayMs: number; unref(): void }> = [];
    const backgroundRuns: Promise<void>[] = [];
    let staffWorkspace = -1001;
    let enteredSend!: () => void;
    const sent = new Promise<void>((resolve) => {
      enteredSend = resolve;
    });
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const item = {
      answer_package_id: "package-a",
      ticket_id: 1,
      action: "reply_keep_open",
      state: "STAFF_SYNC_PENDING",
      reply_text: "Reply",
      follow_up_state: "NONE",
      escalation_target: "NONE",
      internal_note: null,
      topic_echo_state: "PENDING",
      delivery_message_id: 10,
      delivery_error_category: null,
      delivery_error_permanence: null,
      delivery_failure_event_state: "NOT_REQUIRED",
    };
    const database = {
      listInvalidTicketBatchSuccessEchoes: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listClosedTicketBatchReplyAndClosePendingEchoes: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listPendingTicketBatchFailureEvents: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listPendingTicketBatchTopicEchoes: (chatId: number) => {
        calls.push(chatId);
        return chatId === -1001 ? [item] : [];
      },
      getTicketWithUser: () => ({
        id: 1,
        status: "IN_PROGRESS",
        staff_chat_id: -1001,
        message_thread_id: 99,
      }),
      listTicketBatchAnswerItems: () => [item],
      recordTicketBatchTopicEcho: (_packageId: string, _ticketId: number, state: string) => {
        topicEchoes.push({ chatId: staffWorkspace, state });
      },
      listPendingTicketBatchReplyAndCloseContinuations: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listPendingTicketBatchSilentCloseContinuations: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listPendingTicketBatchFinalSummaries: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      getNextTicketBatchStaffRetryAt: (chatId: number) => {
        calls.push(chatId);
        return null;
      },
    } as unknown as SupportDatabase;
    const runtime = new TicketBatchRuntime({
      db: database,
      installation: { requireStaffChatId: () => staffWorkspace } as unknown as InstallationService,
      api: {
        sendMessage: async () => {
          enteredSend();
          await sendGate;
          return { message_id: 11 };
        },
      },
      backgroundTasks: {
        run: (task: () => Promise<void>) => {
          backgroundRuns.push(task());
          return true;
        },
      },
      runStaffChatOperation: async (operation: () => Promise<{ message_id: number }>) => operation(),
      createRecoveryTimer: (callback: () => void, delayMs: number) => {
        const timer = { callback, delayMs, unref: () => undefined };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    } as unknown as TicketBatchRuntimeDependencies);

    const recovery = runtime.recoverPendingStaffOperations();
    await sent;
    staffWorkspace = -1002;
    releaseSend();
    await recovery;

    assert.deepEqual(topicEchoes, []);
    assert.equal(timers.length, 1);
    const recoveryTimer = timers[0];
    assert.ok(recoveryTimer);
    recoveryTimer.callback();
    await backgroundRuns[0];
    assert.equal(calls.includes(-1002), true);
  });

  it("abandons a recovery pass when staff delivery rejects after a workspace switch", async () => {
    const calls: number[] = [];
    const topicEchoStates: string[] = [];
    const timers: Array<{ callback: () => void; delayMs: number; unref(): void }> = [];
    const backgroundRuns: Promise<void>[] = [];
    let staffWorkspace = -1001;
    let enteredSend!: () => void;
    const sent = new Promise<void>((resolve) => {
      enteredSend = resolve;
    });
    let rejectSend!: () => void;
    const sendGate = new Promise<void>((_resolve, reject) => {
      rejectSend = () => reject(new Error("staff delivery failed"));
    });
    const item = {
      answer_package_id: "package-a",
      ticket_id: 1,
      action: "reply_keep_open",
      state: "STAFF_SYNC_PENDING",
      reply_text: "Reply",
      follow_up_state: "NONE",
      escalation_target: "NONE",
      internal_note: null,
      topic_echo_state: "PENDING",
      delivery_message_id: 10,
      delivery_error_category: null,
      delivery_error_permanence: null,
      delivery_failure_event_state: "NOT_REQUIRED",
    };
    const database = {
      listInvalidTicketBatchSuccessEchoes: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listClosedTicketBatchReplyAndClosePendingEchoes: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listPendingTicketBatchFailureEvents: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listPendingTicketBatchTopicEchoes: (chatId: number) => {
        calls.push(chatId);
        return chatId === -1001 ? [item] : [];
      },
      getTicketWithUser: () => ({ id: 1, status: "IN_PROGRESS", staff_chat_id: -1001, message_thread_id: 99 }),
      listTicketBatchAnswerItems: () => [item],
      recordTicketBatchTopicEcho: (_packageId: string, _ticketId: number, state: string) => topicEchoStates.push(state),
      listPendingTicketBatchReplyAndCloseContinuations: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listPendingTicketBatchSilentCloseContinuations: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listPendingTicketBatchFinalSummaries: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      getNextTicketBatchStaffRetryAt: (chatId: number) => {
        calls.push(chatId);
        return null;
      },
    } as unknown as SupportDatabase;
    const runtime = new TicketBatchRuntime({
      db: database,
      installation: { requireStaffChatId: () => staffWorkspace } as unknown as InstallationService,
      api: {
        sendMessage: async () => {
          enteredSend();
          await sendGate;
          return { message_id: 11 };
        },
      },
      backgroundTasks: {
        run: (task: () => Promise<void>) => {
          backgroundRuns.push(task());
          return true;
        },
      },
      runStaffChatOperation: async (operation: () => Promise<{ message_id: number }>) => operation(),
      createRecoveryTimer: (callback: () => void, delayMs: number) => {
        const timer = { callback, delayMs, unref: () => undefined };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    } as unknown as TicketBatchRuntimeDependencies);

    const recovery = runtime.recoverPendingStaffOperations();
    await sent;
    staffWorkspace = -1002;
    rejectSend();
    await recovery;

    assert.deepEqual(topicEchoStates, []);
    assert.equal(timers.length, 1);
    const recoveryTimer = timers[0];
    assert.ok(recoveryTimer);
    recoveryTimer.callback();
    await backgroundRuns[0];
    assert.equal(calls.includes(-1002), true);
  });

  it("abandons a silent-close continuation when close or archive rejects after a workspace switch", async () => {
    const calls: number[] = [];
    const itemUpdates: string[] = [];
    const retries: string[] = [];
    const timers: Array<{ callback: () => void; delayMs: number; unref(): void }> = [];
    const backgroundRuns: Promise<void>[] = [];
    let staffWorkspace = -1001;
    let enteredClose!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      enteredClose = resolve;
    });
    let rejectClose!: () => void;
    const closeGate = new Promise<void>((_resolve, reject) => {
      rejectClose = () => reject(new Error("archive failed"));
    });
    const item = {
      answer_package_id: "package-a",
      ticket_id: 1,
      action: "silent_close",
      state: "APPLYING",
      snapshot_token: "snapshot",
    };
    const database = {
      listInvalidTicketBatchSuccessEchoes: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listClosedTicketBatchReplyAndClosePendingEchoes: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listPendingTicketBatchFailureEvents: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listPendingTicketBatchTopicEchoes: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listPendingTicketBatchReplyAndCloseContinuations: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      listPendingTicketBatchSilentCloseContinuations: (chatId: number) => {
        calls.push(chatId);
        return chatId === -1001 ? [item] : [];
      },
      listTicketBatchAnswerItems: () => [item],
      getTicketWithUser: () => ({ id: 1, status: "CLOSED", staff_chat_id: -1001, archived_at: null }),
      recordTicketBatchTopicEcho: () => undefined,
      recordTicketBatchFailureEvent: () => undefined,
      updateTicketBatchAnswerItem: (_packageId: string, _ticketId: number, state: string) => itemUpdates.push(state),
      setTicketBatchPostDeliveryRetry: (_packageId: string, _ticketId: number, retryAt: string) =>
        retries.push(retryAt),
      listPendingTicketBatchFinalSummaries: (chatId: number) => {
        calls.push(chatId);
        return [];
      },
      getNextTicketBatchStaffRetryAt: (chatId: number) => {
        calls.push(chatId);
        return null;
      },
    } as unknown as SupportDatabase;
    const runtime = new TicketBatchRuntime({
      db: database,
      installation: { requireStaffChatId: () => staffWorkspace } as unknown as InstallationService,
      backgroundTasks: {
        run: (task: () => Promise<void>) => {
          backgroundRuns.push(task());
          return true;
        },
      },
      closeTicket: async () => {
        enteredClose();
        await closeGate;
      },
      staffActor: () => ({ type: "SYSTEM", displayName: "System", username: null, telegramId: null }),
      createRecoveryTimer: (callback: () => void, delayMs: number) => {
        const timer = { callback, delayMs, unref: () => undefined };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    } as unknown as TicketBatchRuntimeDependencies);

    const recovery = runtime.recoverPendingStaffOperations();
    await closeStarted;
    staffWorkspace = -1002;
    rejectClose();
    await recovery;

    assert.deepEqual(itemUpdates, []);
    assert.deepEqual(retries, []);
    assert.equal(timers.length, 1);
    const recoveryTimer = timers[0];
    assert.ok(recoveryTimer);
    recoveryTimer.callback();
    await backgroundRuns[0];
    assert.equal(calls.includes(-1002), true);
  });
});
