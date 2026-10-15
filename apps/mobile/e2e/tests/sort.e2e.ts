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

import { notesnook } from "../test.ids";
import { TestBuilder, Tests } from "./utils";

// iOS uses the existing native More submenus; Android retains its sort sheet.
const openListOptions = (section: "Sort By" | "Group By") => async () => {
  if (device.getPlatform() !== "ios") {
    await Tests.fromId("icon-sort").waitAndTap();
    return;
  }
  await Tests.fromId("header-more-menu").waitAndTap();
  await Tests.fromText(section).waitAndTap();
};
const closeSortSheet = async () => {
  if (device.getPlatform() !== "ios") await device.pressBack();
};
const checkSortedList = async () => {
  if (device.getPlatform() === "ios") {
    await Tests.fromText("Note 1").isVisible(5000);
  } else {
    await Tests.fromId(notesnook.listitem.menu).waitAndTap();
    await device.pressBack();
  }
};
const toggleListStyle = (label: string) => async () => {
  if (device.getPlatform() !== "ios") {
    await Tests.fromId("icon-compact-mode").waitAndTap();
    return;
  }
  await Tests.fromId("header-more-menu").waitAndTap();
  await Tests.fromText(label).waitAndTap();
};

describe("Sort & filter", () => {
  it("Sort by date-edited/date-created", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote("Note 1", "Note 1")
      .createNote("Note 2", "Note 2")
      .waitAndTapByText("Note 1")
      .addStep(async () => {
        const webview = web();
        await webview.element(by.web.className("ProseMirror")).tap();
        await webview
          .element(by.web.className("ProseMirror"))
          .typeText("Edited ", true);
      })
      .pressBack(2)
      .addStep(openListOptions("Sort By"))
      .wait(500)
      .waitAndTapByText("Date created")
      .addStep(closeSortSheet)
      .addStep(checkSortedList)
      .addStep(openListOptions("Sort By"))
      .wait(500)
      .waitAndTapByText("Date edited")
      .addStep(closeSortSheet)
      .addStep(checkSortedList)
      .run();
  });

  it("Disable grouping", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote("Note 1", "Note 1")
      .addStep(openListOptions("Group By"))
      .wait(500)
      .waitAndTapByText("None")
      .addStep(closeSortSheet)
      .addStep(async () => {
        if (device.getPlatform() === "ios") {
          // The redundant All section is intentionally hidden on Apple lists.
          await Tests.fromText("Note 1").isVisible(5000);
          await Tests.fromText("Today").isNotVisible();
        } else await Tests.fromText("ALL").isVisible();
      })
      .run();
  });

  it("Group by Abc", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote("Note 1", "Note 1")
      .addStep(openListOptions("Group By"))
      .wait(500)
      .waitAndTapByText("Abc")
      .addStep(closeSortSheet)
      .isVisibleByText("N")
      .run();
  });

  it("Group by Year", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote("Note 1", "Note 1")
      .addStep(openListOptions("Group By"))
      .wait(500)
      .waitAndTapByText("Year")
      .run();
  });

  it("Group by Week", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote("Note 1", "Note 1")
      .addStep(openListOptions("Group By"))
      .wait(500)
      .waitAndTapByText("Week")
      .run();
  });

  it("Group by Month", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote("Note 1", "Note 1")
      .addStep(openListOptions("Group By"))
      .wait(500)
      .waitAndTapByText("Month")
      .run();
  });

  it("Compact mode", async () => {
    await TestBuilder.create()
      .prepare()
      .createNote("Note 1", "Note 1")
      .addStep(toggleListStyle("View as Compact List"))
      .addStep(async () => {
        if (device.getPlatform() !== "ios")
          await Tests.fromText("Note 1").isNotVisible();
      })
      .addStep(toggleListStyle("View with Previews"))
      .isVisibleByText("Note 1")
      .run();
  });
});
