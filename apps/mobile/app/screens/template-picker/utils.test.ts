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

import {
  filterTemplates,
  shouldAdoptTemplateTitle,
  templatePreview
} from "./utils";

const TEMPLATES = [
  { title: "Daily Journal" },
  { title: "Meeting notes" },
  { title: "Project Plan" },
  { title: undefined }
];

describe("filterTemplates", () => {
  test("returns every template for an empty query", () => {
    expect(filterTemplates(TEMPLATES, "")).toEqual(TEMPLATES);
    expect(filterTemplates(TEMPLATES, "   ")).toEqual(TEMPLATES);
  });

  test("matches the title case-insensitively", () => {
    expect(filterTemplates(TEMPLATES, "meeting")).toEqual([
      { title: "Meeting notes" }
    ]);
    expect(filterTemplates(TEMPLATES, "PLAN")).toEqual([
      { title: "Project Plan" }
    ]);
  });

  test("matches substrings and trims the query", () => {
    expect(filterTemplates(TEMPLATES, "  journal ")).toEqual([
      { title: "Daily Journal" }
    ]);
  });

  test("returns nothing when no title matches", () => {
    expect(filterTemplates(TEMPLATES, "nope")).toEqual([]);
  });
});

describe("shouldAdoptTemplateTitle", () => {
  test("adopts when the current title is empty", () => {
    expect(shouldAdoptTemplateTitle(undefined)).toBe(true);
    expect(shouldAdoptTemplateTitle("")).toBe(true);
    expect(shouldAdoptTemplateTitle("   ")).toBe(true);
  });

  test("keeps a title the user already gave the note", () => {
    expect(shouldAdoptTemplateTitle("My note")).toBe(false);
  });
});

describe("templatePreview", () => {
  test("returns an empty string without a headline", () => {
    expect(templatePreview(undefined)).toBe("");
    expect(templatePreview("")).toBe("");
  });

  test("collapses whitespace into a single line", () => {
    expect(templatePreview("first line\n\nsecond\tline")).toBe(
      "first line second line"
    );
  });

  test("truncates long headlines", () => {
    const preview = templatePreview("a".repeat(200));
    expect(preview.length).toBe(120);
    expect(preview.endsWith("…")).toBe(true);
  });
});
