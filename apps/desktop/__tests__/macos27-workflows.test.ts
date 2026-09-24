import { test, expect } from "@nn/test";

test("new Note remains visible, saves, and reopens with content", async ({
  page
}) => {
  const title = `Mac redesign note ${Date.now()}`;
  const body = "VeyraN macOS redesign validation";
  await page.waitForSelector(".ProseMirror");
  await page.locator('[data-test-id="create-new-note"]').click();
  const titleField = page.locator('[data-test-id="editor-title"]').last();
  await expect(titleField).toBeVisible();
  await titleField.fill(title);
  const editor = page.locator(".ProseMirror").last();
  await expect(editor).toBeVisible();
  await editor.fill(body);
  await expect(editor).toContainText(body);
  await expect(
    page.locator('[data-test-id="list-item"]', { hasText: title })
  ).toBeVisible();

  await page
    .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
    .click();
  await expect(page.locator('[data-test-id="tasks-view"]')).toBeVisible();
  await page
    .locator('[data-test-id="navigation-item"]', { hasText: "Notes" })
    .click();
  await page.locator('[data-test-id="list-item"]', { hasText: title }).click();
  await expect(
    page.locator('[data-test-id="editor-title"]').last()
  ).toHaveValue(title);
  await expect(page.locator(".ProseMirror").last()).toContainText(body);
});

test("VeyraN Task link reaches the standalone workspace", async ({
  page,
  electronApp
}) => {
  await page.waitForSelector(".ProseMirror");
  await electronApp.evaluate((electron) => {
    electron.app.emit(
      "open-url",
      { preventDefault() {} } as Electron.Event,
      "veyran://tasks"
    );
  });
  await expect(page.locator('[data-test-id="tasks-view"]')).toBeVisible();
  const taskBounds = await page
    .locator('[data-test-id="tasks-view"]')
    .boundingBox();
  expect(taskBounds).not.toBeNull();
  expect(taskBounds!.x + taskBounds!.width).toBeGreaterThanOrEqual(
    (page.viewportSize()?.width || 0) - 20
  );
});

test("Focus Mode keeps Tasks visible and menu New Note returns to the editor", async ({
  page,
  electronApp
}) => {
  test.skip(process.platform !== "darwin", "macOS shell behavior");
  await page.waitForSelector(".ProseMirror");
  await page.getByTitle(/focus mode/i).click();
  await expect(page.locator("#app")).toHaveClass(/app-focus-mode/);

  await electronApp.evaluate((electron) => {
    electron.BrowserWindow.getAllWindows()[0].webContents.send(
      "veyran:menu-command",
      "show-tasks"
    );
  });
  await expect(page.locator('[data-test-id="tasks-view"]')).toBeVisible();
  await expect(page.locator("#list-pane")).toBeVisible();
  await expect(page.locator("#editor-pane")).toHaveCount(1);
  await expect(page.locator('[data-test-id="editor-word-count"]')).toHaveCount(
    0
  );

  await electronApp.evaluate((electron) => {
    electron.BrowserWindow.getAllWindows()[0].webContents.send(
      "veyran:menu-command",
      "new-note"
    );
  });
  await expect(page).toHaveURL(/\/notes(?:#|$)/);
  await expect(
    page.locator('[data-test-id="editor-title"]').last()
  ).toBeVisible();
  await expect(page.locator(".ProseMirror").last()).toBeVisible();
});

test("Mac New Note shortcut leaves Tasks and opens a visible editor", async ({
  page
}) => {
  test.skip(process.platform !== "darwin", "macOS shortcut behavior");
  await page.waitForSelector(".ProseMirror");
  await page
    .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
    .click();
  await expect(page.locator('[data-test-id="tasks-view"]')).toBeVisible();
  await page.keyboard.press("Meta+N");
  await expect(page).toHaveURL(/\/notes(?:#|$)/);
  await expect(
    page.locator('[data-test-id="editor-title"]').last()
  ).toBeVisible();
  await expect(page.locator(".ProseMirror").last()).toBeVisible();
});

test("narrow Mac sidebar retains its rail and can expand", async ({
  page,
  electronApp
}) => {
  test.skip(process.platform !== "darwin", "macOS shell behavior");
  await page.waitForSelector(".ProseMirror");
  await electronApp.evaluate((electron) => {
    electron.BrowserWindow.getAllWindows()[0].setSize(900, 700);
  });
  await page.setViewportSize({ width: 900, height: 700 });
  const sidebar = page.locator("#nav-pane");
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(50);

  await electronApp.evaluate((electron) => {
    electron.BrowserWindow.getAllWindows()[0].webContents.send(
      "veyran:menu-command",
      "toggle-sidebar"
    );
  });
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width || 0)
    .toBeGreaterThan(150);
  await expect(page.locator("#list-pane")).toBeVisible();
});

test("native-titlebar setting removes the traffic-light gutter", async ({
  page
}) => {
  test.skip(process.platform !== "darwin", "macOS titlebar behavior");
  await page.waitForSelector(".ProseMirror");
  const brand = page.locator(".veyran-sidebar-brand");
  await expect(brand).toBeVisible();
  const padding = () =>
    brand.evaluate((element) => getComputedStyle(element).paddingLeft);
  expect(await padding()).toBe("76px");
  await page.evaluate(() =>
    document.documentElement.classList.add("veyran-mac-native-titlebar")
  );
  expect(await padding()).toBe("8px");
});
