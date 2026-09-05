import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Update } from "grammy/types";
import { PendingWarningScheduler, sendStaffOnboardingIfNeeded, setBotCommands } from "../src/bot.js";
import { hostConfig, config } from "../src/config.js";
import { getSupportLogsTopicInfo } from "../src/archive.js";
import { InstallationService } from "../src/installation.js";
import { createModerationCleanupScheduler } from "../src/languageModeration.js";
import { createBotHarness, type BotHarness } from "./helpers/botHarness.js";

function configureWorkspace(service: InstallationService, chatId: number): void {
  service.activateWorkspace({ chatId, title: `Workspace ${chatId}` });
  service.markReady();
}

function staffCommand(chatId: number, userId: number, updateId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      from: { id: userId, is_bot: false, first_name: `Staff ${userId}` },
      chat: { id: chatId, type: "supergroup", title: `Workspace ${chatId}` },
      text: "/chatid",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    },
  };
}

function createWorkspaceHarness(chatId: number): { harness: BotHarness; installation: InstallationService } {
  let installation!: InstallationService;
  const harness = createBotHarness({
    installationServiceFactory: (db) => {
      installation = new InstallationService(db);
      configureWorkspace(installation, chatId);
      return installation;
    },
  });
  return { harness, installation };
}

describe("instance-owned runtime state", () => {
  it("routes and authorizes each bot against only its own dynamically selected workspace", async () => {
    const first = createWorkspaceHarness(-1001);
    const second = createWorkspaceHarness(-1002);
    try {
      await first.harness.bot.handleUpdate(staffCommand(-1001, 11, 1));
      await second.harness.bot.handleUpdate(staffCommand(-1001, 11, 2));
      assert.equal(first.harness.countApiCalls("sendMessage"), 1);
      assert.equal(second.harness.countApiCalls("sendMessage"), 0);

      first.harness.clearApiCalls();
      second.harness.clearApiCalls();
      first.installation.activateWorkspace({ chatId: -1003, title: "Replacement workspace" });

      await first.harness.bot.handleUpdate(staffCommand(-1001, 11, 3));
      await first.harness.bot.handleUpdate(staffCommand(-1003, 11, 4));
      await second.harness.bot.handleUpdate(staffCommand(-1002, 11, 5));
      assert.deepEqual(
        first.harness.findApiCalls("sendMessage").map((call) => call.payload.chat_id),
        [-1003]
      );
      assert.deepEqual(
        second.harness.findApiCalls("sendMessage").map((call) => call.payload.chat_id),
        [-1002]
      );
    } finally {
      first.harness.cleanup();
      second.harness.cleanup();
    }
  });

  it("uses explicitly owned workspaces for commands, onboarding, and Support Logs", async () => {
    const first = createWorkspaceHarness(-1101);
    const second = createWorkspaceHarness(-1102);
    try {
      await setBotCommands(first.harness.bot, first.installation);
      await setBotCommands(second.harness.bot, second.installation);
      await sendStaffOnboardingIfNeeded(first.harness.bot.api, first.harness.db, first.installation);
      await sendStaffOnboardingIfNeeded(second.harness.bot.api, second.harness.db, second.installation);
      await getSupportLogsTopicInfo(first.harness.bot.api, first.harness.db, first.installation.requireStaffChatId());
      await getSupportLogsTopicInfo(
        second.harness.bot.api,
        second.harness.db,
        second.installation.requireStaffChatId()
      );

      for (const [current, chatId] of [
        [first, -1101],
        [second, -1102],
      ] as const) {
        assert.equal(
          current.harness
            .findApiCalls("setMyCommands")
            .some((call) => (call.payload.scope as { chat_id?: number } | undefined)?.chat_id === chatId),
          true
        );
        assert.equal(
          current.harness.findApiCalls("sendMessage").some((call) => call.payload.chat_id === chatId),
          true
        );
        assert.equal(
          current.harness.findApiCalls("createForumTopic").every((call) => call.payload.chat_id === chatId),
          true
        );
      }
    } finally {
      first.harness.cleanup();
      second.harness.cleanup();
    }
  });

  it("stops only the pending-warning timers owned by that bot", () => {
    const clearedByFirst: unknown[] = [];
    const clearedBySecond: unknown[] = [];
    const timers: unknown[] = [];
    const createTimer = (() => {
      const timer = { unref: () => undefined };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) satisfies (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    const firstScheduler = new PendingWarningScheduler(undefined, createTimer, (timer) => clearedByFirst.push(timer));
    const secondScheduler = new PendingWarningScheduler(undefined, createTimer, (timer) => clearedBySecond.push(timer));
    const first = createBotHarness({ pendingWarningScheduler: firstScheduler });
    const second = createBotHarness({ pendingWarningScheduler: secondScheduler });
    try {
      firstScheduler.schedule(first.bot.api, first.db, -1200, 7, 3_000);
      secondScheduler.schedule(second.bot.api, second.db, -1200, 7, 3_000);
      assert.equal(timers.length, 2);

      first.bot.stopBackgroundWork();
      assert.deepEqual(clearedByFirst, [timers[0]]);
      assert.deepEqual(clearedBySecond, []);

      second.bot.stopBackgroundWork();
      assert.deepEqual(clearedBySecond, [timers[1]]);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  it("deduplicates cleanup jobs within one scheduler but not across scheduler instances", async () => {
    const firstTimers: Array<() => void> = [];
    const secondTimers: Array<() => void> = [];
    const makeTimerFactory = (callbacks: Array<() => void>) => (callback: () => void) => {
      callbacks.push(callback);
      return { unref: () => undefined };
    };
    const firstScheduler = createModerationCleanupScheduler(() => -1301, {
      createTimer: makeTimerFactory(firstTimers),
    });
    const secondScheduler = createModerationCleanupScheduler(() => -1302, {
      createTimer: makeTimerFactory(secondTimers),
    });
    const first = createWorkspaceHarness(-1301);
    const second = createWorkspaceHarness(-1302);
    try {
      firstScheduler(first.harness.bot.api, first.harness.db, 1);
      firstScheduler(first.harness.bot.api, first.harness.db, 1);
      secondScheduler(second.harness.bot.api, second.harness.db, 1);
      assert.equal(firstTimers.length, 1);
      assert.equal(secondTimers.length, 1);

      firstTimers[0]!();
      await new Promise((resolve) => setImmediate(resolve));
      firstScheduler(first.harness.bot.api, first.harness.db, 1);
      secondScheduler(second.harness.bot.api, second.harness.db, 1);
      assert.equal(firstTimers.length, 2);
      assert.equal(secondTimers.length, 1);
    } finally {
      first.harness.cleanup();
      second.harness.cleanup();
    }
  });

  it("keeps STAFF_CHAT_ID as immutable bootstrap input rather than mutable runtime config", () => {
    assert.equal(typeof hostConfig.staffChatId === "number" || hostConfig.staffChatId === null, true);
    assert.equal("staffChatId" in config, false);
  });
});
