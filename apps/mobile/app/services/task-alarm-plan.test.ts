import type { Task } from "@notesnook/core";
import { desiredTaskAlarms } from "./task-alarm-plan";
import { planTaskNotifications } from "./task-notification-plan";

const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000);
const date = `${tomorrow.getFullYear()}-${String(
  tomorrow.getMonth() + 1
).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

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
        privacyHidden: false
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

  test("Urgent notifications wait until legacy alarms are cleared", () => {
    const item = task("urgent");
    const plan = planTaskNotifications([item], [], Date.now(), 60);
    expect(plan.schedule).toHaveLength(1);
    expect(plan.schedule[0].urgentFallback).toBe(false);
    expect(desiredTaskAlarms([item], false)).toHaveLength(1);

    const unsafe = planTaskNotifications(
      [item],
      [],
      Date.now(),
      60,
      false,
      false
    );
    expect(unsafe.schedule).toHaveLength(0);

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
    ).toEqual([plan.schedule[0].notificationId]);
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
