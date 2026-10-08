import type { Task } from "@notesnook/core";
import {
  desiredTaskAlarms,
  MAX_OVERDUE_SURFACES,
  OVERDUE_SURFACE_LIFETIME_MS,
  overdueTaskSurfaces,
  TASK_ALARM_CONFIGURATION_VERSION,
  taskAlarmKey,
  taskAlarmState,
  taskReminderOccurrences
} from "./task-alarm-plan";
import { planTaskNotifications } from "./task-notification-plan";

const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000);
const date = `${tomorrow.getFullYear()}-${String(
  tomorrow.getMonth() + 1
).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

/** Local wall-clock parts for an instant, matching how reminders are stored. */
function wallClock(instant: number) {
  const at = new Date(instant);
  return {
    date: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(at.getDate()).padStart(2, "0")}`,
    time: `${String(at.getHours()).padStart(2, "0")}:${String(
      at.getMinutes()
    ).padStart(2, "0")}`
  };
}

/** A timed reminder that fired `minutesAgo` before `now`. */
function overdue(
  id: string,
  now: number,
  minutesAgo: number,
  patch: Record<string, unknown> = {}
): Task {
  const parts = wallClock(now - minutesAgo * 60 * 1000);
  return task(id, {
    reminderDate: parts.date,
    reminderTime: parts.time,
    ...patch
  });
}

function task(id: string, patch: Record<string, unknown> = {}): Task {
  return {
    id,
    title: id,
    completed: false,
    urgent: true,
    scheduleVersion: 2,
    reminderDate: date,
    reminderTime: "14:00",
    reminderAt: new Date(`${date}T14:00:00`).getTime(),
    updatedAt: 42,
    ...patch
  } as Task;
}

describe("Urgent Task alarm planning", () => {
  test("uses the local wall time and retains a past active occurrence", () => {
    const item = task("one", { reminderAt: 1 });
    expect(desiredTaskAlarms([item], false)).toEqual([
      {
        taskId: "one",
        alarmKey: "task:one",
        timestamp: new Date(`${date}T14:00:00`).getTime(),
        title: "one",
        updatedAt: 42,
        privacyHidden: false,
        // The generation and the occurrence's own key are part of every planned
        // alarm, so a config bump or a sibling occurrence can never be confused
        // with this one.
        configurationVersion: TASK_ALARM_CONFIGURATION_VERSION,
        occurrenceKey: `${date}Tdate`
      }
    ]);
    expect(
      desiredTaskAlarms(
        [
          task("past", {
            reminderAt: 1,
            scheduleVersion: undefined,
            reminderDate: undefined
          })
        ],
        true
      )
    ).toHaveLength(1);
  });

  test("excludes completed and date-only urgent Tasks", () => {
    expect(
      desiredTaskAlarms(
        [
          task("done", { completed: true }),
          task("date-only", { reminderTime: undefined }),
          task("normal", { urgent: false })
        ],
        false
      )
    ).toEqual([]);
  });

  test("an Urgent notification is a fallback unless the caller says the alarm succeeded", () => {
    const item = task("urgent");
    // No caller decision given: fail-safe default is "needs fallback" for every
    // Urgent occurrence, so a caller that doesn't know the real alarm outcome
    // never silently ends up with neither an alarm nor a notification.
    const plan = planTaskNotifications([item], [], Date.now(), 60);
    expect(plan.schedule).toHaveLength(1);
    expect(plan.schedule[0].urgentFallback).toBe(true);
    expect(desiredTaskAlarms([item], false)).toHaveLength(1);

    // Caller confirms the alarm succeeded (predicate says no fallback
    // needed): no notification at all, since AlarmKit is the sole delivery
    // path and a duplicate would mean two audible alerts for one occurrence.
    const alarmSucceeded = planTaskNotifications(
      [item],
      [],
      Date.now(),
      60,
      false,
      { needsFallback: () => false }
    );
    expect(alarmSucceeded.schedule).toHaveLength(0);

    // An existing trigger that already correctly reflects urgentFallback is
    // left alone -- not needlessly cancelled and rescheduled.
    expect(
      planTaskNotifications(
        [item],
        [
          {
            id: plan.schedule[0].notificationId,
            timestamp: plan.schedule[0].timestamp,
            updatedAt: "42",
            urgentFallback: true
          }
        ],
        Date.now(),
        60
      ).cancelIds
    ).toEqual([]);
  });

  test("the alarm key names one occurrence and matches the planned notification", () => {
    const item = task("recurring", {
      recurrenceRule: "FREQ=DAILY",
      seriesId: "series-key",
      seriesStartDate: date,
      seriesStartTime: "14:00"
    });
    const alarms = desiredTaskAlarms([item], false, Date.now());
    // Every occurrence has its own key, and each key is exactly what the alarm
    // planner produced (so a per-occurrence delivery answer can be matched).
    expect(new Set(alarms.map((alarm) => alarm.alarmKey)).size).toBe(
      alarms.length
    );
    for (const alarm of alarms)
      expect(alarm.alarmKey.startsWith("series:series-key:")).toBe(true);

    const plan = planTaskNotifications([item], [], Date.now(), 60, false, {
      needsFallback: (alarmKey) => alarmKey === alarms[1].alarmKey
    });
    // Only the occurrence whose alarm key was reported missing becomes a
    // notification; the five successfully-scheduled occurrences get none. The
    // notification id names the same occurrence as the alarm key.
    expect(plan.schedule).toHaveLength(1);
    const occurrenceKey = alarms[1].alarmKey.replace("series:series-key:", "");
    expect(plan.schedule[0].notificationId).toBe(
      `task:series-key:${occurrenceKey}`
    );
    // One-off Tasks keep the bare Task key.
    expect(taskAlarmKey(task("one-off"))).toBe("task:one-off");
  });

  test("prearms recurring alarms without requiring completion", () => {
    const item = task("first", {
      recurrenceRule: "FREQ=DAILY",
      seriesId: "series-a",
      seriesStartDate: date,
      seriesStartTime: "14:00"
    });
    const alarms = desiredTaskAlarms([item], false, Date.now());
    expect(alarms).toHaveLength(6);
    expect(new Set(alarms.map((alarm) => alarm.alarmKey)).size).toBe(6);
    expect(alarms[1].alarmKey).toBe(
      `series:series-a:${new Date(alarms[1].timestamp).getFullYear()}-${String(
        new Date(alarms[1].timestamp).getMonth() + 1
      ).padStart(2, "0")}-${String(
        new Date(alarms[1].timestamp).getDate()
      ).padStart(2, "0")}T14:00`
    );

    const next = task("materialized", {
      recurrenceRule: "FREQ=DAILY",
      seriesId: "series-a",
      seriesStartDate: date,
      seriesStartTime: "14:00",
      reminderDate: alarms[1].alarmKey.slice(-16, -6),
      reminderAt: alarms[1].timestamp
    });
    const afterCompletion = desiredTaskAlarms([next], false, Date.now());
    expect(afterCompletion[0].alarmKey).toBe(alarms[1].alarmKey);
  });

  test("retains the elapsed occurrence but does not duplicate its future keys", () => {
    const item = task("first", {
      recurrenceRule: "FREQ=DAILY",
      seriesId: "series-b",
      seriesStartDate: date,
      seriesStartTime: "14:00"
    });
    const elapsed = new Date(`${date}T14:00:00`).getTime() + 1;
    const alarms = desiredTaskAlarms([item], false, elapsed);
    expect(alarms[0].timestamp).toBeLessThan(elapsed);
    expect(new Set(alarms.map((alarm) => alarm.alarmKey)).size).toBe(
      alarms.length
    );
    expect(alarms.slice(1).every((alarm) => alarm.timestamp > elapsed)).toBe(
      true
    );
  });

  test("normal recurring reminders prearm future notifications", () => {
    const item = task("normal", {
      urgent: false,
      recurrenceRule: "FREQ=DAILY",
      seriesId: "series-normal",
      seriesStartDate: date,
      seriesStartTime: "14:00"
    });
    const plan = planTaskNotifications([item], [], Date.now(), 60);
    expect(plan.schedule).toHaveLength(6);
    expect(
      new Set(plan.schedule.map((entry) => entry.notificationId)).size
    ).toBe(6);
  });
});

describe("ongoing overdue surfaces", () => {
  const now = Date.now();

  test("surfaces an incomplete Task whose reminder already fired", () => {
    const item = overdue("fired", now, 60);

    expect(overdueTaskSurfaces([item], now)).toEqual([
      {
        taskId: "fired",
        timestamp: new Date(`${item.reminderDate}T${item.reminderTime}:00`).getTime(),
        title: "fired",
        updatedAt: 42,
        alarmKey: "task:fired",
        occurrenceKey: `${item.reminderDate}Tdate`
      }
    ]);
  });

  test("never surfaces an ordinary reminder -- these surfaces belong to Urgent", () => {
    const item = overdue("normal", now, 30, { urgent: false });
    expect(overdueTaskSurfaces([item], now)).toEqual([]);
  });

  test("never lets ordinary overdue reminders consume an Urgent surface slot", () => {
    const normal = Array.from({ length: MAX_OVERDUE_SURFACES + 2 }, (_, index) =>
      overdue(`normal-${index}`, now, 5 + index, { urgent: false })
    );
    const urgent = overdue("urgent", now, 60);

    expect(overdueTaskSurfaces([...normal, urgent], now).map((e) => e.taskId)).toEqual(
      ["urgent"]
    );
  });

  test("clears every surface once Urgent is switched off or the reminder is removed", () => {
    const fired = overdue("fired", now, 30);
    expect(overdueTaskSurfaces([fired], now)).toHaveLength(1);
    // Urgent switched off: desired set is empty, so the native reconcile ends
    // the associated Live Activity instead of leaving it behind.
    expect(
      overdueTaskSurfaces([{ ...fired, urgent: false }], now)
    ).toEqual([]);
    // Reminder removed: no timed schedule remains to be overdue.
    expect(
      overdueTaskSurfaces([{ ...fired, reminderTime: undefined }], now)
    ).toEqual([]);
    // Completed: the overdue state is gone.
    expect(overdueTaskSurfaces([{ ...fired, completed: true }], now)).toEqual([]);
    // Deleted: the record is simply absent from the current list.
    expect(overdueTaskSurfaces([], now)).toEqual([]);
    // Rescheduled into the future: no longer overdue.
    expect(
      overdueTaskSurfaces([overdue("rescheduled", now, -120)], now)
    ).toEqual([]);
  });

  test("never surfaces a completed Task, a future reminder or a date-only reminder", () => {
    expect(
      overdueTaskSurfaces(
        [
          overdue("done", now, 30, { completed: true }),
          task("later"),
          task("date-only", { reminderTime: undefined })
        ],
        now
      )
    ).toEqual([]);
  });

  test("never resurrects an occurrence older than a Live Activity can survive", () => {
    const stale = overdue(
      "stale",
      now,
      OVERDUE_SURFACE_LIFETIME_MS / 60000 + 5
    );
    const fresh = overdue("fresh", now, OVERDUE_SURFACE_LIFETIME_MS / 60000 - 5);

    expect(overdueTaskSurfaces([stale, fresh], now).map((e) => e.taskId)).toEqual(
      ["fresh"]
    );
  });

  test("keeps the newest overdue Tasks and bounds how many surfaces exist", () => {
    const tasks = Array.from({ length: MAX_OVERDUE_SURFACES + 3 }, (_, index) =>
      overdue(`task-${index}`, now, 10 + index)
    );

    const surfaces = overdueTaskSurfaces(tasks, now);

    expect(surfaces).toHaveLength(MAX_OVERDUE_SURFACES);
    expect(surfaces.map((surface) => surface.taskId)).toEqual([
      "task-0",
      "task-1",
      "task-2",
      "task-3",
      "task-4"
    ]);
  });

  test("passes a sanitised title through so the native side can redact it", () => {
    const item = overdue("noisy", now, 20, {
      title: "Pay\nrent today"
    });

    expect(overdueTaskSurfaces([item], now)[0].title).toBe("Pay rent today");
  });

  test("always sends the real title, leaving redaction to the single native path", () => {
    const item = overdue("secret", now, 15, { title: "Therapy at 5" });

    // The planner never chooses the App Lock placeholder itself: it always
    // sends the real (sanitised) title and lets the one native redaction step
    // decide, so a hidden surface cannot leak through a different route.
    expect(overdueTaskSurfaces([item], now)[0].title).toBe("Therapy at 5");
  });

});

describe("per-occurrence state machine", () => {
  const now = Date.now();
  const base = {
    hasReminder: true,
    urgent: true,
    occurrenceTimestamp: now + 60 * 60 * 1000,
    now
  };

  test("a held alarm that is not presenting is SCHEDULED, never ALERTING", () => {
    // The native report distinguishes "the system holds it" from "it is
    // presenting now"; a held-but-silent occurrence must not read as alerting.
    expect(taskAlarmState({ ...base, held: true })).toBe("SCHEDULED");
    expect(taskAlarmState({ ...base, held: true, presentation: null })).toBe(
      "SCHEDULED"
    );
  });

  test("only a presenting alarm is ALERTING or SNOOZED", () => {
    expect(
      taskAlarmState({ ...base, held: true, presentation: "alerting" })
    ).toBe("ALERTING");
    expect(
      taskAlarmState({ ...base, held: true, presentation: "countdown" })
    ).toBe("SNOOZED");
    expect(taskAlarmState({ ...base, held: true, presentation: "paused" })).toBe(
      "SNOOZED"
    );
  });

  test("an occurrence that is over and not held is STOPPED_BUT_INCOMPLETE", () => {
    expect(
      taskAlarmState({
        ...base,
        occurrenceTimestamp: now - 60 * 1000,
        held: false
      })
    ).toBe("STOPPED_BUT_INCOMPLETE");
    // A future occurrence the system does not hold is simply not armed.
    expect(taskAlarmState({ ...base, held: false })).toBe(
      "REMOVED_OR_DISABLED"
    );
  });

  test("completion, a removed reminder/Urgent and a move each win outright", () => {
    expect(taskAlarmState({ ...base, completed: true, held: true })).toBe(
      "COMPLETED"
    );
    expect(taskAlarmState({ ...base, held: false, urgent: false })).toBe(
      "REMOVED_OR_DISABLED"
    );
    expect(taskAlarmState({ ...base, held: false, hasReminder: false })).toBe(
      "REMOVED_OR_DISABLED"
    );
    expect(
      taskAlarmState({
        ...base,
        previousTimestamp: base.occurrenceTimestamp - 1000,
        held: true,
        presentation: "alerting"
      })
    ).toBe("RESCHEDULED");
  });
});
