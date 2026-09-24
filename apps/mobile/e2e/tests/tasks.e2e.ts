/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

import { expect as detoxExpect } from "detox";
import { notesnook } from "../test.ids";
import { TestBuilder } from "./utils";

describe("TASKS", () => {
  it("quick adds a standalone Task and keeps it in Completed", async () => {
    const title = `Task smoke ${Date.now()}`;
    await TestBuilder.create().prepare().run();
    await element(by.id(notesnook.ids.default.header.buttons.left)).tap();
    await waitFor(element(by.id("Tasks"))).toBeVisible().withTimeout(5000);
    await element(by.id("Tasks")).tap();
    await waitFor(element(by.id("task-smart-all"))).toBeVisible().withTimeout(10000);
    // The card becomes visible before the native push transition has finished.
    await new Promise((resolve) => setTimeout(resolve, 750));
    await element(by.id("task-smart-all")).tap();
    await waitFor(element(by.id("task-quick-add-input")))
      .toBeVisible()
      .withTimeout(10000);
    await element(by.id("task-quick-add-input")).typeText(title);
    await element(by.id("task-quick-add-input")).tapReturnKey();
    await detoxExpect(element(by.text(title))).toBeVisible();
    await element(by.label(`Complete: ${title}`)).tap();
    await element(by.label("Back")).tap();
    await element(by.text("Completed")).tap();
    await detoxExpect(element(by.text(title))).toBeVisible();
  });
});
