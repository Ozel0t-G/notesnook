/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2026 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

import { test, expect } from "@nn/test";
import { rm } from "node:fs/promises";
import { buildAndLaunchApp } from "./electron-test/utils";

test("create, schedule, complete, and reopen a standalone Task", async ({
  page
}) => {
  await page.waitForSelector(".ProseMirror");
  await page
    .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
    .click();

  const tasksView = page.locator('[data-test-id="tasks-view"]');
  await expect(tasksView).toBeVisible();
  await tasksView.locator(".veyran-task-primary-button").click();
  const editor = page.locator('[data-test-id="task-dialog"]');
  await expect(editor).toBeVisible();
  await editor
    .locator('[data-test-id="task-title"]')
    .fill("Desktop task smoke");
  await editor
    .getByRole("combobox", { name: "List" })
    .selectOption({ label: "Reminders" });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await editor.getByLabel("Reminder Date").fill(tomorrow);
  await editor.getByLabel("Reminder Time").fill("09:30");
  await editor.getByRole("combobox", { name: "Repeat" }).selectOption("daily");
  await editor.getByRole("combobox", { name: "Priority" }).selectOption("high");
  await editor.getByRole("checkbox", { name: "Flag" }).check();
  await editor.getByRole("button", { name: "Add Task" }).click();

  await tasksView.locator(".veyran-task-source", { hasText: "All" }).click();
  const row = tasksView.locator('[data-test-id="task-row"]', {
    hasText: "Desktop task smoke"
  });
  await expect(row).toBeVisible();
  await row.locator(".veyran-task-row-open").click({ button: "right" });
  await page.locator('[data-test-id="menu-button-edit-task"]').click();
  await expect(editor).toBeVisible();
  await expect(page.locator("body")).not.toHaveAttribute("aria-hidden", "true");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).not.toBeVisible();
  await row.locator(".veyran-task-complete").click();

  await tasksView
    .locator(".veyran-task-source", { hasText: "Completed" })
    .click();
  const completedRow = tasksView.locator('[data-test-id="task-row"]', {
    hasText: "Desktop task smoke"
  });
  await expect(completedRow).toBeVisible();
  await completedRow.locator(".veyran-task-row-open").click();
  await expect(tasksView.locator(".veyran-task-inspector")).toBeVisible();
  await tasksView
    .locator(".veyran-task-inspector .veyran-task-standard-button")
    .click();
  await expect(editor.locator('[data-test-id="task-title"]')).toBeVisible();
  await expect(editor.locator('[data-test-id="task-title"]')).toHaveValue(
    "Desktop task smoke"
  );
  await expect(editor.getByRole("combobox", { name: "Repeat" })).toHaveValue(
    "daily"
  );
  await expect(editor.getByRole("combobox", { name: "Priority" })).toHaveValue(
    "high"
  );
  await expect(editor.getByRole("checkbox", { name: "Flag" })).toBeChecked();
});

test("customize a Task List and manage Favorites", async ({ page }) => {
  const listName = `Studio ${Date.now()}`;
  await page.waitForSelector(".ProseMirror");
  await page
    .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
    .click();
  const tasksView = page.locator('[data-test-id="tasks-view"]');
  await tasksView.getByRole("button", { name: "New List" }).click();
  const editor = page.locator('[data-test-id="task-list-dialog"]');
  await expect(editor).toBeVisible();
  await editor.getByLabel("List name").fill(listName);
  await editor.getByRole("button", { name: "paintbrush" }).click();
  await editor.getByRole("button", { name: "purple" }).click();
  await editor.getByRole("button", { name: "Create List" }).click();
  await expect(
    tasksView.locator(".veyran-task-source", { hasText: listName })
  ).toBeVisible();
  await tasksView
    .locator(".veyran-task-source-wrap", { hasText: listName })
    .locator(".veyran-task-source-more")
    .click();
  await page.locator('[data-test-id="menu-button-edit-list"]').click();
  await expect(editor).toBeVisible();
  const renamed = `${listName} Renamed`;
  await editor.getByLabel("List name").fill(renamed);
  await editor.locator('button[aria-label="blue"]').click();
  await editor.locator("button", { hasText: /^Save/ }).last().click();
  await expect(
    tasksView.locator(".veyran-task-source", { hasText: renamed })
  ).toBeVisible();

  await tasksView
    .locator(".veyran-task-section-heading")
    .first()
    .locator(".veyran-task-icon-button")
    .click();
  await page
    .locator('[data-test-id^="menu-button-"]', { hasText: renamed })
    .click();
  await expect(
    tasksView
      .locator(".veyran-task-source-group")
      .first()
      .locator(".veyran-task-source", { hasText: renamed })
  ).toBeVisible();

  const favorite = tasksView
    .locator(".veyran-task-source-group")
    .first()
    .locator(".veyran-task-source-wrap", { hasText: renamed });
  await favorite
    .locator(".veyran-task-drag-handle")
    .dragTo(
      tasksView
        .locator(".veyran-task-source-group")
        .first()
        .locator(".veyran-task-source-wrap")
        .first()
    );
  await expect(
    tasksView
      .locator(".veyran-task-source-group")
      .first()
      .locator(".veyran-task-source-wrap")
      .first()
  ).toContainText(renamed);
  await favorite.locator(".veyran-task-source-more").click();
  await expect(
    page.locator('[data-test-id="menu-button-move-favorite-up"]')
  ).toBeDisabled();
  await page.locator('[data-test-id="menu-button-move-favorite-down"]').click();
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await page
    .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
    .click();
  await expect(
    page
      .locator(".veyran-task-source-group")
      .first()
      .locator(".veyran-task-source-wrap")
      .nth(1)
  ).toContainText(renamed);
  const persistedFavorite = page
    .locator(".veyran-task-source-group")
    .first()
    .locator(".veyran-task-source-wrap", { hasText: renamed });
  await persistedFavorite.locator(".veyran-task-source-more").click();
  await page.locator('[data-test-id="menu-button-remove-favorite"]').click();
  await expect(persistedFavorite).toHaveCount(0);
  await page
    .locator(".veyran-task-section-heading")
    .first()
    .locator(".veyran-task-icon-button")
    .click();
  await page
    .locator('[data-test-id^="menu-button-"]', { hasText: renamed })
    .click();
  await expect(persistedFavorite).toBeVisible();
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await page
    .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
    .click();
  await expect(
    page
      .locator(".veyran-task-source-group")
      .first()
      .locator(".veyran-task-source", { hasText: renamed })
  ).toBeVisible();
});

test("List appearance, custom Favorite, and Task survive an app restart", async ({
  createUserDataDir
}) => {
  const listName = `Restart List ${Date.now()}`;
  const taskName = `Restart Task ${Date.now()}`;
  const ctx = await buildAndLaunchApp(await createUserDataDir());
  try {
    let page = await ctx.app.firstWindow();
    await page.waitForSelector(".ProseMirror");
    await page
      .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
      .click();
    let tasks = page.locator('[data-test-id="tasks-view"]');
    await tasks.getByRole("button", { name: "New List" }).click();
    let editor = page.locator('[data-test-id="task-list-dialog"]');
    await editor.getByLabel("List name").fill(listName);
    await editor.locator('button[aria-label="paintbrush"]').click();
    await editor.locator('button[aria-label="purple"]').click();
    await editor.getByRole("button", { name: "Create List" }).click();

    await tasks
      .locator(".veyran-task-section-heading")
      .first()
      .locator(".veyran-task-icon-button")
      .click();
    await page
      .locator('[data-test-id^="menu-button-"]', { hasText: listName })
      .click();
    await expect(
      tasks
        .locator(".veyran-task-source-group")
        .first()
        .locator(".veyran-task-source", { hasText: listName })
    ).toBeVisible();
    await tasks
      .locator(".veyran-task-source-group")
      .last()
      .locator(".veyran-task-source", { hasText: listName })
      .click();
    await tasks.getByRole("textbox", { name: "Quick Add" }).fill(taskName);
    await tasks.locator(".veyran-task-quick-submit").click();
    await expect(
      tasks.locator('[data-test-id="task-row"]', { hasText: taskName })
    ).toBeVisible();

    await ctx.app.close();
    await ctx.relaunch();
    page = await ctx.app.firstWindow();
    await page.waitForSelector(".ProseMirror");
    await page
      .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
      .click();
    tasks = page.locator('[data-test-id="tasks-view"]');
    await expect(
      tasks
        .locator(".veyran-task-source-group")
        .first()
        .locator(".veyran-task-source", { hasText: listName })
    ).toBeVisible();
    await tasks
      .locator(".veyran-task-source-group")
      .last()
      .locator(".veyran-task-source", { hasText: listName })
      .click();
    await expect(
      tasks.locator('[data-test-id="task-row"]', { hasText: taskName })
    ).toBeVisible();
    await tasks
      .locator(".veyran-task-source-group")
      .last()
      .locator(".veyran-task-source-wrap", { hasText: listName })
      .locator(".veyran-task-source-more")
      .click();
    await page.locator('[data-test-id="menu-button-edit-list"]').click();
    editor = page.locator('[data-test-id="task-list-dialog"]');
    await expect(
      editor.locator('button[aria-label="paintbrush"]')
    ).toHaveAttribute("aria-pressed", "true");
    await expect(editor.locator('button[aria-label="purple"]')).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  } finally {
    await ctx.app.close().catch(() => undefined);
    await rm(ctx.outputDir, { recursive: true, force: true });
  }
});
