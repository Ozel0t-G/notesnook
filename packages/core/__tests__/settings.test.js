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

import { databaseTest } from "./utils/index.ts";
import { test, expect, vi } from "vitest";

test("save group options", () =>
  databaseTest().then(async (db) => {
    const groupOptions = {
      groupBy: "abc",
      sortBy: "dateCreated",
      sortDirection: "asc"
    };
    await db.settings.setGroupOptions("home", groupOptions);
    expect(db.settings.getGroupOptions("home")).toMatchObject(groupOptions);
  }));

test("default group options: grouping on only for home", () =>
  databaseTest().then(async (db) => {
    expect(db.settings.getGroupOptions("home")).toEqual({
      groupBy: "default",
      sortBy: "dateEdited",
      sortDirection: "desc"
    });
  }));

test("default group options: note lists don't group by default", () =>
  databaseTest().then(async (db) => {
    expect(db.settings.getGroupOptions("notes")).toEqual({
      groupBy: "none",
      sortBy: "dateEdited",
      sortDirection: "desc"
    });
    expect(db.settings.getGroupOptions("favorites")).toEqual({
      groupBy: "none",
      sortBy: "dateEdited",
      sortDirection: "desc"
    });
    expect(db.settings.getGroupOptions("archive")).toEqual({
      groupBy: "none",
      sortBy: "dateEdited",
      sortDirection: "desc"
    });
    expect(db.settings.getGroupOptions("trash")).toEqual({
      groupBy: "none",
      sortBy: "dateDeleted",
      sortDirection: "desc"
    });
    expect(db.settings.getGroupOptions("search")).toEqual({
      groupBy: "none",
      sortBy: "relevance",
      sortDirection: "desc"
    });
  }));

test("default group options: list organization grouping unchanged", () =>
  databaseTest().then(async (db) => {
    expect(db.settings.getGroupOptions("notebooks")).toEqual({
      groupBy: "default",
      sortBy: "dateEdited",
      sortDirection: "desc"
    });
    expect(db.settings.getGroupOptions("tags")).toEqual({
      groupBy: "default",
      sortBy: "dateCreated",
      sortDirection: "desc"
    });
    expect(db.settings.getGroupOptions("reminders")).toEqual({
      groupBy: "default",
      sortBy: "dueDate",
      sortDirection: "asc"
    });
  }));

test("explicit saved group options are honored", () =>
  databaseTest().then(async (db) => {
    for (const key of ["notes", "favorites", "archive", "trash"]) {
      const groupOptions = {
        groupBy: "year",
        sortBy: "title",
        sortDirection: "asc"
      };
      await db.settings.setGroupOptions(key, groupOptions);
      expect(db.settings.getGroupOptions(key)).toEqual(groupOptions);
    }
  }));

test("save toolbar config", () =>
  databaseTest().then(async (db) => {
    const toolbarConfig = {
      preset: "custom",
      config: ["bold", "italic"]
    };
    await db.settings.setToolbarConfig("mobile", toolbarConfig);
    expect(db.settings.getToolbarConfig("mobile")).toMatchObject(toolbarConfig);
  }));

test("save trash cleanup interval", () =>
  databaseTest().then(async (db) => {
    const interval = 7;
    await db.settings.setTrashCleanupInterval(interval);
    expect(db.settings.getTrashCleanupInterval()).toBe(interval);
  }));

const GROUP_OPTIONS_BY_ID_TESTS = ["notebook", "tag", "color"];

for (const type of GROUP_OPTIONS_BY_ID_TESTS) {
  test(`get ${type} id group options`, () =>
    databaseTest().then(async (db) => {
      const id = `test-${type}-id`;
      const groupOptions = {
        groupBy: "year",
        sortBy: "title",
        sortDirection: "asc"
      };
      await db.settings.setGroupOptionsById(id, type, groupOptions);
      expect(db.settings.getGroupOptionsById(id, type)).toMatchObject(
        groupOptions
      );
    }));
}

// Tags and colors keep the plain notes fallback.
for (const type of ["tag", "color"]) {
  test(`get ${type} id group options fallback to notes group options`, () =>
    databaseTest().then(async (db) => {
      const id = `non-existent-${type}-id`;
      const defaultOptions = db.settings.getGroupOptions("notes");
      const result = db.settings.getGroupOptionsById(id, type);
      expect(result).toMatchObject(defaultOptions);
    }));
}

test("get notebook id group options fallback to ungrouped notes options", () =>
  databaseTest().then(async (db) => {
    const defaultOptions = db.settings.getGroupOptions("notes");
    const result = db.settings.getGroupOptionsById(
      "non-existent-notebook-id",
      "notebook"
    );
    expect(result).toEqual({
      groupBy: "none",
      sortBy: defaultOptions.sortBy,
      sortDirection: defaultOptions.sortDirection
    });
  }));

test("notebook fallback inherits the saved notes sort", () =>
  databaseTest().then(async (db) => {
    await db.settings.setGroupOptions("notes", {
      groupBy: "default",
      sortBy: "title",
      sortDirection: "asc"
    });
    expect(
      db.settings.getGroupOptionsById("unsaved-notebook-sort", "notebook")
    ).toEqual({
      groupBy: "none",
      sortBy: "title",
      sortDirection: "asc"
    });
  }));

test("saved notebook override wins over the ungrouped fallback", () =>
  databaseTest().then(async (db) => {
    const override = {
      groupBy: "year",
      sortBy: "dateCreated",
      sortDirection: "asc"
    };
    await db.settings.setGroupOptionsById(
      "notebook-with-override",
      "notebook",
      override
    );
    expect(
      db.settings.getGroupOptionsById("notebook-with-override", "notebook")
    ).toEqual(override);
  }));

test("notebook override is isolated from sibling notebooks", () =>
  databaseTest().then(async (db) => {
    const override = {
      groupBy: "year",
      sortBy: "title",
      sortDirection: "asc"
    };
    await db.settings.setGroupOptionsById(
      "sibling-notebook-a",
      "notebook",
      override
    );
    expect(
      db.settings.getGroupOptionsById("sibling-notebook-a", "notebook")
    ).toEqual(override);

    const defaultOptions = db.settings.getGroupOptions("notes");
    expect(
      db.settings.getGroupOptionsById("sibling-notebook-b", "notebook")
    ).toEqual({
      groupBy: "none",
      sortBy: defaultOptions.sortBy,
      sortDirection: defaultOptions.sortDirection
    });
  }));

test("home stays grouped and generic notes is ungrouped", () =>
  databaseTest().then(async (db) => {
    expect(db.settings.getGroupOptions("home").groupBy).toBe("default");
    expect(db.settings.getGroupOptions("notes").groupBy).toBe("none");
  }));

test("failed setGroupOptionsById does not leak into cache or defaults", () =>
  databaseTest().then(async (db) => {
    const override = {
      groupBy: "year",
      sortBy: "title",
      sortDirection: "asc"
    };
    // A successful sibling write must survive the later failure.
    await db.settings.setGroupOptionsById("sibling-notebook", "notebook", override);

    const upsert = vi
      .spyOn(db.settings.collection, "upsert")
      .mockRejectedValueOnce(new Error("write failed"));
    try {
      await expect(
        db.settings.setGroupOptionsById("failed-notebook", "notebook", {
          groupBy: "month",
          sortBy: "dateCreated",
          sortDirection: "asc"
        })
      ).rejects.toThrow("write failed");
    } finally {
      upsert.mockRestore();
    }

    // The rejected override must not be visible for its id...
    expect(
      db.settings.getGroupOptionsById("failed-notebook", "notebook")
    ).toEqual({
      groupBy: "none",
      sortBy: "dateEdited",
      sortDirection: "desc"
    });
    // ...nor must it corrupt the sibling that was written before.
    expect(
      db.settings.getGroupOptionsById("sibling-notebook", "notebook")
    ).toEqual(override);
  }));

test("getGroupOptionsById ignores inherited object properties", () =>
  databaseTest().then(async (db) => {
    const inheritedIds = ["__proto__", "constructor", "toString", "hasOwnProperty"];
    for (const type of GROUP_OPTIONS_BY_ID_TESTS) {
      for (const id of inheritedIds) {
        const result = db.settings.getGroupOptionsById(id, type);
        expect(result.groupBy).toBe("none");
        expect(result.sortBy).toBe("dateEdited");
        expect(result.sortDirection).toBe("desc");
      }
    }
  }));

test("setGroupOptionsById with __proto__ id does not pollute Object.prototype", () =>
  databaseTest().then(async (db) => {
    const override = {
      groupBy: "year",
      sortBy: "title",
      sortDirection: "asc"
    };
    await db.settings.setGroupOptionsById("__proto__", "notebook", override);

    expect(Object.prototype.groupBy).toBeUndefined();
    expect({}.groupBy).toBeUndefined();
    // Stored as an own key, so it is returned for that id...
    expect(db.settings.getGroupOptionsById("__proto__", "notebook")).toEqual(
      override
    );
    // ...without leaking onto other ids.
    expect(
      db.settings.getGroupOptionsById("unrelated-notebook", "notebook").groupBy
    ).toBe("none");
  }));
