/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import { RRule } from "rrule";
import { Mutex } from "async-mutex";
import { strings } from "@notesnook/intl";
import Database from "../api/index.js";
import { Reminder, SettingItem } from "../types.js";
import { getId, makeId } from "../utils/id.js";
import { logger } from "../logger.js";
import {
  DEFAULT_TASK_LIST_COLOR,
  DEFAULT_TASK_LIST_SYMBOL,
  isTaskListColor,
  isTaskListSymbol
} from "./task-list-appearance.js";

const VERSION = 1;
const PREFIX = "appleTasks:v1:";
const DEFAULT_LIST_ID = makeId(`${PREFIX}defaultList`);
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const warnedRecordKeys = new Set<string>();
const MAX_WARNED_RECORD_KEYS = 1000;

export type TaskPriority = "none" | "low" | "medium" | "high";
export type TaskSmartList =
  | "today"
  | "scheduled"
  | "all"
  | "flagged"
  | "completed";

export interface Task {
  id: string;
  title: string;
  description?: string;
  listId: string;
  completed: boolean;
  completedAt?: number;
  /** Wall time captured at completion so recurrence reconciliation is zone-stable. */
  completedWallDate?: string;
  completedWallTime?: string;
  dueDate?: string;
  dueTime?: string;
  reminderAt?: number;
  /** Authoritative local calendar schedule for redesigned Tasks. */
  reminderDate?: string;
  reminderTime?: string;
  /** AlarmKit delivery intent; unsupported devices retain it without rewriting. */
  urgent?: boolean;
  /** Additive calendar model. Legacy records are projected on read without rewrites. */
  scheduleVersion?: number;
  recurrenceRule?: string;
  priority: TaskPriority;
  flagged: boolean;
  createdAt: number;
  updatedAt: number;
  schemaVersion: 1;
  /** The first occurrence of a recurring series. */
  seriesId?: string;
  seriesStartDate?: string;
  seriesStartTime?: string;
  occurrenceKey?: string;
  legacyReminderId?: string;
  /** Calendar wall-clock lead from due time to reminder time. */
  reminderLeadMinutes?: number;
  localOnly?: boolean;
}

export type TaskInput = Pick<Task, "title"> &
  Partial<Omit<Task, "title" | "schemaVersion" | "createdAt" | "updatedAt">>;

export interface TaskList {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  schemaVersion: 1;
  color?: string;
  symbol?: string;
}

export type TaskListInput = Pick<TaskList, "name"> &
  Partial<Pick<TaskList, "sortOrder" | "color" | "symbol">>;

function validListColor(color: string) {
  return (
    isTaskListColor(color) ||
    /^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(color)
  );
}

function key(kind: "task" | "list", id: string) {
  return `${PREFIX}${kind}:${id}`;
}

function settingId(recordKey: string) {
  return makeId(recordKey);
}

function calendarDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getDate()).padStart(2, "0")}`;
}

function calendarTime(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

/** Explicit legacy reminders win over legacy due dates. New calendar fields win over both. */
export function taskReminderSchedule(
  task: Pick<
    Task,
    | "reminderDate"
    | "reminderTime"
    | "reminderAt"
    | "dueDate"
    | "dueTime"
    | "scheduleVersion"
  >
): { date?: string; time?: string } {
  if (task.scheduleVersion === 2)
    return { date: task.reminderDate, time: task.reminderTime };
  if (task.reminderAt !== undefined) {
    const instant = new Date(task.reminderAt);
    return { date: calendarDate(instant), time: calendarTime(instant) };
  }
  return { date: task.dueDate, time: task.dueTime };
}

/** Date-only reminders notify at 09:00 in the device's current local timezone. */
export function taskReminderTimestamp(
  task: Partial<
    Pick<
      Task,
      | "reminderDate"
      | "reminderTime"
      | "reminderAt"
      | "dueDate"
      | "dueTime"
      | "scheduleVersion"
    >
  >
): number | undefined {
  if (task.scheduleVersion === 2 && !task.reminderDate) return;
  if (task.reminderDate && task.scheduleVersion === 2) {
    const [year, month, day] = task.reminderDate.split("-").map(Number);
    const [hour, minute] = (task.reminderTime || "09:00")
      .split(":")
      .map(Number);
    return new Date(year, month - 1, day, hour, minute).getTime();
  }
  if (task.reminderAt !== undefined) return task.reminderAt;
  if (task.dueDate) {
    const [year, month, day] = task.dueDate.split("-").map(Number);
    const [hour, minute] = (task.dueTime || "09:00").split(":").map(Number);
    return new Date(year, month - 1, day, hour, minute).getTime();
  }
}

function isValidCalendarDate(date: string) {
  if (!DATE.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  const test = new Date(year, month - 1, day);
  return (
    test.getFullYear() === year &&
    test.getMonth() === month - 1 &&
    test.getDate() === day
  );
}

function floatingInstant(date: string, time = "00:00") {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

function wallMinutes(date: Date) {
  return (
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes()
    ) / 60000
  );
}

function reminderLeadMinutes(
  task: Pick<Task, "dueDate" | "dueTime" | "reminderAt">
) {
  if (!task.dueDate || task.reminderAt === undefined) return;
  return (
    floatingInstant(task.dueDate, task.dueTime).getTime() / 60000 -
    wallMinutes(new Date(task.reminderAt))
  );
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nextReminderAt(task: Task, next: { date: string; time?: string }) {
  if (task.reminderAt === undefined) return;
  const lead = task.reminderLeadMinutes ?? reminderLeadMinutes(task);
  if (lead === undefined) return;
  const [year, month, day] = next.date.split("-").map(Number);
  const [hour, minute] = (next.time || "00:00").split(":").map(Number);
  const reminder = new Date(year, month - 1, day, hour, minute);
  reminder.setMinutes(reminder.getMinutes() - lead);
  return reminder.getTime();
}

function nextOccurrence(
  task: Task
): { date: string; time?: string } | undefined {
  if (!task.recurrenceRule || !task.dueDate) return;
  const rule = task.recurrenceRule.replace(/^RRULE:/i, "").trim();
  const options = RRule.parseString(rule);
  const start = floatingInstant(
    task.seriesStartDate || task.dueDate,
    task.seriesStartDate !== undefined ? task.seriesStartTime : task.dueTime
  );
  const current = floatingInstant(task.dueDate, task.dueTime);
  const isTimed =
    task.seriesStartDate !== undefined
      ? task.seriesStartTime !== undefined
      : task.dueTime !== undefined;
  let after = current;
  if (task.completedAt !== undefined) {
    const completed = new Date(task.completedAt);
    const completedDate =
      task.completedWallDate || completed.toISOString().slice(0, 10);
    const completedTime =
      task.completedWallTime || completed.toISOString().slice(11, 16);
    const completionWallTime = floatingInstant(
      completedDate,
      isTimed ? completedTime : "00:00"
    ).getTime();
    // A date-only occurrence remains relevant for the whole completion day.
    const cutoff = isTimed ? completionWallTime : completionWallTime - 1;
    if (cutoff > after.getTime()) after = new Date(cutoff);
  }
  const next = new RRule({ ...options, dtstart: start }).after(after, false);
  if (!next) return;
  return {
    date: next.toISOString().slice(0, 10),
    time: isTimed ? next.toISOString().slice(11, 16) : undefined
  };
}

function safeNextOccurrence(task: Task) {
  try {
    return nextOccurrence(task);
  } catch {
    warnInvalidRecord(`recurrence:${task.id}`, "invalid recurrence rule");
    return;
  }
}

function legacyRule(reminder: Reminder): string | undefined {
  if (reminder.mode !== "repeat") return;
  switch (reminder.recurringMode) {
    case "day":
      return "FREQ=DAILY";
    case "year":
      return "FREQ=YEARLY";
    case "week": {
      const dayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
      const days = (reminder.selectedDays || []).filter(
        (d) => d >= 0 && d <= 6
      );
      return `FREQ=WEEKLY${
        days.length ? `;BYDAY=${days.map((d) => dayCodes[d]).join(",")}` : ""
      }`;
    }
    case "month": {
      const days = (reminder.selectedDays || []).filter(
        (d) => d >= 1 && d <= 31
      );
      return `FREQ=MONTHLY${
        days.length ? `;BYMONTHDAY=${days.join(",")}` : ""
      }`;
    }
  }
}

function legacySchedule(
  seed: Date,
  recurrenceRule: string | undefined,
  migrationTime: Date
): { dueDate: string; dueTime: string; dueAt: number } | undefined {
  if (!Number.isFinite(seed.getTime())) return;
  if (!recurrenceRule)
    return {
      dueDate: calendarDate(seed),
      dueTime: calendarTime(seed),
      dueAt: seed.getTime()
    };
  try {
    const start = floatingInstant(calendarDate(seed), calendarTime(seed));
    const cutoff = new Date(
      Date.UTC(
        migrationTime.getFullYear(),
        migrationTime.getMonth(),
        migrationTime.getDate(),
        migrationTime.getHours(),
        migrationTime.getMinutes(),
        migrationTime.getSeconds(),
        migrationTime.getMilliseconds()
      )
    );
    const next = new RRule({
      ...RRule.parseString(recurrenceRule),
      dtstart: start
    }).after(cutoff, true);
    if (!next) return;
    const dueDate = next.toISOString().slice(0, 10);
    const dueTime = next.toISOString().slice(11, 16);
    const [year, month, day] = dueDate.split("-").map(Number);
    const [hour, minute] = dueTime.split(":").map(Number);
    return {
      dueDate,
      dueTime,
      dueAt: new Date(year, month - 1, day, hour, minute).getTime()
    };
  } catch {
    return;
  }
}

function parseRecord<T extends { id: string; schemaVersion: number }>(
  item: SettingItem | undefined,
  prefix: string
): T | undefined {
  if (!item || !item.key.startsWith(prefix)) return;
  if (typeof item.value !== "string") {
    warnInvalidRecord(item.key, "missing JSON value");
    return;
  }
  try {
    const value: unknown = JSON.parse(item.value);
    if (!value || typeof value !== "object") {
      warnInvalidRecord(item.key, "invalid record shape");
      return;
    }
    const record = value as T;
    if (record.schemaVersion !== VERSION) {
      warnInvalidRecord(item.key, "unsupported schema version");
      return;
    }
    if (
      item.key !== `${prefix}${record.id}` ||
      (prefix.endsWith("task:") && !isTaskRecord(record)) ||
      (prefix.endsWith("list:") && !isListRecord(record))
    ) {
      warnInvalidRecord(item.key, "invalid record shape");
      return;
    }
    return record;
  } catch {
    warnInvalidRecord(item.key, "invalid JSON");
    return;
  }
}

function warnInvalidRecord(recordKey: string, reason: string) {
  if (
    warnedRecordKeys.has(recordKey) ||
    warnedRecordKeys.size >= MAX_WARNED_RECORD_KEYS
  )
    return;
  warnedRecordKeys.add(recordKey);
  logger.warn("Skipping Task domain setting record", {
    key: recordKey,
    reason
  });
}

function isTaskRecord(record: unknown): record is Task {
  if (!record || typeof record !== "object") return false;
  const task = record as Task;
  return (
    typeof task.id === "string" &&
    !!task.id &&
    typeof task.title === "string" &&
    !!task.title.trim() &&
    (task.description === undefined || typeof task.description === "string") &&
    typeof task.listId === "string" &&
    !!task.listId &&
    typeof task.completed === "boolean" &&
    (task.completedWallDate === undefined ||
      isValidCalendarDate(task.completedWallDate)) &&
    (task.completedWallTime === undefined ||
      (typeof task.completedWallTime === "string" &&
        TIME.test(task.completedWallTime))) &&
    typeof task.flagged === "boolean" &&
    ["none", "low", "medium", "high"].includes(task.priority) &&
    Number.isFinite(task.createdAt) &&
    Number.isFinite(task.updatedAt) &&
    (!task.dueDate || isValidCalendarDate(task.dueDate)) &&
    (!task.dueTime ||
      (typeof task.dueTime === "string" && TIME.test(task.dueTime))) &&
    (task.reminderAt === undefined || Number.isFinite(task.reminderAt)) &&
    (task.reminderDate === undefined ||
      (typeof task.reminderDate === "string" &&
        isValidCalendarDate(task.reminderDate))) &&
    (task.reminderTime === undefined ||
      (typeof task.reminderTime === "string" &&
        TIME.test(task.reminderTime))) &&
    (task.urgent === undefined || typeof task.urgent === "boolean") &&
    (task.scheduleVersion === undefined ||
      (Number.isInteger(task.scheduleVersion) && task.scheduleVersion >= 2)) &&
    (task.recurrenceRule === undefined ||
      typeof task.recurrenceRule === "string")
  );
}

function isListRecord(record: unknown): record is TaskList {
  if (!record || typeof record !== "object") return false;
  const list = record as TaskList;
  return (
    typeof list.id === "string" &&
    !!list.id &&
    typeof list.name === "string" &&
    !!list.name.trim() &&
    Number.isFinite(list.sortOrder) &&
    Number.isFinite(list.createdAt) &&
    Number.isFinite(list.updatedAt) &&
    (list.symbol === undefined || typeof list.symbol === "string") &&
    (list.color === undefined || typeof list.color === "string")
  );
}

function compareTasks(a: Task, b: Task) {
  const aSchedule = taskReminderSchedule(a);
  const bSchedule = taskReminderSchedule(b);
  const aDate = aSchedule.date || "9999-12-31";
  const bDate = bSchedule.date || "9999-12-31";
  return (
    aDate.localeCompare(bDate) ||
    (aSchedule.time || "").localeCompare(bSchedule.time || "") ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}

/** A date-only Task becomes overdue after its calendar day ends. */
export function isTaskOverdue(task: Task, now = new Date()): boolean {
  const schedule = taskReminderSchedule(task);
  if (task.completed || !schedule.date) return false;
  const today = calendarDate(now);
  if (schedule.date < today) return true;
  if (schedule.date > today || !schedule.time) return false;
  const [year, month, day] = schedule.date.split("-").map(Number);
  const [hour, minute] = schedule.time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute).getTime() < now.getTime();
}

class TaskRecordStore {
  constructor(protected readonly db: Database) {}

  protected async save<T extends { id: string }>(
    kind: "task" | "list",
    value: T
  ) {
    const recordKey = key(kind, value.id);
    await this.db.settings.collection.upsert({
      id: settingId(recordKey),
      type: "settingitem",
      key: recordKey,
      value: JSON.stringify(value),
      localOnly: "localOnly" in value ? !!value.localOnly : undefined,
      dateCreated: "createdAt" in value ? Number(value.createdAt) : Date.now()
    } as SettingItem);
  }

  protected async delete(kind: "task" | "list", id: string) {
    await this.db.settings.collection.softDelete([settingId(key(kind, id))]);
  }

  protected getRecord<T extends { id: string; schemaVersion: number }>(
    kind: "task" | "list",
    id: string
  ): T | undefined {
    return parseRecord<T>(
      this.db.settings.collection.get(settingId(key(kind, id))),
      `${PREFIX}${kind}:`
    );
  }

  protected records<T extends { id: string; schemaVersion: number }>(
    kind: "task" | "list"
  ): T[] {
    const prefix = `${PREFIX}${kind}:`;
    return this.db.settings.collection.items().flatMap((item) => {
      const record = parseRecord<T>(item, prefix);
      return record ? [record] : [];
    });
  }
}

export class TaskLists extends TaskRecordStore {
  listSync(): TaskList[] {
    return this.records<TaskList>("list");
  }

  getSync(id: string): TaskList | undefined {
    const existing = this.getRecord<TaskList>("list", id);
    if (existing || id !== DEFAULT_LIST_ID) return existing;
    const recordKey = settingId(key("list", DEFAULT_LIST_ID));
    return this.db.settings.collection.records([recordKey])[recordKey]
      ? undefined
      : this.virtualDefault();
  }

  async list(): Promise<TaskList[]> {
    const result = this.records<TaskList>("list");
    if (!result.some((item) => item.id === DEFAULT_LIST_ID))
      result.push(await this.default());
    return result.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id)
    );
  }

  async default(): Promise<TaskList> {
    const existing = this.getRecord<TaskList>("list", DEFAULT_LIST_ID);
    if (existing) return existing;
    const recordKey = settingId(key("list", DEFAULT_LIST_ID));
    if (this.db.settings.collection.records([recordKey])[recordKey])
      throw new Error(
        "The default Task list has an unsupported schema version."
      );
    return this.virtualDefault();
  }

  private virtualDefault(): TaskList {
    return {
      id: DEFAULT_LIST_ID,
      name: strings.reminders(),
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
      schemaVersion: VERSION,
      symbol: DEFAULT_TASK_LIST_SYMBOL,
      color: DEFAULT_TASK_LIST_COLOR
    };
  }

  /** A read of Tasks never writes; actual mutations can materialize the list. */
  async ensureDefaultPersisted(): Promise<TaskList> {
    const value = await this.default();
    if (!this.getRecord<TaskList>("list", DEFAULT_LIST_ID))
      await this.save("list", {
        ...value,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    return this.getRecord<TaskList>("list", DEFAULT_LIST_ID)!;
  }

  async create(input: TaskListInput | string): Promise<TaskList> {
    const data = typeof input === "string" ? { name: input } : input;
    const name = data.name.trim();
    if (!name) throw new Error("Task list name is required.");
    if (data.symbol && !isTaskListSymbol(data.symbol))
      throw new Error("Invalid Task list symbol.");
    if (data.color && !validListColor(data.color))
      throw new Error("Invalid Task list color.");
    const now = Date.now();
    const value: TaskList = {
      id: getId(),
      name,
      sortOrder: data.sortOrder ?? now,
      createdAt: now,
      updatedAt: now,
      schemaVersion: VERSION,
      color: data.color ?? DEFAULT_TASK_LIST_COLOR,
      symbol: data.symbol ?? DEFAULT_TASK_LIST_SYMBOL
    };
    await this.save("list", value);
    return value;
  }

  async update(id: string, patch: Partial<TaskListInput>): Promise<TaskList> {
    const old = this.getSync(id);
    if (!old) throw new Error("Task list not found.");
    const name = patch.name === undefined ? old.name : patch.name.trim();
    if (!name) throw new Error("Task list name is required.");
    if (patch.symbol !== undefined && !isTaskListSymbol(patch.symbol))
      throw new Error("Invalid Task list symbol.");
    if (patch.color !== undefined && !validListColor(patch.color))
      throw new Error("Invalid Task list color.");
    const value: TaskList = { ...old, ...patch, name, updatedAt: Date.now() };
    await this.save("list", value);
    return value;
  }

  async remove(id: string): Promise<void> {
    if (id === DEFAULT_LIST_ID)
      throw new Error("The default Task list cannot be deleted.");
    if (!this.getRecord<TaskList>("list", id)) return;
    const fallback = await this.default();
    for (const task of this.db.tasks
      .listSync()
      .filter((item) => item.listId === id))
      await this.db.tasks.update(task.id, { listId: fallback.id });
    await this.delete("list", id);
  }
}

export class Tasks extends TaskRecordStore {
  private readonly maintenanceMutex = new Mutex();
  private readonly createMutex = new Mutex();
  /** Serializes local writes to a Task with guarded widget completions. */
  private readonly mutationMutex = new Mutex();
  /** Includes completed history. */
  async list(): Promise<Task[]> {
    return this.listSync();
  }
  listSync(): Task[] {
    return this.records<Task>("task").sort(compareTasks);
  }

  async get(id: string): Promise<Task | undefined> {
    return this.getRecord<Task>("task", id);
  }

  private recordExists(id: string) {
    const settingKey = settingId(key("task", id));
    return !!this.db.settings.collection.records([settingKey])[settingKey];
  }

  /** Includes Task tombstones so deleting a converted Task cannot revive its source Reminder. */
  isMigratedReminder(reminderId: string): boolean {
    return this.recordExists(makeId(`${PREFIX}legacy:${reminderId}`));
  }

  async create(input: TaskInput): Promise<Task> {
    const title = input.title.trim();
    if (!title) throw new Error("Task title is required.");
    const listId = input.listId || (await this.db.taskLists.default()).id;
    if (!this.db.taskLists.getSync(listId))
      throw new Error("Task list not found.");
    const now = Date.now();
    const id = input.id || getId();
    const calendarWrite =
      hasOwn(input, "reminderDate") || hasOwn(input, "reminderTime");
    const reminderDate = calendarWrite ? input.reminderDate : undefined;
    const reminderTime =
      calendarWrite && reminderDate ? input.reminderTime : undefined;
    const dueDate = calendarWrite
      ? input.dueDate ?? reminderDate
      : input.dueDate;
    const dueTime = calendarWrite
      ? input.dueDate !== undefined
        ? input.dueTime
        : reminderTime
      : input.dueTime;
    const reminderAt = calendarWrite
      ? taskReminderTimestamp({
          reminderDate,
          reminderTime,
          scheduleVersion: 2
        })
      : input.reminderAt;
    const value: Task = {
      id,
      title,
      description: input.description,
      listId,
      completed: !!input.completed,
      completedAt: input.completed ? input.completedAt || now : undefined,
      completedWallDate: input.completed ? input.completedWallDate : undefined,
      completedWallTime: input.completed ? input.completedWallTime : undefined,
      dueDate,
      dueTime,
      reminderAt,
      reminderDate,
      reminderTime,
      urgent: input.urgent || undefined,
      scheduleVersion: calendarWrite ? 2 : input.scheduleVersion,
      recurrenceRule: input.recurrenceRule,
      priority: input.priority || "none",
      flagged: !!input.flagged,
      createdAt: now,
      updatedAt: now,
      schemaVersion: VERSION,
      seriesId: input.recurrenceRule ? input.seriesId || id : undefined,
      seriesStartDate: input.recurrenceRule
        ? input.seriesStartDate || dueDate
        : undefined,
      seriesStartTime: input.recurrenceRule
        ? input.seriesStartTime || dueTime
        : undefined,
      occurrenceKey: input.occurrenceKey,
      legacyReminderId: input.legacyReminderId,
      reminderLeadMinutes:
        input.reminderLeadMinutes ??
        reminderLeadMinutes({ dueDate, dueTime, reminderAt }),
      localOnly: input.localOnly
    };
    validateTask(value);
    return this.createMutex.runExclusive(async () => {
      if (this.recordExists(id))
        throw new Error("A Task with this ID already exists or was deleted.");
      if (listId === DEFAULT_LIST_ID)
        await this.db.taskLists.ensureDefaultPersisted();
      await this.save("task", value);
      return value;
    });
  }

  async update(id: string, patch: Partial<TaskInput>): Promise<Task> {
    return this.mutationMutex.runExclusive(() => this.updateUnsafe(id, patch));
  }

  private async updateUnsafe(
    id: string,
    patch: Partial<TaskInput>
  ): Promise<Task> {
    const old = await this.get(id);
    if (!old) throw new Error("Task not found.");
    if (patch.listId && !this.db.taskLists.getSync(patch.listId))
      throw new Error("Task list not found.");
    const value: Task = {
      ...old,
      ...patch,
      id,
      schemaVersion: VERSION,
      createdAt: old.createdAt,
      updatedAt: Math.max(Date.now(), old.updatedAt + 1)
    };
    const calendarWrite =
      hasOwn(patch, "reminderDate") || hasOwn(patch, "reminderTime");
    if (calendarWrite) {
      if (!value.reminderDate) value.reminderTime = undefined;
      const previousSchedule = taskReminderSchedule(old);
      const dueMirrorsReminder =
        !old.dueDate ||
        (old.dueDate === previousSchedule.date &&
          old.dueTime === previousSchedule.time);
      if (dueMirrorsReminder) {
        value.dueDate = value.reminderDate;
        value.dueTime = value.reminderTime;
      }
      value.reminderAt = taskReminderTimestamp({
        reminderDate: value.reminderDate,
        reminderTime: value.reminderTime,
        scheduleVersion: 2
      });
      value.scheduleVersion = 2;
    } else if (
      old.scheduleVersion === 2 &&
      (hasOwn(patch, "dueDate") ||
        hasOwn(patch, "dueTime") ||
        hasOwn(patch, "reminderAt"))
    ) {
      // Older fork clients can still write the compatibility fields.
      if (hasOwn(patch, "reminderAt")) {
        const instant =
          value.reminderAt === undefined
            ? undefined
            : new Date(value.reminderAt);
        value.reminderDate = instant ? calendarDate(instant) : undefined;
        value.reminderTime = instant ? calendarTime(instant) : undefined;
      } else if (
        old.dueDate === old.reminderDate &&
        old.dueTime === old.reminderTime
      ) {
        value.reminderDate = value.dueDate;
        value.reminderTime = value.dueTime;
      }
    }
    value.title = value.title.trim();
    if (
      hasOwn(patch, "recurrenceRule") &&
      patch.recurrenceRule !== old.recurrenceRule
    ) {
      value.seriesId = value.recurrenceRule
        ? old.seriesId || old.id
        : undefined;
      value.seriesStartDate = value.recurrenceRule ? value.dueDate : undefined;
      value.seriesStartTime = value.recurrenceRule ? value.dueTime : undefined;
    } else if (
      value.recurrenceRule &&
      (hasOwn(patch, "dueDate") || hasOwn(patch, "dueTime") || calendarWrite)
    ) {
      // Changing one occurrence does not move the series schedule.
      value.seriesStartDate = old.seriesStartDate || old.dueDate;
      value.seriesStartTime = old.seriesStartTime || old.dueTime;
    }
    if (!value.completed) {
      value.completedAt = undefined;
      value.completedWallDate = undefined;
      value.completedWallTime = undefined;
    }
    if (
      hasOwn(patch, "dueDate") ||
      hasOwn(patch, "dueTime") ||
      hasOwn(patch, "reminderAt") ||
      calendarWrite
    )
      value.reminderLeadMinutes = reminderLeadMinutes(value);
    validateTask(value);
    if (patch.listId === DEFAULT_LIST_ID)
      await this.db.taskLists.ensureDefaultPersisted();
    await this.save("task", value);
    return value;
  }

  async complete(id: string): Promise<Task> {
    return this.mutationMutex.runExclusive(() => this.completeUnsafe(id));
  }

  /** Complete only the occurrence and revision displayed by a widget snapshot.
   * An already completed occurrence remains a successful, repairable retry. */
  async completeIfUnchanged(
    id: string,
    expectedUpdatedAt: number
  ): Promise<Task | undefined> {
    return this.mutationMutex.runExclusive(async () => {
      const current = await this.get(id);
      if (
        !current ||
        (!current.completed && current.updatedAt !== expectedUpdatedAt)
      )
        return;
      return this.completeUnsafe(id);
    });
  }

  private async completeUnsafe(id: string): Promise<Task> {
    const old = await this.get(id);
    if (!old) throw new Error("Task not found.");
    const completedAt = Date.now();
    const wallTime = new Date(completedAt);
    const completed = old.completed
      ? old
      : await this.updateUnsafe(id, {
          completed: true,
          completedAt,
          completedWallDate: calendarDate(wallTime),
          completedWallTime: `${String(wallTime.getHours()).padStart(
            2,
            "0"
          )}:${String(wallTime.getMinutes()).padStart(2, "0")}`
        });
    await this.ensureNextOccurrence(completed);
    return completed;
  }

  private async ensureNextOccurrence(completed: Task): Promise<void> {
    const next = safeNextOccurrence(completed);
    if (next) {
      const seriesId = completed.seriesId || completed.id;
      const occurrenceKey = `${next.date}T${next.time || "date"}`;
      const nextId = makeId(`${PREFIX}occurrence:${seriesId}:${occurrenceKey}`);
      if (!this.recordExists(nextId)) {
        const reminderAt = nextReminderAt(completed, next);
        const reminderInstant =
          reminderAt === undefined ? undefined : new Date(reminderAt);
        const reminderDate = completed.reminderDate
          ? reminderInstant
            ? calendarDate(reminderInstant)
            : next.date
          : undefined;
        const reminderTime = completed.reminderDate
          ? completed.reminderTime === undefined
            ? undefined
            : reminderInstant
            ? calendarTime(reminderInstant)
            : next.time
          : undefined;
        try {
          await this.create({
            ...completed,
            id: nextId,
            completed: false,
            completedAt: undefined,
            completedWallDate: undefined,
            completedWallTime: undefined,
            dueDate: next.date,
            dueTime: next.time,
            reminderAt,
            ...(completed.scheduleVersion === 2
              ? { reminderDate, reminderTime }
              : {}),
            seriesId,
            seriesStartDate: completed.seriesStartDate || completed.dueDate,
            seriesStartTime: completed.seriesStartTime || completed.dueTime,
            occurrenceKey,
            reminderLeadMinutes: completed.reminderLeadMinutes
          });
        } catch (error) {
          // Another completion may have created the same stable occurrence.
          if (!this.recordExists(nextId)) throw error;
        }
      }
    }
  }

  async reconcileRecurrence(): Promise<void> {
    await this.maintenanceMutex.runExclusive(() =>
      this.reconcileRecurrenceUnsafe()
    );
  }

  private async reconcileRecurrenceUnsafe(): Promise<void> {
    for (const task of this.listSync()) {
      if (
        !task.completed ||
        !task.recurrenceRule ||
        !this.db.taskLists.getSync(task.listId)
      )
        continue;
      await this.ensureNextOccurrence(task);
    }
  }

  async uncomplete(id: string): Promise<Task> {
    return this.mutationMutex.runExclusive(() => this.uncompleteUnsafe(id));
  }

  private async uncompleteUnsafe(id: string): Promise<Task> {
    const old = await this.get(id);
    if (!old) throw new Error("Task not found.");
    if (!old.completed) return old;
    if (old.recurrenceRule && old.dueDate) {
      const next = safeNextOccurrence(old);
      if (next) {
        const occurrenceKey = `${next.date}T${next.time || "date"}`;
        const nextId = makeId(
          `${PREFIX}occurrence:${old.seriesId || old.id}:${occurrenceKey}`
        );
        if (this.recordExists(nextId))
          throw new Error(
            "Cannot reopen a recurring Task while its next occurrence exists."
          );
      }
    }
    return this.updateUnsafe(id, { completed: false, completedAt: undefined });
  }

  async remove(id: string): Promise<void> {
    await this.mutationMutex.runExclusive(async () => {
      if (!this.getRecord<Task>("task", id)) return;
      await this.delete("task", id);
    });
  }

  async smartList(kind: TaskSmartList, date = new Date()): Promise<Task[]> {
    const today = calendarDate(date);
    const tasks = this.listSync();
    switch (kind) {
      case "all":
        return tasks.filter((task) => !task.completed);
      case "flagged":
        return tasks.filter((task) => !task.completed && task.flagged);
      case "completed":
        return tasks
          .filter((task) => task.completed)
          .sort(
            (a, b) =>
              (b.completedAt || 0) - (a.completedAt || 0) ||
              a.id.localeCompare(b.id)
          );
      case "today":
        return tasks.filter((task) => {
          const schedule = taskReminderSchedule(task);
          return !task.completed && !!schedule.date && schedule.date <= today;
        });
      case "scheduled":
        return tasks.filter((task) => {
          const schedule = taskReminderSchedule(task);
          return !task.completed && !!schedule.date && schedule.date >= today;
        });
    }
  }

  /** Runs at startup and after sync. Older clients retain their source Reminder. */
  async migrateLegacyReminders(): Promise<void> {
    await this.maintenanceMutex.runExclusive(() =>
      this.migrateLegacyRemindersUnsafe()
    );
  }

  async repairListReferences(): Promise<void> {
    await this.maintenanceMutex.runExclusive(() =>
      this.repairListReferencesUnsafe()
    );
  }

  async reconcile(): Promise<void> {
    await this.maintenanceMutex.runExclusive(async () => {
      await this.migrateLegacyRemindersUnsafe();
      await this.repairListReferencesUnsafe();
      await this.reconcileRecurrenceUnsafe();
    });
  }

  private async repairListReferencesUnsafe(): Promise<void> {
    const tasks = this.listSync();
    if (!tasks.length) return;
    const lists = new Set([
      DEFAULT_LIST_ID,
      ...this.db.taskLists.listSync().map((list) => list.id)
    ]);
    if (tasks.every((task) => lists.has(task.listId))) return;
    const fallback = await this.db.taskLists.default();
    for (const task of tasks) {
      if (lists.has(task.listId)) continue;
      await this.update(task.id, { listId: fallback.id });
    }
  }

  private async migrateLegacyRemindersUnsafe(): Promise<void> {
    let listId: string | undefined;
    const migrationTime = new Date(Date.now());
    for await (const reminder of this.db.reminders.all.iterate()) {
      if (!reminder.id || !reminder.title || !Number.isFinite(reminder.date))
        continue;
      const recurrenceRule = legacyRule(reminder);
      if (
        reminder.mode !== "once" &&
        (reminder.mode !== "repeat" || !recurrenceRule)
      ) {
        warnInvalidRecord(
          `legacy:${reminder.id}`,
          "unsupported legacy recurrence mode"
        );
        continue;
      }
      const id = makeId(`${PREFIX}legacy:${reminder.id}`);
      if (!this.recordExists(id)) {
        const seed = new Date(reminder.date);
        const schedule = legacySchedule(seed, recurrenceRule, migrationTime);
        if (!schedule) {
          warnInvalidRecord(`legacy:${reminder.id}`, "invalid legacy schedule");
          continue;
        }
        listId ||= (await this.db.taskLists.default()).id;
        const snooze = reminder.snoozeUntil;
        const validSnooze = snooze !== undefined && Number.isFinite(snooze);
        await this.create({
          id,
          title: reminder.title,
          description: reminder.description ?? undefined,
          listId,
          dueDate: schedule.dueDate,
          dueTime: schedule.dueTime,
          reminderAt: reminder.disabled
            ? undefined
            : validSnooze &&
              (!recurrenceRule || snooze > migrationTime.getTime())
            ? snooze
            : schedule.dueAt,
          recurrenceRule,
          seriesStartDate: recurrenceRule ? calendarDate(seed) : undefined,
          seriesStartTime: recurrenceRule ? calendarTime(seed) : undefined,
          legacyReminderId: reminder.id,
          localOnly: reminder.localOnly
        });
      }
      // The source stays active for clients that do not understand Tasks.
      // Updated clients suppress it locally via isMigratedReminder().
    }
  }
}

function validateTask(task: Task) {
  if (!task.title) throw new Error("Task title is required.");
  if (task.description !== undefined && typeof task.description !== "string")
    throw new Error("Invalid Task description.");
  if (task.completedWallDate && !isValidCalendarDate(task.completedWallDate))
    throw new Error("Invalid Task completion date.");
  if (task.completedWallTime && !TIME.test(task.completedWallTime))
    throw new Error("Invalid Task completion time.");
  if (task.dueDate && !isValidCalendarDate(task.dueDate))
    throw new Error("Invalid Task due date.");
  if (task.dueTime && (!task.dueDate || !TIME.test(task.dueTime)))
    throw new Error("Invalid Task due time.");
  if (task.reminderAt !== undefined && !Number.isFinite(task.reminderAt))
    throw new Error("Invalid Task reminder time.");
  if (task.reminderDate && !isValidCalendarDate(task.reminderDate))
    throw new Error("Invalid Task reminder date.");
  if (
    task.reminderTime &&
    (!task.reminderDate || !TIME.test(task.reminderTime))
  )
    throw new Error("Invalid Task reminder time.");
  if (
    task.urgent &&
    (!taskReminderSchedule(task).time || !taskReminderSchedule(task).date)
  )
    throw new Error("An urgent Task requires a reminder date and time.");
  if (task.recurrenceRule) {
    if (!task.dueDate) throw new Error("A recurring Task requires a due date.");
    RRule.parseString(task.recurrenceRule.replace(/^RRULE:/i, "").trim());
  }
  if (!["none", "low", "medium", "high"].includes(task.priority))
    throw new Error("Invalid Task priority.");
}
