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
import { device as _device, expect } from "detox";
import { readFileSync } from "fs";
//@ts-ignore
import { toMatchImageSnapshot } from "jest-image-snapshot";
import type { RouteName } from "../../app/stores/use-navigation-store";
import { notesnook } from "../test.ids";
jestExpect.extend({ toMatchImageSnapshot });

const testvars = {
  isFirstTest: true
};

class Element {
  element: Detox.NativeElement;
  constructor(public type: "id" | "text" | "label", public value: string) {
    if (type == "id") {
      this.element = element(by.id(value)).atIndex(0);
    } else if (type == "label") {
      this.element = element(by.label(value)).atIndex(0);
    } else {
      this.element = element(by.text(value)).atIndex(0);
    }
  }

  isVisible(timeout?: number) {
    return waitFor(this.element)
      .toBeVisible()
      .withTimeout(timeout || 500);
  }

  isNotVisible(timeout?: number) {
    return waitFor(this.element)
      .not.toBeVisible()
      .withTimeout(timeout || 500);
  }

  async waitAndTap(timeout?: number) {
    await waitFor(this.element)
      .toBeVisible()
      .withTimeout(timeout || 500);
    await this.element.tap();
  }

  tap(point?: Detox.Point2D): Promise<void> {
    return this.element.tap(point);
  }

  static fromId(id: string) {
    return new Element("id", id);
  }
  static fromText(text: string) {
    return new Element("text", text);
  }
  static fromLabel(label: string) {
    return new Element("label", label);
  }
}

/**
 * iOS navigates with the native bottom bar; the drawer and the in-list
 * "New note" bar only exist on Android now.
 */
const isIOS = () => device.getPlatform() === "ios";

/** The element that proves the app finished launching into a usable session. */
const readyElement = () =>
  isIOS()
    ? element(by.text("All Notes"))
    : element(by.id(notesnook.buttons.add));

const Tests = {
  awaitLaunch: async () => {
    await device.disableSynchronization();
    try {
      await waitFor(readyElement()).toBeVisible().withTimeout(10000);
      return;
    } catch {
      // Fresh installs show onboarding before the app session is available.
    }
    const splash = element(by.id("notesnook.splashscreen"));
    try {
      await waitFor(splash).toBeVisible().withTimeout(2000);
      await element(by.text("Get started")).tap();
    } catch {
      // A previous test run may have reached the offline account choice.
    }
    await waitFor(element(by.text("Use offline")))
      .toBeVisible()
      .withTimeout(10000);
    await Tests.sleep(750);
    await element(by.text("Use offline")).tap();
    await waitFor(element(by.text("I understand")))
      .toBeVisible()
      .withTimeout(10000);
    await element(by.id(notesnook.ids.default.dialog.yes)).tap();
    // The welcome flow persists introCompleted when Get started is tapped.
    // On iOS 27 the offline confirmation can leave its modal mounted after
    // the navigation callback, so relaunch into the persisted app session.
    try {
      await waitFor(readyElement()).toBeVisible().withTimeout(4000);
      return;
    } catch {
      await device.launchApp({ newInstance: true });
    }
    await waitFor(readyElement()).toBeVisible().withTimeout(30000);
  },
  sleep: (duration: number) => {
    return new Promise((resolve) =>
      setTimeout(() => {
        resolve(undefined);
      }, duration)
    );
  },
  fromId: Element.fromId,
  fromText: Element.fromText,
  fromLabel: Element.fromLabel,
  async exitEditor() {
    if (device.getPlatform() === "ios") {
      await Tests.sleep(350);
      try {
        await expect(
          web().element(
            by.web.cssSelector(".active #header > button:first-child")
          )
        ).toExist();
      } catch {
        // A UUID-selected iPad has no device-name hint. Detect its actual
        // split editor, whose Fullscreen action exposes the Back control.
        await web()
          .element(
            by.web.cssSelector(
              ".active #header > div:nth-child(2) > button:first-child"
            )
          )
          .tap();
        await Tests.sleep(350);
      }
      await web()
        .element(by.web.cssSelector(".active #header > button:first-child"))
        .tap();
      // The editor's keyboard snapshot briefly covers the native tab bar.
      await Tests.sleep(2000);
    } else {
      await _device.pressBack();
      await _device.pressBack();
    }
  },
  async waitForEditor() {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await expect(
          web().element(by.web.cssSelector(".active .ProseMirror"))
        ).toExist();
        return;
      } catch (error) {
        if (attempt === 19) throw error;
        await Tests.sleep(500);
      }
    }
  },
  async createNote(title?: string, _body?: string) {
    const body =
      _body ||
      "Test note description that is very long and should not fit in text.";
    await Tests.tapNewNote();
    await Tests.sleep(1500);
    if (title) {
      await web().element(by.web.cssSelector(".active #editor-title")).focus();
      await web()
        .element(by.web.cssSelector(".active #editor-title"))
        .typeText(title, false);
    }
    await Tests.waitForEditor();
    await web().element(by.web.cssSelector(".active .ProseMirror")).focus();
    await web()
      .element(by.web.cssSelector(".active .ProseMirror"))
      .typeText(body, true);
    await Tests.exitEditor();
    if (isIOS()) {
      try {
        await waitFor(element(by.id("library-heading")))
          .toBeVisible()
          .withTimeout(1000);
        await element(by.text("All Notes")).tap();
      } catch {
        // Notebook and collection creation already return to a note list.
      }
    }
    await Tests.fromText(body).isVisible(10000);
    return { title, body };
  },
  /**
   * Starts a new note. On iOS this is the bottom bar's New Note action; on
   * Android it is still the floating / inline add button.
   */
  async tapNewNote() {
    if (isIOS()) {
      await Tests.tapTab(notesnook.tabbar.labels.newNote);
      return;
    }
    await Tests.fromId(notesnook.buttons.add).tap();
  },
  /**
   * Selects a top-level section. iOS only; Android has no bottom bar.
   * UIKit owns these labels. React Native's parent testID is not exposed as
   * an ancestor to Detox on iOS 27, so use the visible tab title directly.
   */
  async tapTab(label: string) {
    if (label === "Library") {
      try {
        await expect(element(by.id("library-heading"))).toBeVisible();
        return;
      } catch {
        // A Library collection or child route is currently covering the root.
      }
    }
    const idByLabel: Record<string, string> = {
      Library: notesnook.tabbar.itemIds.library,
      Tasks: notesnook.tabbar.itemIds.tasks,
      Search: notesnook.tabbar.itemIds.search,
      "New Note": notesnook.tabbar.itemIds.newNote
    };
    const tab = element(by.id(idByLabel[label]));
    try {
      await waitFor(tab).toBeVisible().withTimeout(1500);
      await tab.tap();
    } catch {
      // UIKit does not always expose the selected item's identifier on
      // iPhone. Its visible title remains a tappable fallback.
      // Hidden React navigation headers can retain the same text. Scope the
      // fallback to UIKit's actual tab bar instead of relying on an index.
      const title = element(
        by.text(label).withAncestor(by.type("UITabBar"))
      ).atIndex(0);
      await waitFor(title).toBeVisible().withTimeout(10000);
      await title.tap();
    }
  },
  /** Opens Tasks: the bottom bar on iOS, the drawer entry on Android. */
  async openTasks() {
    if (isIOS()) {
      await Tests.tapTab(notesnook.tabbar.labels.tasks);
      return;
    }
    await Tests.openSideMenu();
    await Tests.fromId("Tasks").waitAndTap();
  },
  /**
   * Reaches a content route. iOS goes through the Library tab, which is the
   * root of every content route now; Android still goes through the drawer.
   *
   * The old Notes destination maps to Library > All Notes.
   */
  async navigate(screen: RouteName | string) {
    if (isIOS()) {
      try {
        await expect(element(by.id("library-heading"))).toBeVisible();
      } catch {
        try {
          const collectionBack = element(by.id("library-collection-back"));
          try {
            await waitFor(collectionBack).toBeVisible().withTimeout(1000);
            await collectionBack.tap();
          } catch {
            const back = element(
              by.id(notesnook.ids.default.header.buttons.left)
            );
            await waitFor(back).toBeVisible().withTimeout(10000);
            await back.tap();
          }
        } catch {
          await Tests.tapTab(notesnook.tabbar.labels.library);
        }
      }
      await waitFor(element(by.id("library-heading")))
        .toBeVisible()
        .withTimeout(10000);
      const label = screen === "Notes" ? "All Notes" : String(screen);
      const destination = element(
        (screen === "Notes" ? by.text(label) : by.label(label)).withAncestor(
          by.id("library-scroll")
        )
      );
      await waitFor(destination).toBeVisible().withTimeout(10000);
      await destination.tap();
      await waitFor(element(by.id("library-heading")))
        .not.toBeVisible()
        .withTimeout(10000);
      return;
    }
    const menu = Tests.fromId(notesnook.ids.default.header.buttons.left);
    await menu.waitAndTap();
    await Tests.fromText(screen as string).waitAndTap();
  },
  /**
   * The drawer is Android-only now. On iOS the Library tab is the equivalent
   * navigation root.
   */
  async openSideMenu() {
    if (isIOS()) {
      await Tests.tapTab(notesnook.tabbar.labels.library);
      return;
    }
    await Tests.fromId(notesnook.ids.default.header.buttons.left).waitAndTap();
  },
  async prepare() {
    await device.disableSynchronization();
    if (testvars.isFirstTest) {
      testvars.isFirstTest = false;
      return await Tests.awaitLaunch();
    }
    await device.reverseTcpPort(8081);
    await device.uninstallApp();
    await device.installApp();
    await device.launchApp({ newInstance: true });
    await Tests.awaitLaunch();
  },
  async createNotebook(title = "Notebook 1", description = true) {
    await Tests.sleep(1000);
    const titleInput = Tests.fromId(
      notesnook.ids.dialogs.notebook.inputs.title
    );
    await titleInput.isVisible();
    await titleInput.element.typeText(title);
    await Tests.sleep(1000);
    if (description) {
      await Tests.fromId(
        notesnook.ids.dialogs.notebook.inputs.description
      ).element.typeText(`Description of ${title}`);
    }
    await Tests.fromText("Add").waitAndTap();
  },
  async matchSnapshot(element: Element, name: string) {
    const path = await element.element.takeScreenshot(name);
    const bitmapBuffer = readFileSync(path);
    (jestExpect(bitmapBuffer) as any).toMatchImageSnapshot({
      failureThreshold: 200,
      failureThresholdType: "pixel"
    });
  }
};

class TestBuilder {
  private steps: (() => Promise<void> | void)[] = [];
  private result: any;
  private savedResult: any;
  constructor() {}

  saveResult() {
    return this.addStep(() => {
      this.savedResult = this.result;
    });
  }

  addStep(step: () => Promise<void> | void) {
    this.steps.push(step);
    return this;
  }

  awaitLaunch() {
    return this.addStep(async () => {
      await Tests.awaitLaunch();
    });
  }

  wait(duration = 500) {
    return this.addStep(async () => {
      await Tests.sleep(duration);
    });
  }

  fromId(id: string) {
    return this.addStep(() => {
      this.result = Tests.fromId(id);
    });
  }

  fromText(text: string) {
    return this.addStep(() => {
      this.result = Tests.fromText(text);
    });
  }

  /** Taps a bottom bar item by its accessibility label. iOS only. */
  waitAndTapByLabel(label: string) {
    return this.addStep(async () => {
      await Tests.tapTab(label);
    });
  }

  exitEditor() {
    return this.addStep(async () => {
      await Tests.exitEditor();
    });
  }

  createNote(title?: string, body?: string) {
    return this.addStep(async () => {
      this.result = await Tests.createNote(title, body);
    });
  }

  navigate(screen: RouteName | string) {
    return this.addStep(async () => {
      await Tests.navigate(screen);
    });
  }

  openSideMenu() {
    return this.addStep(async () => {
      await Tests.openSideMenu();
    });
  }

  openTasks() {
    return this.addStep(async () => {
      await Tests.openTasks();
    });
  }

  prepare() {
    return this.addStep(async () => {
      await Tests.prepare();
    });
  }

  createNotebook(title = "Notebook 1", description = true) {
    return this.addStep(async () => {
      await Tests.createNotebook(title, description);
    });
  }

  matchSnapshot(element: Element, name: string) {
    return this.addStep(async () => {
      await Tests.matchSnapshot(element, name);
    });
  }

  isVisibleById(id: string, timeout?: number) {
    return this.addStep(async () => {
      const element = new Element("id", id);
      await element.isVisible(timeout);
    });
  }

  isVisibleByText(text: string, timeout?: number) {
    return this.addStep(async () => {
      const element = new Element("text", text);
      await element.isVisible(timeout);
    });
  }

  isNotVisibleById(id: string, timeout?: number) {
    return this.addStep(async () => {
      const element = new Element("id", id);
      await element.isNotVisible(timeout);
    });
  }

  isNotVisibleByText(text: string, timeout?: number) {
    return this.addStep(async () => {
      const element = new Element("text", text);
      await element.isNotVisible(timeout);
    });
  }

  waitAndTapById(id: string, timeout?: number) {
    return this.addStep(async () => {
      const element = new Element("id", id);
      await element.waitAndTap(timeout);
    });
  }

  waitAndTapByText(text: string, timeout?: number) {
    return this.addStep(async () => {
      const element = new Element("text", text);
      await element.waitAndTap(timeout);
    });
  }

  tapById(id: string, point?: Detox.Point2D) {
    return this.addStep(async () => {
      const element = new Element("id", id);
      await element.tap(point);
    });
  }

  tapReturnKeyById(id: string) {
    return this.addStep(async () => {
      const element = new Element("id", id);
      await element.element.tapReturnKey();
    });
  }

  tapByText(text: string, point?: Detox.Point2D) {
    return this.addStep(async () => {
      const element = new Element("text", text);
      await element.tap(point);
    });
  }

  processResult(callback: (result: any) => Promise<void>) {
    return this.addStep(async () => {
      if (this.savedResult) {
        await callback(this.savedResult);
      } else {
        throw new Error("No result to process.");
      }
    });
  }

  typeTextById(id: string, text: string) {
    return this.addStep(async () => {
      await Element.fromId(id).element.typeText(text);
    });
  }

  replaceTextById(id: string, text: string) {
    return this.addStep(async () => {
      await Element.fromId(id).element.replaceText(text);
    });
  }

  clearTextById(id: string) {
    return this.addStep(async () => {
      await Element.fromId(id).element.clearText();
    });
  }

  pressBack(count = 1) {
    return this.addStep(async () => {
      for (let i = 0; i < count; i++) {
        await device.pressBack();
      }
    });
  }

  longPressByText(text: string) {
    return this.addStep(async () => {
      const element = new Element("text", text);
      await element.element.longPress();
    });
  }

  longPressById(id: string) {
    return this.addStep(async () => {
      const element = new Element("id", id);
      await element.element.longPress();
    });
  }

  async run() {
    for (const step of this.steps) {
      const result = step.call(this);
      if (result instanceof Promise) {
        await result;
      }
    }
    this.steps = []; // Clear steps after execution
  }
  static create() {
    return new TestBuilder();
  }
}

export { Element, Tests, TestBuilder };
