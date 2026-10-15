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

import { describe, it, expect } from "vitest";
import {
  boundContent,
  boundItems,
  boundText,
  CONTENT_LIMITS
} from "../../src/connect/content.js";
import { connectErrorCode } from "./helpers.js";

describe("VeyraN Connect bounded output", () => {
  it("bounds summary strings and reports truncation", () => {
    const short = boundText("hello", 10);
    expect(short).toEqual({ value: "hello", truncated: false });
    const long = boundText("x".repeat(20), 10);
    expect(long.value).toHaveLength(10);
    expect(long.truncated).toBe(true);
    expect(boundText(undefined, 10)).toEqual({ value: "", truncated: false });
  });

  it("bounds collections and reports the untruncated total", () => {
    const items = [1, 2, 3, 4, 5];
    const bounded = boundItems(items, 3);
    expect(bounded.items).toEqual([1, 2, 3]);
    expect(bounded.total).toBe(5);
    expect(bounded.truncated).toBe(true);
    expect(boundItems(items, 10)).toEqual({
      items,
      total: 5,
      truncated: false
    });
  });

  it("fails closed instead of returning a partial note body", () => {
    const withinLimit = "x".repeat(CONTENT_LIMITS.maxResponseContentChars);
    expect(boundContent(withinLimit)).toHaveLength(
      CONTENT_LIMITS.maxResponseContentChars
    );

    const tooLarge = "x".repeat(CONTENT_LIMITS.maxResponseContentChars + 1);
    let caught: unknown;
    try {
      boundContent(tooLarge);
    } catch (error) {
      caught = error;
    }
    // Never a silent prefix: the caller either gets the complete body or an
    // explicit error.
    expect(connectErrorCode(caught)).toBe("CONTENT_TOO_LARGE");
  });

  it("treats missing content as the canonical empty document", () => {
    expect(boundContent(undefined)).toBe("");
  });
});
