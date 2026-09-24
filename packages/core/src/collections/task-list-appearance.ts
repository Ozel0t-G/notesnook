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

/** Stable SF Symbol identifiers shared by Task List editors on Apple platforms. */
export const TASK_LIST_SYMBOLS = [
  "list.bullet",
  "briefcase",
  "house",
  "cart",
  "graduationcap",
  "heart",
  "car",
  "airplane",
  "gamecontroller",
  "fork.knife",
  "pills",
  "dumbbell",
  "book",
  "laptopcomputer",
  "hammer",
  "wrench",
  "person",
  "person.2",
  "pawprint",
  "gift",
  "music.note",
  "camera",
  "leaf",
  "star",
  "bell",
  "paintbrush",
  "figure.walk",
  "creditcard",
  "folder",
  "checklist"
] as const;

/** Semantic palette keys are stable across theme and platform changes. */
export const TASK_LIST_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "mint",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "purple",
  "pink",
  "brown",
  "gray"
] as const;

export const DEFAULT_TASK_LIST_SYMBOL = "list.bullet";
export const DEFAULT_TASK_LIST_COLOR = "blue";

export function isTaskListSymbol(value: string): boolean {
  return (TASK_LIST_SYMBOLS as readonly string[]).includes(value);
}

export function isTaskListColor(value: string): boolean {
  return (TASK_LIST_COLORS as readonly string[]).includes(value);
}
