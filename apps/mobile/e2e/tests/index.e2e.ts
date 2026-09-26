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

import { TestBuilder, Tests } from "./utils";
import { expect as jestExpect } from "@jest/globals";

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

  it("New Note returns to the previously selected section", async () => {
    if (device.getPlatform() !== "ios") return;
    await TestBuilder.create().prepare().run();

    await Tests.tapTab("Tasks");
    await waitFor(element(by.id("task-smart-all")))
      .toBeVisible()
      .withTimeout(10000);
    await Tests.tapNewNote();
    await Tests.waitForEditor();
    await Tests.exitEditor();
    await waitFor(element(by.id("task-smart-all")))
      .toBeVisible()
      .withTimeout(10000);

    await Tests.tapTab("Search");
    await waitFor(element(by.id("global-search-input")))
      .toBeVisible()
      .withTimeout(10000);
    await element(by.id("global-search-input")).tapReturnKey();
    await Tests.sleep(500);
    await Tests.tapNewNote();
    await Tests.waitForEditor();
    await Tests.exitEditor();
    await waitFor(element(by.id("global-search-input")))
      .toBeVisible()
      .withTimeout(10000);
    try {
      await element(by.id("global-search-input")).tapReturnKey();
    } catch {
      // The editor return path may already have dismissed the keyboard.
    }
    await Tests.sleep(500);

    await Tests.tapTab("Library");
    await waitFor(element(by.text("All Notes")))
      .toBeVisible()
      .withTimeout(10000);
    await Tests.tapNewNote();
    await Tests.waitForEditor();
    await Tests.exitEditor();
    await waitFor(element(by.text("All Notes")))
      .toBeVisible()
      .withTimeout(10000);
  });

  it("Library opens All Notes and Inbox", async () => {
    if (device.getPlatform() !== "ios") return;
    await TestBuilder.create().prepare().run();
    await waitFor(element(by.text("All Notes")))
      .toBeVisible()
      .withTimeout(10000);
    await waitFor(element(by.text("Inbox")))
      .toBeVisible()
      .withTimeout(10000);
    await device.takeScreenshot("veyran-library");
    await element(by.text("All Notes")).tap();
    await waitFor(element(by.text("All Notes")))
      .toBeVisible()
      .withTimeout(10000);
    await device.takeScreenshot("veyran-all-notes");
    await element(by.id("library-collection-back")).tap();
    await element(by.text("Inbox")).tap();
    await waitFor(element(by.text("Inbox")))
      .toBeVisible()
      .withTimeout(10000);
    await device.takeScreenshot("veyran-inbox");
  });

  it("an Inbox note saves and reopens with its content", async () => {
    if (device.getPlatform() !== "ios") return;
    await TestBuilder.create().prepare().run();
    await element(by.text("Inbox")).tap();
    await Tests.tapNewNote();
    await Tests.waitForEditor();
    const body = "Inbox content survives save and reopen";
    const editor = web().element(by.web.className("ProseMirror"));
    await editor.focus();
    await editor.typeText(body, true);
    await Tests.exitEditor();
    const savedRow = element(by.id("note-item-0"));
    await waitFor(savedRow).toBeVisible().withTimeout(15000);
    await savedRow.tap();
    await Tests.waitForEditor();
    jestExpect(
      await web().element(by.web.className("ProseMirror")).getText()
    ).toContain(body);
    await device.takeScreenshot("veyran-inbox-reopened-note");
  });

  it("Tasks settings row describes its iOS destination", async () => {
    if (device.getPlatform() !== "ios") return;
    await TestBuilder.create().prepare().run();
    await element(by.label("Settings")).tap();
    await waitFor(element(by.text("Appearance")))
      .toBeVisible()
      .withTimeout(10000);
    const taskSettings = element(by.id("task-notifications-ios"));
    await element(by.id("settings-list")).swipe("up", "slow", 0.8);
    await element(by.id("settings-list")).swipe("up", "slow", 0.8);
    await waitFor(taskSettings).toBeVisible().withTimeout(10000);
    await expect(element(by.text("Open VeyraN settings in iOS"))).toBeVisible();
    await device.takeScreenshot("veyran-task-settings-row");
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
