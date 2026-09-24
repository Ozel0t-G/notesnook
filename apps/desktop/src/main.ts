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

import "./overrides";
import { app, BrowserWindow, nativeTheme, shell, dialog } from "electron";
import { isDevelopment } from "./utils";
import { registerProtocol, PROTOCOL_URL } from "./utils/protocol";
import { configureAutoUpdater } from "./utils/autoupdater";
import { getBackgroundColor, getTheme, setTheme } from "./utils/theme";
import { setupApplicationMenu, setupMenu } from "./utils/menu";
import { WindowState } from "./utils/window-state";
import { setupJumplist } from "./utils/jumplist";
import { setupTray } from "./utils/tray";
import { CLIOptions, parseArguments } from "./cli";
import { AssetManager } from "./utils/asset-manager";
import { createIPCHandler } from "electron-trpc/main";
import { router, api } from "./api";
import { config } from "./utils/config";
import path from "path";
import { bringToFront } from "./utils/bring-to-front";
import { bridge } from "./api/bridge";
import { setupDesktopIntegration } from "./utils/desktop-integration";
import { disableCustomDns, enableCustomDns } from "./utils/custom-dns";
import { Messages, setI18nGlobal } from "@notesnook/intl";
import { i18n } from "@lingui/core";
import { PATHS } from "./constants";
import { normalizePathString } from "./utils/resolve-path";
import { taskReminderScheduler } from "./utils/task-reminder-scheduler";

const locale =
  process.env.NODE_ENV === "development"
    ? import("@notesnook/intl/locales/$pseudo-LOCALE.json")
    : import("@notesnook/intl/locales/$en.json");
locale.then(({ default: locale }) => {
  i18n.load({
    en: locale.messages as unknown as Messages
  });
  i18n.activate("en");
});
// Desktop and intl can resolve separate copies of the same Lingui version.
// Their private class fields make TypeScript treat the identical runtime API
// as nominally different, so bridge that package boundary explicitly.
setI18nGlobal(i18n as unknown as Parameters<typeof setI18nGlobal>[0]);

const appHostnames = isDevelopment()
  ? ["localhost", "127.0.0.1"]
  : ["app.notesnook.com"];
// Pending nn:// link to open once the window is ready (used on Windows/Linux
// when the app is launched via the nn:// protocol for the first time).
let pendingNNLink: string | undefined = findInternalLink(process.argv);
let pendingTaskPath: string | undefined = process.argv
  .map(parseVeyraNTaskRoute)
  .find(Boolean);
let taskRendererReady = false;
let taskRouteQueue = Promise.resolve();
let creatingWindow: Promise<void> | undefined;

taskReminderScheduler.setActivationHandler((id) => {
  if (!/^(?:[a-f0-9]{24}|[a-f0-9]{32})$/i.test(id)) return;
  pendingTaskPath = `/tasks#/tasks/${encodeURIComponent(id)}/edit`;
  void openPendingTask();
});
taskReminderScheduler.setSnapshotHandler(() => {
  taskRendererReady = true;
  void routePendingTask();
});

async function ensureWindow() {
  if (globalThis.window) return;
  if (!creatingWindow)
    creatingWindow = createWindow().finally(() => {
      creatingWindow = undefined;
    });
  await creatingWindow;
}

async function openPendingTask() {
  try {
    await ensureWindow();
    bringToFront();
    await routePendingTask();
  } catch {
    console.error("Failed to open Task notification");
  }
}

function routePendingTask() {
  // Serialize rapid URL/notification activations so the latest route wins.
  taskRouteQueue = taskRouteQueue.then(
    applyPendingTaskRoute,
    applyPendingTaskRoute
  );
  return taskRouteQueue;
}

async function applyPendingTaskRoute() {
  const destination = pendingTaskPath;
  const window = globalThis.window;
  if (!destination || !window || !taskRendererReady) return;
  bringToFront();
  const script = `window.history.replaceState(null, "", ${JSON.stringify(
    destination
  )}); window.dispatchEvent(new PopStateEvent("popstate")); window.dispatchEvent(new HashChangeEvent("hashchange"));`;
  try {
    await window.webContents.executeJavaScript(script);
    if (pendingTaskPath === destination) pendingTaskPath = undefined;
  } catch {
    console.error("Failed to route Task notification");
  }
}

// only run a single instance
if (!MAC_APP_STORE && !app.requestSingleInstanceLock()) {
  console.log("Another instance is already running!");
  app.exit();
}

if (process.platform == "win32" && process.env.PORTABLE_EXECUTABLE_DIR) {
  console.log("Portable app: true");
  const root = path.join(process.env.PORTABLE_EXECUTABLE_DIR, "Notesnook");
  app.setPath("appData", path.join(root, "AppData"));
  app.setPath("documents", path.join(root, "Documents"));
  app.setPath("userData", path.join(root, "UserData"));
}

if (process.platform === "win32") {
  app.setAppUserModelId(app.name);
}

process.on("uncaughtException", (error) => {
  console.error("uncaughtException:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

app.commandLine.appendSwitch("lang", "en-US");

async function createWindow() {
  taskRendererReady = false;
  const cliOptions = await parseArguments(process.argv);
  setTheme(getTheme());

  // this workaround is necessary because macos doesn't support
  // the --hidden flag when launching the app on startup
  if (
    process.platform === "darwin" &&
    app.getLoginItemSettings().wasOpenedAtLogin &&
    config.desktopSettings.autoStart &&
    config.desktopSettings.startMinimized
  ) {
    cliOptions.hidden = true;
  }

  const mainWindowState = new WindowState(
    process.platform === "darwin"
      ? { defaultWidth: 1280, defaultHeight: 800 }
      : {}
  );
  const mainWindow = new BrowserWindow({
    show: !cliOptions.hidden,
    paintWhenInitiallyHidden: cliOptions.hidden,
    skipTaskbar: cliOptions.hidden,
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: process.platform === "darwin" ? 820 : undefined,
    minHeight: process.platform === "darwin" ? 560 : undefined,
    darkTheme: getTheme() === "dark",
    // Keep a solid startup canvas. A transparent BrowserWindow exposes resize
    // and shadow artifacts before the renderer is ready; pane materials remain
    // renderer-scoped even when macOS supplies the native backdrop below them.
    backgroundColor:
      process.platform === "darwin" && getTheme() === "system"
        ? nativeTheme.shouldUseDarkColors
          ? "#1d2025"
          : "#f7f8fa"
        : getBackgroundColor(),
    opacity: 0,
    autoHideMenuBar: false,
    icon: AssetManager.appIcon({
      size: 512,
      format: process.platform === "win32" ? "ico" : "png"
    }),

    ...(config.desktopSettings.nativeTitlebar
      ? {}
      : {
          titleBarStyle:
            process.platform === "win32" || process.platform === "darwin"
              ? "hidden"
              : "default",
          frame: process.platform === "win32" || process.platform === "darwin",
          // Window controls overlay colors are only used by Windows and Linux.
          // macOS keeps its native traffic lights in the integrated toolbar.
          ...(process.platform === "darwin"
            ? {
                vibrancy: "sidebar" as const,
                visualEffectState: "followWindow" as const,
                trafficLightPosition: { x: 18, y: 17 }
              }
            : {
                titleBarOverlay: {
                  height: 37,
                  color: "#00000000",
                  symbolColor: config.windowControlsIconColor
                }
              })
        }),

    webPreferences: {
      zoomFactor: config.zoomFactor,
      spellcheck: config.isSpellCheckerEnabled,
      preload: __dirname + "/preload.js"
    }
  });

  createIPCHandler({ router, windows: [mainWindow] });
  globalThis.window = mainWindow;
  mainWindow.setMenuBarVisibility(false);
  mainWindowState.manage(mainWindow);

  if (
    cliOptions.hidden &&
    !(
      config.desktopSettings.minimizeToSystemTray ||
      config.desktopSettings.closeToSystemTray
    )
  )
    mainWindow.minimize();

  await mainWindow.webContents.loadURL(`${createURL(cliOptions, "/")}`);
  mainWindow.setOpacity(1);

  if (config.privacyMode) {
    await api.integration.setPrivacyMode({ enabled: config.privacyMode });
  }

  await AssetManager.loadIcons();
  setupDesktopIntegration(config.desktopSettings);

  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      callback(permission === "geolocation" ? false : true);
    }
  );
  mainWindow.webContents.session.setSpellCheckerDictionaryDownloadURL(
    "http://dictionaries.notesnook.com/"
  );
  mainWindow.webContents.session.setProxy({ proxyRules: config.proxyRules });

  mainWindow.on("show", () =>
    /**
     * We may set `skipTaskbar` to true at startup.
     * This also removes the window from the Alt-Tab switcher.
     * To fix that, whenever the app is shown, we set `skipTaskbar` to false.
     */
    mainWindow.setSkipTaskbar(false)
  );
  mainWindow.once("closed", () => {
    nativeTheme.off("updated", updateNativeTheme);
    globalThis.window = null;
    taskRendererReady = false;
  });

  setupMenu();
  setupJumplist();

  if (isDevelopment())
    mainWindow.webContents.openDevTools({ mode: "bottom", activate: true });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsedUrl = new URL(url);
      if (!appHostnames.includes(parsedUrl.hostname)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch (e) {
      console.error("will-navigate: failed to parse URL", url, e);
      event.preventDefault();
    }
  });

  function updateNativeTheme() {
    if (
      process.platform === "darwin" &&
      getTheme() === "system" &&
      !mainWindow.isDestroyed()
    ) {
      mainWindow.setBackgroundColor(
        nativeTheme.shouldUseDarkColors ? "#1d2025" : "#f7f8fa"
      );
    }
    setupTray();
    setupJumplist();
  }
  nativeTheme.on("updated", updateNativeTheme);

  if (pendingNNLink) {
    bridge.onOpenLink(pendingNNLink);
    pendingNNLink = undefined;
  }
}

app.once("ready", async () => {
  console.info("App ready. Opening window.");
  setupApplicationMenu();

  if (app.runningUnderARM64Translation) {
    console.log("App is running under ARM64 translation");
    dialog.showMessageBoxSync({
      message:
        "VeyraN is running under ARM64 translation. Install the ARM64 build for better performance.",
      type: "warning",
      buttons: ["Okay"],
      title: "Degraded Performance Warning"
    });
  }

  if (config.customDns) enableCustomDns();
  else disableCustomDns();

  if (!MAC_APP_STORE) {
    app.setAsDefaultProtocolClient("nn");
    app.setAsDefaultProtocolClient("veyran");
  }

  if (!isDevelopment()) registerProtocol();
  await ensureWindow();
  await migrateBackupDirectory();
  await configureAutoUpdater();
});

app.once("window-all-closed", () => {
  if (process.platform !== "darwin" || MAC_APP_STORE) {
    app.quit();
  }
});

app.on("second-instance", async (_ev, argv) => {
  const taskPath = argv.map(parseVeyraNTaskRoute).find(Boolean);
  if (taskPath) {
    pendingTaskPath = taskPath;
    await openPendingTask();
    return;
  }
  const nnLink = findInternalLink(argv);
  if (nnLink) {
    if (globalThis.window) bridge.onOpenLink(nnLink);
    else {
      pendingNNLink = nnLink;
      await ensureWindow();
    }
    bringToFront();
    return;
  }
  if (!globalThis.window) await ensureWindow();
  const cliOptions = await parseArguments(argv);
  if (cliOptions.note) bridge.onCreateItem("note");
  if (cliOptions.notebook) bridge.onCreateItem("notebook");
  if (cliOptions.reminder) bridge.onCreateItem("reminder");
  if (cliOptions.task) bridge.onCreateItem("task");
  bringToFront();
});

// macOS opens URLs via this event. The app may or may not be fully loaded yet.
app.on("open-url", (event, url) => {
  event.preventDefault();
  const taskPath = parseVeyraNTaskRoute(url);
  if (taskPath) {
    pendingTaskPath = taskPath;
    void openPendingTask();
    return;
  }
  if (!isAcceptedInternalLink(url)) return;
  if (globalThis.window) {
    bridge.onOpenLink(url);
    bringToFront();
  } else {
    // Window not ready yet — store for when createWindow finishes loading.
    pendingNNLink = url;
  }
});

app.on("activate", () => {
  if (globalThis.window === null) {
    void ensureWindow();
  }
});

function isAcceptedInternalLink(url: string): boolean {
  return /^(?:nn|veyran):\/\//i.test(url);
}

function findInternalLink(argv: string[]): string | undefined {
  return argv.find(
    (arg) => isAcceptedInternalLink(arg) && !parseVeyraNTaskRoute(arg)
  );
}

function parseVeyraNTaskRoute(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "veyran:" || url.search || url.hash) return;
    const host = url.hostname.toLowerCase();
    if (host === "tasks" && (url.pathname === "" || url.pathname === "/"))
      return "/tasks";
    if (host !== "task") return;
    if (url.pathname === "/new") return "/tasks#/tasks/create";
    const id = url.pathname.slice(1);
    if (!/^(?:[a-f0-9]{24}|[a-f0-9]{32})$/i.test(id)) return;
    return `/tasks#/tasks/${encodeURIComponent(id)}/edit`;
  } catch {
    return;
  }
}

function createURL(options: CLIOptions, path = "/") {
  const url = new URL(isDevelopment() ? "http://localhost:3000" : PROTOCOL_URL);

  url.pathname = path;
  if (options.note === true) url.hash = "/notes/create/1";
  else if (options.notebook === true) url.hash = "/notebooks/create";
  else if (options.reminder === true || options.task)
    url.hash = "/tasks/create";
  else if (typeof options.note === "string")
    url.hash = `/notes/${options.note}/edit`;
  else if (typeof options.notebook === "string")
    url.pathname = `/notebooks/${options.notebook}`;

  return url;
}

async function migrateBackupDirectory() {
  if (!globalThis.window) return;
  try {
    if (config.backupDirectory !== PATHS.backupsDirectory) return;
    const oldPath = await globalThis.window?.webContents.executeJavaScript(
      `localStorage.getItem("backupStorageLocation")`
    );
    if (!oldPath || oldPath === PATHS.backupsDirectory) return;
    config.backupDirectory = normalizePathString(oldPath);
  } catch (e) {
    console.error("Failed to migrate backup directory", e);
    const pressedButton = dialog.showMessageBoxSync(globalThis.window, {
      message:
        "Failed to migrate backup directory. It has been reset to default.",
      title: "Backup Directory Migration Failed",
      type: "error",
      buttons: ["Set backup directory", "Ignore"]
    });
    if (pressedButton === 0) {
      await api.integration.selectBackupDirectory();
    }
  }
}
