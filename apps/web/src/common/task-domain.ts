/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2026 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

import { db } from "./db";
import {
  isTaskOverdue,
  type Task,
  type TaskInput,
  type TaskList,
  type TaskPriority,
  type TaskSmartList
} from "@notesnook/core";

export type SmartTaskList = TaskSmartList;
export type TaskRecord = Task;
export type TaskListRecord = TaskList;
export type { TaskInput, TaskPriority };

export const taskDomain = db;
export const taskIsOverdue = isTaskOverdue;

export function compareTasks(a: TaskRecord, b: TaskRecord): number {
  const overdue = Number(taskIsOverdue(b)) - Number(taskIsOverdue(a));
  if (overdue) return overdue;
  const due = (a.dueDate || "9999-12-31").localeCompare(
    b.dueDate || "9999-12-31"
  );
  if (due) return due;
  const time = (a.dueTime || "23:59").localeCompare(b.dueTime || "23:59");
  if (time) return time;
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}
