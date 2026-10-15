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

/**
 * The editor WebView header, rendered into a real DOM with `react-dom` (React
 * 18, the version this package ships) and activated the way a browser and an
 * assistive technology activate a `<button>`.
 *
 * Two headers live here: the *legacy* one (Android and every non-iOS host) and
 * the restrained iOS *document chrome* (More / Edit-Done, with the noisy
 * controls moved into labelled More entries). Both act on `mousedown` - the
 * press has to register before the browser moves focus or collapses the
 * selection, which is exactly why the labelled buttons prevent their default
 * there even while the software keyboard is hidden. A keyboard (Enter/Space)
 * or assistive-technology activation dispatches a `click` with `detail === 0`
 * and no `mousedown` at all, so the same action has to be reachable that way
 * too - exactly once, and without a real pointer press running twice.
 *
 * Everything peripheral is mocked inside this file (the CSS module, the theme,
 * the tab hook, the menu library and the intl strings), so the suite needs no
 * setup file or extra dependency: the buttons under test are the production
 * ones. The menu library mock mirrors the real contract the header relies on
 * (an `onItemClick` carrying the item's `value`, and disabled items that do
 * not fire) without rendering its portal chrome.
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach
} from "@jest/globals";
import React from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

const mockPost = jest.fn();

/** The tab the header renders for, with a note open in it. */
const mockTab: {
  id: string;
  session: {
    id?: string;
    noteId?: string;
    locked?: boolean;
    readonly?: boolean;
    origin?: { id: string; title: string } | null;
  };
} = { id: "tab-1", session: { id: "logical-1", noteId: "note-1" } };

/** The localized label the header must use for the affordance. */
const mockBackLabel = "Retour";

jest.mock("./styles.module.css", () => {
  // Any class name the header asks for resolves to itself; `__esModule` has to
  // stay falsy so the default import is the proxy and not its `default` key.
  return new Proxy(
    {},
    {
      get: (_target, key) => (key === "__esModule" ? undefined : String(key))
    }
  );
});

jest.mock("@notesnook/theme", () => {
  const color = new Proxy(
    {},
    { get: (_target, key) => `var(--mock-${String(key)})` }
  );
  return {
    useThemeColors: () => ({
      colors: new Proxy({}, { get: () => color }),
      isDark: false
    })
  };
});

jest.mock("../hooks/useSafeArea", () => ({
  useSafeArea: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}));

const mockTabState = {
  tabs: [mockTab],
  currentTab: "tab-1",
  canGoBack: false,
  canGoForward: false
};
const mockTabListeners = new Set<
  (next: typeof mockTabState, previous: typeof mockTabState) => void
>();
jest.mock("../hooks/useTabStore", () => ({
  useTabContext: () => mockTab,
  useTabStore: Object.assign(
    (selector: (state: typeof mockTabState) => unknown) =>
      selector(mockTabState),
    {
      getState: () => mockTabState,
      subscribe: (
        listener: (
          next: typeof mockTabState,
          previous: typeof mockTabState
        ) => void
      ) => {
        mockTabListeners.add(listener);
        return () => mockTabListeners.delete(listener);
      }
    }
  )
}));

/**
 * The menu library is periphery here, but its *contract* is what the header
 * uses: the item's `value` reaches `onItemClick`, and a disabled item does not
 * fire. A jest.mock factory cannot use JSX (nor any out-of-scope binding), so
 * both parts are built with the factory's own `require` and share a context
 * that carries the menu's `onItemClick`.
 */
jest.mock("@szhsin/react-menu", () => {
  const React = require("react");
  const MenuContext = React.createContext(null);
  return {
    ControlledMenu: (props: {
      children?: unknown;
      state?: string;
      onItemClick?: (event: { value: unknown }) => void;
    }) =>
      React.createElement(
        MenuContext.Provider,
        { value: props.onItemClick ?? null },
        React.createElement(
          "div",
          { "data-testid": "menu", "data-state": props.state },
          props.children
        )
      ),
    MenuItem: (props: {
      children?: unknown;
      value?: unknown;
      disabled?: boolean;
      "aria-expanded"?: boolean;
      "aria-controls"?: string;
    }) => {
      const onItemClick = React.useContext(MenuContext) as
        | ((event: { value: unknown }) => void)
        | null;
      return React.createElement(
        "div",
        {
          "data-testid": "menu-item",
          "data-value": props.value,
          "data-disabled": props.disabled ? "true" : "false",
          "aria-expanded": props["aria-expanded"],
          "aria-controls": props["aria-controls"],
          onClick: () => {
            if (props.disabled) return;
            onItemClick?.({ value: props.value });
          }
        },
        props.children
      );
    }
  };
});

jest.mock("@notesnook/intl", () => ({
  strings: new Proxy(
    {},
    {
      get: (_target, key) => () =>
        String(key) === "back" ? mockBackLabel : String(key)
    }
  )
}));

import Header from "./header";
import { EditorEvents } from "../utils/editor-events";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const testGlobals = globalThis as unknown as Record<string, unknown>;

/**
 * The mock function type the per-tab command seam carries. It is derived from
 * the imported `jest` *value* itself: `@jest/globals` exports `jest` as a
 * value, so the `jest.Mock` *namespace* type is not in scope in this module
 * (TS2503). `ReturnType<typeof jest.fn>` names exactly the same mock contract
 * without a suppression or a new dependency.
 */
type MockFunction = ReturnType<typeof jest.fn>;

/** The per-tab editor command mocks the header acts on. */
const editorsGlobal = () =>
  testGlobals.editors as Record<
    string,
    { commands: Record<string, MockFunction> }
  >;

/** The settings the header renders from (the WebView's own payload shape). */
const settings = (
  patch: Partial<{
    deviceMode: string;
    fullscreen: boolean;
    pagedPresentation: boolean;
    fontScale: number;
    isMacCatalyst: boolean;
    readonly: boolean;
  }> = {}
) => ({
  deviceMode: "tablet",
  fullscreen: false,
  pagedPresentation: true,
  fontScale: 1,
  premium: false,
  isMacCatalyst: false,
  ...patch
});

type HeaderProps = {
  loading?: boolean;
  noHeader?: boolean;
  hasUndo?: boolean;
  hasRedo?: boolean;
  writing?: boolean;
  detailsOpen?: boolean;
  collectionInHeader?: boolean;
  surface?: string;
  onEdit?: () => void;
  onDone?: () => void;
  onToggleDetails?: () => void;
};

describe("editor header", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (
    patch: Parameters<typeof settings>[0] = {},
    props: HeaderProps = {}
  ) => {
    act(() => {
      root.render(
        <Header
          settings={settings(patch) as never}
          hasUndo={props.hasUndo ?? false}
          hasRedo={props.hasRedo ?? false}
          noHeader={props.noHeader ?? false}
          loading={props.loading}
          writing={props.writing}
          detailsOpen={props.detailsOpen}
          collectionInHeader={props.collectionInHeader}
          surface={props.surface}
          onEdit={props.onEdit}
          onDone={props.onDone}
          onToggleDetails={props.onToggleDetails}
        />
      );
    });
  };

  /**
   * The Back affordance is identified by its *localized label* and never as
   * "the first labelled button": the iOS document chrome labels its primary
   * controls too (More, Edit/Done), so a positional query would silently
   * identify the wrong control.
   */
  const backButton = () =>
    container.querySelector<HTMLButtonElement>(
      `button[aria-label="${mockBackLabel}"]`
    );

  const byLabel = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  const menuItem = (value: string) =>
    container.querySelector<HTMLElement>(`[data-value="${value}"]`);

  /** A real pointer press: it registers on the pointer down. */
  const press = (element: Element) => {
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true
    });
    act(() => {
      element.dispatchEvent(down);
    });
    return down;
  };

  /** The click a real mouse press dispatches right after the pointer down. */
  const mouseClick = (element: Element) => {
    act(() => {
      element.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 1 })
      );
    });
  };

  /** A keyboard / assistive-technology activation: detail 0, no mousedown. */
  const keyboardActivate = (element: Element) => {
    act(() => {
      element.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 0 })
      );
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockTabState.tabs = [mockTab];
    mockTabState.currentTab = mockTab.id;
    mockTab.session = { id: "logical-1", noteId: "note-1" };
    testGlobals.sessionId = "transport-1";
    testGlobals.post = mockPost;
    testGlobals.editors = {
      "tab-1": {
        commands: {
          undo: jest.fn(),
          redo: jest.fn(),
          blur: jest.fn(),
          focus: jest.fn(),
          startSearch: jest.fn()
        }
      }
    };
    testGlobals.editorControllers = {};
    testGlobals.keyboardShown = false;
    // The legacy header is the default; the iOS chrome tests opt in explicitly.
    delete testGlobals.__PLATFORM__;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete testGlobals.__PLATFORM__;
  });

  describe("legacy header (non-iOS hosts)", () => {
    it("renders the localized Back label for the paged presentation", () => {
      render();

      const back = backButton();
      expect(back).not.toBeNull();
      // The label comes from the intl layer, not from a hardcoded string: the
      // icon-only button would otherwise be announced as an unlabelled
      // "button".
      expect(back!.getAttribute("aria-label")).toBe(mockBackLabel);
      expect(back!.getAttribute("title")).toBe(mockBackLabel);
    });

    it("hides the affordance only without the paged presentation", () => {
      // Non-mobile, non-fullscreen and unpaged: the editor was not navigated
      // into, so there is no page to go back to.
      render({ pagedPresentation: false });
      expect(backButton()).toBeNull();

      // Fullscreen keeps the affordance: it is the close control of a
      // fullscreen editor, exactly as the native fullscreen-first presentation
      // behaves.
      render({ pagedPresentation: true, fullscreen: true });
      expect(backButton()).not.toBeNull();

      // The iPhone presentation keeps its own affordance (deviceMode mobile).
      render({ deviceMode: "mobile", pagedPresentation: false });
      expect(backButton()).not.toBeNull();
    });

    it("keeps the pointer press on mousedown, exactly once", () => {
      render();
      const back = backButton()!;

      const down = press(back);

      // The press registered on the pointer down. The Back affordance is an
      // icon-only button, whose own default leaves the event unprevented
      // (unlike the labelled header buttons), so the action must not depend on
      // `preventDefault` to run.
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith(
        EditorEvents.back,
        undefined,
        mockTab.id,
        mockTab.session.noteId
      );
      expect(down.defaultPrevented).toBe(false);

      // The click a real mouse press dispatches right after carries a detail,
      // and must not run the action a second time.
      mouseClick(back);
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it("activates on a keyboard or assistive-technology click, exactly once", () => {
      render();
      const back = backButton()!;

      // What Enter/Space on the focused button and an AX activation dispatch: a
      // click with detail 0 and no mousedown before it.
      keyboardActivate(back);
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith(
        EditorEvents.back,
        undefined,
        mockTab.id,
        mockTab.session.noteId
      );

      // The DOM's own activation path (`element.click()`) is the same case.
      act(() => {
        back.click();
      });
      expect(mockPost).toHaveBeenCalledTimes(2);

      // A pointer press after that still activates once, not twice.
      press(back);
      mouseClick(back);
      expect(mockPost).toHaveBeenCalledTimes(3);
    });

    it("re-renders the Back affordance when the paged presentation changes", () => {
      // The header is memoized, so the comparator has to notice a
      // paged-presentation change or a wide -> narrow resize would keep
      // rendering the previous width's affordance. The same root is reused for
      // every render, so only the varied field differs.
      render({ pagedPresentation: true });
      expect(backButton()).not.toBeNull();

      render({ pagedPresentation: false });
      expect(backButton()).toBeNull();

      render({ pagedPresentation: true });
      expect(backButton()).not.toBeNull();

      // The Mac Catalyst guard is unaffected: a change the comparator does
      // notice (fullscreen) still re-renders, and the Mac header renders
      // nothing at all, whatever the presentation.
      render({
        pagedPresentation: true,
        fullscreen: true,
        isMacCatalyst: true
      });
      expect(backButton()).toBeNull();
      expect(byLabel("more")).toBeNull();
    });
  });

  describe("iOS document chrome", () => {
    beforeEach(() => {
      testGlobals.__PLATFORM__ = "ios";
    });

    it("shows the known iPad collection in the command row without hiding primary actions or leaking into paged/locked editors", () => {
      mockTab.session.origin = {
        id: "book-b",
        title: "A long synthetic notebook"
      };
      const caption = () =>
        container.querySelector<HTMLElement>("#editor-collection-caption");
      render({ pagedPresentation: false }, { collectionInHeader: true });
      expect(caption()?.textContent).toBe("A long synthetic notebook");
      expect(caption()?.style.textOverflow).toBe("ellipsis");
      expect(caption()?.closest("#header")).not.toBeNull();
      expect(byLabel("share")).not.toBeNull();
      expect(byLabel("more")).not.toBeNull();
      expect(byLabel("done")).not.toBeNull();
      // Only this presentation prop changes: the real memo comparator must
      // update the row when the parent's window-width decision changes.
      render({ pagedPresentation: false }, { collectionInHeader: false });
      expect(caption()).toBeNull();
      render({ pagedPresentation: true }, { collectionInHeader: true });
      expect(caption()).toBeNull();
      expect(backButton()).not.toBeNull();
      mockTab.session.locked = true;
      render({ pagedPresentation: false }, { collectionInHeader: true });
      expect(caption()).toBeNull();
      mockTab.session = { id: "logical-b", noteId: "note-b", origin: null };
      render(
        { pagedPresentation: false },
        { collectionInHeader: true, writing: false }
      );
      expect(container.textContent).not.toContain("A long synthetic notebook");
    });

    it("shows the restrained primary row: More + Edit, nothing noisy", () => {
      // Not paged and not fullscreen: no Back, so the row is exactly the two
      // primary controls.
      render(
        { pagedPresentation: false },
        { writing: false, detailsOpen: false }
      );

      expect(byLabel("more")).not.toBeNull();
      expect(byLabel("edit")).not.toBeNull();
      expect(byLabel("done")).toBeNull();
      // The disabled undo/redo, the tab-count box and fullscreen are not in the
      // primary row any more.
      expect(byLabel("undo")).toBeNull();
      expect(byLabel("redo")).toBeNull();
      expect(byLabel("tabs")).toBeNull();
      expect(byLabel("fullscreen")).toBeNull();
      // ...while the real More entries still expose them (see below).
      expect(menuItem("undo")).not.toBeNull();
      expect(menuItem("redo")).not.toBeNull();
      expect(menuItem("tabs")).not.toBeNull();
    });

    it("keeps the Back affordance where the C1 condition requires it", () => {
      // Wide iPad with the paged presentation: Back is required.
      render({ pagedPresentation: true }, { writing: false });
      expect(backButton()).not.toBeNull();

      // iPhone: required too.
      render({ deviceMode: "mobile", pagedPresentation: false });
      expect(backButton()).not.toBeNull();

      // Wide, unpaged iPad: not required.
      render({ pagedPresentation: false });
      expect(backButton()).toBeNull();
    });

    it("toggles the primary action between the labelled Edit and Done", () => {
      render({ pagedPresentation: false }, { writing: false });
      expect(byLabel("edit")).not.toBeNull();
      expect(byLabel("done")).toBeNull();

      render({ pagedPresentation: false }, { writing: true });
      expect(byLabel("done")).not.toBeNull();
      expect(byLabel("edit")).toBeNull();
    });

    it("enters writing on the Edit press, before focus moves, exactly once", () => {
      const onEdit = jest.fn();
      render(
        { pagedPresentation: false },
        { writing: false, onEdit, onDone: jest.fn() }
      );

      const edit = byLabel("edit")!;
      const down = press(edit);

      // The labelled primary press keeps the selection: the default is
      // prevented even though the software keyboard is hidden.
      expect(down.defaultPrevented).toBe(true);
      expect(onEdit).toHaveBeenCalledTimes(1);

      mouseClick(edit);
      expect(onEdit).toHaveBeenCalledTimes(1);

      // A keyboard/AT activation (detail 0, no mousedown) is the same action.
      keyboardActivate(edit);
      expect(onEdit).toHaveBeenCalledTimes(2);
    });

    it("exits writing on the Done press with the same contract", () => {
      const onDone = jest.fn();
      render(
        { pagedPresentation: false },
        { writing: true, onDone, onEdit: jest.fn() }
      );

      const done = byLabel("done")!;
      const down = press(done);

      expect(down.defaultPrevented).toBe(true);
      expect(onDone).toHaveBeenCalledTimes(1);

      mouseClick(done);
      expect(onDone).toHaveBeenCalledTimes(1);

      keyboardActivate(done);
      expect(onDone).toHaveBeenCalledTimes(2);
    });

    it("prevents the press default whether or not the software keyboard is shown", () => {
      // The mousedown guard must not depend on the keyboard state: the press
      // only keeps the selection when it is prevented either way.
      for (const keyboardShown of [false, true]) {
        testGlobals.keyboardShown = keyboardShown;
        const onEdit = jest.fn();
        render(
          { pagedPresentation: false },
          { writing: false, onEdit, onDone: jest.fn() }
        );
        const down = press(byLabel("edit")!);
        expect(down.defaultPrevented).toBe(true);
        expect(onEdit).toHaveBeenCalledTimes(1);
      }
    });

    it("routes the More entries to the existing per-tab actions", () => {
      const editor = editorsGlobal();

      render({ pagedPresentation: false }, { hasUndo: true, hasRedo: true });

      act(() => menuItem("undo")!.click());
      expect(editor["tab-1"].commands.undo).toHaveBeenCalledTimes(1);

      act(() => menuItem("redo")!.click());
      expect(editor["tab-1"].commands.redo).toHaveBeenCalledTimes(1);

      act(() => menuItem("tabs")!.click());
      expect(mockPost).toHaveBeenCalledWith(
        EditorEvents.showTabs,
        undefined,
        mockTab.id,
        mockTab.session.noteId
      );

      // The real Properties sheet - the existing share/edit path - is intact.
      act(() => menuItem("properties")!.click());
      expect(mockPost).toHaveBeenCalledWith(
        EditorEvents.properties,
        undefined,
        mockTab.id,
        mockTab.session.noteId
      );

      // Fullscreen keeps its existing event on the non-iPhone presentation.
      act(() => menuItem("fullscreen")!.click());
      expect(mockPost).toHaveBeenCalledWith(
        EditorEvents.fullscreen,
        undefined,
        mockTab.id,
        mockTab.session.noteId
      );
    });

    it("carries the genuine undo/redo disabled state of the active tab", () => {
      const editor = editorsGlobal();

      render({ pagedPresentation: false }, { hasUndo: false, hasRedo: true });

      const undo = menuItem("undo")!;
      const redo = menuItem("redo")!;
      expect(undo.getAttribute("data-disabled")).toBe("true");
      expect(redo.getAttribute("data-disabled")).toBe("false");

      // A disabled entry never fires its action...
      act(() => undo.click());
      expect(editor["tab-1"].commands.undo).not.toHaveBeenCalled();

      // ...an enabled one runs the correct tab's history.
      act(() => redo.click());
      expect(editor["tab-1"].commands.redo).toHaveBeenCalledTimes(1);
    });

    it("labels the tabs entry with the localized name and the open count", () => {
      render({ pagedPresentation: false });
      expect(menuItem("tabs")!.textContent).toContain("tabs");
      // The single seeded tab's count is rendered next to the label.
      expect(menuItem("tabs")!.textContent).toContain("1");
    });

    it("toggles the local details disclosure with aria semantics", () => {
      const onToggleDetails = jest.fn();
      render(
        { pagedPresentation: false },
        { detailsOpen: false, onToggleDetails }
      );

      const details = menuItem("details")!;
      expect(details.getAttribute("aria-expanded")).toBe("false");
      expect(details.getAttribute("aria-controls")).toBe("editor-details");

      act(() => details.click());
      expect(onToggleDetails).toHaveBeenCalledTimes(1);

      render({ pagedPresentation: false }, { detailsOpen: true });
      expect(menuItem("details")!.getAttribute("aria-expanded")).toBe("true");
    });

    it("drops the fullscreen entry on the iPhone presentation", () => {
      render({ deviceMode: "mobile", pagedPresentation: false });
      expect(menuItem("fullscreen")).toBeNull();
    });

    it("opens the More menu from the primary control, not the noisy row", () => {
      render({ pagedPresentation: false }, { writing: false });
      const menu = container.querySelector<HTMLElement>(
        '[data-testid="menu"]'
      )!;
      expect(menu.getAttribute("data-state")).toBe("closed");

      press(byLabel("more")!);
      expect(menu.getAttribute("data-state")).toBe("open");
    });

    it("keeps the locked note on the existing Properties path", () => {
      mockTab.session.locked = true;
      try {
        render({ pagedPresentation: false });
        press(byLabel("more")!);
        expect(mockPost).toHaveBeenCalledWith(
          EditorEvents.properties,
          undefined,
          mockTab.id,
          mockTab.session.noteId
        );
      } finally {
        delete mockTab.session.locked;
      }
    });

    it("shows no write affordance for a locked session", () => {
      mockTab.session.locked = true;
      try {
        render({ pagedPresentation: false }, { writing: false });

        // A locked note is not writable: neither a functional Edit/Done nor the
        // read-only PencilLock may be offered (the pane is the password
        // overlay). The label is asserted by absence, because the PencilLock
        // control carries the same "edit" label as the primary Edit.
        expect(byLabel("edit")).toBeNull();
        expect(byLabel("done")).toBeNull();
        // The More control - and with it the real Properties path - stays.
        expect(byLabel("more")).not.toBeNull();
      } finally {
        delete mockTab.session.locked;
      }
    });

    it("shows no write affordance for a globally read-only editor", () => {
      render({ pagedPresentation: false, readonly: true }, { writing: false });

      expect(byLabel("edit")).toBeNull();
      expect(byLabel("done")).toBeNull();
      // Nothing was sent over the bridge while rendering (the header posts only
      // on an explicit action, and there is no action to take here).
      expect(mockPost).not.toHaveBeenCalled();
      // The More control is untouched.
      expect(byLabel("more")).not.toBeNull();
    });

    it("lets a globally read-only editor outrank a session-level read-only note", () => {
      mockTab.session.readonly = true;
      try {
        render(
          { pagedPresentation: false, readonly: true },
          { writing: false }
        );

        // The session-level PencilLock would be the way back to writing on a
        // read-only note, but the editor as a whole is read-only: there is no
        // such way, so it is not offered.
        expect(byLabel("edit")).toBeNull();
        expect(byLabel("done")).toBeNull();
      } finally {
        delete mockTab.session.readonly;
      }
    });

    it("preserves the read-only note's PencilLock while the editor is editable", () => {
      mockTab.session.readonly = true;
      try {
        render(
          { pagedPresentation: false, readonly: false },
          { writing: false }
        );

        // A read-only *note* on a writable editor keeps the existing way back:
        // the PencilLock labelled "edit" (no plain Edit/Done).
        const pencilLock = byLabel("edit");
        expect(pencilLock).not.toBeNull();
        expect(byLabel("done")).toBeNull();

        // Pressing it posts the existing disable-read-only-mode event, once,
        // with the note it belongs to - and nothing else.
        press(pencilLock!);
        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost).toHaveBeenCalledWith(
          "editor-events:disable-readonly-mode",
          mockTab.session.noteId
        );
      } finally {
        delete mockTab.session.readonly;
      }
    });

    it("re-renders the primary control when the global read-only setting flips", () => {
      // The memoized header reads `settings.readonly` for the primary control,
      // so the comparator must compare it. Every prop but `readonly` is held
      // constant across the three renders, so a stale memo would keep the
      // previous control on screen.
      const props = { writing: false, detailsOpen: false };
      render({ pagedPresentation: false, readonly: false }, props);
      expect(byLabel("edit")).not.toBeNull();

      render({ pagedPresentation: false, readonly: true }, props);
      expect(byLabel("edit")).toBeNull();
      expect(byLabel("done")).toBeNull();

      render({ pagedPresentation: false, readonly: false }, props);
      expect(byLabel("edit")).not.toBeNull();
    });

    it("renders no chrome at all with noHeader, even on iOS", () => {
      render({ pagedPresentation: false }, { noHeader: true });
      expect(byLabel("more")).toBeNull();
      expect(byLabel("edit")).toBeNull();
      expect(backButton()).toBeNull();
      expect(container.querySelector("#header")).toBeNull();
    });

    it("paints the resolved document surface on the bar", () => {
      render(
        { pagedPresentation: false },
        { surface: "rgb(1, 2, 3)", writing: false }
      );
      const bar = container.firstElementChild as HTMLElement;
      expect(bar.style.backgroundColor).toBe("rgb(1, 2, 3)");
      // The header keeps its stable identity (id="header") for the parent's
      // empty-area tap handling.
      expect(container.querySelector("#header")).not.toBeNull();
    });

    it("re-renders on every chrome prop change the memo must not miss", () => {
      // writing: Edit -> Done
      render(
        { pagedPresentation: false },
        { writing: false, detailsOpen: false }
      );
      expect(byLabel("edit")).not.toBeNull();

      render(
        { pagedPresentation: false },
        { writing: true, detailsOpen: false }
      );
      expect(byLabel("done")).not.toBeNull();

      // detailsOpen: the disclosure's aria state follows.
      render(
        { pagedPresentation: false },
        { writing: true, detailsOpen: false }
      );
      expect(menuItem("details")!.getAttribute("aria-expanded")).toBe("false");
      render(
        { pagedPresentation: false },
        { writing: true, detailsOpen: true }
      );
      expect(menuItem("details")!.getAttribute("aria-expanded")).toBe("true");

      // surface: the bar's background follows.
      render(
        { pagedPresentation: false },
        { writing: true, detailsOpen: true, surface: "rgb(4, 5, 6)" }
      );
      expect(
        (container.firstElementChild as HTMLElement).style.backgroundColor
      ).toBe("rgb(4, 5, 6)");
      render(
        { pagedPresentation: false },
        { writing: true, detailsOpen: true, surface: "rgb(7, 8, 9)" }
      );
      expect(
        (container.firstElementChild as HTMLElement).style.backgroundColor
      ).toBe("rgb(7, 8, 9)");
    });
  });
  describe("iOS primary Share button", () => {
    const result = (patch: Record<string, unknown> = {}) => ({
      status: "delivered",
      revision: 1,
      snapshot: { tabId: "tab-1", noteId: "note-1", sessionId: "transport-1" },
      ...patch
    });
    let flush: ReturnType<typeof jest.fn>;
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const settle = async () => {
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
    };
    const transition = (id: string) => {
      const previous = { ...mockTabState };
      mockTabState.currentTab = id;
      mockTabListeners.forEach((listener) => listener(mockTabState, previous));
    };
    beforeEach(() => {
      testGlobals.__PLATFORM__ = "ios";
      flush = jest.fn(async () => result());
      testGlobals.editorControllers = {
        "tab-1": { flushOutboundSaves: flush, loading: false }
      };
    });
    it("exposes a localized 44pt primary button and pointer activation preserves the text selection", async () => {
      render();
      const button = byLabel("share")!;
      expect(button).not.toBeNull();
      expect(button.style.width).toBe("44px");
      expect(button.style.height).toBe("44px");
      const text = document.createTextNode("selected words");
      container.appendChild(text);
      const range = document.createRange();
      range.selectNodeContents(text);
      window.getSelection()?.addRange(range);
      expect(press(button).defaultPrevented).toBe(true);
      mouseClick(button);
      await settle();
      expect(flush).toHaveBeenCalledTimes(2);
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith(
        EditorEvents.shareNote,
        { logicalSessionId: "logical-1" },
        "tab-1",
        "note-1"
      );
      expect(window.getSelection()?.toString()).toBe("selected words");
      window.getSelection()?.removeAllRanges();
    });
    it("supports keyboard/assistive activation and readonly notes", async () => {
      mockTab.session.readonly = true;
      render({ readonly: true });
      keyboardActivate(byLabel("share")!);
      await settle();
      expect(mockPost).toHaveBeenCalledTimes(1);
    });
    it("waits for both flush receipts and blocks duplicate presses while pending", async () => {
      const first = deferred<any>();
      flush.mockImplementationOnce(() => first.promise);
      render();
      keyboardActivate(byLabel("share")!);
      keyboardActivate(byLabel("share")!);
      await settle();
      expect(mockPost).not.toHaveBeenCalled();
      expect(byLabel("share")!.disabled).toBe(true);
      await act(async () => {
        first.resolve(result());
      });
      await settle();
      expect(flush).toHaveBeenCalledTimes(2);
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(byLabel("share")!.disabled).toBe(false);
    });
    it.each(["failed", "busy", "stale"])(
      "does not send Share after %s",
      async (status) => {
        flush.mockImplementation(async () => result({ status }));
        render();
        keyboardActivate(byLabel("share")!);
        await settle();
        expect(mockPost).not.toHaveBeenCalled();
      }
    );
    it("accepts a positive nothing-pending receipt", async () => {
      flush.mockImplementation(async () =>
        result({ status: "nothing-pending" })
      );
      render();
      keyboardActivate(byLabel("share")!);
      await settle();
      expect(mockPost).toHaveBeenCalledTimes(1);
    });
    it("aborts if the second flush sees newer edits", async () => {
      flush
        .mockImplementationOnce(async () => result())
        .mockImplementationOnce(async () => result({ revision: 2 }));
      render();
      keyboardActivate(byLabel("share")!);
      await settle();
      expect(mockPost).not.toHaveBeenCalled();
    });
    it("rejects a foreign receipt", async () => {
      flush.mockImplementation(async () =>
        result({
          snapshot: {
            tabId: "tab-2",
            noteId: "note-2",
            sessionId: "transport-1"
          }
        })
      );
      render();
      keyboardActivate(byLabel("share")!);
      await settle();
      expect(mockPost).not.toHaveBeenCalled();
    });
    it("remains stale after A to B to A while awaiting the receipt", async () => {
      const first = deferred<any>();
      flush.mockImplementationOnce(() => first.promise);
      render();
      keyboardActivate(byLabel("share")!);
      transition("tab-2");
      transition("tab-1");
      await act(async () => {
        first.resolve(result());
      });
      await settle();
      expect(mockPost).not.toHaveBeenCalled();
    });
    it("accepts an ordinary controller object republish with the same stable flush method", async () => {
      const first = deferred<any>();
      flush.mockImplementationOnce(() => first.promise);
      render();
      keyboardActivate(byLabel("share")!);
      testGlobals.editorControllers = {
        "tab-1": { flushOutboundSaves: flush, loading: false }
      };
      await act(async () => {
        first.resolve(result());
      });
      await settle();
      expect(mockPost).toHaveBeenCalledTimes(1);
    });
    it("rejects a replacement controller method", async () => {
      const first = deferred<any>();
      flush.mockImplementationOnce(() => first.promise);
      render();
      keyboardActivate(byLabel("share")!);
      testGlobals.editorControllers = {
        "tab-1": { flushOutboundSaves: jest.fn(), loading: false }
      };
      await act(async () => {
        first.resolve(result());
      });
      await settle();
      expect(mockPost).not.toHaveBeenCalled();
    });
    it("disables the saved-note action for an unsaved document", () => {
      mockTab.session.noteId = undefined;
      render();
      expect(byLabel("share")!.disabled).toBe(true);
    });
    it("updates the Share disabled state when only parent loading changes", () => {
      render({}, { loading: false });
      expect(byLabel("share")!.disabled).toBe(false);
      render({}, { loading: true });
      expect(byLabel("share")!.disabled).toBe(true);
      render({}, { loading: false });
      expect(byLabel("share")!.disabled).toBe(false);
    });
    it("rejects a malformed receipt safely", async () => {
      flush.mockImplementation(async () => result({ snapshot: undefined }));
      render();
      keyboardActivate(byLabel("share")!);
      await settle();
      expect(mockPost).not.toHaveBeenCalled();
    });
    it("keeps Mac Catalyst's native header ownership", () => {
      render({ isMacCatalyst: true });
      expect(byLabel("share")).toBeNull();
    });
  });
});
