/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2026 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

import { test, expect } from "@nn/test";

test("create, complete, and reopen a standalone Task", async ({ page }) => {
  await page.waitForSelector(".ProseMirror");
  await page
    .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
    .click();

  const tasksView = page.locator('[data-test-id="tasks-view"]');
  await expect(tasksView).toBeVisible();
  await tasksView
    .getByRole("textbox", { name: "Quick Add" })
    .fill("Desktop task smoke");
  await tasksView.getByRole("button", { name: "Add Task" }).last().click();

  await tasksView.getByRole("button", { name: "All" }).click();
  const row = tasksView.locator('[data-test-id="task-row"]', {
    hasText: "Desktop task smoke"
  });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Complete" }).click();

  await tasksView.getByRole("button", { name: "Completed" }).click();
  const completedRow = tasksView.locator('[data-test-id="task-row"]', {
    hasText: "Desktop task smoke"
  });
  await expect(completedRow).toBeVisible();
  await completedRow.click();
  await expect(page.locator('[data-test-id="task-dialog"]')).toBeVisible();
  await expect(page.locator('[data-test-id="task-title"]')).toHaveValue(
    "Desktop task smoke"
  );
});

test("customize a Task List and persist an empty Favorites section", async ({
  page
}) => {
  await page.waitForSelector(".ProseMirror");
  await page
    .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
    .click();
  const tasksView = page.locator('[data-test-id="tasks-view"]');
  await tasksView.getByRole("button", { name: "New List" }).click();
  const editor = page.locator('[data-test-id="task-list-dialog"]');
  await expect(editor).toBeVisible();
  await editor.getByLabel("List name").fill("Studio");
  await editor.getByRole("button", { name: "paintbrush" }).click();
  await editor.getByRole("button", { name: "purple" }).click();
  await editor.getByRole("button", { name: "Create List" }).click();
  await expect(tasksView.getByRole("button", { name: /Studio/ })).toBeVisible();

  await tasksView.getByRole("button", { name: "Edit Favorites" }).click();
  for (const name of ["Today", "Scheduled", "All", "Flagged", "Completed"])
    await tasksView
      .getByRole("button", { name: `Remove from Favorites: ${name}` })
      .click();
  await expect(tasksView.getByText("No favorites selected")).toBeVisible();
  await tasksView
    .getByRole("combobox", { name: "Add to Favorites" })
    .selectOption({ label: "Studio" });
  await tasksView.getByRole("button", { name: "Add to Favorites" }).click();
  await expect(tasksView.getByRole("button", { name: /Studio/ })).toHaveCount(
    2
  );
});
