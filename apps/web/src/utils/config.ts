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

import { tryParse } from "./parse";

function withoutUpstreamCorsProxy<T>(key: string, value: T): T {
  if (key !== "corsProxy" || typeof value !== "string") return value;
  try {
    if (new URL(value).hostname.toLowerCase() === "cors.notesnook.com") {
      return "" as T;
    }
  } catch {
    // The settings UI validates newly entered proxy URLs.
  }
  return value;
}

function set<T>(key: string, value: T) {
  const safeValue = withoutUpstreamCorsProxy(key, value);
  window.localStorage.setItem(key, JSON.stringify(safeValue));
  return safeValue;
}

function get<T>(key: string, def?: T): T {
  const value = window.localStorage.getItem(key);
  if (!value && def !== undefined) return def;
  const parsed = value ? tryParse(value) : def;
  // The former Notesnook CORS proxy was saved as a default in old profiles.
  // Do not silently send VeyraN editor URLs through that upstream service.
  return withoutUpstreamCorsProxy(key, parsed);
}

function remove(key: string) {
  window.localStorage.removeItem(key);
}

function clear() {
  window.localStorage.clear();
}

function all<T>(): Record<string, T> {
  const data: Record<string, T> = {};
  for (let i = 0; i < window.localStorage.length; ++i) {
    const key = window.localStorage.key(i);
    if (!key) continue;
    data[key] = get(key);
  }
  return data;
}

function has(predicate: (key: string) => boolean) {
  for (let i = 0; i < window.localStorage.length; ++i) {
    const key = window.localStorage.key(i);
    if (!key) continue;
    if (predicate(key)) return true;
  }
  return false;
}

function logout() {
  const toKeep = [
    "editorConfig",
    "backupStorageLocation",
    "serverUrls",
    "corsProxy",
    "theme:light",
    "theme:dark",
    "colorScheme",
    "followSystemTheme",
    "doubleSpacedLines"
  ];
  const vals = {} as Record<string, any>;

  for (const keep of toKeep) {
    const val = get(keep);
    if (val !== undefined) vals[keep] = val;
  }

  clear();

  for (const key in vals) {
    set(key, vals[key]);
  }
}

const Config = { set, get, clear, all, has, remove, logout };
export default Config;
