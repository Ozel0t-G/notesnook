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
  addRecentSearch,
  MAX_RECENT_SEARCHES,
  sanitizeRecentSearches
} from "./search-recents";

describe("addRecentSearch", () => {
  it("puts the newest term first", () => {
    expect(addRecentSearch(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("moves an existing term to the front without duplicating it", () => {
    expect(addRecentSearch(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  it("matches case-insensitively but keeps the typed form", () => {
    expect(addRecentSearch(["Notes"], "notes")).toEqual(["notes"]);
  });

  it("trims the term", () => {
    expect(addRecentSearch([], "  hello  ")).toEqual(["hello"]);
  });

  it("ignores a whitespace-only query and returns the same list", () => {
    const list = ["a"];
    expect(addRecentSearch(list, "   ")).toBe(list);
  });

  it("caps the list, newest first", () => {
    const list = Array.from(
      { length: MAX_RECENT_SEARCHES },
      (_, index) => `t${index}`
    );
    const next = addRecentSearch(list, "newest");
    expect(next).toHaveLength(MAX_RECENT_SEARCHES);
    expect(next[0]).toBe("newest");
    expect(next).not.toContain(`t${MAX_RECENT_SEARCHES - 1}`);
  });
});

describe("sanitizeRecentSearches", () => {
  it("returns an empty list for non-arrays", () => {
    expect(sanitizeRecentSearches(null)).toEqual([]);
    expect(sanitizeRecentSearches("nope")).toEqual([]);
    expect(sanitizeRecentSearches(undefined)).toEqual([]);
  });

  it("drops empty and non-string entries", () => {
    expect(sanitizeRecentSearches(["a", 1, "  ", null, "b"])).toEqual([
      "a",
      "b"
    ]);
  });

  it("de-duplicates case-insensitively and caps", () => {
    const value = [
      "a",
      "A",
      "b",
      ...Array.from({ length: 10 }, (_, index) => `x${index}`)
    ];
    const result = sanitizeRecentSearches(value);
    expect(result[0]).toBe("a");
    expect(result).toHaveLength(MAX_RECENT_SEARCHES);
    expect(
      result.filter((term) => term.toLocaleLowerCase() === "a")
    ).toHaveLength(1);
  });
});
