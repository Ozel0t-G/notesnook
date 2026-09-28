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
import { notesnook } from "../test.ids";
import { Tests } from "./utils";

// Run after account-lifecycle with --reuse against the retained disposable QA
// session. This suite never calls prepare(), reinstalls, deletes a profile,
// reads credentials, or writes into an existing user's note/Task.
const featureSuite =
  process.env.VEYRAN_QA_RETAINED_ACCOUNT_FEATURES === "true"
    ? describe
    : describe.skip;
// A focused rerun can reference a fixture whose write/reopen test already
// passed on this retained QA device. Only its numeric QA identifier is reused.
const retainedFixtureId = process.env.VEYRAN_QA_FEATURE_FIXTURE_ID;
if (retainedFixtureId && !/^\d{13}$/.test(retainedFixtureId)) {
  throw new Error(
    "The retained feature fixture must be a numeric QA identifier"
  );
}
const runId = retainedFixtureId || Date.now();
const noteBody = `VEYRAN-TF-QA feature note body ${runId}`;
const noteEdit = `VEYRAN-TF-QA feature note edit ${runId}`;
const taskTitle = `VEYRAN-TF-QA Feature Task ${runId}`;
const qaNoteText = () => by.text(new RegExp(`^${noteBody}[\\s\\S]*$`));

async function screenshot(name: string) {
  await device.takeScreenshot(`account-feature-regression-${name}`);
}

async function assertRetainedAccount() {
  await detoxExpect(element(by.id("veyran-account-identity"))).toBeVisible();
  await detoxExpect(element(by.id("veyran-account-session"))).toBeVisible();
  await detoxExpect(element(by.text("Signed in to VeyraN"))).toBeVisible();
  await detoxExpect(element(by.id("logout"))).toBeVisible();
}

async function relaunchRetainedSession() {
  await device.launchApp({
    newInstance: true,
    launchArgs: { detoxEnableSynchronization: 0 }
  });
  await device.disableSynchronization();
  await Tests.awaitLaunch();
  await library();
}

async function library() {
  const collectionBack = element(by.id("library-collection-back"));
  let collectionVisible = false;
  try {
    await waitFor(collectionBack).toBeVisible().withTimeout(750);
    collectionVisible = true;
  } catch {
    // Another tab or the Library root is already selected.
  }
  if (collectionVisible) {
    await collectionBack.tap();
    await waitFor(element(by.id("library-heading")))
      .toBeVisible()
      .withTimeout(10000);
    return;
  }
  await Tests.tapTab("Library");
  try {
    await waitFor(element(by.id("library-heading")))
      .toBeVisible()
      .withTimeout(1500);
  } catch {
    // Library collections preserve their selection when the tab is reselected.
    await waitFor(collectionBack).toBeVisible().withTimeout(10000);
    await collectionBack.tap();
  }
  await waitFor(element(by.id("library-heading")))
    .toBeVisible()
    .withTimeout(10000);
}

async function settings() {
  await library();
  await Tests.navigate("Settings");
  await waitFor(element(by.id("settings-list")))
    .toBeVisible()
    .withTimeout(10000);
  // SSE requires disabled synchronization. Native rows become visible before
  // the screen transition finishes and can receive a touch reliably.
  await Tests.sleep(2000);
}

async function tapSettingsRow(id: string) {
  const row = element(by.id(id));
  await waitFor(row).toBeVisible().withTimeout(10000);
  await row.tap({ x: 70, y: 25 });
}

async function settingsBack() {
  const back = element(by.id(notesnook.ids.default.header.buttons.left));
  await waitFor(back).toBeVisible().withTimeout(10000);
  await back.tap();
  await Tests.sleep(2000);
}

async function openQaNote() {
  // The iOS list presents an automatically titled note by its body headline.
  // Keep the unique prefix when editing, so this matches only our saved note.
  const row = element(qaNoteText());
  await waitFor(row).toBeVisible().withTimeout(15000);
  await Tests.sleep(750);
  await row.tap();
  await waitFor(element(by.id(notesnook.editor.id)))
    .toBeVisible()
    .withTimeout(10000);
  await Tests.waitForEditor();
}

async function createQaNote() {
  await Tests.tapNewNote();
  await waitFor(element(by.id(notesnook.editor.id)))
    .toBeVisible()
    .withTimeout(10000);
  await Tests.waitForEditor();
  const editor = web().element(by.web.cssSelector(".active .ProseMirror"));
  // Compose is the explicit new-note action. Wait for its native transition
  // and active DOM, then enter the fixture without relying on bridge booleans.
  await Tests.sleep(1500);
  await editor.focus();
  await editor.typeText(noteBody, true);
  await assertEditorContains(noteBody);
  await Tests.sleep(1500);
  await Tests.exitEditor();
  await library();
  await Tests.navigate("Notes");
  await waitFor(element(by.id("library-collection-back")))
    .toBeVisible()
    .withTimeout(10000);
}

async function assertEditorContains(text: string) {
  await waitFor(element(by.id(notesnook.editor.id)))
    .toBeVisible()
    .withTimeout(10000);
  await Tests.waitForEditor();
  const editor = web().element(by.web.cssSelector(".active .ProseMirror"));
  // A cached WebView can expose the DOM before its note body is hydrated.
  // Detox then returns {} instead of text; require the actual unique QA body.
  for (let attempt = 0; attempt < 30; attempt++) {
    let body: unknown;
    try {
      body = await editor.getText();
    } catch {
      // Retry while the native editor activates its WebView.
    }
    if (typeof body === "string" && body.trim() && body.includes(text)) {
      jestExpect(body).toContain(text);
      return;
    }
    await Tests.sleep(500);
  }
  throw new Error("The active native editor did not load the expected QA body");
}

async function taskSmartList(id: "all" | "completed") {
  const card = element(by.id(`task-smart-${id}`));
  try {
    await waitFor(card).toBeVisible().withTimeout(1500);
  } catch {
    // iPhone shows a list or its navigation; iPad keeps both panes mounted.
    const back = element(by.label("Back"));
    await waitFor(back).toBeVisible().withTimeout(10000);
    await back.tap();
    await waitFor(card).toBeVisible().withTimeout(10000);
  }
  await Tests.sleep(750);
  await card.tap();
  await Tests.sleep(750);
}

async function applyBundledTheme(scheme: "light" | "dark") {
  const name = scheme === "light" ? "VeyraN Light" : "VeyraN Dark";
  const applied = element(by.text(`Applied as ${scheme} theme`));
  const apply = element(by.text(`Set as ${scheme} theme`));
  await waitFor(element(by.text(name)))
    .toBeVisible()
    .withTimeout(10000);
  await Tests.sleep(750);
  await element(by.text(name)).tap();
  try {
    await waitFor(applied).toBeVisible().withTimeout(1500);
    await Tests.sleep(750);
    await applied.tap();
  } catch {
    await waitFor(apply).toBeVisible().withTimeout(10000);
    await Tests.sleep(750);
    await apply.tap();
  }
  await waitFor(element(by.text(`${name} applied successfully`)))
    .toBeVisible()
    .withTimeout(10000);
  await Tests.sleep(750);
  await screenshot(`theme-${scheme}-selected`);
}

featureSuite("RETAINED ACCOUNT FEATURE REGRESSION", () => {
  beforeEach(async () => {
    // Preserve the account and fixtures while starting each case at Library.
    // An earlier failed editor or detail screen must not hide the native tabs.
    await relaunchRetainedSession();
  });

  afterEach(async () => {
    let detailVisible = false;
    try {
      await waitFor(element(by.text("Edit Task")))
        .toBeVisible()
        .withTimeout(750);
      detailVisible = true;
    } catch {
      // No saved Task detail is covering the content tabs.
    }
    if (detailVisible) {
      const back = element(by.label("Back"));
      await waitFor(back).toBeVisible().withTimeout(10000);
      await back.tap();
      await Tests.sleep(750);
    }
    let editorVisible = false;
    try {
      await waitFor(element(by.id(notesnook.editor.id)))
        .toBeVisible()
        .withTimeout(750);
      editorVisible = true;
    } catch {
      // The test ended on a native content screen rather than in the editor.
    }
    if (editorVisible) await Tests.exitEditor();
  });

  beforeAll(async () => {
    jestExpect(device.getPlatform()).toBe("ios");
    jestExpect(["true", "1"]).toContain(process.env.DETOX_REUSE);
    // Leave any previous QA screen without reinstalling or resetting its data.
    await relaunchRetainedSession();
    // Refuse to count an offline onboarding fallback as live account QA.
    await settings();
    await assertRetainedAccount();
    await screenshot("retained-account-settings");
    await settingsBack();
    await library();
  });

  it("opens All Notes and Inbox, then saves, reopens and edits a new note", async () => {
    await library();
    await screenshot("library");
    await element(by.text("All Notes")).tap();
    await waitFor(element(by.id("library-collection-back")))
      .toBeVisible()
      .withTimeout(10000);
    await screenshot("all-notes");
    await library();
    await element(by.text("Inbox")).tap();
    await waitFor(element(by.id("library-collection-back")))
      .toBeVisible()
      .withTimeout(10000);
    await screenshot("inbox");
    await library();

    await createQaNote();
    await openQaNote();
    await assertEditorContains(noteBody);
    await screenshot("note-reopened");
    const editor = web().element(by.web.cssSelector(".active .ProseMirror"));
    await editor.focus();
    await editor.moveCursorToEnd();
    await editor.typeText(` ${noteEdit}`, true);
    await assertEditorContains(noteEdit);
    await Tests.exitEditor();
    await openQaNote();
    await assertEditorContains(noteEdit);
    await screenshot("edited-note-reopened");
    await Tests.exitEditor();
    await library();
  }, 120000);

  it("quick adds, completes and reopens a Task after a process restart", async () => {
    await Tests.openTasks();
    await taskSmartList("all");
    const input = element(by.id("task-quick-add-input"));
    await waitFor(input).toBeVisible().withTimeout(10000);
    await input.replaceText("");
    await input.typeText(taskTitle);
    // Native input events must update React's quickTitle before submitting.
    await Tests.sleep(750);
    const submit = element(by.id("task-quick-add-submit"));
    await waitFor(submit).toBeVisible().withTimeout(10000);
    await submit.tap();
    const complete = element(by.label(`Complete: ${taskTitle}`));
    // The title also matches the draft input, so only the saved Task's action
    // proves creation and can qualify the task-created screenshot.
    await waitFor(complete).toBeVisible().withTimeout(10000);
    // The submit button leaves the blank Quick Add input focused. Dismiss its
    // keyboard before the completion touch, which otherwise only blurs input.
    await detoxExpect(input).toHaveText("");
    await input.tapReturnKey();
    await Tests.sleep(750);
    await screenshot("task-created");
    await complete.tap();
    // All contains only incomplete Tasks. Wait for the saved completion before
    // switching lists, so a keyboard-dismissed tap cannot masquerade as success.
    await waitFor(complete).not.toBeVisible().withTimeout(10000);
    await taskSmartList("completed");
    await waitFor(element(by.text(taskTitle)))
      .toBeVisible()
      .withTimeout(10000);
    await waitFor(element(by.label(`Mark incomplete: ${taskTitle}`)))
      .toBeVisible()
      .withTimeout(10000);
    await screenshot("task-completed");
    await library();

    await device.terminateApp();
    await relaunchRetainedSession();
    await Tests.openTasks();
    await taskSmartList("completed");
    await waitFor(element(by.text(taskTitle)))
      .toBeVisible()
      .withTimeout(10000);
    await waitFor(element(by.label(`Mark incomplete: ${taskTitle}`)))
      .toBeVisible()
      .withTimeout(10000);
    await element(by.label(taskTitle)).tap();
    // The multiline native input and its hidden placeholder UILabel share the
    // same label. Match the real input so the placeholder cannot win selection.
    const titleInput = element(
      by.type("RCTUITextView").and(by.label("Task title"))
    );
    await waitFor(titleInput).toBeVisible().withTimeout(10000);
    await detoxExpect(titleInput).toHaveText(taskTitle);
    await screenshot("completed-task-reopened");
    await element(by.label("Back")).tap();
    await library();
  }, 120000);

  it("finds the edited QA note in Search and retains VeyraN Account Settings", async () => {
    await Tests.tapTab("Search");
    const input = element(by.id("global-search-input"));
    await waitFor(input).toBeVisible().withTimeout(10000);
    await input.replaceText("");
    await input.typeText(noteEdit);
    await Tests.sleep(500);
    await input.tapReturnKey();
    const result = element(qaNoteText());
    await waitFor(result).toBeVisible().withTimeout(15000);
    await screenshot("note-search-result");
    await result.tap();
    await assertEditorContains(noteEdit);
    await screenshot("search-note-editor");
    await Tests.exitEditor();
    // The native editor returns to Library, including when opened from Search.
    await settings();
    await assertRetainedAccount();
    await detoxExpect(element(by.text("Notesnook Free"))).not.toBeVisible();
    await detoxExpect(element(by.text("Upgrade plan"))).not.toBeVisible();
    await screenshot("settings-after-feature-restart");
  }, 90000);

  it("applies local VeyraN Light/Dark and exercises the System/appearance controls", async () => {
    await settings();
    await tapSettingsRow("personalization");
    await waitFor(element(by.id("theme-picker")))
      .toBeVisible()
      .withTimeout(10000);
    await Tests.sleep(2000);
    await screenshot("appearance-controls");
    await tapSettingsRow("theme-picker");
    await applyBundledTheme("light");
    await applyBundledTheme("dark");
    await settingsBack();

    // The custom switches expose no readable native value. Pair each tap to
    // restore its preference; screenshots require an independent visual verdict.
    // This does not claim automatic System-following or color/contrast proof.
    const darkMode = element(by.id("enable-dark-mode"));
    await waitFor(darkMode).toBeVisible().withTimeout(10000);
    await screenshot("appearance-before-toggle");
    await tapSettingsRow("enable-dark-mode");
    await Tests.sleep(2000);
    await screenshot("appearance-mode-toggled");
    await tapSettingsRow("enable-dark-mode");
    await Tests.sleep(2000);
    const system = element(by.id("use-system-theme"));
    // SettingsGroup uses a KeyboardAwareFlatList. Restore its scroll position
    // after theme animation before asserting or touching the System row.
    const appearanceScroll = element(
      by.type("RCTEnhancedScrollView").withDescendant(by.id("use-system-theme"))
    );
    await waitFor(appearanceScroll).toBeVisible().withTimeout(10000);
    await appearanceScroll.scrollTo("top");
    await waitFor(system).toBeVisible().withTimeout(10000);
    await tapSettingsRow("use-system-theme");
    await Tests.sleep(2000);
    await screenshot("system-preference-toggled");
    await tapSettingsRow("use-system-theme");
    await Tests.sleep(2000);
    await screenshot("system-preference-restored");
    await settingsBack();
    await settingsBack();
    await library();

    // Relaunch restores the persisted manual scheme if System was originally off.
    await device.terminateApp();
    await relaunchRetainedSession();
    await settings();
    await assertRetainedAccount();
    await screenshot("final-retained-account");
    await settingsBack();
    await library();
  }, 120000);
});
