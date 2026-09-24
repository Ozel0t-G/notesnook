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

import Database from "../api/index.js";
import { SettingItem } from "../types.js";
import { makeId } from "../utils/id.js";
import { TaskSmartList } from "./tasks.js";

const KEY = "appleTasks:v1:favorites";
const ID = makeId(KEY);
const SMART_LISTS: TaskSmartList[] = [
  "today",
  "scheduled",
  "all",
  "flagged",
  "completed"
];

export type TaskFavorite = `smart:${TaskSmartList}` | `list:${string}`;
export const DEFAULT_TASK_FAVORITES: TaskFavorite[] = SMART_LISTS.map(
  (id) => `smart:${id}` as const
);

function validFavorite(value: unknown): value is TaskFavorite {
  if (typeof value !== "string") return false;
  if (value.startsWith("smart:"))
    return SMART_LISTS.includes(value.slice(6) as TaskSmartList);
  return /^list:[a-f0-9]{24}$/i.test(value);
}

function validFavorites(value: unknown): value is TaskFavorite[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(validFavorite) &&
    new Set(value).size === value.length
  );
}

/** Synced, account-scoped ordering. An explicit empty array means no favorites. */
export class TaskFavorites {
  constructor(private readonly db: Database) {}

  listSync(): TaskFavorite[] {
    const item = this.db.settings.collection.get(ID);
    if (!item) return [...DEFAULT_TASK_FAVORITES];
    if ((item.key as string) !== KEY || typeof item.value !== "string")
      return [...DEFAULT_TASK_FAVORITES];
    try {
      const value: unknown = JSON.parse(item.value);
      if (
        value &&
        typeof value === "object" &&
        (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
        validFavorites((value as { items?: unknown }).items)
      )
        return [...(value as { items: TaskFavorite[] }).items];
    } catch {
      // A damaged or future-version preference must not hide Task navigation.
    }
    return [...DEFAULT_TASK_FAVORITES];
  }

  async list(): Promise<TaskFavorite[]> {
    return this.listSync();
  }

  async set(items: TaskFavorite[]): Promise<void> {
    if (!validFavorites(items)) throw new Error("Invalid Task favorites.");
    const recordKey: string = KEY;
    await this.db.settings.collection.upsert({
      id: ID,
      type: "settingitem",
      key: recordKey,
      value: JSON.stringify({ schemaVersion: 1, items }),
      dateCreated: Date.now()
    } as SettingItem);
  }
}
