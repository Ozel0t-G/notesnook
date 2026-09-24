import { test, expect } from "@nn/test";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const artifactDir = path.resolve(
  __dirname,
  "../../../artifacts/macos-redesign"
);

test("capture packaged macOS workspace at standard and narrow sizes", async ({
  page,
  electronApp
}) => {
  test.skip(process.platform !== "darwin", "macOS visual validation");
  await mkdir(artifactDir, { recursive: true });
  await page.waitForSelector(".ProseMirror");
  const menuLabels = await electronApp.evaluate(
    (electron) =>
      electron.Menu.getApplicationMenu()?.items.map((item) => item.label) || []
  );
  expect(menuLabels).toContain("VeyraN");
  expect(menuLabels).toContain("File");
  expect(menuLabels).toContain("View");

  const setAppearance = async (appearance: "dark" | "light") => {
    await page.evaluate((value) => {
      localStorage.setItem("colorScheme", JSON.stringify(value));
      localStorage.setItem("followSystemTheme", "false");
    }, appearance);
    await electronApp.evaluate((electron, value) => {
      electron.nativeTheme.themeSource = value;
    }, appearance);
    await page.reload();
    await page.waitForSelector(".ProseMirror");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      appearance
    );
  };
  const setWindowSize = async (width: number, height: number) => {
    await electronApp.evaluate(
      (electron, size) => {
        electron.BrowserWindow.getAllWindows()[0].setSize(
          size.width,
          size.height
        );
      },
      { width, height }
    );
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    expect(page.viewportSize()).toEqual({ width, height });
  };
  const capture = async (name: string) => {
    await page.screenshot({ path: path.join(artifactDir, `${name}.png`) });
  };
  const tasksButton = page.locator('[data-test-id="navigation-item"]', {
    hasText: "Tasks"
  });
  const notesButton = page.locator('[data-test-id="navigation-item"]', {
    hasText: "Notes"
  });

  await setWindowSize(1440, 900);
  await setAppearance("dark");
  const runtimeOs = await page.evaluate(() =>
    (globalThis as unknown as { os?: () => string }).os?.()
  );
  expect(["darwin", "macOS", "mas"]).toContain(runtimeOs);
  await expect(page.locator("html")).toHaveClass(/veyran-mac-window/);
  await expect(page.locator('[data-test-id="Minimize"]')).toHaveCount(0);
  await expect(page.locator('[data-test-id="Maximize"]')).toHaveCount(0);
  await expect(page.locator('[data-test-id="Restore"]')).toHaveCount(0);
  await expect(page.locator('[data-test-id="Close"]')).toHaveCount(0);
  await expect(page.locator('[data-veyran-window-control="true"]')).toHaveCount(
    0
  );
  await capture("macos-dark-notes");
  await tasksButton.click();
  await expect(page.locator('[data-test-id="tasks-view"]')).toBeVisible();
  await capture("macos-dark-tasks");

  await notesButton.click();
  await setAppearance("light");
  await capture("macos-light-notes");
  await tasksButton.click();
  await capture("macos-light-tasks");

  await notesButton.click();
  await setWindowSize(900, 700);
  await capture("macos-narrow-notes");
  await electronApp.evaluate((electron) => {
    electron.BrowserWindow.getAllWindows()[0].webContents.send(
      "veyran:menu-command",
      "show-tasks"
    );
  });
  await expect(page.locator('[data-test-id="tasks-view"]')).toBeVisible();
  await capture("macos-narrow-tasks");

  await setWindowSize(1440, 900);
  await page.evaluate(() => {
    location.hash = "#/settings";
  });
  await expect(page.locator('[data-test-id="settings-dialog"]')).toBeVisible();
  await capture("macos-light-settings");
});

test("capture populated Note and Task inspector", async ({ page }) => {
  test.skip(process.platform !== "darwin", "macOS visual validation");
  await mkdir(artifactDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".ProseMirror");
  await page.locator('[data-test-id="create-new-note"]').click();
  await page.locator('[data-test-id="editor-title"]').last().fill("A Mac note");
  await page
    .locator(".ProseMirror")
    .last()
    .fill("A clear note preview and a calm writing surface.");
  await expect(
    page.locator('[data-test-id="list-item"]', { hasText: "A Mac note" })
  ).toBeVisible();
  await page.screenshot({
    path: path.join(artifactDir, "macos-light-notes-populated.png")
  });

  await page
    .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
    .click();
  const tasks = page.locator('[data-test-id="tasks-view"]');
  await tasks
    .getByRole("textbox", { name: "Quick Add" })
    .fill("Plan the next release");
  await tasks.locator(".veyran-task-quick-submit").click();
  await tasks.locator(".veyran-task-source", { hasText: "All" }).click();
  const row = tasks.locator('[data-test-id="task-row"]', {
    hasText: "Plan the next release"
  });
  await expect(row).toBeVisible();
  await row.locator(".veyran-task-row-open").click();
  await expect(tasks.locator(".veyran-task-inspector")).toBeVisible();
  await page.screenshot({
    path: path.join(artifactDir, "macos-light-task-detail.png")
  });
  await tasks
    .locator(".veyran-task-inspector .veyran-task-standard-button")
    .click();
  await expect(page.locator('[data-test-id="task-title"]')).toBeVisible();
  const sheet = await page
    .locator('[data-test-id="task-dialog"] > div')
    .boundingBox();
  expect(sheet).not.toBeNull();
  expect(sheet!.y).toBeLessThan(90);
  await page.screenshot({
    path: path.join(artifactDir, "macos-light-task-sheet.png")
  });
  await page.locator('[data-test-id="dialog-no"]').click();
  await expect(page.locator('[data-test-id="task-dialog"]')).not.toBeVisible();

  await page.evaluate(() => localStorage.setItem("colorScheme", '"dark"'));
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await page
    .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
    .click();
  await tasks.locator(".veyran-task-source", { hasText: "All" }).click();
  await row.locator(".veyran-task-row-open").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: path.join(artifactDir, "macos-dark-task-detail.png")
  });
  await tasks
    .locator(".veyran-task-inspector .veyran-task-standard-button")
    .click();
  await expect(page.locator('[data-test-id="task-title"]')).toBeVisible();
  await page.screenshot({
    path: path.join(artifactDir, "macos-dark-task-sheet.png")
  });
});

test("Mac split workspace fits medium, wide, and fullscreen windows", async ({
  page,
  electronApp
}) => {
  test.skip(process.platform !== "darwin", "macOS window validation");
  await mkdir(artifactDir, { recursive: true });
  await page.waitForSelector(".ProseMirror");
  await page
    .locator('[data-test-id="navigation-item"]', { hasText: "Tasks" })
    .click();
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080]
  ]) {
    await electronApp.evaluate(
      (electron, size) => {
        electron.BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]);
      },
      [width, height]
    );
    await page.setViewportSize({ width, height });
    await expect(page.locator('[data-test-id="tasks-view"]')).toBeVisible();
    const sizes = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: document.documentElement.clientWidth,
      list:
        document.querySelector(".veyran-task-main")?.getBoundingClientRect()
          .width || 0
    }));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
    expect(sizes.list).toBeGreaterThan(400);
  }
  await page.screenshot({
    path: path.join(artifactDir, "macos-wide-tasks.png")
  });
  await electronApp.evaluate((electron) => {
    electron.BrowserWindow.getAllWindows()[0].setFullScreen(true);
  });
  await expect
    .poll(() =>
      electronApp.evaluate((electron) =>
        electron.BrowserWindow.getAllWindows()[0].isFullScreen()
      )
    )
    .toBe(true);
  await expect(page.locator('[data-test-id="tasks-view"]')).toBeVisible();
  await page.screenshot({
    path: path.join(artifactDir, "macos-fullscreen-tasks.png")
  });
});
