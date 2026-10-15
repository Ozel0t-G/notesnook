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
 * The native configure-toolbar helpers (`tools`, `getToolIcon`,
 * `getUngroupedTools`).
 *
 * The real, already-compiled `$en` and `$pseudo-LOCALE` catalogs are loaded and
 * activated here through lingui's singleton (`@lingui/core`) and
 * `@notesnook/intl`'s `setI18nGlobal` seam - the same path
 * `apps/mobile/globals.js` uses. `tools()` labels are therefore asserted as
 * literal shipping English ("Bold"/"Italic"/"Underline"), and a live pseudo
 * activation re-labels a tool to prove the catalog is genuinely applied.
 *
 * Scope: these tests exercise the real SOURCE through a single module instance
 * (the editor ids are redirected to source with `jest.requireActual`); they do
 * NOT prove the shipping CJS/ESM bundle boundary or the native UI - the
 * supervisor verifies those separately. These tests pin down that:
 *
 * - `tools()` labels come from the host's *live* collection (`strings`), so the
 *   real `@notesnook/intl` is imported rather than a fake label map.
 * - `getToolIcon` resolves a `ToolDefinition.icon` alias through the real icon
 *   map and returns `null` (never an SVG with `d="undefined"`) for `none` and
 *   for unknown aliases.
 * - `getUngroupedTools` matches EXACT ids (including nested subgroups), skips
 *   every conditional context tool, offers `macFormat` on every Apple host
 *   (Mac Catalyst and iPhone/iPad) and never on Android/other hosts, preserves
 *   definition order and never mutates its input.
 *
 * Only the two host sources (`Platform.OS` + `isMacCatalyst`) are mocked. The
 * editor module ids are redirected to the real sources (`jest.requireActual`)
 * so the suite exercises the shipping code without a built `dist` - never a
 * fake resolver or icon map.
 */

const mockIsMacCatalyst = jest.fn(() => false);

jest.mock("../../../utils/constants", () => ({
  isMacCatalyst: mockIsMacCatalyst
}));

/**
 * Mutable host fixture. The generic cases below pin a non-Apple host
 * (`android`) explicitly so their expectations keep the pre-S2 shape; the
 * `macFormat gating` cases override `OS` per test. `Platform.OS` is read per
 * call by `toolbar-definition.ts`, so mutating this object is enough - no
 * module reload is needed.
 */
jest.mock(
  "react-native",
  () => ({
    Platform: { OS: "android" }
  }),
  { virtual: true }
);

// The real icon map (aliases -> SVG path) and the real toolbar definitions,
// resolved from source because this checkout has no built `@notesnook/editor`
// dist. This mirrors state.test.ts and replaces no logic with fakes.
jest.mock("@notesnook/editor/dist/cjs/toolbar/icons", () =>
  jest.requireActual("../../../../../../packages/editor/src/toolbar/icons")
);

jest.mock("@notesnook/editor/dist/cjs/toolbar/tool-definitions", () =>
  jest.requireActual(
    "../../../../../../packages/editor/src/toolbar/tool-definitions"
  )
);

import { i18n } from "@lingui/core";
import { type Messages, setI18nGlobal, strings } from "@notesnook/intl";
import enCatalog from "@notesnook/intl/locales/$en.json";
import pseudoCatalog from "@notesnook/intl/locales/$pseudo-LOCALE.json";
import { Icons } from "@notesnook/editor/dist/cjs/toolbar/icons";
import { getAllTools } from "@notesnook/editor/dist/cjs/toolbar/tool-definitions";
import { Platform } from "react-native";
import {
  getToolIcon,
  getUngroupedTools,
  tools
} from "./toolbar-definition";

type ToolMap = ReturnType<typeof tools>;

/** Every id the definitions flag as a context-only tool. */
function conditionalIds(): string[] {
  const all = getAllTools();
  return Object.keys(all).filter(
    (id) => (all[id as keyof typeof all] as { conditional?: boolean }).conditional
  );
}

/** The ids that may appear in a toolbar in definition order. */
function expectedUngrouped(grouped: Set<string>): string[] {
  const all = getAllTools();
  // Mirrors the SAME host predicate `toolbar-definition.ts` uses: `macFormat`
  // is offered on every Apple host, never on Android/other hosts.
  const appleHost = mockIsMacCatalyst() || hostPlatformOS() === "ios";
  return Object.keys(all).filter((id) => {
    const definition = all[id as keyof typeof all] as { conditional?: boolean };
    if (definition.conditional && id !== "macFormat") return false;
    if (id === "macFormat" && !appleHost) return false;
    return !grouped.has(id);
  });
}

/** The mutable host platform of the `react-native` mock fixture above. */
function hostPlatformOS(): string {
  return (Platform as unknown as { OS: string }).OS;
}

/** Point the mocked host at a platform ("android", "ios", ...). */
function setHostPlatform(os: string) {
  (Platform as unknown as { OS: string }).OS = os;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  return Object.freeze(value);
}

/**
 * Activate the real compiled catalogs through lingui's singleton and
 * `@notesnook/intl`'s `setI18nGlobal` seam. Without this the shipping
 * `strings.*()` macro output falls back to the raw msgid, so a literal English
 * assertion would be tautological. Restored to EN in `afterAll` so every case
 * stays independent.
 */
beforeAll(() => {
  // The compiled lingui catalogs are `Messages` - their values may be arrays or
  // nested arrays (rich/plural messages), not a flat `Record<string, string>`.
  // TypeScript cannot prove the JSON module overlaps `Messages`, so bridge the
  // module boundary with `unknown` while keeping the real target type (the same
  // idiom apps/desktop and apps/web use for their compiled catalogs).
  i18n.load({
    en: enCatalog.messages as unknown as Messages,
    "pseudo-LOCALE": pseudoCatalog.messages as unknown as Messages
  });
  i18n.activate("en");
  // This host and `@notesnook/intl` resolve separate copies of the same
  // `@lingui/core` 5.1.2. Their private class fields make TypeScript treat the
  // identical runtime API as nominally different, so bridge that package
  // boundary explicitly - it is the SAME instance the catalogs were loaded and
  // activated on, exactly as `apps/mobile/globals.js` registers it.
  setI18nGlobal(i18n as unknown as Parameters<typeof setI18nGlobal>[0]);
});

afterAll(() => {
  i18n.activate("en");
});

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMacCatalyst.mockReturnValue(false);
  // Generic (non-Apple) host fixture for every case that does not opt into an
  // Apple host explicitly: the pre-S2 expectations keep the web behaviour.
  setHostPlatform("android");
});

describe("tools", () => {
  it("labels every tool from the host's live @notesnook/intl collection", () => {
    const all = tools();
    // Literal shipping English, not a self-comparison: these only hold once the
    // compiled `$en` catalog is loaded and activated in `beforeAll`.
    expect(all.bold.title).toBe("Bold");
    expect(all.italic.title).toBe("Italic");
    expect(all.underline.title).toBe("Underline");
    // Each title comes from the matching string function of the collection.
    expect(all.checkList.title).toBe(strings.checklist());
    expect(all.macFormat.title).toBe(strings.formatting());
    expect(all.exportToCSV.title).toBe(strings.exportCsv());
    expect(all.none.title).toBe("");
  });

  it("re-labels from a live pseudo catalog and restores EN", () => {
    const enBold = tools().bold.title;
    expect(enBold).toBe("Bold");

    i18n.activate("pseudo-LOCALE");
    try {
      // A different *actual* translation proves the catalog is genuinely
      // active; a no-op activation would silently return the EN msgid "Bold".
      expect(tools().bold.title).not.toBe(enBold);
    } finally {
      i18n.activate("en");
    }

    // EN restored so later cases stay independent.
    expect(tools().bold.title).toBe(enBold);
  });

  it("passes the host collection to the shared definitions", () => {
    expect(tools()).toEqual(getAllTools(strings));
  });

  it("keeps the editor's ids, icons and flags untouched", () => {
    const host = tools();
    const editorDefault = getAllTools();
    expect(Object.keys(host)).toEqual(Object.keys(editorDefault));
    for (const id of Object.keys(editorDefault)) {
      expect(host[id as keyof ToolMap].icon).toBe(
        editorDefault[id as keyof typeof editorDefault].icon
      );
      // The CJS build is typed by inference (allowJs), so only some entries
      // carry `conditional`. Compare through the same typed optional shape the
      // helpers above use instead of narrowing the imported JS.
      expect(
        (host[id as keyof ToolMap] as { conditional?: boolean }).conditional
      ).toBe(
        (
          editorDefault[id as keyof typeof editorDefault] as {
            conditional?: boolean;
          }
        ).conditional
      );
    }
  });
});

describe("getToolIcon", () => {
  it("returns null for the `none` alias", () => {
    expect(getToolIcon("none" as never, "#fff")).toBeNull();
  });

  it("returns null for an unknown alias instead of an undefined path", () => {
    const svg = getToolIcon("definitely-not-an-icon" as never, "#fff");
    expect(svg).toBeNull();
    expect(svg ?? "").not.toContain("undefined");
  });

  it("renders a path filled with the requested color for known aliases", () => {
    for (const alias of ["bold", "noteLink", "formatClear", "checklist", "heading"]) {
      const svg = getToolIcon(alias as never, "#abcdef");
      expect(typeof svg).toBe("string");
      expect(svg).toContain('fill="#abcdef"');
      expect(svg).not.toContain("undefined");
    }
  });

  it("resolves every definition alias; only `none` yields null", () => {
    const all = tools();
    for (const id of Object.keys(all)) {
      const alias = all[id as keyof ToolMap].icon;
      const svg = getToolIcon(alias as never, "#123456");

      if (alias === "none") {
        expect(svg).toBeNull();
      } else {
        // The alias must exist in the real icon map (no undefined path).
        expect(Icons[alias as keyof typeof Icons]).toBeTruthy();
        expect(typeof svg).toBe("string");
        expect(svg).toContain('fill="#123456"');
        expect(svg).not.toContain("undefined");
      }
    }
  });
});

describe("getUngroupedTools", () => {
  it("matches exact ids, never substrings", () => {
    const ungrouped = getUngroupedTools([["codeRemove"]]);
    // `codeRemove` is conditional and grouped; the substring bug wrongly hid
    // `code` because `"codeRemove".includes("code")`.
    expect(ungrouped).not.toContain("codeRemove");
    expect(ungrouped).toContain("code");
  });

  it("flattens nested subgroups", () => {
    const groups = [["bold", ["strikethrough", "code", "subscript"]]];
    const ungrouped = getUngroupedTools(groups);
    for (const id of ["bold", "strikethrough", "code", "subscript"]) {
      expect(ungrouped).not.toContain(id);
    }
    expect(ungrouped).toContain("italic");
  });

  it("never offers a conditional context tool", () => {
    const ungrouped = getUngroupedTools([]);
    for (const id of conditionalIds()) {
      if (id === "macFormat") continue;
      expect(ungrouped).not.toContain(id);
    }
  });

  it("returns the non-conditional tools in definition order for an empty input", () => {
    const ungrouped = getUngroupedTools([]);
    expect(ungrouped).toEqual(expectedUngrouped(new Set()));
  });

  it("preserves definition order after filtering grouped ids", () => {
    const ungrouped = getUngroupedTools([
      ["clearformatting"],
      ["headings", ["italic", "code"]]
    ]);
    expect(ungrouped).toEqual(
      expectedUngrouped(new Set(["clearformatting", "headings", "italic", "code"]))
    );
  });

  it("never mutates its input", () => {
    const input = deepFreeze([["bold", ["italic", "code"]]]);
    const snapshot = JSON.parse(JSON.stringify(input));
    expect(() => getUngroupedTools(input)).not.toThrow();
    expect(input).toEqual(snapshot);
    // Nested arrays stayed intact.
    expect(input[0][1]).toEqual(["italic", "code"]);
  });

  it("handles empty and single-element inputs without mutation", () => {
    const empty = deepFreeze([]) as unknown as (string | string[])[][];
    expect(getUngroupedTools(empty)).toEqual(expectedUngrouped(new Set()));

    const single = deepFreeze([["bold"]]) as (string | string[])[][];
    const ungrouped = getUngroupedTools(single);
    expect(ungrouped).not.toContain("bold");
    expect(single).toEqual([["bold"]]);
  });

  describe("macFormat gating", () => {
    it("hides macFormat on a non-Apple host (Android)", () => {
      setHostPlatform("android");
      mockIsMacCatalyst.mockReturnValue(false);
      expect(getUngroupedTools([])).not.toContain("macFormat");
    });

    it("offers macFormat on a Mac Catalyst host", () => {
      setHostPlatform("ios");
      mockIsMacCatalyst.mockReturnValue(true);
      expect(getUngroupedTools([])).toContain("macFormat");
    });

    it("offers macFormat on iPhone/iPad (iOS, not Mac Catalyst)", () => {
      setHostPlatform("ios");
      mockIsMacCatalyst.mockReturnValue(false);
      expect(getUngroupedTools([])).toContain("macFormat");
    });

    it("keeps Mac Catalyst precedence when the iOS flag is not the source of truth", () => {
      // A Mac Catalyst host is an iOS host, so the Apple predicate must hold
      // even when `isMacCatalyst` and `Platform.OS` disagree about the family
      // (defense-in-depth: `Platform.OS` alone already implies Apple).
      setHostPlatform("ios");
      mockIsMacCatalyst.mockReturnValue(true);
      expect(getUngroupedTools([])).toContain("macFormat");

      mockIsMacCatalyst.mockReturnValue(false);
      expect(getUngroupedTools([])).toContain("macFormat");
    });

    it("reads the host on every call, not once at module load", () => {
      setHostPlatform("ios");
      expect(getUngroupedTools([])).toContain("macFormat");

      setHostPlatform("android");
      mockIsMacCatalyst.mockReturnValue(false);
      expect(getUngroupedTools([])).not.toContain("macFormat");

      // And back again: nothing is cached between calls.
      setHostPlatform("ios");
      expect(getUngroupedTools([])).toContain("macFormat");
    });

    it("still hides macFormat when it is already grouped on an Apple host", () => {
      setHostPlatform("ios");
      expect(getUngroupedTools([["macFormat"]])).not.toContain("macFormat");
    });
  });
});
