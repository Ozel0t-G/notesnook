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

const mockSetWindowTitle = jest.fn();

jest.mock("react-native", () => ({
  NativeModules: {
    VeyraNMacMenu: {
      setWindowTitle: (title: string, subtitle: string) =>
        mockSetWindowTitle(title, subtitle)
    }
  }
}));

import { NativeModules } from "react-native";
import {
  applyMacWindowTitle,
  resolveMacWindowTitle,
  setMacWindowTitle,
  useMacListTitleStore
} from "./mac-window-title";

describe("Mac window title", () => {
  beforeEach(() => {
    mockSetWindowTitle.mockClear();
  });

  test("names the focused list when no note is open", () => {
    expect(
      resolveMacWindowTitle({
        section: "library",
        sectionTitle: "Library",
        listTitle: "Notebooks"
      })
    ).toEqual({ title: "Notebooks", subtitle: "" });
  });

  test("shows the list's count line as the subtitle", () => {
    expect(
      resolveMacWindowTitle({
        section: "library",
        sectionTitle: "Library",
        listTitle: "All Notes",
        countLabel: "12 notes"
      })
    ).toEqual({ title: "All Notes", subtitle: "12 notes" });
  });

  test("names the selected Task list, with its count line as the subtitle", () => {
    expect(
      resolveMacWindowTitle({
        section: "tasks",
        sectionTitle: "Tasks",
        listTitle: "Today",
        countLabel: "4 tasks"
      })
    ).toEqual({ title: "Today", subtitle: "4 tasks" });
  });

  test("names the Tasks and Search sections themselves without a list", () => {
    expect(
      resolveMacWindowTitle({
        section: "tasks",
        sectionTitle: "Tasks",
        countLabel: "4 tasks"
      })
    ).toEqual({ title: "Tasks", subtitle: "4 tasks" });
    expect(
      resolveMacWindowTitle({
        section: "search",
        sectionTitle: "Search",
        listTitle: "All Notes",
        countLabel: "12 notes"
      })
    ).toEqual({ title: "Search", subtitle: "" });
  });

  test("keeps the list's own name as the title, whatever note is open", () => {
    // The window title is always the focused list/section; the open note's
    // title is not part of the resolver's inputs any more.
    expect(
      resolveMacWindowTitle({
        section: "library",
        sectionTitle: "Library",
        listTitle: "All Notes",
        countLabel: "3 notes"
      })
    ).toEqual({ title: "All Notes", subtitle: "3 notes" });
  });

  test("has nothing to show without a list", () => {
    expect(
      resolveMacWindowTitle({ section: "library", sectionTitle: "Library" })
    ).toBeUndefined();
  });

  test("pushes the resolved title and count line to the native window", () => {
    const applied = applyMacWindowTitle({
      section: "library",
      sectionTitle: "Library",
      listTitle: "Notebooks",
      countLabel: "12 notes"
    });

    expect(applied).toBe(true);
    expect(mockSetWindowTitle).toHaveBeenCalledWith("Notebooks", "12 notes");
  });

  test("does not touch the window when there is nothing to show", () => {
    const applied = applyMacWindowTitle({
      section: "library",
      sectionTitle: "Library"
    });

    expect(applied).toBe(false);
    expect(mockSetWindowTitle).not.toHaveBeenCalled();
  });

  test("is a no-op when the native module is not linked", () => {
    const native = NativeModules as unknown as Record<string, unknown>;
    const nativeModule = native.VeyraNMacMenu;
    native.VeyraNMacMenu = undefined;
    try {
      setMacWindowTitle("Anything", "Somewhere");
    } finally {
      native.VeyraNMacMenu = nativeModule;
    }

    expect(mockSetWindowTitle).not.toHaveBeenCalled();
  });
});

describe("Mac focused list title", () => {
  afterEach(() => {
    useMacListTitleStore.getState().setListTitle(undefined);
    mockSetWindowTitle.mockClear();
  });

  test("publishes the list header's title and count, and clears both again", () => {
    useMacListTitleStore.getState().setListTitle("Notebooks", 12);
    expect(useMacListTitleStore.getState().listTitle).toBe("Notebooks");
    expect(useMacListTitleStore.getState().listCount).toBe(12);

    useMacListTitleStore.getState().setListTitle(undefined);
    expect(useMacListTitleStore.getState().listTitle).toBeUndefined();
    expect(useMacListTitleStore.getState().listCount).toBeUndefined();
  });

  test("the published title names the window, the count the subtitle", () => {
    useMacListTitleStore.getState().setListTitle("Notebooks", 12);

    const applied = applyMacWindowTitle({
      section: "library",
      sectionTitle: "Library",
      listTitle: useMacListTitleStore.getState().listTitle,
      countLabel: "12 notes"
    });

    expect(applied).toBe(true);
    expect(mockSetWindowTitle).toHaveBeenCalledWith("Notebooks", "12 notes");
  });

  test("the Tasks screen's list title is the window title, its count the subtitle", () => {
    useMacListTitleStore.getState().setListTitle("Today", 4);

    const applied = applyMacWindowTitle({
      section: "tasks",
      sectionTitle: "Tasks",
      listTitle: useMacListTitleStore.getState().listTitle,
      countLabel: "4 tasks"
    });

    expect(applied).toBe(true);
    expect(mockSetWindowTitle).toHaveBeenCalledWith("Today", "4 tasks");
  });
});
