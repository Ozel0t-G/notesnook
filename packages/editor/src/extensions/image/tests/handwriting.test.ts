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
  getHandwritingPresentation,
  isHandwritingEditEligible,
  isHandwritingFilename,
  isTransparentCorner
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

/** RGBA for a 2x1 canvas: pixel 0 = top-left, pixel 1 = top-right. */
function corners(topLeftAlpha: number, topRightAlpha: number) {
  return [10, 10, 10, topLeftAlpha, 20, 20, 20, topRightAlpha];
}

describe("transparent handwriting corner detection", () => {
  test("both corners fully transparent => transparent page", () => {
    expect(isTransparentCorner(corners(0, 0))).toBe(true);
    const data = new Uint8ClampedArray(corners(0, 0));
    expect(isTransparentCorner(data)).toBe(true);
  });

  test("any opaque corner => opaque (old) page", () => {
    expect(isTransparentCorner(corners(255, 0))).toBe(false);
    expect(isTransparentCorner(corners(0, 255))).toBe(false);
    expect(isTransparentCorner(corners(1, 1))).toBe(false);
  });

  test("missing/short data is treated as opaque", () => {
    expect(isTransparentCorner(undefined)).toBe(false);
    expect(isTransparentCorner(null)).toBe(false);
    expect(isTransparentCorner([])).toBe(false);
    expect(isTransparentCorner([0, 0, 0, 0])).toBe(false);
  });
});

describe("handwriting frameless / dark-mode decision", () => {
  test("normal images are never frameless or inverted", () => {
    for (const transparent of [true, false, undefined]) {
      for (const isDark of [true, false]) {
        const result = getHandwritingPresentation({
          isHandwriting: false,
          transparent,
          isDark
        });
        expect(result).toEqual({ frameless: false, invertForDark: false });
      }
    }
  });

  test("opaque (old) handwriting keeps its frame and colours", () => {
    const result = getHandwritingPresentation({
      isHandwriting: true,
      transparent: false,
      isDark: true
    });
    expect(result).toEqual({ frameless: false, invertForDark: false });
  });

  test("unknown transparency is never treated as transparent", () => {
    const result = getHandwritingPresentation({
      isHandwriting: true,
      transparent: undefined,
      isDark: true
    });
    expect(result).toEqual({ frameless: false, invertForDark: false });
  });

  test("transparent handwriting is frameless in light mode", () => {
    const result = getHandwritingPresentation({
      isHandwriting: true,
      transparent: true,
      isDark: false
    });
    expect(result).toEqual({ frameless: true, invertForDark: false });
  });

  test("transparent handwriting inverts in dark mode", () => {
    const result = getHandwritingPresentation({
      isHandwriting: true,
      transparent: true,
      isDark: true
    });
    expect(result).toEqual({ frameless: true, invertForDark: true });
  });
});
