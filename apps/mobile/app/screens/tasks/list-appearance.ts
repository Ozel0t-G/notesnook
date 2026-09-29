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

import { TASK_LIST_SYMBOLS } from "@notesnook/core";

const SYMBOLS = TASK_LIST_SYMBOLS;

export const TASK_LIST_COLORS = [
  ["red", "#FF453A"],
  ["orange", "#FF9F0A"],
  ["yellow", "#FFD60A"],
  ["green", "#30D158"],
  ["mint", "#66D4CF"],
  ["teal", "#40C8E0"],
  ["cyan", "#64D2FF"],
  ["blue", "#0A84FF"],
  ["indigo", "#5E5CE6"],
  ["purple", "#BF5AF2"],
  ["pink", "#FF375F"],
  ["brown", "#AC8E68"],
  ["gray", "#8E8E93"]
] as const;

export function taskListColor(value?: string) {
  return (
    TASK_LIST_COLORS.find(([name]) => name === value)?.[1] ||
    (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value || "")
      ? value || "#0A84FF"
      : "#0A84FF")
  );
}

export function taskListSymbol(value?: string) {
  return value && SYMBOLS.includes(value as (typeof SYMBOLS)[number])
    ? value
    : "list.bullet";
}

