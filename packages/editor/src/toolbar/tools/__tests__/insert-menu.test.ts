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

import { describe, expect, test, vi } from "vitest";
import { getInsertMenuItems } from "../block.js";
import { Editor } from "../../../types.js";

function fakeEditor(storage: Record<string, unknown>) {
  return {
    isActive: () => false,
    storage,
    chain: () => ({ focus: () => ({}) })
  } as unknown as Editor;
}

describe("insert (+) menu", () => {
  test("handwriting is a first-level action when enabled (iPad)", () => {
    const openAttachmentPicker = vi.fn();
    const items = getInsertMenuItems(
      fakeEditor({ handwritingEnabled: true, openAttachmentPicker }),
      true
    );
    const item = items.find((i) => i.key === "handwriting");
    expect(item).toBeDefined();
    expect(item?.type).toBe("button");
    expect(item?.isHidden).toBe(false);
    // direct action, no sub menu
    expect((item as { menu?: unknown }).menu).toBeUndefined();

    (item as { onClick: () => void }).onClick();
    expect(openAttachmentPicker).toHaveBeenCalledWith("handwriting");
  });

  test("handwriting is hidden on every other device", () => {
    for (const storage of [{}, { handwritingEnabled: false }]) {
      const items = getInsertMenuItems(fakeEditor(storage), true);
      expect(items.find((i) => i.key === "handwriting")?.isHidden).toBe(true);
    }
  });

  test("handwriting is no longer nested in Image -> ...", () => {
    const items = getInsertMenuItems(
      fakeEditor({ handwritingEnabled: true }),
      true
    );
    const image = items.find((i) => i.key === "image") as {
      menu: { items: { key: string }[] };
    };
    expect(image.menu.items.map((i) => i.key)).not.toContain("handwriting");
  });

  test("keeps the existing entries", () => {
    const keys = getInsertMenuItems(fakeEditor({}), true).map((i) => i.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "tasklist",
        "image",
        "attachment",
        "embed",
        "table"
      ])
    );
  });
});
