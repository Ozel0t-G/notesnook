/*
This file is part of the Notesnook project (https://notesnook.com/)
Copyright (C) 2026 Streetwriters (Private) Limited
This program is free software under the GNU General Public License v3 or later.
*/

/**
 * Production orchestrator tests for Urgent Task delivery.
 *
 * These exercise the real `TaskNotifications.reconcile()` pass end to end: the
 * real alarm plan, the real notification plan and the real per-occurrence
 * delivery gate. Only the device edges are faked -- notifee's trigger store,
 * the native AlarmKit module and the encrypted `db` -- because those are what
 * the pass talks to. Every assertion is about the *observable device state*
 * after a pass (which notifications are pending, which alarms are installed),
 * never about which internal helper was called.
 *
 * Jest needs `@notifee/react-native` to resolve here exactly as metro/rspack
 * alias it, so this suite is run with
 * `--moduleNameMapper '{"^@notifee/react-native$":"<rootDir>/node_modules/@ammarahmed/notifee-react-native"}'`.
 */

type FakeTrigger = {
  id: string;
  timestamp: number;
  title?: string;
  body?: string;
  data: Record<string, string>;
};

type FakeAlarmDevice = {
  /** alarmKey -> "scheduled" | "active" (alerting, snoozed or paused). */
  alarms: Map<string, "scheduled" | "active">;
  calls: string[];
  status: string;
  verifyCalls: number;
  /** Which verify call (1-based) fails, so a failing *retry* is expressible. */
  failVerifyOnCall: number;
  /** Occurrences the device refuses to schedule (a per-occurrence failure). */
  dropAlarms: Set<string>;
  /** Held presentations the device could not redact under App Lock. */
  unredacted: Set<string>;
  failCancel: false | Error;
  triggers: Map<string, FakeTrigger>;
  displayed: FakeTrigger[];
};

jest.mock("@notifee/react-native", () => {
  const triggers = new Map<string, FakeTrigger>();
  const displayed: FakeTrigger[] = [];
  const readTriggers = async () =>
    [...triggers.values()].map((trigger) => ({
      notification: {
        id: trigger.id,
        title: trigger.title,
        body: trigger.body,
        data: trigger.data
      },
      trigger: { type: 0, timestamp: trigger.timestamp }
    }));
  const createTrigger = async (
    notification: {
      id: string;
      title?: string;
      body?: string;
      data?: Record<string, string>;
    },
    trigger: { timestamp: number }
  ) => {
    triggers.set(notification.id, {
      id: notification.id,
      timestamp: trigger.timestamp,
      title: notification.title,
      body: notification.body,
      data: notification.data || {}
    });
  };
  const cancelTrigger = async (id: string) => {
    triggers.delete(id);
  };
  const readDisplayed = async () =>
    displayed.map((trigger) => ({
      notification: {
        id: trigger.id,
        title: trigger.title,
        data: trigger.data
      }
    }));
  const cancelDisplayed = async (id: string) => {
    const index = displayed.findIndex((entry) => entry.id === id);
    if (index !== -1) displayed.splice(index, 1);
  };
  const readSettings = async () => ({ authorizationStatus: 2 });
  const notifee = {
    getTriggerNotifications: jest.fn(readTriggers),
    createTriggerNotification: jest.fn(createTrigger),
    cancelTriggerNotification: jest.fn(cancelTrigger),
    getDisplayedNotifications: jest.fn(readDisplayed),
    cancelDisplayedNotification: jest.fn(cancelDisplayed),
    getNotificationSettings: jest.fn(readSettings),
    requestPermission: jest.fn(async () => ({ authorizationStatus: 2 })),
    createChannel: jest.fn(async (channel: { id: string }) => channel.id),
    onForegroundEvent: jest.fn(),
    decrementBadgeCount: jest.fn()
  };
  return {
    __esModule: true,
    default: notifee,
    AuthorizationStatus: {
      NOT_DETERMINED: 0,
      DENIED: 1,
      AUTHORIZED: 2,
      PROVISIONAL: 3
    },
    TriggerType: { TIMESTAMP: 0 },
    EventType: { PRESS: 1, DISMISSED: 2, DELIVERED: 3 },
    __store: { triggers, displayed },
    __base: {
      readTriggers,
      createTrigger,
      cancelTrigger,
      readDisplayed,
      cancelDisplayed,
      readSettings
    }
  };
});

jest.mock("react-native", () => {
  const device = {
    alarms: new Map<string, "scheduled" | "active">(),
    calls: [] as string[],
    status: "authorized" as string,
    verifyCalls: 0,
    failVerifyOnCall: 0,
    dropAlarms: new Set<string>(),
    /** Keys whose held presentation still shows the real title under App Lock. */
    unredacted: new Set<string>(),
    failCancel: false as false | Error
  };
  const deviceReplace = async (
    _accountId: string,
    alarms: { alarmKey: string }[]
  ) => {
    device.calls.push("replace");
    const wanted = new Set(alarms.map((alarm) => alarm.alarmKey));
    for (const key of [...device.alarms.keys()])
      if (!wanted.has(key)) device.alarms.delete(key);
    for (const alarm of alarms)
      if (
        !device.alarms.has(alarm.alarmKey) &&
        !device.dropAlarms.has(alarm.alarmKey)
      )
        device.alarms.set(alarm.alarmKey, "scheduled");
    return {
      status: "authorized",
      scheduledAlarmKeys: [...device.alarms.keys()],
      activeAlarmKeys: [...device.alarms.entries()]
        .filter(([, state]) => state === "active")
        .map(([key]) => key),
      unredactedAlarmKeys: [...device.alarms.keys()].filter((key) =>
        device.unredacted.has(key)
      )
    };
  };
  const deviceVerify = async (_accountId: string, keys: string[]) => {
    device.verifyCalls += 1;
    device.calls.push("verify");
    if (device.failVerifyOnCall === device.verifyCalls)
      throw new Error("native verify failed");
    const held = keys.filter((key) => device.alarms.has(key));
    return {
      status: device.status,
      scheduledAlarmKeys: held,
      activeAlarmKeys: held.filter(
        (key) => device.alarms.get(key) === "active"
      )
    };
  };
  const deviceCancelScheduled = async (_accountId: string, keys: string[]) => {
    device.calls.push("cancelScheduled");
    if (device.failCancel) throw new Error("cancellation unavailable");
    const cancelled: string[] = [];
    const retained: string[] = [];
    for (const key of keys) {
      if (!device.alarms.has(key)) continue;
      if (device.alarms.get(key) === "scheduled") {
        device.alarms.delete(key);
        cancelled.push(key);
      } else retained.push(key);
    }
    return {
      status: device.status,
      cancelledAlarmKeys: cancelled,
      retainedAlarmKeys: retained
    };
  };
  const replaceAlarms = jest.fn(deviceReplace);
  const verifyAlarms = jest.fn(deviceVerify);
  const cancelScheduledAlarms = jest.fn(deviceCancelScheduled);
  return {
    Platform: { OS: "ios" },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
    NativeModules: {
      TaskAlarmModule: {
        status: async () => device.status,
        requestAuthorization: async () => "authorized",
        replaceAlarms: (accountId: string, alarms: { alarmKey: string }[]) =>
          replaceAlarms(accountId, alarms),
        verifyAlarms: (accountId: string, keys: string[]) =>
          verifyAlarms(accountId, keys),
        cancelScheduledAlarms: (accountId: string, keys: string[]) =>
          cancelScheduledAlarms(accountId, keys),
        cancelAll: async () => {
          device.calls.push("cancelAll");
          device.alarms.clear();
        },
        syncOverdueActivities: async () => ({
          status: "authorized",
          created: 0,
          updated: 0,
          ended: 0,
          failedTaskIds: []
        }),
        endOverdueActivities: async () => ({ status: "authorized", ended: 0 })
      }
    },
    __device: device,
    __replaceAlarms: replaceAlarms,
    __verifyAlarms: verifyAlarms,
    __cancelScheduledAlarms: cancelScheduledAlarms,
    __base: { deviceReplace, deviceVerify, deviceCancelScheduled }
  };
});

jest.mock("@notesnook/intl", () => ({
  strings: {
    tasksTitle: () => "VeyraN Task",
    tasksUrgentFallbackBody: () => "Open VeyraN to view this Task.",
    tasksUrgentDueRedacted: (time: string) => `Urgent Task due (${time})`
  }
}));

jest.mock("../common/database/mmkv", () => ({
  MMKV: { getString: jest.fn(), setString: jest.fn() }
}));

jest.mock("./settings", () => ({
  __esModule: true,
  default: { get: jest.fn(() => ({ appLockEnabled: false })) }
}));

jest.mock("./event-manager", () => ({
  ToastManager: { show: jest.fn() }
}));

jest.mock("../stores/use-setting-store", () => ({
  useSettingStore: {
    getState: jest.fn(() => ({
      settings: { appLockEnabled: false },
      isAppLoading: false
    })),
    subscribe: jest.fn(() => () => {})
  }
}));

jest.mock("../stores/use-user-store", () => ({
  useUserStore: {
    getState: jest.fn(() => ({
      user: { id: "account-a" },
      appLocked: false,
      isLoggingOut: false
    })),
    subscribe: jest.fn(() => () => {})
  }
}));

jest.mock("../common/database", () => ({
  db: {
    isInitialized: true,
    tasks: { list: jest.fn(async () => []) },
    eventManager: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) }
  },
  DatabaseLogger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    log: jest.fn()
  }
}));

jest.mock("./task-alarms", () => ({
  ...jest.requireActual("./task-alarms"),
  // The overdue Live Activity bridge is covered by task-alarms.test.ts; here it
  // must not add alarm noise to the delivery assertions.
  syncOverdueActivities: async () => ({
    status: "authorized",
    created: 0,
    updated: 0,
    ended: 0,
    failedTaskIds: []
  })
}));

import { EVENTS, type Task } from "@notesnook/core";
import { db, DatabaseLogger } from "../common/database";
import { MMKV } from "../common/database/mmkv";
import { useSettingStore } from "../stores/use-setting-store";
import { useUserStore } from "../stores/use-user-store";
import SettingsService from "./settings";
import { ToastManager } from "./event-manager";
import { taskAlarmKey, taskReminderOccurrences } from "./task-alarm-plan";
import {
  TASK_ALARM_UNREDACTED_MESSAGE,
  TaskNotifications,
  isStaleTaskNotification
} from "./task-notifications";

const database = db as unknown as {
  isInitialized: boolean;
  tasks: { list: jest.Mock };
  eventManager: { subscribe: jest.Mock };
};
const DatabaseLog = DatabaseLogger as unknown as {
  error: jest.Mock;
  warn: jest.Mock;
};
const storage = MMKV as unknown as {
  getString: jest.Mock;
  setString: jest.Mock;
};
const settingStore = useSettingStore.getState as unknown as jest.Mock;
const userStore = useUserStore.getState as unknown as jest.Mock;
const settingsService = SettingsService.get as unknown as jest.Mock;
const toast = ToastManager.show as unknown as jest.Mock;

const notifee = jest.requireMock("@notifee/react-native").default as {
  getTriggerNotifications: jest.Mock;
  createTriggerNotification: jest.Mock;
  cancelTriggerNotification: jest.Mock;
  getDisplayedNotifications: jest.Mock;
  cancelDisplayedNotification: jest.Mock;
  getNotificationSettings: jest.Mock;
};
const notifeeStore = jest.requireMock("@notifee/react-native").__store as {
  triggers: Map<string, FakeTrigger>;
  displayed: FakeTrigger[];
};
const nativeMock = jest.requireMock("react-native") as {
  __device: FakeAlarmDevice;
  __replaceAlarms: jest.Mock;
  __verifyAlarms: jest.Mock;
  __cancelScheduledAlarms: jest.Mock;
  __base: {
    deviceReplace: (...args: never[]) => unknown;
    deviceVerify: (...args: never[]) => unknown;
    deviceCancelScheduled: (...args: never[]) => unknown;
  };
};
const device = nativeMock.__device;
const notifeeBase = jest.requireMock("@notifee/react-native").__base as {
  readTriggers: (...args: never[]) => unknown;
  createTrigger: (...args: never[]) => unknown;
  cancelTrigger: (...args: never[]) => unknown;
  readDisplayed: (...args: never[]) => unknown;
  cancelDisplayed: (...args: never[]) => unknown;
  readSettings: (...args: never[]) => unknown;
};

const NOW = 1_800_000_000_000;
const CLEANUP_KEY = "notesnook.taskSurfaces.pendingCleanup.v1";

const pendingCleanup = new Map<string, string>();

function localDate(offsetDays: number) {
  const date = new Date(NOW + offsetDays * 24 * 60 * 60 * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getDate()).padStart(2, "0")}`;
}

/** An Urgent one-off Task whose reminder is `offsetDays` away. */
function urgentTask(id: string, offsetDays = 1): Task {
  return {
    id,
    title: `title-${id}`,
    listId: "list-1",
    completed: false,
    urgent: true,
    scheduleVersion: 2,
    reminderDate: localDate(offsetDays),
    reminderTime: "14:00",
    updatedAt: 42
  } as Task;
}

function recurringTask(id: string): Task {
  return {
    id,
    title: `title-${id}`,
    listId: "list-1",
    completed: false,
    urgent: true,
    scheduleVersion: 2,
    recurrenceRule: "FREQ=DAILY",
    seriesId: id,
    reminderDate: localDate(1),
    reminderTime: "14:00",
    seriesStartDate: localDate(1),
    seriesStartTime: "14:00",
    updatedAt: 42
  } as Task;
}

function alarmKeyFor(task: Task, occurrenceDays = 1) {
  return taskAlarmKey(task, `${localDate(occurrenceDays)}T14:00`);
}

function triggerId(id: string) {
  return `task:${id}`;
}

function pendingTrigger(task: Task): FakeTrigger {
  return {
    id: triggerId(task.id),
    timestamp: NOW + 1000,
    data: {
      type: "task",
      taskId: task.id,
      updatedAt: "42",
      privacyHidden: "0",
      accountId: "account-a",
      occurrenceKey: "",
      seriesId: ""
    }
  };
}

const createdNotificationIds = () =>
  [...notifeeStore.triggers.keys()].sort();

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  notifeeStore.triggers.clear();
  notifeeStore.displayed.length = 0;
  pendingCleanup.clear();
  device.alarms.clear();
  device.calls = [];
  device.status = "authorized";
  device.verifyCalls = 0;
  device.failVerifyOnCall = 0;
  device.dropAlarms.clear();
  device.unredacted.clear();
  device.failCancel = false;
  database.isInitialized = true;
  // Every mocked device call is reset to its base behaviour, so a test that
  // programmed a one-off failure cannot leak it into the next one.
  nativeMock.__replaceAlarms.mockReset();
  nativeMock.__replaceAlarms.mockImplementation(
    nativeMock.__base.deviceReplace as never
  );
  nativeMock.__verifyAlarms.mockReset();
  nativeMock.__verifyAlarms.mockImplementation(
    nativeMock.__base.deviceVerify as never
  );
  nativeMock.__cancelScheduledAlarms.mockReset();
  nativeMock.__cancelScheduledAlarms.mockImplementation(
    nativeMock.__base.deviceCancelScheduled as never
  );
  notifee.getTriggerNotifications.mockReset();
  notifee.getTriggerNotifications.mockImplementation(
    notifeeBase.readTriggers as never
  );
  notifee.createTriggerNotification.mockReset();
  notifee.createTriggerNotification.mockImplementation(
    notifeeBase.createTrigger as never
  );
  notifee.cancelTriggerNotification.mockReset();
  notifee.cancelTriggerNotification.mockImplementation(
    notifeeBase.cancelTrigger as never
  );
  notifee.getDisplayedNotifications.mockReset();
  notifee.getDisplayedNotifications.mockImplementation(
    notifeeBase.readDisplayed as never
  );
  notifee.cancelDisplayedNotification.mockReset();
  notifee.cancelDisplayedNotification.mockImplementation(
    notifeeBase.cancelDisplayed as never
  );
  notifee.getNotificationSettings.mockReset();
  notifee.getNotificationSettings.mockImplementation(
    notifeeBase.readSettings as never
  );
  database.tasks.list.mockReset();
  database.tasks.list.mockResolvedValue([]);
  userStore.mockReturnValue({
    user: { id: "account-a" },
    appLocked: false,
    isLoggingOut: false
  });
  settingStore.mockReturnValue({
    settings: { appLockEnabled: false },
    isAppLoading: false
  });
  settingsService.mockReturnValue({ appLockEnabled: false });
  toast.mockClear();
  storage.getString.mockImplementation((key: string) => pendingCleanup.get(key));
  storage.setString.mockImplementation((key: string, value: string) => {
    if (value) pendingCleanup.set(key, value);
    else pendingCleanup.delete(key);
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("Urgent per-occurrence delivery exclusivity", () => {
  test("withdraws the competing fallback, verifies it, and only then installs the alarm", async () => {
    const task = urgentTask("exclusive");
    database.tasks.list.mockResolvedValue([task]);
    // Yesterday's pass left a notification fallback pending for this occurrence.
    notifeeStore.triggers.set(triggerId(task.id), pendingTrigger(task));

    await TaskNotifications.reconcile();

    // One occurrence, one audible delivery: the alarm exists and the
    // notification that would have alerted alongside it is gone.
    expect([...device.alarms.keys()]).toEqual([alarmKeyFor(task)]);
    expect(createdNotificationIds()).toEqual([]);
    const cancelOrder =
      notifee.cancelTriggerNotification.mock.invocationCallOrder[0];
    const replaceOrder = nativeMock.__replaceAlarms.mock.invocationCallOrder[0];
    expect(cancelOrder).toBeLessThan(replaceOrder);
  });

  test("introduces no alarm when the competing fallback cannot be withdrawn", async () => {
    const task = urgentTask("stuck-fallback");
    database.tasks.list.mockResolvedValue([task]);
    notifeeStore.triggers.set(triggerId(task.id), pendingTrigger(task));
    // The cancellation silently does nothing, so the fallback is still pending
    // when the pass re-reads the trigger store to verify the withdrawal.
    notifee.cancelTriggerNotification.mockImplementation(async () => {});

    await TaskNotifications.reconcile();

    // No alarm may take over an occurrence whose fallback is still pending; the
    // notification remains the single delivery.
    expect(device.alarms.size).toBe(0);
    expect(createdNotificationIds()).toEqual([triggerId(task.id)]);
  });

  test("a lost replace acknowledgement never leaves both an alarm and a fallback", async () => {
    const task = urgentTask("lost-ack");
    database.tasks.list.mockResolvedValue([task]);
    notifeeStore.triggers.set(triggerId(task.id), pendingTrigger(task));
    // The device applied the pass but the answer was lost, so JS sees a
    // rejection; verification then fails too, and so does the cancellation.
    nativeMock.__replaceAlarms.mockImplementationOnce(
      async (_accountId: string, alarms: { alarmKey: string }[]) => {
        for (const alarm of alarms)
          device.alarms.set(alarm.alarmKey, "scheduled");
        throw new Error("bridge lost the answer");
      }
    );
    // The read succeeds; the retry after the failed write is what fails.
    device.failVerifyOnCall = 2;
    device.failCancel = new Error("cancellation unavailable");

    await TaskNotifications.reconcile();

    // Two audible deliveries for one occurrence is the failure this ordering
    // exists to prevent: the withdrawn fallback must not be re-created while
    // the alarm state is unverified.
    expect(createdNotificationIds()).toEqual([]);
    expect(device.alarms.size).toBe(1);
    expect(DatabaseLog.error).toHaveBeenCalled();
  });

  test("a verified cancellation grants a fallback only to the occurrences it cancelled", async () => {
    const first = urgentTask("partial-cancel");
    const second = urgentTask("partial-cancel-2");
    database.tasks.list.mockResolvedValue([first, second]);
    nativeMock.__replaceAlarms.mockRejectedValueOnce(
      new Error("replace failed")
    );
    // The read succeeds; the retry after the failed write is what fails.
    device.failVerifyOnCall = 2;
    nativeMock.__cancelScheduledAlarms.mockResolvedValueOnce({
      status: "authorized",
      cancelledAlarmKeys: [alarmKeyFor(first)],
      retainedAlarmKeys: []
    });

    await TaskNotifications.reconcile();

    // The cancelled occurrence falls back; the one the device answered nothing
    // about stays unknown and gains no second delivery.
    expect(createdNotificationIds()).toEqual([triggerId(first.id)]);
  });

  test("keeps a snoozed alarm's occurrence out of the fallback path", async () => {
    const task = urgentTask("snoozed");
    database.tasks.list.mockResolvedValue([task]);
    device.alarms.set(alarmKeyFor(task), "active");
    nativeMock.__replaceAlarms.mockRejectedValueOnce(
      new Error("replace failed")
    );
    // The read succeeds; the retry after the failed write is what fails.
    device.failVerifyOnCall = 2;

    await TaskNotifications.reconcile();

    expect(createdNotificationIds()).toEqual([]);
    expect(device.alarms.get(alarmKeyFor(task))).toBe("active");
  });

  test("cleans up alarms held from before a denied authorization instead of duplicating them", async () => {
    const cancelled = urgentTask("denied-scheduled");
    const presenting = urgentTask("denied-presenting");
    database.tasks.list.mockResolvedValue([cancelled, presenting]);
    device.alarms.set(alarmKeyFor(cancelled), "scheduled");
    device.alarms.set(alarmKeyFor(presenting), "active");
    device.status = "denied";
    nativeMock.__cancelScheduledAlarms.mockResolvedValueOnce({
      status: "denied",
      cancelledAlarmKeys: [alarmKeyFor(cancelled)],
      retainedAlarmKeys: [alarmKeyFor(presenting)]
    });

    await TaskNotifications.reconcile();

    // The alarm that is presenting right now still owns its occurrence; only the
    // one that was actually cancelled may become a notification.
    expect(createdNotificationIds()).toEqual([triggerId(cancelled.id)]);
    expect(device.alarms.has(alarmKeyFor(presenting))).toBe(true);
  });

  test("stamps each notification with its own occurrence identity, not the current record's", async () => {
    const series = recurringTask("series-head");
    database.tasks.list.mockResolvedValue([series]);
    const occurrences = taskReminderOccurrences(series, NOW);
    expect(occurrences.length).toBeGreaterThan(2);
    // The device scheduled every occurrence of the series but the last one.
    for (const occurrence of occurrences.slice(0, -1))
      device.alarms.set(taskAlarmKey(series, occurrence.key), "scheduled");
    device.dropAlarms.add(
      taskAlarmKey(series, occurrences[occurrences.length - 1].key)
    );

    await TaskNotifications.reconcile();

    const last = occurrences[occurrences.length - 1];
    expect(createdNotificationIds()).toEqual([
      `task:series-head:${last.key}`
    ]);
    const stamped = [...notifeeStore.triggers.values()][0];
    expect(stamped.data.occurrenceKey).toBe(last.key);
    expect(stamped.data.seriesId).toBe("series-head");
    expect(stamped.data.urgentFallback).toBe("1");
  });

  test("a normal unchanged pass writes nothing at all", async () => {
    const task = urgentTask("stable");
    database.tasks.list.mockResolvedValue([task]);
    device.alarms.set(alarmKeyFor(task), "scheduled");

    await TaskNotifications.reconcile();

    expect(notifee.createTriggerNotification).not.toHaveBeenCalled();
    expect(notifee.cancelTriggerNotification).not.toHaveBeenCalled();
    expect(device.alarms.size).toBe(1);
    expect(createdNotificationIds()).toEqual([]);
  });

  test("an occurrence that already owns an unchanged fallback is not duplicated", async () => {
    const task = urgentTask("already-fallback");
    database.tasks.list.mockResolvedValue([task]);
    device.status = "unsupported";
    notifeeStore.triggers.set(triggerId(task.id), {
      ...pendingTrigger(task),
      timestamp: taskReminderOccurrences(task, NOW)[0].timestamp,
      data: { ...pendingTrigger(task).data, urgentFallback: "1" }
    });

    await TaskNotifications.reconcile();

    expect(createdNotificationIds()).toEqual([triggerId(task.id)]);
    expect(notifee.createTriggerNotification).not.toHaveBeenCalled();
  });
});

describe("Task change subscription", () => {
  test("re-plans on a settings-collection write, which is where core keeps Task records", async () => {
    database.tasks.list.mockResolvedValue([]);
    TaskNotifications.start();
    try {
      const subscription = database.eventManager.subscribe.mock.calls.find(
        ([event]) => event === EVENTS.databaseUpdated
      );
      expect(subscription).toBeDefined();
      const handler = subscription?.[1] as (event: {
        type: string;
        collection: string;
      }) => void;
      const before = database.tasks.list.mock.calls.length;

      // Core stores Tasks as settings records: `TaskRecordStore.save` writes
      // `db.settings.collection` (`packages/core/src/collections/tasks.ts`), and
      // `SQLCollection.upsert` publishes `databaseUpdated` with
      // `collection: this.type`, which is "settings"
      // (`packages/core/src/database/sql-collection.ts:108`,
      // `packages/core/src/collections/settings.ts:104`). A Task being created,
      // edited, completed, deleted or synced therefore reaches this handler.
      handler({ type: "upsert", collection: "settings" });
      jest.advanceTimersByTime(300);
      await TaskNotifications.reconcile();

      expect(database.tasks.list.mock.calls.length).toBeGreaterThan(before);
    } finally {
      TaskNotifications.stop();
    }
  });
});

describe("App Lock privacy in the delivery pass", () => {
  test("redacts a notification when the persisted App Lock setting is on but the store is not hydrated", async () => {
    const task = urgentTask("private");
    database.tasks.list.mockResolvedValue([task]);
    // This occurrence's alarm cannot be scheduled, so it becomes the fallback
    // notification -- the path that must carry the redacted title.
    device.dropAlarms.add(alarmKeyFor(task));
    settingStore.mockReturnValue({
      settings: { appLockEnabled: false },
      isAppLoading: false
    });
    settingsService.mockReturnValue({ appLockEnabled: true });

    await TaskNotifications.reconcile();

    const created = notifeeStore.triggers.get(triggerId(task.id));
    expect(created?.title).toBe("VeyraN Task");
    expect(created?.data.privacyHidden).toBe("1");
  });

  test("surfaces a redaction failure instead of claiming App Lock hid the title", async () => {
    const task = urgentTask("unredactable");
    database.tasks.list.mockResolvedValue([task]);
    settingStore.mockReturnValue({
      settings: { appLockEnabled: true },
      isAppLoading: false
    });
    // The alarm exists and is held, but the device could not redact the
    // presentation that is already on screen.
    device.alarms.set(alarmKeyFor(task), "active");
    device.unredacted.add(alarmKeyFor(task));

    await TaskNotifications.reconcile();

    // The failure is said out loud, never reported as a clean redaction.
    expect(DatabaseLog.error).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({
      message: TASK_ALARM_UNREDACTED_MESSAGE,
      type: "error"
    });
    // ...and the occurrence is still *held*, so it gains no second, duplicate
    // audible delivery.
    expect(createdNotificationIds()).toEqual([]);
  });

  test("withdraws an already-displayed unredacted notification", async () => {
    const task = urgentTask("displayed");
    database.tasks.list.mockResolvedValue([task]);
    notifeeStore.displayed.push({
      id: triggerId("displayed"),
      timestamp: NOW,
      title: "title-displayed",
      data: { type: "task", taskId: task.id, privacyHidden: "0" }
    });
    settingStore.mockReturnValue({
      settings: { appLockEnabled: true },
      isAppLoading: false
    });

    await TaskNotifications.reconcile();

    expect(notifee.cancelDisplayedNotification).toHaveBeenCalledWith(
      triggerId("displayed")
    );
    expect(pendingCleanup.get(CLEANUP_KEY)).toBeUndefined();
  });
});

describe("pending device cleanup obligations", () => {
  test("retries a failed cleanup before planning anything new", async () => {
    const task = urgentTask("after-logout");
    database.tasks.list.mockResolvedValue([task]);
    device.alarms.set(alarmKeyFor(urgentTask("old")), "scheduled");
    pendingCleanup.set(
      CLEANUP_KEY,
      JSON.stringify({ labels: ["native alarms"], at: NOW - 1000 })
    );

    await TaskNotifications.reconcile();

    // The owed cleanup ran (the old account's alarms were cancelled) before the
    // new pass was allowed to install this account's alarm.
    expect(device.calls[0]).toBe("cancelAll");
    expect([...device.alarms.keys()]).toEqual([alarmKeyFor(task)]);
    expect(pendingCleanup.get(CLEANUP_KEY)).toBeUndefined();
  });

  test("runs an owed cleanup even when the Task domain is not usable this launch", async () => {
    database.isInitialized = false;
    device.alarms.set(alarmKeyFor(urgentTask("old")), "scheduled");
    pendingCleanup.set(
      CLEANUP_KEY,
      JSON.stringify({
        labels: ["native alarms", "task notifications"],
        at: NOW - 1000
      })
    );

    await TaskNotifications.reconcile();

    expect(device.alarms.size).toBe(0);
    // Nothing was planned for a domain that cannot be read.
    expect(notifee.createTriggerNotification).not.toHaveBeenCalled();
  });

  test("keeps the obligation when the retry fails again", async () => {
    database.isInitialized = false;
    pendingCleanup.set(
      CLEANUP_KEY,
      JSON.stringify({ labels: ["task notifications"], at: NOW - 1000 })
    );
    notifee.getTriggerNotifications.mockRejectedValueOnce(
      new Error("trigger store unavailable")
    );

    await TaskNotifications.reconcile();

    expect(pendingCleanup.get(CLEANUP_KEY)).toContain("task notifications");
  });
});

describe("stale delivered Task notifications", () => {
  const tasks = new Map([
    ["open", { completed: false, updatedAt: 10 }],
    ["done", { completed: true, updatedAt: 11 }]
  ]);

  test("keeps the notification of an unchanged open Task", () => {
    expect(
      isStaleTaskNotification({ taskId: "open", updatedAt: "10" }, tasks)
    ).toBe(false);
  });

  test("withdraws completed, deleted and changed Tasks", () => {
    expect(
      isStaleTaskNotification({ taskId: "done", updatedAt: "11" }, tasks)
    ).toBe(true);
    expect(
      isStaleTaskNotification({ taskId: "gone", updatedAt: "1" }, tasks)
    ).toBe(true);
    expect(
      isStaleTaskNotification({ taskId: "open", updatedAt: "9" }, tasks)
    ).toBe(true);
  });
});
