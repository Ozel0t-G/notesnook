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

/**
 * The pure contract of the shared toolbar resolver (`resolveToolbarGroups`).
 *
 * This is the single source of truth the mobile WebView (`tiptap.tsx`), the
 * editor settings (`useSettings.ts`) and the native configure-toolbar store
 * (`state.ts`) all resolve through, so the matrix below pins down exactly what
 * a stored preset/tools payload renders:
 *
 * - Mac Catalyst's `default` is the Notes-style "Aa" + lists bar; a host that
 *   opts in with `ios: true` gets the compact iOS "Aa" bar; every other host
 *   (web, Android, and any host that does not pass the flag) keeps the existing
 *   web default. Mac Catalyst always wins over the iOS flag.
 * - `minimal` is the same built-in minimal preset everywhere.
 * - `custom` returns the EXACT stored groups, nested subgroup order included,
 *   deep-cloned; an empty custom stays empty.
 * - a legacy payload (no/unknown preset) keeps its exact tools.
 * - no preset and no tools falls back to the host default.
 *
 * None of the branches may mutate their inputs or the module singletons
 * (`defaultPresets`, `MAC_TOOLBAR_GROUPS`) that every editor shares.
 */

import { describe, expect, it } from "vitest";
import {
  IOS_TOOLBAR_GROUPS,
  MAC_TOOLBAR_GROUPS,
  MOBILE_STATIC_TOOLBAR_GROUPS,
  STATIC_TOOLBAR_GROUPS,
  getAllTools,
  getDefaultPresets,
  getIosToolbarGroups,
  getMacToolbarGroups,
  resolveToolbarGroups
} from "../tool-definitions.js";
import type { ToolbarDefinition, ToolbarGroupDefinition } from "../types.js";
import type { ToolId } from "../tools/index.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A custom definition with a nested "more" subgroup and a deliberate order. */
const nestedCustom: ToolbarDefinition = [
  ["clearformatting"],
  ["headings", ["strikethrough", "code", "subscript"]],
  ["addLink", "addInternalLink"]
];

/** Every leaf tool id of a definition, depth-first, nested "more" groups included. */
const flatten = (groups: ToolbarDefinition): ToolId[] =>
  groups.flatMap((group: ToolbarGroupDefinition) =>
    group.flatMap((tool) => (Array.isArray(tool) ? tool : [tool]))
  );

describe("resolveToolbarGroups", () => {
  describe("default preset", () => {
    it("resolves Mac Catalyst to the Notes-style Aa + lists bar", () => {
      expect(
        resolveToolbarGroups({ toolbarPreset: "default", macCatalyst: true })
      ).toEqual(getMacToolbarGroups());
    });

    it("resolves every non-Mac host to the existing web default", () => {
      const expected = getDefaultPresets().default;
      expect(
        resolveToolbarGroups({ toolbarPreset: "default", macCatalyst: false })
      ).toEqual(expected);
      // A flag-less iPad/Android tablet shares the web default: the resolver
      // reads the explicit Mac/iOS flags, never a `deviceMode`, so a "tablet"
      // host is not special on its own.
      expect(
        resolveToolbarGroups({ toolbarPreset: "default", macCatalyst: false })
      ).toEqual(expected);
      // `macCatalyst` defaults to false when omitted.
      expect(resolveToolbarGroups({ toolbarPreset: "default" })).toEqual(
        expected
      );
    });

    it("never returns the shared Mac singleton itself", () => {
      const mac = resolveToolbarGroups({
        toolbarPreset: "default",
        macCatalyst: true
      });
      expect(mac).not.toBe(MAC_TOOLBAR_GROUPS);
      expect(mac[0]).not.toBe(MAC_TOOLBAR_GROUPS[0]);
      expect(mac[1]).not.toBe(MAC_TOOLBAR_GROUPS[1]);
    });
  });

  describe("compact iOS preset (opt-in)", () => {
    it("has the exact compact shape with a nested more group", () => {
      expect(IOS_TOOLBAR_GROUPS.slice(0, 5)).toEqual([
        ["macFormat"],
        ["checkList"],
        ["insertBlock"],
        ["undo"],
        ["closeKeyboard"]
      ]);
      expect(IOS_TOOLBAR_GROUPS[6][0]).toContain("highlight");
      expect(IOS_TOOLBAR_GROUPS[6][0]).toContain("addInternalLink");
    });

    it("is returned when the host opts in with ios: true", () => {
      expect(
        resolveToolbarGroups({ toolbarPreset: "default", ios: true })
      ).toEqual(IOS_TOOLBAR_GROUPS);
      expect(
        resolveToolbarGroups({ toolbarPreset: "default", ios: true })
      ).toEqual(getIosToolbarGroups());
    });

    it("lets Mac Catalyst take precedence over the iOS flag", () => {
      expect(
        resolveToolbarGroups({
          toolbarPreset: "default",
          macCatalyst: true,
          ios: true
        })
      ).toEqual(getMacToolbarGroups());
    });

    it("is not selected when the flag is absent or explicitly false", () => {
      const webDefault = getDefaultPresets().default;
      // The three host-default paths with no flag stay byte-identical to today.
      expect(resolveToolbarGroups({ toolbarPreset: "default" })).toEqual(
        webDefault
      );
      expect(
        resolveToolbarGroups({ toolbarPreset: "default", ios: false })
      ).toEqual(webDefault);
      expect(
        resolveToolbarGroups({
          toolbarPreset: "default",
          macCatalyst: false,
          ios: false
        })
      ).toEqual(webDefault);
      expect(resolveToolbarGroups({})).toEqual(webDefault);
      expect(resolveToolbarGroups({ ios: false })).toEqual(webDefault);
      // ...and never leaks the iOS preset.
      expect(resolveToolbarGroups({ toolbarPreset: "default" })).not.toEqual(
        IOS_TOOLBAR_GROUPS
      );
    });

    it("is the host fallback for an opt-in host with no preset or tools", () => {
      expect(resolveToolbarGroups({ ios: true })).toEqual(IOS_TOOLBAR_GROUPS);
      expect(
        resolveToolbarGroups({ toolbarPreset: "custom", ios: true })
      ).toEqual(IOS_TOOLBAR_GROUPS);
      expect(resolveToolbarGroups({ toolbarPreset: null, ios: true })).toEqual(
        IOS_TOOLBAR_GROUPS
      );
    });

    it("keeps an explicitly empty custom empty even when opting in", () => {
      expect(
        resolveToolbarGroups({ toolbarPreset: "custom", tools: [], ios: true })
      ).toEqual([]);
    });

    it("does not touch minimal, custom or legacy branches", () => {
      expect(
        resolveToolbarGroups({ toolbarPreset: "minimal", ios: true })
      ).toEqual(getDefaultPresets().minimal);

      const custom = resolveToolbarGroups({
        toolbarPreset: "custom",
        tools: nestedCustom,
        ios: true
      });
      expect(custom).toEqual(nestedCustom);
      expect(custom[1][1]).toEqual(["strikethrough", "code", "subscript"]);

      const legacy = resolveToolbarGroups({ tools: nestedCustom, ios: true });
      expect(legacy).toEqual(nestedCustom);
    });

    it("retains every web-default tool exactly once, plus direct writing actions", () => {
      const ios = flatten(IOS_TOOLBAR_GROUPS);
      expect(ios.filter((id) => id === "macFormat")).toEqual(["macFormat"]);
      const nonFormat = ios.filter((id) => id !== "macFormat");
      expect(new Set(nonFormat).size).toBe(nonFormat.length);
      expect(new Set(nonFormat)).toEqual(
        new Set([
          ...flatten(getDefaultPresets().default),
          "insertBlock",
          "undo",
          "redo",
          "closeKeyboard"
        ])
      );
    });

    it("never returns the shared iOS singleton (outer, inner and nested)", () => {
      const resolved = resolveToolbarGroups({
        toolbarPreset: "default",
        ios: true
      });
      expect(resolved).not.toBe(IOS_TOOLBAR_GROUPS);
      resolved.forEach((group, i) => {
        expect(group).not.toBe(IOS_TOOLBAR_GROUPS[i]);
      });
      // The nested "more" subgroup is its own fresh array too.
      const nestedIndex = IOS_TOOLBAR_GROUPS.findIndex((group) =>
        group.some((tool) => Array.isArray(tool))
      );
      expect(nestedIndex).toBeGreaterThanOrEqual(0);
      expect(resolved[nestedIndex][0]).not.toBe(
        IOS_TOOLBAR_GROUPS[nestedIndex][0]
      );
      expect(resolved[nestedIndex][0]).toEqual(
        IOS_TOOLBAR_GROUPS[nestedIndex][0]
      );
    });

    it("survives mutating the resolved iOS groups", () => {
      const before = clone(IOS_TOOLBAR_GROUPS);
      const resolved = resolveToolbarGroups({
        toolbarPreset: "default",
        ios: true
      });

      (resolved[6][0] as string[]).push("math");
      resolved[1].push("code");
      resolved.push(["insertBlock"]);

      expect(IOS_TOOLBAR_GROUPS).toEqual(before);
      expect(getIosToolbarGroups()).toEqual(before);
    });

    it("hands out independent copies on consecutive resolutions", () => {
      const first = resolveToolbarGroups({
        toolbarPreset: "default",
        ios: true
      });
      const second = resolveToolbarGroups({
        toolbarPreset: "default",
        ios: true
      });
      expect(first).not.toBe(second);
      expect(first[6][0]).not.toBe(second[6][0]);
      (first[6][0] as string[]).push("none");
      expect(second[6][0]).not.toContain("none");
    });

    it("leaves macFormat conditional and the static groups untouched", () => {
      // The flag stays on: customizers skip macFormat outside Apple, and on
      // iPad/iPhone only until the iOS picker wiring lands (then Apple,
      // including the iPhone, offers it).
      expect(getAllTools().macFormat.conditional).toBe(true);
      expect(STATIC_TOOLBAR_GROUPS).toEqual([
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
      ]);
      expect(MOBILE_STATIC_TOOLBAR_GROUPS).toEqual([
        [...STATIC_TOOLBAR_GROUPS[0], "previewAttachment"]
      ]);
    });
  });

  describe("minimal preset", () => {
    it("is the built-in minimal preset on every host", () => {
      const expected = getDefaultPresets().minimal;
      expect(
        resolveToolbarGroups({ toolbarPreset: "minimal", macCatalyst: true })
      ).toEqual(expected);
      expect(
        resolveToolbarGroups({ toolbarPreset: "minimal", macCatalyst: false })
      ).toEqual(expected);
      expect(resolveToolbarGroups({ toolbarPreset: "minimal" })).toEqual(
        expected
      );
    });
  });

  describe("custom preset", () => {
    it("returns the exact stored groups, nested order preserved", () => {
      const resolved = resolveToolbarGroups({
        toolbarPreset: "custom",
        tools: nestedCustom
      });
      expect(resolved).toEqual(nestedCustom);
      expect(resolved[1][1]).toEqual(["strikethrough", "code", "subscript"]);
    });

    it("returns an empty custom as an empty list", () => {
      expect(
        resolveToolbarGroups({ toolbarPreset: "custom", tools: [] })
      ).toEqual([]);
    });

    it("deep-clones: mutating the result never touches the input", () => {
      const input = clone(nestedCustom);
      const resolved = resolveToolbarGroups({
        toolbarPreset: "custom",
        tools: input
      });

      expect(resolved).not.toBe(input);
      resolved[0].push("math");
      (resolved[1][1] as string[]).push("highlight");
      resolved[1].push("alignment");

      expect(input).toEqual(nestedCustom);
      expect(input[0]).toEqual(["clearformatting"]);
      expect(input[1][1]).toEqual(["strikethrough", "code", "subscript"]);
    });

    it("returns a custom list byte-identical to a preset verbatim (no guessing)", () => {
      const presetCopy = clone(getDefaultPresets().minimal);
      const resolved = resolveToolbarGroups({
        toolbarPreset: "custom",
        tools: presetCopy
      });
      // Still the caller's exact groups - a fresh copy - not the preset singleton.
      expect(resolved).toEqual(presetCopy);
      expect(resolved).not.toBe(presetCopy);
      expect(resolved).not.toBe(getDefaultPresets().minimal);
    });

    it("falls back to the host default when custom has no groups at all", () => {
      expect(resolveToolbarGroups({ toolbarPreset: "custom" })).toEqual(
        getDefaultPresets().default
      );
      expect(
        resolveToolbarGroups({ toolbarPreset: "custom", macCatalyst: true })
      ).toEqual(getMacToolbarGroups());
    });
  });

  describe("legacy payloads (no or unknown preset)", () => {
    it("keeps the exact stored tools when the preset is absent", () => {
      const legacy = clone(nestedCustom);
      const resolved = resolveToolbarGroups({ tools: legacy });
      expect(resolved).toEqual(legacy);
      expect(resolved).not.toBe(legacy);
      resolved[0].push("math");
      expect(legacy[0]).toEqual(["clearformatting"]);
    });

    it("treats null and an unrecognized preset exactly like an absent one", () => {
      const legacy = clone(nestedCustom);
      expect(
        resolveToolbarGroups({ toolbarPreset: null, tools: legacy })
      ).toEqual(legacy);
      expect(
        resolveToolbarGroups({ toolbarPreset: "totally-bogus", tools: legacy })
      ).toEqual(legacy);
      // The legacy groups are never rewritten into a built-in preset.
      expect(
        resolveToolbarGroups({ toolbarPreset: "", tools: legacy })
      ).toEqual(legacy);
    });

    it("falls back to the host default when neither preset nor tools exist", () => {
      expect(resolveToolbarGroups({})).toEqual(getDefaultPresets().default);
      expect(resolveToolbarGroups({ macCatalyst: true })).toEqual(
        getMacToolbarGroups()
      );
      expect(resolveToolbarGroups()).toEqual(getDefaultPresets().default);
    });
  });

  describe("module singletons are never mutated", () => {
    it("survives mutating the resolved web default", () => {
      const before = clone(getDefaultPresets().default);
      const resolved = resolveToolbarGroups({
        toolbarPreset: "default",
        macCatalyst: false
      });

      // The default preset's first group carries a nested subgroup at [0][3].
      (resolved[0][3] as string[]).push("math");
      resolved[0].push("alignment");
      resolved.push(["insertBlock"]);

      expect(getDefaultPresets().default).toEqual(before);
      expect(resolveToolbarGroups({ toolbarPreset: "default" })).toEqual(
        before
      );
    });

    it("survives mutating the resolved Mac default", () => {
      const before = clone(MAC_TOOLBAR_GROUPS);
      const resolved = resolveToolbarGroups({
        toolbarPreset: "default",
        macCatalyst: true
      });

      resolved[1].push("alignment");
      resolved[0].push("bold");

      expect(MAC_TOOLBAR_GROUPS).toEqual(before);
      expect(getMacToolbarGroups()).toEqual(before);
    });

    it("survives mutating the resolved minimal preset", () => {
      const before = clone(getDefaultPresets().minimal);
      const resolved = resolveToolbarGroups({ toolbarPreset: "minimal" });
      resolved[0].push("highlight");
      expect(getDefaultPresets().minimal).toEqual(before);
    });
  });
});
