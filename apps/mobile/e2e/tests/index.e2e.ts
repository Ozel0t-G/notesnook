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

import { TestBuilder } from "./utils";

describe("APP LAUNCH AND NAVIGATION", () => {
  it("App should launch successfully & hide welcome screen", async () => {
    await TestBuilder.create().prepare().run();
  });

  it("Basic navigation should work", async () => {
    await TestBuilder.create()
      .prepare()
      .navigate("Favorites")
      .navigate("Monographs")
      .navigate("Trash")
      // Reminders is a redirect stub now; Tasks is its own top-level section.
      .openTasks()
      .isVisibleById("task-smart-all")
      .run();
  });

  it("Bottom bar sections should work", async () => {
    if (device.getPlatform() !== "ios") return;
    await TestBuilder.create()
      .prepare()
      // Library is the root of every content route, including All Notes.
      .waitAndTapByLabel("Library")
      .isVisibleByText("Library")
      .waitAndTapByLabel("Search")
      .isVisibleById("global-search-input")
      .waitAndTapByLabel("Tasks")
      .isVisibleById("task-smart-all")
      .waitAndTapByLabel("Library")
      .isVisibleByText("Library")
      .run();
  });

  it("Side menu navigation should work", async () => {
    // The drawer is Android-only now; iOS covers the same ground above.
    if (device.getPlatform() === "ios") return;
    await TestBuilder.create()
      .prepare()
      .openSideMenu()
      .waitAndTapById("sidemenu-settings-icon")
      .wait(500)
      .waitAndTapByText("Settings")
      .isVisibleByText("Settings")
      .pressBack(1)
      .tapById("tab-notebooks")
      .isVisibleByText("No notebooks")
      .tapById("tab-tags")
      .isVisibleByText("No tags")
      .tapById("tab-home")
      .tapByText("Notes")
      .isVisibleByText("Search in Notes")
      .run();
  });
});
