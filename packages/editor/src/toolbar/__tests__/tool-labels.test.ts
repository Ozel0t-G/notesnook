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
 * The label-injection contract of the shared toolbar definitions.
 *
 * `getAllTools` can be handed an already-initialized `@notesnook/intl`
 * collection (the native configure-toolbar bundle does this). Only the titles
 * may change: the ids, their authoring order, the icon aliases and the
 * `conditional` flags are frozen and identical for every caller.
 *
 * The default collection is this module's own real `@notesnook/intl` import.
 * This suite loads and activates the real, already-compiled `$en` and
 * `$pseudo-LOCALE` catalogs through lingui's singleton (`@lingui/core`) and
 * `@notesnook/intl`'s `setI18nGlobal` seam - the same path
 * `apps/mobile/globals.js` uses. The English assertions below are therefore
 * literal shipping labels ("Bold"/"Italic"/"Underline"), and a live pseudo
 * activation proves the catalog is genuinely applied instead of silently
 * returning the raw msgid.
 *
 * The `injectedLabels` proxy below is a deliberately fake, factory-contract
 * seam: it proves only that a whole injected collection is consumed by the
 * factory. It is NOT shipping proof.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@lingui/core";
import { type Messages, setI18nGlobal, strings } from "@notesnook/intl";
import enCatalog from "@notesnook/intl/locales/$en.json";
import pseudoCatalog from "@notesnook/intl/locales/$pseudo-LOCALE.json";
import { getAllTools, getToolDefinition } from "../tool-definitions.js";
import type { ToolbarStrings } from "../tool-definitions.js";

/**
 * The frozen `ToolId` authoring order. Any id insertion/removal/reorder in the
 * toolbar definition must be an intentional, reviewed change.
 */
const TOOL_IDS = [
  "none",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "addInternalLink",
  "addLink",
  "editLink",
  "removeLink",
  "openLink",
  "copyLink",
  "linkSettings",
  "code",
  "codeRemove",
  "clearformatting",
  "subscript",
  "superscript",
  "insertBlock",
  "bulletList",
  "numberedList",
  "checkList",
  "fontFamily",
  "fontSize",
  "headings",
  "macFormat",
  "alignment",
  "textDirection",
  "highlight",
  "textColor",
  "math",
  "tableSettings",
  "columnProperties",
  "rowProperties",
  "cellProperties",
  "insertColumnLeft",
  "insertColumnRight",
  "moveColumnLeft",
  "moveColumnRight",
  "deleteColumn",
  "splitCells",
  "mergeCells",
  "insertRowAbove",
  "insertRowBelow",
  "moveRowUp",
  "moveRowDown",
  "deleteRow",
  "deleteTable",
  "cellBackgroundColor",
  "cellBorderColor",
  "cellTextColor",
  "cellBorderWidth",
  "imageSettings",
  "imageAlignCenter",
  "imageAlignLeft",
  "imageAlignRight",
  "editHandwriting",
  "imageProperties",
  "previewAttachment",
  "attachmentSettings",
  "downloadAttachment",
  "removeAttachment",
  "embedSettings",
  "embedAlignCenter",
  "embedAlignLeft",
  "embedAlignRight",
  "embedProperties",
  "webclipSettings",
  "webclipFullScreen",
  "webclipOpenExternal",
  "webclipOpenSource",
  "outdent",
  "indent",
  "exportToCSV"
] as const;

/** An unmistakable marker so an injected title can never be confused with EN. */
const INJECTED = "‹injected-label›";

/**
 * The real compiled catalogs, activated through lingui's singleton and
 * `@notesnook/intl`'s own `setI18nGlobal` seam. Without this the shipping
 * `strings.*()` macro output falls back to the raw msgid, so the literal
 * English assertions below would be tautological. Restored to EN afterwards so
 * every case stays independent.
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
  // This suite and `@notesnook/intl` may resolve separate copies of the same
  // `@lingui/core` 5.1.2. Their private class fields make TypeScript treat the
  // identical runtime API as nominally different, so bridge that package
  // boundary explicitly - it is the SAME instance the catalogs were loaded and
  // activated on, exactly as `apps/mobile/globals.js` registers it.
  setI18nGlobal(i18n as unknown as Parameters<typeof setI18nGlobal>[0]);
});

afterAll(() => {
  i18n.activate("en");
});

/**
 * A complete stand-in collection with the exact `@notesnook/intl` shape: every
 * message function returns {@link INJECTED}. The factory may only consume it as
 * the whole collection, never partially. This is a factory-contract seam, not
 * shipping proof.
 */
const injectedLabels = new Proxy({} as Record<string, () => string>, {
  get: () => () => INJECTED
}) as unknown as ToolbarStrings;

describe("getAllTools - frozen metadata", () => {
  it("keys the definitions in the frozen authoring order", () => {
    expect(Object.keys(getAllTools())).toEqual([...TOOL_IDS]);
  });

  it("resolves the default titles from the activated real @notesnook/intl catalog", () => {
    const all = getAllTools();
    // Literal shipping English, not a self-comparison: these only hold once the
    // compiled `$en` catalog is loaded and activated in `beforeAll`.
    expect(all.bold.title).toBe("Bold");
    expect(all.italic.title).toBe("Italic");
    expect(all.underline.title).toBe("Underline");
    // Each title comes from the matching string function of the collection.
    expect(all.addInternalLink.title).toBe(strings.noteLink());
    expect(all.checkList.title).toBe(strings.checklist());
    expect(all.macFormat.title).toBe(strings.formatting());
    expect(all.none.title).toBe("");
  });

  it("re-labels from a live pseudo catalog and restores EN", () => {
    const enBold = getAllTools().bold.title;
    expect(enBold).toBe("Bold");

    i18n.activate("pseudo-LOCALE");
    try {
      // A different *actual* translation proves the catalog is genuinely
      // active; a no-op activation would silently return the EN msgid "Bold".
      expect(getAllTools().bold.title).not.toBe(enBold);
    } finally {
      i18n.activate("en");
    }

    // EN restored so later cases stay independent.
    expect(getAllTools().bold.title).toBe(enBold);
  });

  it("keeps macFormat a conditional, heading-icon tool", () => {
    const macFormat = getAllTools().macFormat;
    expect(macFormat.conditional).toBe(true);
    expect(macFormat.icon).toBe("heading");
  });

  it("exposes every definition through getToolDefinition consistently", () => {
    const all = getAllTools();
    for (const id of Object.keys(all)) {
      expect(getToolDefinition(id as keyof typeof all)).toEqual(
        all[id as keyof typeof all]
      );
    }
  });
});

describe("getAllTools - injected label collection", () => {
  const injected = getAllTools(injectedLabels);
  const defaults = getAllTools();

  it("keeps the exact ids and order", () => {
    expect(Object.keys(injected)).toEqual(Object.keys(defaults));
    expect(Object.keys(injected)).toEqual([...TOOL_IDS]);
  });

  it("changes only the titles", () => {
    for (const id of Object.keys(defaults)) {
      const actual = injected[id as keyof typeof injected];
      const expected = defaults[id as keyof typeof defaults];

      expect(actual.icon).toBe(expected.icon);
      expect(actual.conditional).toBe(expected.conditional);

      if (id === "none") {
        // Not a localized label: always the empty title.
        expect(actual.title).toBe("");
      } else {
        expect(actual.title).toBe(INJECTED);
        // Sanity: the injected title really is distinct from the shipping one.
        expect(actual.title).not.toBe(expected.title);
      }
    }
  });
});
