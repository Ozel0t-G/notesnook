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

import { ToolbarDefinition, ToolDefinition } from "./types.js";
import { ToolId } from "./tools/index.js";
import { strings } from "@notesnook/intl";

/**
 * The localized label collection the toolbar definitions are built from.
 *
 * It is the exact shape of `@notesnook/intl`'s `strings`, so passing the whole
 * collection is the only supported way to inject one — no partial fakes and no
 * invented labels.
 */
export type ToolbarStrings = typeof strings;

const tools = (
  label: ToolbarStrings = strings
): Record<ToolId, ToolDefinition> => ({
  undo: { icon: "undo", title: label.undo() },
  redo: { icon: "redo", title: label.redo() },
  closeKeyboard: { icon: "closeKeyboard", title: label.done() },
  none: {
    icon: "none",
    title: ""
  },
  bold: {
    icon: "bold",
    title: label.bold()
  },
  italic: {
    icon: "italic",
    title: label.italic()
  },
  underline: {
    icon: "underline",
    title: label.underline()
  },
  strikethrough: {
    icon: "strikethrough",
    title: label.strikethrough()
  },
  addInternalLink: {
    icon: "noteLink",
    title: label.noteLink()
  },
  addLink: {
    icon: "link",
    title: label.link()
  },
  editLink: {
    icon: "linkEdit",
    title: label.linkEdit(),
    conditional: true
  },
  removeLink: {
    icon: "linkRemove",
    title: label.linkRemove(),
    conditional: true
  },
  openLink: {
    icon: "openLink",
    title: label.openLink(),
    conditional: true
  },
  copyLink: {
    icon: "copyLink",
    title: label.copyLink(),
    conditional: true
  },
  linkSettings: {
    icon: "linkSettings",
    title: label.linkSettings(),
    conditional: true
  },
  code: {
    icon: "code",
    title: label.code()
  },
  codeRemove: {
    icon: "codeRemove",
    title: label.codeRemove(),
    conditional: true
  },
  clearformatting: {
    icon: "formatClear",
    title: label.formatClear()
  },
  subscript: {
    icon: "subscript",
    title: label.subscript()
  },
  superscript: {
    icon: "superscript",
    title: label.superscript()
  },
  insertBlock: {
    icon: "plus",
    title: label.insert(),
    conditional: true
  },
  bulletList: {
    icon: "bulletList",
    title: label.bulletList()
  },
  numberedList: {
    icon: "numberedList",
    title: label.numberedList()
  },
  checkList: {
    icon: "checklist",
    title: label.checklist()
  },
  fontFamily: {
    icon: "fontFamily",
    title: label.fontFamily()
  },
  fontSize: {
    icon: "fontSize",
    title: label.fontSize()
  },
  headings: {
    icon: "heading",
    title: label.headings()
  },
  macFormat: {
    icon: "heading",
    title: label.formatting(),
    // Apple-only tool (Mac Catalyst + the compact iOS preset). It stays
    // `conditional` so the toolbar customizers skip it outside Apple: the web
    // customizer never offers it, and the native customizer offers it on every
    // Apple host (Mac Catalyst and iPhone/iPad alike).
    conditional: true
  },
  alignment: {
    icon: "alignCenter",
    title: label.alignment()
  },
  textDirection: {
    icon: "ltr",
    title: label.ltr()
  },
  highlight: {
    icon: "highlight",
    title: label.highlight()
  },
  textColor: {
    icon: "textColor",
    title: label.textColor()
  },
  math: {
    icon: "math",
    title: label.mathInline()
  },

  tableSettings: {
    icon: "tableSettings",
    title: label.tableSettings(),
    conditional: true
  },
  columnProperties: {
    icon: "columnProperties",
    title: label.columnProperties(),
    conditional: true
  },
  rowProperties: {
    icon: "rowProperties",
    title: label.rowProperties(),
    conditional: true
  },
  cellProperties: {
    icon: "cellProperties",
    title: label.cellProperties(),
    conditional: true
  },
  insertColumnLeft: {
    icon: "insertColumnLeft",
    title: label.insertColumnLeft(),
    conditional: true
  },
  insertColumnRight: {
    icon: "insertColumnRight",
    title: label.insertColumnRight(),
    conditional: true
  },
  moveColumnLeft: {
    icon: "moveColumnLeft",
    title: label.moveColumnLeft(),
    conditional: true
  },
  moveColumnRight: {
    icon: "moveColumnRight",
    title: label.moveColumnRight(),
    conditional: true
  },
  deleteColumn: {
    icon: "deleteColumn",
    title: label.deleteColumn(),
    conditional: true
  },
  splitCells: {
    icon: "splitCells",
    title: label.splitCells(),
    conditional: true
  },
  mergeCells: {
    icon: "mergeCells",
    title: label.mergeCells(),
    conditional: true
  },
  insertRowAbove: {
    icon: "insertRowAbove",
    title: label.insertRowAbove(),
    conditional: true
  },
  insertRowBelow: {
    icon: "insertRowBelow",
    title: label.insertRowBelow(),
    conditional: true
  },
  moveRowUp: {
    icon: "moveRowUp",
    title: label.moveRowUp(),
    conditional: true
  },
  moveRowDown: {
    icon: "moveRowDown",
    title: label.moveRowDown(),
    conditional: true
  },
  deleteRow: {
    icon: "deleteRow",
    title: label.deleteRow(),
    conditional: true
  },
  deleteTable: {
    icon: "deleteTable",
    title: label.deleteTable(),
    conditional: true
  },
  cellBackgroundColor: {
    icon: "backgroundColor",
    title: label.cellBackgroundColor(),
    conditional: true
  },
  cellBorderColor: {
    icon: "cellBorderColor",
    title: label.cellBorderColor(),
    conditional: true
  },
  cellTextColor: {
    icon: "textColor",
    title: label.textColor(),
    conditional: true
  },
  cellBorderWidth: {
    icon: "none",
    title: label.none(),
    conditional: true
  },
  imageSettings: {
    icon: "imageSettings",
    title: label.imageSettings(),
    conditional: true
  },
  imageAlignCenter: {
    icon: "alignCenter",
    title: label.alignCenter(),
    conditional: true
  },
  imageAlignLeft: {
    icon: "alignLeft",
    title: label.alignLeft(),
    conditional: true
  },
  imageAlignRight: {
    icon: "alignRight",
    title: label.alignRight(),
    conditional: true
  },
  editHandwriting: {
    icon: "editHandwriting",
    title: label.editHandwriting(),
    conditional: true
  },
  imageProperties: {
    icon: "more",
    title: label.imageProperties(),
    conditional: true
  },
  previewAttachment: {
    icon: "previewAttachment",
    title: label.previewAttachment(),
    conditional: true
  },
  attachmentSettings: {
    icon: "attachmentSettings",
    title: label.attachmentSettings(),
    conditional: true
  },
  downloadAttachment: {
    icon: "download",
    title: label.downloadAttachment(),
    conditional: true
  },
  removeAttachment: {
    icon: "delete",
    title: label.delete(),
    conditional: true
  },
  embedSettings: {
    icon: "embedSettings",
    title: label.embedSettings(),
    conditional: true
  },
  embedAlignCenter: {
    icon: "alignCenter",
    title: label.alignCenter(),
    conditional: true
  },
  embedAlignLeft: {
    icon: "alignLeft",
    title: label.alignLeft(),
    conditional: true
  },
  embedAlignRight: {
    icon: "alignRight",
    title: label.alignRight(),
    conditional: true
  },
  embedProperties: {
    icon: "more",
    title: label.embedProperties(),
    conditional: true
  },
  webclipSettings: {
    icon: "webclipSettings",
    title: label.webclipSettings(),
    conditional: true
  },
  webclipFullScreen: {
    icon: "fullscreen",
    title: label.fullscreen(),
    conditional: true
  },
  webclipOpenExternal: {
    icon: "openLink",
    title: label.openLink(),
    conditional: true
  },
  webclipOpenSource: {
    icon: "openSource",
    title: label.openSource(),
    conditional: true
  },
  outdent: {
    icon: "outdent",
    title: label.outdent(),
    conditional: true
  },
  indent: {
    icon: "indent",
    title: label.indent(),
    conditional: true
  },
  exportToCSV: {
    icon: "csv",
    title: label.exportCsv(),
    conditional: true
  }
});

export function getToolDefinition(id: ToolId) {
  return tools()[id];
}

/**
 * Every tool definition keyed by {@link ToolId}.
 *
 * `label` defaults to this module's own `@notesnook/intl` collection, which
 * keeps every existing caller byte-identical. A host that resolves its own,
 * already-initialized copy of `@notesnook/intl` (the native configure-toolbar
 * UI bundles editor's CJS build, whose own copy is never activated) passes its
 * collection in so titles come from the host's current locale instead of an
 * uninitialized module instance. Only the titles change; ids, icons, flags and
 * order are always the same.
 */
export function getAllTools(label: ToolbarStrings = strings) {
  return tools(label);
}

export function getDefaultPresets() {
  return defaultPresets;
}

/**
 * Mac Catalyst toolbar definition (WP08 R6).
 *
 * macOS Notes-style: a single "Aa" button that opens one popover with every
 * paragraph style, inline style and list, plus quick checklist/bullet/numbered
 * list buttons. The web-style font-size stepper and the paragraph/font-family
 * dropdowns are deliberately absent; formats that do not belong in a note's
 * body (alignment, text direction, highlight, text color, math) stay reachable
 * through the native Format menu.
 *
 * The insert ("+") group is not listed here: the toolbar prepends
 * `MOBILE_STATIC_TOOLBAR_GROUPS` for every editable mobile editor, and Mac
 * keeps it exactly as it is.
 */
export const MAC_TOOLBAR_GROUPS: ToolbarDefinition = [
  ["macFormat"],
  ["checkList", "bulletList", "numberedList"]
];

/**
 * Returns a fresh copy of the Mac toolbar groups so callers can pass it to
 * `Toolbar`'s `tools` prop without sharing mutable state with other editors.
 */
export function getMacToolbarGroups(): ToolbarDefinition {
  return MAC_TOOLBAR_GROUPS.map((group) => [...group]);
}

/**
 * Compact iPhone/iPad toolbar definition (D2 S1).
 *
 * The same "Aa" formatting entry as Mac Catalyst followed by a handful of
 * quick actions, with everything else the web default offers behind a single
 * nested "more" group. Every tool id of the web default preset is retained
 * exactly once across these groups; the "Aa" (`macFormat`) popover
 * intentionally repeats those same paragraph, inline and list commands in its
 * own menu, so the group keeps its individual buttons.
 *
 * This preset is opt-in: it is only returned when a caller passes
 * `ToolbarGroupsInput.ios === true`, and Mac Catalyst always wins over it. The
 * host wiring that passes the flag is in place: the WebView derives it in
 * `useSettings.ts` (`ios: true` on an iOS host that is not Mac Catalyst) and the
 * settings preview passes the same flag from `presetGroups` in
 * `apps/mobile/app/screens/settings/editor/state.ts`. The static "insert" (+)
 * groups are untouched.
 */
export const IOS_TOOLBAR_GROUPS: ToolbarDefinition = [
  ["macFormat"],
  ["checkList"],
  ["insertBlock"],
  ["undo"],
  ["closeKeyboard"],
  ["redo"],
  [
    [
      "bold",
      "italic",
      "underline",
      "highlight",
      "addLink",
      "addInternalLink",
      "fontSize",
      "fontFamily",
      "headings",
      "numberedList",
      "bulletList",
      "subscript",
      "superscript",
      "strikethrough",
      "code",
      "textColor",
      "math",
      "alignment",
      "textDirection",
      "clearformatting"
    ]
  ]
];

/**
 * Returns a fresh copy of the compact iOS toolbar groups so callers can pass
 * it to `Toolbar`'s `tools` prop without sharing mutable state with other
 * editors. Unlike `getMacToolbarGroups`, this preset has a nested "more"
 * subgroup, so the full deep clone is required.
 */
export function getIosToolbarGroups(): ToolbarDefinition {
  return cloneToolbarGroups(IOS_TOOLBAR_GROUPS);
}

export const STATIC_TOOLBAR_GROUPS: ToolbarDefinition = [
  [
    "insertBlock",
    "tableSettings",
    "cellProperties",
    "imageSettings",
    "embedSettings",
    "attachmentSettings",
    "linkSettings",
    "codeRemove",
    "outdent",
    "indent",
    "webclipSettings"
  ]
];
export const MOBILE_STATIC_TOOLBAR_GROUPS: ToolbarDefinition = [
  [...STATIC_TOOLBAR_GROUPS[0], "previewAttachment"]
];

export const READONLY_MOBILE_STATIC_TOOLBAR_GROUPS: ToolbarDefinition = [
  [
    "imageSettings",
    "attachmentSettings",
    "linkSettings",
    "webclipSettings",
    "previewAttachment"
  ]
];

export const READONLY_MOBILE_TOOLBAR_NODES = [
  "image",
  "attachment",
  "webclip",
  "link"
];

const defaultPresets: Record<"default" | "minimal", ToolbarDefinition> = {
  default: [
    [
      "bold",
      "italic",
      "underline",
      [
        "strikethrough",
        "code",
        "subscript",
        "superscript",
        "highlight",
        "textColor",
        "math"
      ]
    ],
    ["fontSize"],
    ["headings", "fontFamily"],
    ["checkList", "numberedList", "bulletList"],
    ["addLink", "addInternalLink"],
    ["alignment", "textDirection"],
    ["clearformatting"]
  ],
  minimal: [
    ["bold", "italic", "underline", "strikethrough", "code"],
    ["headings", "addLink"],
    ["clearformatting"]
  ]
};

/**
 * The presets a user can store for the toolbar. Kept in sync with the mobile
 * app's `DragState["preset"]` and the `toolbarConfig:*` DB payloads.
 */
export type ToolbarPreset = "default" | "minimal" | "custom";

/**
 * Input of {@link resolveToolbarGroups}.
 *
 * `toolbarPreset` is absent on payloads that predate presets (the legacy
 * `tools`-only caches and DB rows); an unrecognized value is treated the same
 * way, never as a silent rewrite of the stored configuration.
 */
export type ToolbarGroupsInput = {
  toolbarPreset?: ToolbarPreset | string | null;
  tools?: ToolbarDefinition | null;
  /**
   * True only in the Mac Catalyst app. This is deliberately a plain flag and
   * not a `deviceMode`: an iPad classified as `"tablet"` by the device
   * detection must keep its own toolbar, and Mac/iPad/Android tablets
   * intentionally share the stored `tablet` custom groups.
   */
  macCatalyst?: boolean;
  /**
   * Opt-in switch for the compact iPhone/iPad toolbar (`IOS_TOOLBAR_GROUPS`).
   * Defaults to false: a host that does not pass it keeps the existing web
   * default exactly as before. Mac Catalyst takes precedence over it, so a
   * caller that sets both still gets the Mac bar.
   */
  ios?: boolean;
};

/**
 * Fresh copy of a toolbar definition: a new outer array, a new array per
 * group and a new array per nested "more" subgroup. The presets,
 * `MAC_TOOLBAR_GROUPS` and `IOS_TOOLBAR_GROUPS` are module singletons, so every
 * branch of the resolver must clone before handing a definition to a mutable
 * consumer.
 */
function cloneToolbarGroups(groups: ToolbarDefinition): ToolbarDefinition {
  return groups.map((group) =>
    group.map((tool) => (Array.isArray(tool) ? [...tool] : tool))
  );
}

/**
 * `getDefaultPresets()` returns the shared singleton; clone on the way out.
 *
 * Mac Catalyst wins over the opt-in compact iOS preset; only a host that
 * explicitly passes `ios === true` (and is not Mac) gets the compact bar,
 * every other host keeps the existing web default byte-for-byte.
 */
function hostDefaultGroups(
  macCatalyst: boolean,
  ios: boolean
): ToolbarDefinition {
  if (macCatalyst) return getMacToolbarGroups();
  if (ios) return getIosToolbarGroups();
  return cloneToolbarGroups(defaultPresets.default);
}

/**
 * The single source of truth for the toolbar groups an editor actually
 * renders, shared by the mobile WebView (`tiptap.tsx`), the editor settings
 * (`useSettings.ts`) and the native configure-toolbar store (`state.ts`).
 *
 * Contract (B1):
 * - `"custom"` -> the EXACT `tools` passed in, nested groups/order preserved,
 *   deep-cloned and never mutated. A custom list byte-identical to a preset is
 *   still returned verbatim (no equality guessing). An empty array stays empty.
 * - `"default"` -> Mac Catalyst gets the Notes-style `macFormat` + lists bar,
 *   a host that opts in with `ios: true` gets the compact iOS bar, and every
 *   other host gets the existing web default preset.
 * - `"minimal"` -> the existing minimal preset, on every host.
 * - preset ABSENT (legacy payload) + `tools` present -> those exact groups.
 * - both absent -> the host platform default (see `"default"` above).
 *
 * A `"custom"` payload with no `tools` field (or a nullish one) falls back to
 * the host default; an explicitly empty array stays empty. No branch ever
 * writes back to or mutates its inputs or the stored configuration.
 */
export function resolveToolbarGroups(
  input: ToolbarGroupsInput = {}
): ToolbarDefinition {
  const { tools, macCatalyst = false, ios = false } = input;
  const preset = normalizeToolbarPreset(input.toolbarPreset);

  if (preset === "custom")
    return Array.isArray(tools)
      ? cloneToolbarGroups(tools)
      : hostDefaultGroups(macCatalyst, ios);

  if (preset === "minimal") return cloneToolbarGroups(defaultPresets.minimal);

  if (preset === "default") return hostDefaultGroups(macCatalyst, ios);

  // No (or an unrecognized) preset: a legacy payload keeps exactly the groups
  // it stored; a payload without groups gets the host default.
  return Array.isArray(tools)
    ? cloneToolbarGroups(tools)
    : hostDefaultGroups(macCatalyst, ios);
}

/**
 * `undefined`, `null` and unrecognized strings all mean "no preset": the
 * caller decides from the legacy groups instead of having its stored
 * configuration silently rewritten to a preset it never chose.
 */
function normalizeToolbarPreset(
  preset: ToolbarGroupsInput["toolbarPreset"]
): ToolbarPreset | undefined {
  return preset === "default" || preset === "minimal" || preset === "custom"
    ? preset
    : undefined;
}
