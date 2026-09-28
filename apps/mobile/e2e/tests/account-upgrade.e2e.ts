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

import { expect as jestExpect } from "@jest/globals";
import { expect as detoxExpect } from "detox";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import {
  closeSync,
  chmodSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "fs";
import { basename, dirname, isAbsolute, relative, resolve } from "path";
import { homedir } from "os";
import { notesnook } from "../test.ids";
import { Tests } from "./utils";

// Explicitly opt in and use Detox --reuse. The shared setup launches the app;
// this suite never prepares, reinstalls, onboards, logs out or deletes. Seeding
// is a separate explicit opt-in, only for disposable empty QA devices.
// Keep Detox logs, screenshots, videos and hierarchy capture disabled: existing
// note text is read only long enough to hash it, never stored in the manifest.
const phase = process.env.VEYRAN_QA_UPGRADE_PHASE;
const requestedFile = process.env.VEYRAN_QA_UPGRADE_BASELINE_FILE;
const seedEmptyClone =
  process.env.VEYRAN_QA_UPGRADE_SEED_EMPTY_CLONE === "true";
const resumePartialSeed =
  process.env.VEYRAN_QA_UPGRADE_RESUME_PARTIAL_SEED === "true";
const appearanceOnly = process.env.VEYRAN_QA_UPGRADE_APPEARANCE_ONLY === "true";
const installationControlOnly =
  process.env.VEYRAN_QA_UPGRADE_INSTALLATION_CONTROL === "true";
const fixtureId = process.env.VEYRAN_QA_UPGRADE_FIXTURE_ID;
const cloneIds = new Set([
  "DEF8FC18-2E86-47ED-AFE6-21E5D3498C29",
  "DF6A7A6B-D09A-47F4-AB54-502E9B7EA6C9",
  "54215FED-5C86-4D5E-919E-AE95560959AE"
]);
const upgradeSuite = phase && requestedFile ? describe : describe.skip;

type Snapshot = {
  schema: 1;
  deviceId: string;
  capturedAt: string;
  library: { allNotes: number; inbox: number };
  note: { bodySha256: string; bodyLength: number };
  qaFixture?: { noteTitle: string; taskTitle: string };
  task?: { titleSha256: string; completed: boolean };
  account: { identityRows: number; sessionRows: number; signOutRows: number };
  preferences: {
    weekStartsOn: "Sunday" | "Monday" | null;
    timeFormat: "12-hour" | "24-hour" | null;
    useSystemTheme: boolean | null;
    darkMode: boolean | null;
  };
};

async function visible(item: Detox.NativeElement, timeout = 750) {
  try {
    await waitFor(item).toBeVisible().withTimeout(timeout);
    return true;
  } catch {
    return false;
  }
}

function assertIsolatedContainers() {
  const dataRoot = realpathSync(
    resolve(
      homedir(),
      "Library/Developer/CoreSimulator/Devices",
      device.id,
      "data"
    )
  );
  const paths: Record<string, string> = {};
  for (const kind of ["app", "data", "group.com.ozel0t.note.notesnookpencil"]) {
    const path = execFileSync(
      "xcrun",
      [
        "simctl",
        "get_app_container",
        device.id,
        "com.ozel0t.note.notesnookpencil",
        kind
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    ).trim();
    const suffix = relative(dataRoot, realpathSync(path));
    if (!suffix || suffix.startsWith("../") || isAbsolute(suffix))
      throw new Error("Upgrade QA requires isolated app/data/AppGroup paths");
    paths[kind] = realpathSync(path);
  }
  const processes = execFileSync("ps", ["-axo", "pid=,comm="], {
    encoding: "utf8"
  });
  const appProcess = processes
    .split("\n")
    .find((line) => line.trim().endsWith(`${paths.app}/Notesnook`));
  const pid = appProcess?.trim().match(/^[0-9]+/)?.[0];
  if (!pid) throw new Error("Upgrade QA requires the isolated app process");
  // Read only into memory; procinfo can contain inherited environment values.
  // Never print or persist the raw output or any unapproved environment key.
  const procinfo = execFileSync(
    "xcrun",
    ["simctl", "spawn", device.id, "launchctl", "procinfo", pid],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const homes = Array.from(
    procinfo.matchAll(
      /^\s*(?:HOME|CFFIXED_USER_HOME|_DYLD_CLOSURE_HOME) => (.*)$/gm
    ),
    (match) => match[1]
  );
  const udids = Array.from(
    procinfo.matchAll(/^\s*SIMULATOR_UDID => (.*)$/gm),
    (match) => match[1]
  );
  if (
    !homes.includes(paths.data) ||
    homes.some((home) => {
      const suffix = relative(dataRoot, realpathSync(home));
      return suffix.startsWith("../") || isAbsolute(suffix);
    }) ||
    !udids.length ||
    udids.some((udid) => udid !== device.id)
  )
    throw new Error(
      "Upgrade QA requires isolated process HOME and device UUID"
    );
}

async function library() {
  if (await visible(element(by.id("library-heading")))) return;
  // Settings can cover the native tab bar. Navigate its visible Back controls
  // before trying a tab; these actions never change any preference or account.
  for (let attempt = 0; attempt < 4; attempt++) {
    const collectionBack = element(by.id("library-collection-back"));
    const back = element(by.id(notesnook.ids.default.header.buttons.left));
    if (await visible(collectionBack)) await collectionBack.tap();
    else if (await visible(back)) await back.tap();
    else break;
    if (await visible(element(by.id("library-heading")))) return;
  }
  // A previous run can leave a mounted editor or Library collection. These
  // Back/tab actions only navigate; no input or account action is performed.
  try {
    await detoxExpect(
      web().element(by.web.cssSelector(".active .ProseMirror"))
    ).toExist();
    await Tests.exitEditor();
  } catch {
    // No editor is mounted.
  }
  await Tests.tapTab("Library");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await visible(element(by.id("library-heading")))) return;
    const collectionBack = element(by.id("library-collection-back"));
    const settingsBack = element(
      by.id(notesnook.ids.default.header.buttons.left)
    );
    if (await visible(collectionBack)) await collectionBack.tap();
    else if (await visible(settingsBack)) await settingsBack.tap();
    else break;
  }
  await waitFor(element(by.id("library-heading")))
    .toBeVisible()
    .withTimeout(30000);
}

async function restartAtLibrary() {
  await device.terminateApp();
  await device.launchApp({
    newInstance: true,
    launchArgs: { detoxEnableSynchronization: 0 }
  });
  await device.disableSynchronization();
  assertIsolatedContainers();
  await library();
}

async function libraryCount(label: "All Notes" | "Inbox") {
  const item = element(
    by
      .traits(["button"])
      .withDescendant(by.text(label))
      .withAncestor(by.id("library-scroll"))
  ).atIndex(0);
  await waitFor(item).toBeVisible().withTimeout(10000);
  const attributes = (await item.getAttributes()) as {
    label?: string;
    accessibilityLabel?: string;
  };
  // Parse in JavaScript: this installed Detox runtime sends RegExp native
  // matchers as literal strings. Only read these two nonprivate Library rows.
  const rowLabel = attributes.label ?? attributes.accessibilityLabel;
  if (rowLabel === `${label}, No notes`) return 0;
  const count = rowLabel?.match(
    new RegExp(`^${label}, ([0-9,]+) notes?$`)
  )?.[1];
  if (!count) throw new Error(`Cannot read ${label} count from Library`);
  return Number(count.replace(/,/g, ""));
}

async function settingsBack() {
  const back = element(by.id(notesnook.ids.default.header.buttons.left));
  await waitFor(back).toBeVisible().withTimeout(10000);
  await back.tap();
}

async function openSettingsScreen(id: "personalization" | "behaviour") {
  // whileElement starts its scroll immediately when the destination is not
  // visible; wait for the delayed SettingsHome list to mount first.
  await waitFor(element(by.id("settings-list")))
    .toBeVisible()
    .withTimeout(10000);
  await Tests.sleep(2000);
  const item = element(by.id(id));
  await waitFor(item)
    .toBeVisible()
    .whileElement(by.id("settings-list"))
    .scroll(150, "down");
  await item.tap({ x: 70, y: 25 });
  await waitFor(
    element(
      by.id(id === "personalization" ? "use-system-theme" : "date-format")
    )
  )
    .toBeVisible()
    .withTimeout(10000);
}

async function readableEditorText() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const value: unknown = await web()
      .element(by.web.cssSelector(".active .ProseMirror"))
      .getText();
    // The installed Detox extractResult returns an object for empty text.
    // The editor DOM also appears before an existing note finishes loading.
    if (typeof value === "string" && value.trim()) return value;
    await Tests.sleep(500);
  }
  throw new Error("Existing-note upgrade requires readable nonempty note text");
}

async function captureAppearance() {
  const screenshot = await device.takeScreenshot(
    `upgrade-${phase}-${device.id}-appearance-${Date.now()}`
  );
  chmodSync(screenshot, 0o600);
  const path = `${requestedFile}.appearance-${Date.now()}.png`;
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, readFileSync(screenshot));
  } finally {
    closeSync(descriptor);
  }
}

async function switchValue(id: string): Promise<boolean | null> {
  const item = element(by.id(id));
  if (!(await visible(item))) return null;
  const attributes = (await item.getAttributes()) as { value?: unknown };
  // These custom switches currently expose no native value. Do not infer a
  // preference from appearance or tap a switch to discover its current state.
  return typeof attributes.value === "boolean" ? attributes.value : null;
}

async function taskList() {
  await Tests.openTasks();
  const all = element(by.id("task-smart-all"));
  if (!(await visible(all))) await element(by.label("Back")).tap();
  await waitFor(all).toBeVisible().withTimeout(10000);
  await Tests.sleep(750);
  await all.tap();
}

async function showBehaviorSamples() {
  for (const id of ["default-sidebar-view", "date-format", "day-format"]) {
    if (
      (await visible(element(by.id("week-format")), 250)) &&
      (await visible(element(by.id("time-format")), 250))
    )
      return;
    const row = element(by.id(id));
    if (await visible(row, 250)) {
      await row.swipe("up", "slow", 0.9, 0.5, 0.9);
      await Tests.sleep(300);
    }
  }
}

async function readWeekFormat(): Promise<
  Snapshot["preferences"]["weekStartsOn"]
> {
  for (const day of ["Sunday", "Monday"] as const) {
    if (await visible(element(by.text(day).withAncestor(by.id("week-format")))))
      return day;
  }
  const row = element(by.id("week-format"));
  if (!(await visible(row))) return null;
  const attributes = (await row.getAttributes()) as {
    label?: string;
    text?: string;
    accessibilityLabel?: string;
  };
  const match = [
    attributes.label,
    attributes.text,
    attributes.accessibilityLabel
  ]
    .join(" ")
    .match(/\b(Sunday|Monday)\b/)?.[1];
  return match === "Sunday" || match === "Monday" ? match : null;
}

async function seed(fixture: NonNullable<Snapshot["qaFixture"]>) {
  assertIsolatedContainers();
  await library();
  const count = await libraryCount("All Notes");
  const body = `VEYRAN-TF-QA old17 in-place migration body ${fixtureId}`;
  if (count === 0) await Tests.createNote(fixture.noteTitle, body);
  else {
    if (!resumePartialSeed || count !== 1)
      throw new Error("Seeding requires an empty disposable clone");
    // Resume only the exact unique QA note created by this suite, never an
    // existing user note or a fixture with extra/mismatched readable content.
    await Tests.navigate("Notes");
    const row = element(by.id(notesnook.ids.note.get(0)));
    await waitFor(row).toBeVisible().withTimeout(10000);
    await Tests.sleep(2000);
    await row.tap();
    await waitFor(element(by.id(notesnook.editor.id)))
      .toBeVisible()
      .withTimeout(10000);
    await Tests.waitForEditor();
    const retainedBody = (await readableEditorText()).trim();
    // Hash even the failure comparison so unexpected note text is never
    // printed by Jest's received/expected diff.
    jestExpect(createHash("sha256").update(retainedBody).digest("hex")).toBe(
      createHash("sha256").update(body).digest("hex")
    );
    await Tests.exitEditor();
  }
  await library();
  await taskList();
  if (!(await visible(element(by.text(fixture.taskTitle))))) {
    const input = element(by.id("task-quick-add-input"));
    await waitFor(input).toBeVisible().withTimeout(10000);
    await input.typeText(fixture.taskTitle);
    const submit = element(by.id("task-quick-add-submit"));
    await waitFor(submit).toBeVisible().withTimeout(10000);
    await Tests.sleep(350);
    await submit.tap();
  }
  await waitFor(element(by.text(fixture.taskTitle)))
    .toBeVisible()
    .withTimeout(10000);
  await restartAtLibrary();
  await Tests.navigate("Settings");
  await openSettingsScreen("behaviour");
  await showBehaviorSamples();
  if ((await readWeekFormat()) !== "Monday") {
    const row = element(by.id("week-format"));
    await waitFor(row).toBeVisible().withTimeout(10000);
    const attributes = (await row.getAttributes()) as {
      elementBounds?: { width: number; height: number };
      frame?: { width: number; height: number };
    };
    const bounds = attributes.elementBounds ?? attributes.frame;
    if (!bounds || bounds.width < 100 || bounds.height < 50)
      throw new Error("Cannot locate safe week-format selector bounds");
    // The picker occupies the lower right part of this source-defined row.
    await row.tapAtPoint({ x: bounds.width * 0.6, y: bounds.height - 30 });
    await waitFor(element(by.text("Monday")))
      .toBeVisible()
      .withTimeout(10000);
    await Tests.sleep(750);
    await element(by.text("Monday")).tap();
    await Tests.sleep(500);
  }
  jestExpect(await readWeekFormat()).toBe("Monday");
  await settingsBack();
  await library();
}

async function capture(fixture?: Snapshot["qaFixture"]): Promise<Snapshot> {
  await library();
  const counts = {
    allNotes: await libraryCount("All Notes"),
    inbox: await libraryCount("Inbox")
  };
  const countDiagnostic = openSync(
    `${requestedFile}.library-${Date.now()}.json`,
    "wx",
    0o600
  );
  try {
    writeFileSync(
      countDiagnostic,
      JSON.stringify({ deviceId: device.id, library: counts }) + "\n"
    );
  } finally {
    closeSync(countDiagnostic);
  }
  console.info(
    "PRESERVED_PROFILE_LIBRARY_DIAGNOSTIC " +
      JSON.stringify({ deviceId: device.id, library: counts })
  );
  let note: Snapshot["note"] | null = null;
  if (counts.allNotes > 0) {
    await Tests.navigate("Notes");
    const firstNote = element(by.id(notesnook.ids.note.get(0)));
    await waitFor(firstNote).toBeVisible().withTimeout(15000);
    await Tests.sleep(2000);
    await firstNote.tap();
    await waitFor(element(by.id(notesnook.editor.id)))
      .toBeVisible()
      .withTimeout(10000);
    await Tests.waitForEditor();
    const body = (await readableEditorText()).replace(/\r\n/g, "\n");
    if (!body.trim())
      throw new Error(
        "Existing-note upgrade requires readable nonempty note text"
      );
    note = {
      bodySha256: createHash("sha256").update(body).digest("hex"),
      bodyLength: body.length
    };
    await Tests.exitEditor();
  }
  await library();
  await Tests.navigate("Settings");
  await waitFor(element(by.id("settings-list")))
    .toBeVisible()
    .withTimeout(10000);
  await element(by.id("settings-list")).scrollTo("top");
  // Never read account row attributes: its description includes an email.
  const account = {
    identityRows: Number(
      await visible(element(by.id("veyran-account-identity")))
    ),
    sessionRows: Number(
      await visible(element(by.id("veyran-account-session")))
    ),
    signOutRows: Number(await visible(element(by.id("logout"))))
  };

  await openSettingsScreen("personalization");
  await captureAppearance();
  const useSystemTheme = await switchValue("use-system-theme");
  const darkMode = await switchValue("enable-dark-mode");
  await settingsBack();
  // Observe each section from a restarted, fully mounted SettingsHome rather
  // than racing delayed nested-screen layout while switching sections.
  await restartAtLibrary();
  await Tests.navigate("Settings");
  await openSettingsScreen("behaviour");
  await showBehaviorSamples();
  const weekStartsOn = await readWeekFormat();
  const timeFormatRow = element(by.id("time-format"));
  let timeFormat: Snapshot["preferences"]["timeFormat"] = null;
  if (await visible(timeFormatRow)) {
    // This row contains only the safe setting name/description/current time.
    // Never use this attribute-reading technique on the account identity row.
    const attributes = (await timeFormatRow.getAttributes()) as {
      label?: string;
      text?: string;
      accessibilityLabel?: string;
    };
    const rowText = [
      attributes.label,
      attributes.text,
      attributes.accessibilityLabel
    ].join(" ");
    const format = rowText.match(/\b(12-hour|24-hour) \(/)?.[1];
    if (format === "12-hour" || format === "24-hour") timeFormat = format;
  }
  await settingsBack();
  await library();
  if (!note) {
    // A ciphertext file can exist without a populated account. Keep the safe
    // empty-fixture evidence in the private test log, never write a successful
    // baseline or claim data preservation without readable existing content.
    const diagnostic = {
      deviceId: device.id,
      library: counts,
      account,
      preferences: { weekStartsOn, timeFormat, useSystemTheme, darkMode }
    };
    const descriptor = openSync(
      `${requestedFile}.empty-${Date.now()}.json`,
      "wx",
      0o600
    );
    try {
      writeFileSync(descriptor, JSON.stringify(diagnostic, null, 2) + "\n");
    } finally {
      closeSync(descriptor);
    }
    throw new Error(
      "Existing-note upgrade requires a retained nonempty profile"
    );
  }
  let task: Snapshot["task"];
  if (fixture) {
    await taskList();
    await waitFor(element(by.text(fixture.taskTitle)))
      .toBeVisible()
      .withTimeout(10000);
    await waitFor(element(by.label(`Complete: ${fixture.taskTitle}`)))
      .toBeVisible()
      .withTimeout(10000);
    task = {
      titleSha256: createHash("sha256").update(fixture.taskTitle).digest("hex"),
      completed: false
    };
    await library();
  }
  return {
    schema: 1,
    deviceId: device.id,
    capturedAt: new Date().toISOString(),
    library: counts,
    note,
    ...(fixture ? { qaFixture: fixture, task } : {}),
    account,
    preferences: { weekStartsOn, timeFormat, useSystemTheme, darkMode }
  };
}

function assertRetained(baseline: Snapshot, current: Snapshot) {
  jestExpect(current.deviceId).toBe(baseline.deviceId);
  jestExpect(current.library).toEqual(baseline.library);
  jestExpect(current.note).toEqual(baseline.note);
  if (baseline.qaFixture) {
    jestExpect(current.qaFixture).toEqual(baseline.qaFixture);
    jestExpect(current.task).toEqual(baseline.task);
  }
  // Build 17 may lack the repaired identity/session rows. Only require rows
  // observed before upgrading; new account UI is allowed to become visible.
  for (const key of ["identityRows", "sessionRows", "signOutRows"] as const) {
    if (baseline.account[key]) jestExpect(current.account[key]).toBe(1);
  }
  for (const key of Object.keys(baseline.preferences) as Array<
    keyof Snapshot["preferences"]
  >) {
    if (baseline.preferences[key] !== null)
      jestExpect(current.preferences[key]).toBe(baseline.preferences[key]);
  }
}

upgradeSuite("PRESERVED PROFILE UPGRADE (CLONES ONLY)", () => {
  let baselineFile: string;
  beforeAll(() => {
    if (phase !== "baseline" && phase !== "verify")
      throw new Error("Upgrade phase must be baseline or verify");
    if (seedEmptyClone && phase !== "baseline")
      throw new Error(
        "Seeding is only permitted before the old-build baseline"
      );
    if (fixtureId && !/^[a-zA-Z0-9-]{1,80}$/.test(fixtureId))
      throw new Error("QA fixture ID must be a safe generated identifier");
    if (seedEmptyClone && !fixtureId)
      throw new Error("Explicit empty-clone seeding requires a QA fixture ID");
    if (resumePartialSeed && (!seedEmptyClone || phase !== "baseline"))
      throw new Error("Partial QA fixture resume requires explicit seeding");
    if (appearanceOnly && seedEmptyClone)
      throw new Error("Appearance-only observation cannot seed a fixture");
    if (!requestedFile || !isAbsolute(requestedFile))
      throw new Error("Upgrade baseline requires an absolute external path");
    if (
      device.getPlatform() !== "ios" ||
      !cloneIds.has(device.id) ||
      process.env.VEYRAN_QA_DEVICE_ID !== device.id
    )
      throw new Error(
        "Upgrade suite only permits explicitly isolated QA devices"
      );
    if (!/^(1|true)$/.test(process.env.DETOX_REUSE || ""))
      throw new Error("Upgrade suite requires Detox --reuse");
    // A simulator clone can retain original-device absolute registrations.
    // The host runner must also enforce this guard before Detox's app launch.
    assertIsolatedContainers();
    baselineFile = resolve(
      realpathSync(dirname(requestedFile)),
      basename(requestedFile)
    );
    const relativePath = relative(
      resolve(__dirname, "../../../.."),
      baselineFile
    );
    if (!relativePath.startsWith("../"))
      throw new Error("Upgrade baseline must be outside the repository");
  });

  it(
    installationControlOnly
      ? "captures an old17 installation-control Library baseline"
      : appearanceOnly
      ? "captures only the safe Appearance screen"
      : "captures or verifies retained note/settings fingerprints",
    async () => {
      if (installationControlOnly) {
        if (phase !== "baseline" || seedEmptyClone || appearanceOnly)
          throw new Error(
            "Installation control is a separate read-only baseline"
          );
        await library();
        const descriptor = openSync(baselineFile, "wx", 0o600);
        try {
          writeFileSync(
            descriptor,
            JSON.stringify({
              schema: 1,
              purpose: "installation-control; no semantic migration PASS",
              deviceId: device.id,
              library: {
                allNotes: await libraryCount("All Notes"),
                inbox: await libraryCount("Inbox")
              }
            }) + "\n"
          );
        } finally {
          closeSync(descriptor);
        }
        return;
      }
      if (appearanceOnly) {
        await library();
        await Tests.navigate("Settings");
        await openSettingsScreen("personalization");
        await captureAppearance();
        await settingsBack();
        await library();
        return;
      }
      if (phase === "baseline") {
        const fixture = fixtureId
          ? {
              noteTitle: `VEYRAN-TF-QA Old17 Note ${fixtureId}`,
              taskTitle: `VEYRAN-TF-QA Old17 Task ${fixtureId}`
            }
          : undefined;
        if (seedEmptyClone && fixture) {
          // Record the original empty UI honestly before adding QA data. A
          // nonempty or unreadable profile must never be seeded by this path.
          if (!resumePartialSeed) {
            try {
              await capture();
              throw new Error("Refusing to seed a nonempty clone");
            } catch (error) {
              if (
                !(error instanceof Error) ||
                error.message !==
                  "Existing-note upgrade requires a retained nonempty profile"
              )
                throw error;
            }
          }
          await seed(fixture);
          await restartAtLibrary();
        }
        const current = await capture(fixture);
        const descriptor = openSync(baselineFile, "wx", 0o600);
        try {
          writeFileSync(descriptor, JSON.stringify(current, null, 2) + "\n");
        } finally {
          closeSync(descriptor);
        }
        return;
      }
      const metadata = lstatSync(baselineFile);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.mode & 0o077
      )
        throw new Error(
          "Upgrade baseline must be a private regular file (0600)"
        );
      const baseline = JSON.parse(
        readFileSync(baselineFile, "utf8")
      ) as Snapshot;
      jestExpect(baseline.schema).toBe(1);
      const current = await capture(baseline.qaFixture);
      assertRetained(baseline, current);
      await device.terminateApp();
      await device.launchApp({ newInstance: true });
      assertRetained(baseline, await capture(baseline.qaFixture));
    },
    360000
  );
});
