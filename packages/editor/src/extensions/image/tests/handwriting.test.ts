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

import { describe, expect, test } from "vitest";
import {
  isHandwritingEditEligible,
  isHandwritingFilename
} from "../handwriting.js";

const ID = "3f2b8c1e-5d4a-4e7b-9c1d-0a1b2c3d4e5f";
const hw = { hash: "abc", filename: `handwriting-${ID}.png` };

function editor(handwritingEnabled: boolean, isEditable = true) {
  return { isEditable, storage: { handwritingEnabled } } as any;
}

describe("handwriting image detection", () => {
  test("only handwriting-<UUID>.png counts", () => {
    expect(isHandwritingFilename(`handwriting-${ID}.png`)).toBe(true);
    expect(isHandwritingFilename(`HANDWRITING-${ID.toUpperCase()}.PNG`)).toBe(
      true
    );
    for (const name of [
      "photo.png",
      "handwriting.png",
      `handwriting-${ID}.pkdrawing`,
      `handwriting-${ID}.json`,
      `handwriting-${ID}.jpg`,
      `my-handwriting-${ID}.png`,
      "handwriting-not-a-uuid.png",
      "",
      undefined,
      null
    ])
      expect(isHandwritingFilename(name as any)).toBe(false);
  });
});

describe("edit overlay eligibility", () => {
  test("handwriting image on an enabled (iPad) editor", () => {
    expect(isHandwritingEditEligible(editor(true), hw)).toBe(true);
  });

  test("normal images never get the edit UI", () => {
    expect(
      isHandwritingEditEligible(editor(true), {
        hash: "abc",
        filename: "vacation.png"
      })
    ).toBe(false);
    expect(isHandwritingEditEligible(editor(true), { hash: "abc" })).toBe(
      false
    );
    expect(isHandwritingEditEligible(editor(true), undefined)).toBe(false);
  });

  test("not on devices that cannot edit handwriting", () => {
    expect(isHandwritingEditEligible(editor(false), hw)).toBe(false);
  });

  test("not in read-only mode", () => {
    expect(isHandwritingEditEligible(editor(true, false), hw)).toBe(false);
  });

  test("not without an attachment hash", () => {
    expect(
      isHandwritingEditEligible(editor(true), { filename: hw.filename })
    ).toBe(false);
  });
});
