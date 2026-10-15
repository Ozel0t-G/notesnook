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

import { Icons } from "@notesnook/editor/dist/cjs/toolbar/icons";
import { ToolbarGroupDefinition } from "@notesnook/editor";
import {
  getAllTools,
  getDefaultPresets
} from "@notesnook/editor/dist/cjs/toolbar/tool-definitions";
import { ToolId } from "@notesnook/editor";
import { strings } from "@notesnook/intl";
import { Platform } from "react-native";
import { isMacCatalyst } from "../../../utils/constants";

/**
 * The native configure-toolbar UI runs in its own bundle, which ships and
 * initializes its own copy of `@notesnook/intl` (see `apps/mobile/globals.js`).
 * The editor's CJS build carries a separate, never-activated copy, so the host
 * collection is passed in explicitly: only titles come from the host locale,
 * ids/icons/flags/order are identical to every other consumer.
 */
export const tools = () => getAllTools(strings);
export const presets: { [name: string]: ToolbarGroupDefinition[] } = {
  default: getDefaultPresets().default as any,
  minimal: getDefaultPresets().minimal as any,
  custom: []
};

export function findToolById(id: keyof ReturnType<typeof tools>): {
  title: string;
  icon: string;
} {
  return tools()[id];
}

export function getToolIcon(id: ToolId, color: string) {
  const icon = Icons[id as keyof typeof Icons];

  // `id` is a `ToolDefinition.icon` alias. `Icons.none` is the empty string and
  // an unknown alias resolves to `undefined`; both must yield `null` so callers
  // never render an SVG with `d="undefined"`.
  return icon
    ? `<svg width="20" height="20"  >
  <path d="${icon}" fill="${color}" />
</svg>`
    : null;
}

export function getUngroupedTools(
  toolDefinition: (string | string[])[][]
): string[] {
  const allTools = tools();
  const keys = Object.keys(allTools);

  // Collect the EXACT tool ids out of the stored groups and their nested
  // "more" subgroups. Matching with `JSON.stringify(...).includes(key)` was a
  // substring test, so a stored `codeRemove` also (wrongly) counted as `code`.
  const grouped = new Set<string>();
  for (const group of toolDefinition) {
    for (const tool of group) {
      if (Array.isArray(tool)) {
        for (const nested of tool) grouped.add(nested);
      } else {
        grouped.add(tool);
      }
    }
  }

  // The Apple host source is the SAME one `state.ts` resolves the presets with
  // (`Platform.OS` + `isMacCatalyst`), read per call - never cached at module
  // load - so the picker and the rendered toolbar agree on which tools exist on
  // this host. `Platform.OS === "ios"` already covers Mac Catalyst (see
  // `isMacCatalyst()` in `utils/constants`), but both flags are kept explicit.
  const appleHost = isMacCatalyst() || Platform.OS === "ios";

  const ungrouped: string[] = [];
  for (const key of keys) {
    const definition = allTools[key as ToolId] as { conditional?: boolean };
    // Every conditional tool is a context tool that is never offered as a
    // generic toolbar entry - except `macFormat`, the Apple-only "Aa"
    // formatting entry of the Mac Catalyst bar and the compact iOS preset.
    if (definition.conditional && key !== "macFormat") continue;
    if (key === "macFormat" && !appleHost) continue;
    if (!grouped.has(key)) ungrouped.push(key);
  }

  return ungrouped;
}
