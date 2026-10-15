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
 * The *parent* editor (the real `editor.tsx`, default export `TiptapProvider`)
 * and the iOS document-chrome presentation it drives.
 *
 * This suite exercises the production parent component in a real DOM with
 * `react-dom` (React 18, the version this package ships). It asserts the
 * parent's own wiring - never the children's internals:
 *
 * - the quiet/writing decision (`readingPresentation`) and the labelled
 *   Edit/Done route the header hands back;
 * - entry from a *real* title (`#editor-title`) or body (`.main-editor`)
 *   focus, and the privacy guard that keeps a locked session's password field
 *   and an explicitly non-editable body from ever entering writing;
 * - the details (word count + tags) disclosure lifecycle: kept through the
 *   first save of the note being typed, reset on an asynchronous load and on
 *   an A -> B switch;
 * - read-only and `noHeader` parity (the toolbar must stay reachable);
 * - the per-tab globals the native side and the editor commands read
 *   (`editorControllers`, `editorTitles`), and the app-supplied date line;
 * - writing survives a theme/settings re-render and a window resize.
 *
 * Bounded seams (deliberately mocked, and NOT claimed to be the full runtime):
 * - `./header` is reduced to the contract the parent relies on (a labelled
 *   primary action fed by `writing`, a details toggle, and no chrome under
 *   `noHeader`/Mac). The real header's buttons, menu, mousedown/AT activation
 *   and C1/legacy/Mac rules are covered exhaustively by `header.test.tsx`.
 * - `./tiptap` is reduced to the observable input the parent hands it
 *   (`readingPresentation`, `noToolbar`, `locked`), mirrored with an inline
 *   `display` so the assertion needs no style engine. The real wrapper and its
 *   CSS-hide contract are covered by `tests/toolbar-configuration.test.tsx`.
 * - `../hooks/useEditorController` and `../hooks/useSettings` are small,
 *   explicit seams; `./title`, `./editor-date`, `./statusbar` and `./tags` are
 *   the REAL components (so the `editor-title` id, the `editorTitles` ref, the
 *   date store and the `statusBars`/`editorTags` global refs are the shipping
 *   ones), and `../utils/editor-date` is the real store.
 * - `@notesnook/editor`, `@notesnook/theme`, `@notesnook/intl`, the CSS module
 *   and the mac/pending-save utilities are periphery, mocked inside this file.
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
import type { Settings } from "../utils";

/**
 * The tab the parent renders for. It mirrors only the session fields these
 * tests read (the real `TabItem` additionally requires
 * `session.spellCheckDisabled`, which is not part of this presentation).
 */
type MockTab = {
  id: string;
  session?: {
    origin?: { id: string; title: string } | null;
    noteId?: string;
    readonly?: boolean;
    locked?: boolean;
    noteLocked?: boolean;
  };
};

/** The mock function contract of the imported `jest` *value* (see header.test). */
type MockFunction = ReturnType<typeof jest.fn>;

/**
 * The bridge transport spy. Only the NewTag test installs it (the parent posts
 * on mount, so an always-installed spy would mix those calls in); it never lets
 * anything leave jsdom.
 */
const mockPost = jest.fn();

/* ----------------------------- periphery seams ---------------------------- */

jest.mock("@notesnook/editor", () => ({
  Editor: class {},
  getFontById: () => ({ font: "sans-serif" }),
  getTableOfContents: () => [],
  toBlobURL: () => "blob:mock",
  usePermissionHandler: () => {},
  replaceDateTime: (value: string) => value,
  /**
   * The real `StatusBar` (now mounted unmocked) reads the word count through
   * this export. It is periphery: the counter's own logic is not under test
   * here, only that the real status bar mounts and keeps its global ref.
   */
  getTotalWords: () => 0
}));

jest.mock("@notesnook/theme", () => {
  const color = new Proxy(
    {},
    { get: (_target, key) => `var(--mock-${String(key)})` }
  );
  const colors = new Proxy({}, { get: () => color });
  return {
    resolveAppleSurfaces: () => ({ documentSurface: "rgb(20, 20, 20)" }),
    useThemeColors: () => ({ colors, isDark: false }),
    useThemeEngineStore: (selector: (store: unknown) => unknown) =>
      selector({ theme: { colorScheme: "light" } })
  };
});

jest.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: (_target, key) => () => String(key) })
}));

jest.mock("./styles.module.css", () => {
  return new Proxy(
    {},
    { get: (_target, key) => (key === "__esModule" ? undefined : String(key)) }
  );
});

jest.mock("../hooks/useSafeArea", () => ({
  useSafeArea: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}));

jest.mock("../utils/mac", () => ({
  MAC_TEXT_COLUMN_MAX_WIDTH: "46rem",
  MAC_TEXT_COLUMN_PADDING: 24,
  MAC_TOOLBAR_CAPSULE_CLEARANCE: 90,
  MAC_TITLE_FONT_SIZE: 22,
  MAC_TITLE_LINE_HEIGHT: 28
}));

jest.mock("../utils/mac-drop", () => ({
  setupMacFileDrop: () => () => {}
}));

jest.mock("../utils/pending-saves", () => ({
  pendingSaveRequests: {
    getPendingContentIds: async () => [],
    getPendingTitleIds: async () => [],
    postPendingRequests: async () => {},
    removePendingContentsById: () => {},
    removePendingTitlesById: () => {},
    setContent: () => {},
    setTitle: () => {}
  }
}));

/**
 * The macOS/iOS header seam. It renders the labelled primary action the parent
 * drives (`writing` -> "Done", otherwise "Edit"), the details toggle, and no
 * chrome where the real header renders none (`noHeader`, Mac Catalyst).
 */
jest.mock("./header", () => {
  const ReactForMock = require("react");
  return {
    __esModule: true,
    default: (props: {
      noHeader?: boolean;
      writing?: boolean;
      detailsOpen?: boolean;
      collectionInHeader?: boolean;
      surface?: string;
      settings: { isMacCatalyst?: boolean };
      onEdit?: () => void;
      onDone?: () => void;
      onToggleDetails?: () => void;
    }) => {
      if (props.noHeader || props.settings.isMacCatalyst) return null;
      return ReactForMock.createElement(
        "div",
        {
          id: "header",
          "data-testid": "header",
          "data-writing": String(!!props.writing),
          "data-details-open": String(!!props.detailsOpen),
          "data-surface": props.surface,
          "data-collection-in-header": String(!!props.collectionInHeader)
        },
        ReactForMock.createElement(
          "button",
          {
            "data-testid": props.writing ? "done" : "edit",
            onClick: () => (props.writing ? props.onDone?.() : props.onEdit?.())
          },
          props.writing ? "Done" : "Edit"
        ),
        ReactForMock.createElement(
          "button",
          {
            "data-testid": "details-toggle",
            onClick: () => props.onToggleDetails?.()
          },
          "Details"
        )
      );
    }
  };
});

/**
 * The formatting-toolbar seam. Mirroring the real wrapper, a locked session
 * mounts no toolbar; the reading flag and `noToolbar` only change the CSS
 * `display` of the still-mounted bar (expressed here as an inline style).
 */
jest.mock("./tiptap", () => {
  const ReactForMock = require("react");
  return {
    __esModule: true,
    default: (props: {
      settings: { noToolbar?: boolean };
      readingPresentation?: boolean;
    }) => {
      const locked = !!mockCurrentTab?.session?.locked;
      return ReactForMock.createElement(
        "div",
        {
          "data-testid": "editor-wrapper",
          "data-reading": String(!!props.readingPresentation)
        },
        locked
          ? null
          : ReactForMock.createElement("div", {
              className: "editor-toolbar",
              style: {
                display:
                  props.settings.noToolbar || props.readingPresentation
                    ? "none"
                    : "flex"
              }
            })
      );
    }
  };
});

/**
 * `./statusbar` and `./tags` are deliberately NOT mocked: the details row is
 * CSS-hidden (never unmounted), so the point of this suite is that the *real*
 * components stay mounted and keep their `statusBars`/`editorTags` global refs
 * registered while the row is collapsed. Only the tiny editor periphery they
 * read is provided (`getTotalWords` above; each mock editor's
 * `extensionStorage.characterCount` and `on`/`off` below).
 */

/** The per-tab controller the parent publishes; only its shape matters here. */
const mockControllerState = {
  loading: false,
  title: "My note",
  titlePlaceholder: "Note title"
};

jest.mock("../hooks/useEditorController", () => ({
  useEditorController: () => ({
    loading: mockControllerState.loading,
    title: mockControllerState.title,
    titlePlaceholder: mockControllerState.titlePlaceholder,
    content: { current: null },
    passwordInputRef: { current: null },
    setLoading: () => {},
    setTitle: () => {},
    setTitlePlaceholder: () => {},
    titleChange: () => {},
    getTableOfContents: () => [],
    countWords: () => {},
    scroll: () => {},
    updateTab: () => {},
    scrollIntoView: () => {},
    focusPassInput: () => {},
    blurPassInput: () => {}
  })
}));

/** The settings payload the native app pushes into the WebView. */
function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    readonly: false,
    fullscreen: false,
    deviceMode: "tablet",
    isMacCatalyst: false,
    pagedPresentation: false,
    premium: false,
    tools: [],
    corsProxy: "https://cors.notesnook.com",
    fontSize: 16,
    fontFamily: "sans-serif",
    timeFormat: "12-hour",
    dateFormat: "DD-MM-YYYY",
    fontScale: 1,
    markdownShortcuts: true,
    features: {},
    loggedIn: true,
    defaultLineHeight: 1.2,
    dayFormat: "short",
    noHeader: false,
    noToolbar: false,
    doubleSpacedLines: false,
    ...overrides
  };
}

let mockSettings: Settings = makeSettings();
let mockCurrentTab: MockTab = { id: "tab-1", session: { noteId: "note-a" } };
const mockTabStoreState = {
  currentTab: "tab-1",
  tabs: [] as MockTab[],
  biometryAvailable: false,
  biometryEnrolled: false,
  getCurrentNoteId: () => mockCurrentTab.session?.noteId
};

jest.mock("../hooks/useSettings", () => ({
  useSettings: () => mockSettings
}));

jest.mock("../hooks/useTabStore", () => {
  const ReactForMock = require("react");
  const TabContext = ReactForMock.createContext(null);
  const state = () => mockTabStoreState;
  const useTabStore = (selector?: (state: unknown) => unknown) =>
    selector ? selector(state()) : state();
  return {
    TabContext,
    useTabContext: () => ReactForMock.useContext(TabContext),
    useTabStore: Object.assign(useTabStore, {
      getState: state,
      subscribe: () => () => {},
      setState: () => {}
    })
  };
});

import ParentEditor from "./editor";
import { Freeze } from "react-freeze";
import { createStore, useStore } from "zustand";
import { startTransition } from "react";
import { TabContext } from "../hooks/useTabStore";
import { editorDate } from "../utils/editor-date";
import { EditorEvents } from "../utils/editor-events";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const testGlobals = globalThis as unknown as Record<string, unknown>;

const mockTabId = "tab-1";

type MockCommands = {
  focus: MockFunction;
  blur: MockFunction;
  undo: MockFunction;
  redo: MockFunction;
  startSearch: MockFunction;
};

/**
 * The per-tab editor the real `StatusBar` also reads: besides the commands the
 * parent drives, it needs the character-count extension accessor and the
 * event on/off pair. These are inert fakes - the counter's own logic stays in
 * `statusbar.test.tsx` and is not re-tested here.
 */
type MockEditor = {
  commands: MockCommands;
  extensionStorage: { characterCount: { characters: MockFunction } };
  on: MockFunction;
  off: MockFunction;
  isFocused: boolean;
};

let mockCommands: MockCommands = {
  focus: jest.fn(),
  blur: jest.fn(),
  undo: jest.fn(),
  redo: jest.fn(),
  startSearch: jest.fn()
};
let mockEditors: Record<string, MockEditor> = {};

describe("iOS document chrome (parent editor)", () => {
  let container: HTMLDivElement;
  let root: Root;

  /**
   * jsdom's `HTMLElement` (and `Element`) has no `scrollTo`, but the parent's
   * real scroll restoration (`editor.tsx` -> `restoreNoteSelection` ->
   * `containerRef.current?.scrollTo(...)`, called on mount via
   * `useLayoutEffect` -> `updateFocusedTab`) invokes it for a tab with a
   * `noteId`. Optional chaining only guards `current` being `null`, not the
   * missing method, so the real code path throws a `TypeError` in jsdom.
   *
   * This is a documented test-periphery seam: install a real `scrollTo` stub
   * for the duration of each test and restore the prototype afterwards. It is
   * captured at collection time, before any `beforeEach` mutates the prototype.
   */
  const scrollToDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTo"
  );

  const render = () => {
    act(() => {
      root.render(
        <TabContext.Provider value={mockCurrentTab as any}>
          <ParentEditor />
        </TabContext.Provider>
      );
    });
  };

  it("provides a private popup owner inside the real active Mac editor root", () => {
    mockSettings.isMacCatalyst = true;
    render();
    const owner = container.querySelector(".active .dialogContainer");
    expect(owner).not.toBeNull();
    expect(
      owner?.parentElement?.contains(container.querySelector(".main-editor"))
    ).toBe(true);
    expect(owner?.parentElement?.contains(title())).toBe(true);
  });

  it.each([false, true])("keeps exactly the focused Mac owner across frozen tabs and external store updates (transition=%s)", (transition) => {
    mockSettings.isMacCatalyst = true;
    const tabs = [mockCurrentTab, { id: "tab-2", session: { noteId: "note-b" } }];
    mockEditors["tab-2"] = { ...mockEditors[mockTabId] };
    mockTabStoreState.tabs = tabs;
    const store = createStore(() => ({ currentTab: "tab-1" }));
    function Tabs() {
      // Production App subscribes to zustand; bridge changes use setState.
      const current = useStore(store, state => state.currentTab);
      return <>{tabs.map(tab => (
        <TabContext.Provider key={tab.id} value={tab as any}>
          <Freeze freeze={current !== tab.id}><ParentEditor /></Freeze>
        </TabContext.Provider>
      ))}</>;
    }
    act(() => root.render(<Tabs />));
    const switchTo = (currentTab: string) => {
      mockTabStoreState.currentTab = currentTab;
      act(() => {
        const update = () => store.setState({ currentTab });
        if (transition) startTransition(update); else update();
      });
    };
    const currentRoot = () => {
      expect(document.querySelectorAll('.active')).toHaveLength(1);
      expect(container.querySelectorAll('.active .dialogContainer')).toHaveLength(1);
      const active = container.querySelector<HTMLElement>('.active')!;
      // Tiptap is the suite's leaf seam. Mark the actual retained body DOM as
      // its ProseMirror root to test the production document selector identity.
      active.querySelector('.main-editor')!.classList.add('ProseMirror');
      expect(document.querySelector('.active .ProseMirror')).toBe(active.querySelector('.main-editor'));
      return active;
    };
    const first = currentRoot();
    switchTo('tab-2'); const second = currentRoot();
    expect(second).not.toBe(first); expect(first.classList.contains('active')).toBe(false);
    switchTo('tab-1'); expect(currentRoot()).toBe(first); expect(second.classList.contains('active')).toBe(false);
  });

  it("preserves the existing mobile popup host on iPhone and iPad", () => {
    render();
    expect(container.querySelector(".dialogContainer")).toBeNull();
  });

  const wrapper = () =>
    container.querySelector<HTMLElement>('[data-testid="editor-wrapper"]');
  /** `data-reading` is the parent's own decision, observed at its edge. */
  const reading = () => wrapper()?.getAttribute("data-reading");
  const toolbar = () => container.querySelector<HTMLElement>(".editor-toolbar");
  const primary = () =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="edit"], [data-testid="done"]'
    );
  const detailsRow = () =>
    container.querySelector<HTMLElement>("#editor-details");
  const title = () =>
    container.querySelector<HTMLTextAreaElement>("#editor-title");
  const body = () => container.querySelector<HTMLElement>(".main-editor");
  const scroller = () =>
    container.querySelector<HTMLElement>("#editor-container-scroller");

  const press = (element: Element) => {
    act(() => {
      (element as HTMLElement).click();
    });
  };
  const pressPrimary = () => press(primary()!);
  const pressDetails = () =>
    press(container.querySelector('[data-testid="details-toggle"]')!);

  /** The bubbling focus event React's `onFocus` listens for at the root. */
  const focus = (element: Element) => {
    act(() => {
      element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();

    // JSDOM periphery seam: provide the `scrollTo` the real parent calls on
    // mount. Installed after `clearAllMocks` so call counts start clean, and
    // removed in `afterEach` (jsdom has no such method to spy on).
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value: jest.fn()
    });

    mockSettings = makeSettings();
    mockControllerState.loading = false;
    mockCurrentTab = { id: mockTabId, session: { noteId: "note-a" } };
    editorDate.set(mockTabId, "");

    mockCommands = {
      focus: jest.fn(),
      blur: jest.fn(),
      undo: jest.fn(),
      redo: jest.fn(),
      startSearch: jest.fn()
    };
    mockEditors = {
      [mockTabId]: {
        commands: mockCommands,
        extensionStorage: {
          characterCount: { characters: jest.fn(() => 0) }
        },
        on: jest.fn(),
        off: jest.fn(),
        isFocused: false
      }
    };

    testGlobals.editors = mockEditors;
    testGlobals.editorControllers = {};
    testGlobals.editorTitles = {};
    testGlobals.editorTags = {};
    testGlobals.statusBars = {};
    testGlobals.handwriting = false;
    testGlobals.templates = false;
    testGlobals.__PLATFORM__ = "ios";

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete testGlobals.__PLATFORM__;

    // Restore the prototype exactly: put back the original descriptor if jsdom
    // had one, otherwise delete the seam so no other suite observes it.
    if (scrollToDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollTo",
        scrollToDescriptor
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
  });

  it("starts an existing note in the calm reading presentation and routes Edit/Done", () => {
    render();

    // Quiet: the toolbar is asked to hide and the primary action is "Edit".
    expect(reading()).toBe("true");
    expect(toolbar()!.style.display).toBe("none");
    expect(container.querySelector('[data-testid="edit"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="done"]')).toBeNull();

    // Entering writing shows the toolbar, flips the label and focuses the real
    // per-tab editor - no document/read-only change.
    pressPrimary();
    expect(reading()).toBe("false");
    expect(toolbar()!.style.display).toBe("flex");
    expect(container.querySelector('[data-testid="done"]')).not.toBeNull();
    expect(mockCommands.focus).toHaveBeenCalledTimes(1);

    // Done returns to quiet and blurs the real body and title.
    const titleElement = title()!;
    const titleBlur = jest.spyOn(titleElement, "blur");
    pressPrimary();
    expect(reading()).toBe("true");
    expect(container.querySelector('[data-testid="edit"]')).not.toBeNull();
    expect(mockCommands.blur).toHaveBeenCalledTimes(1);
    expect(titleBlur).toHaveBeenCalledTimes(1);
  });

  it("enters writing from the real title or body focus and ignores other controls", () => {
    render();
    expect(reading()).toBe("true");

    // A control inside the same scroller that is neither the title nor the
    // body (here the details row; in a locked note it is the password field)
    // must not enter writing.
    focus(detailsRow()!);
    expect(reading()).toBe("true");

    // The real title textarea, `id="editor-title"`, is the entry the parent's
    // focus wiring looks for.
    const titleElement = title();
    expect(titleElement).not.toBeNull();
    focus(titleElement!);
    expect(reading()).toBe("false");

    // Back to quiet, then the note body (`.main-editor`) is the other entry.
    pressPrimary();
    expect(reading()).toBe("true");
    focus(body()!);
    expect(reading()).toBe("false");
  });

  it("ignores a body focus when the content root is explicitly non-editable", () => {
    render();
    expect(reading()).toBe("true");

    const bodyElement = body()!;
    bodyElement.setAttribute("contenteditable", "false");
    focus(bodyElement);
    // The editable root says "not editable": the chrome must not follow it.
    expect(reading()).toBe("true");

    bodyElement.removeAttribute("contenteditable");
    focus(bodyElement);
    expect(reading()).toBe("false");
  });

  it("never turns a locked session's focus into writing", () => {
    mockCurrentTab = {
      id: mockTabId,
      session: { noteId: "note-a", locked: true, noteLocked: true }
    };
    render();

    // A locked note is not writable, so the quiet presentation is never asked
    // for (the real wrapper mounts no toolbar for a locked session).
    expect(reading()).toBe("false");
    expect(toolbar()).toBeNull();

    const password = container.querySelector<HTMLInputElement>(
      'input[name="password"]'
    );
    expect(password).not.toBeNull();

    // Neither the password field nor a body focus may enter writing.
    focus(password!);
    expect(container.querySelector('[data-testid="done"]')).toBeNull();

    focus(body()!);
    expect(container.querySelector('[data-testid="done"]')).toBeNull();
    expect(reading()).toBe("false");
  });

  it("keeps writing and the details row through the first save of a new note", () => {
    mockCurrentTab = { id: mockTabId, session: {} };
    render();

    // A fresh, unsaved note starts in writing.
    expect(reading()).toBe("false");
    expect(container.querySelector('[data-testid="done"]')).not.toBeNull();

    pressDetails();
    expect(detailsRow()!.style.display).toBe("flex");

    // The user is writing in it: a real body focus records the user entry.
    focus(body()!);

    // The first save assigns the id. The note must stay in writing and keep
    // the details row the user opened.
    mockCurrentTab = { id: mockTabId, session: { noteId: "note-new" } };
    render();
    expect(reading()).toBe("false");
    expect(detailsRow()!.style.display).toBe("flex");
    expect(container.querySelector('[data-testid="done"]')).not.toBeNull();
  });

  it("returns to quiet and closes the details on an asynchronous note load", () => {
    mockCurrentTab = { id: mockTabId, session: {} };
    render();
    expect(reading()).toBe("false");

    pressDetails();
    expect(detailsRow()!.style.display).toBe("flex");

    // No user entry: the note was merely loaded asynchronously into the tab.
    mockCurrentTab = { id: mockTabId, session: { noteId: "note-loaded" } };
    render();
    expect(reading()).toBe("true");
    expect(detailsRow()!.style.display).toBe("none");
  });

  it("returns to quiet and resets the details on an A -> B document switch", () => {
    render();
    expect(reading()).toBe("true");

    pressDetails();
    expect(detailsRow()!.style.display).toBe("flex");

    mockCurrentTab = { id: mockTabId, session: { noteId: "note-b" } };
    render();
    expect(reading()).toBe("true");
    expect(detailsRow()!.style.display).toBe("none");
  });

  it("keeps the toolbar for a read-only session and never flips its read-only state", () => {
    mockCurrentTab = {
      id: mockTabId,
      session: { noteId: "note-a", readonly: true }
    };
    render();

    // The static link/image tools must stay reachable.
    expect(reading()).toBe("false");
    expect(toolbar()!.style.display).toBe("flex");
    // The real title is genuinely read-only - the presentation never touched it.
    expect(title()!.readOnly).toBe(true);
  });

  it("treats a globally read-only session the same way", () => {
    mockSettings = makeSettings({ readonly: true });
    render();

    expect(reading()).toBe("false");
    expect(toolbar()!.style.display).toBe("flex");
    expect(title()!.readOnly).toBe(true);
  });

  it("with noHeader there is no chrome, so the toolbar must stay reachable", () => {
    mockSettings = makeSettings({ noHeader: true });
    render();

    // No header at all, so there is no labelled Edit to come back through.
    expect(container.querySelector('[data-testid="header"]')).toBeNull();
    expect(container.querySelector("#editor-title")).toBeNull();

    // The route into writing is therefore the visible formatting toolbar: the
    // quiet presentation must never be requested without a header, and the
    // pane reserves the bar's clearance the way it does while writing.
    expect(reading()).toBe("false");
    expect(toolbar()!.style.display).toBe("flex");
    expect(scroller()!.style.paddingBottom).toBe("45px");
  });

  it("honours the noToolbar setting independently of the reading flag", () => {
    mockSettings = makeSettings({ noToolbar: true });
    render();

    // The wrapper is told to hide the bar; that is the pre-existing setting and
    // the parent does not fight it.
    expect(toolbar()!.style.display).toBe("none");
    // The note still starts quiet (the wrapper stays mounted either way).
    expect(reading()).toBe("true");
  });

  it("starts a brand-new, unsaved note in writing with the toolbar shown", () => {
    mockCurrentTab = { id: mockTabId, session: {} };
    render();

    expect(reading()).toBe("false");
    expect(toolbar()!.style.display).toBe("flex");
    expect(container.querySelector('[data-testid="done"]')).not.toBeNull();
  });

  it("preserves writing across a theme/settings change and a window resize", () => {
    render();
    expect(reading()).toBe("true");

    pressPrimary();
    expect(reading()).toBe("false");

    // A settings/theme payload update re-renders the pane...
    mockSettings = makeSettings({ fontSize: 20, fontFamily: "serif" });
    render();
    expect(reading()).toBe("false");

    // ...and a real resize (the title's own listener runs) must not drop the
    // chrome back to the calm presentation.
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(reading()).toBe("false");
    expect(container.querySelector('[data-testid="done"]')).not.toBeNull();
  });

  it("publishes the per-tab controller and title metadata refs", () => {
    render();

    // The parent registers its controller on the global seam the editor
    // commands and the native side read.
    expect(globalThis.editorControllers[mockTabId]).toBeDefined();

    // The real title registers its own textarea ref under the tab id.
    const titleElement = title();
    expect(titleElement).not.toBeNull();
    expect(globalThis.editorTitles[mockTabId]?.current).toBe(titleElement);
  });

  it("shows the app-supplied last-edited date above the note", () => {
    editorDate.set(mockTabId, "12 Oct 2026, 10:00");
    render();

    const dateLine = Array.from(container.querySelectorAll("p")).find(
      (paragraph) => paragraph.textContent === "12 Oct 2026, 10:00"
    );
    expect(dateLine).not.toBeUndefined();
  });

  it("hands the resolved document surface down to the header", () => {
    render();

    // The parent resolves the *document* surface once and paints the bar with
    // it, so the chrome and the note share the same calm tone.
    const header = container.querySelector<HTMLElement>(
      '[data-testid="header"]'
    );
    expect(header).not.toBeNull();
    expect(header!.getAttribute("data-surface")).toBe("rgb(20, 20, 20)");
  });

  it("never enters writing from the primary Edit while the editor is globally read-only", () => {
    mockSettings = makeSettings({ readonly: true });
    render();

    // The header seam still offers the labelled action (the real header's own
    // suppression of it is covered by header.test.tsx), so this probes the
    // parent's guard directly: pressing it must do nothing at all.
    expect(container.querySelector('[data-testid="edit"]')).not.toBeNull();
    pressPrimary();

    expect(mockCommands.focus).not.toHaveBeenCalled();
    expect(mockCommands.blur).not.toHaveBeenCalled();
    expect(mockCommands.undo).not.toHaveBeenCalled();
    expect(mockCommands.redo).not.toHaveBeenCalled();
    // The pane never flipped to the writing presentation.
    expect(container.querySelector('[data-testid="done"]')).toBeNull();
    expect(reading()).toBe("false");
  });

  it("never enters writing from the primary Edit while the session is locked", () => {
    mockCurrentTab = {
      id: mockTabId,
      session: { noteId: "note-a", locked: true, noteLocked: true }
    };
    render();

    expect(container.querySelector('[data-testid="edit"]')).not.toBeNull();
    pressPrimary();

    expect(mockCommands.focus).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="done"]')).toBeNull();
    expect(reading()).toBe("false");
  });

  it("mounts the real status bar and tags row and keeps it private when locked or headerless", () => {
    render();

    // The real `StatusBar` and `Tags` render their own DOM inside the row (not
    // a nulled seam): the word count and the "+ Add tag" control are the
    // shipping ones.
    expect(detailsRow()).not.toBeNull();
    expect(detailsRow()!.textContent).toContain("totalWords");
    expect(detailsRow()!.textContent).toContain("addTag");

    // A locked note renders no metadata row at all.
    mockCurrentTab = {
      id: mockTabId,
      session: { noteId: "note-a", locked: true, noteLocked: true }
    };
    render();
    expect(detailsRow()).toBeNull();

    // ...and neither does a headerless presentation.
    mockCurrentTab = { id: mockTabId, session: { noteId: "note-a" } };
    mockSettings = makeSettings({ noHeader: true });
    render();
    expect(detailsRow()).toBeNull();
  });

  it("keeps the status bar and tags refs registered and identical while the row is CSS-hidden", () => {
    render();

    const statusRef = globalThis.statusBars[mockTabId];
    const tagsRef = globalThis.editorTags[mockTabId];
    expect(statusRef?.current).toBeDefined();
    expect(tagsRef?.current).toBeDefined();

    // Collapsed: the row is CSS-hidden, not unmounted.
    expect(detailsRow()!.style.display).toBe("none");

    // Opening/closing the disclosure must never remount them: the refs the
    // native side and the editor commands hold stay the same objects.
    pressDetails();
    expect(detailsRow()!.style.display).toBe("flex");
    expect(globalThis.statusBars[mockTabId]).toBe(statusRef);
    expect(globalThis.editorTags[mockTabId]).toBe(tagsRef);

    pressDetails();
    expect(detailsRow()!.style.display).toBe("none");
    expect(globalThis.statusBars[mockTabId]).toBe(statusRef);
    expect(globalThis.editorTags[mockTabId]).toBe(tagsRef);

    // Edit -> Done, likewise.
    pressPrimary();
    expect(globalThis.statusBars[mockTabId]).toBe(statusRef);
    expect(globalThis.editorTags[mockTabId]).toBe(tagsRef);
  });

  it("accepts tags on the collapsed row and shows them when the Details open, on the same ref", () => {
    render();

    const row = detailsRow()!;
    const tagsRef = globalThis.editorTags[mockTabId]!;
    expect(row.style.display).toBe("none");
    expect(row.textContent).not.toContain("#fixture");

    // The synthetic fixture arrives while the row is CSS-hidden (the native
    // side pushes tags through this exact ref regardless of the disclosure).
    act(() => {
      tagsRef.current!.setTags([
        { title: "fixture", alias: "fixture", id: "tag-1", type: "tag" }
      ]);
    });

    // It landed on the still-mounted, still-hidden row, under the same ref.
    expect(row.style.display).toBe("none");
    expect(globalThis.editorTags[mockTabId]).toBe(tagsRef);
    expect(row.textContent).toContain("#fixture");

    // Opening the disclosure reveals the updated tag, still on the same ref.
    pressDetails();
    expect(detailsRow()!.style.display).toBe("flex");
    expect(globalThis.editorTags[mockTabId]).toBe(tagsRef);
    expect(detailsRow()!.textContent).toContain("#fixture");
  });

  it("keeps the native NewTag route on the rendered tag, with the real tab and note", () => {
    // The real Tags control posts over the bridge; the spy replaces only the
    // transport, so no data is written and nothing leaves jsdom.
    testGlobals.post = mockPost;
    render();

    const tagsRef = globalThis.editorTags[mockTabId]!;
    act(() => {
      tagsRef.current!.setTags([
        { title: "fixture", alias: "fixture", id: "tag-1", type: "tag" }
      ]);
    });
    pressDetails();

    const tagButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button")
    ).find((element) => element.textContent === "#fixture");
    expect(tagButton).toBeDefined();

    press(tagButton!);
    expect(mockPost).toHaveBeenCalledWith(
      EditorEvents.newtag,
      undefined,
      mockTabId,
      "note-a"
    );
  });
  it("dismisses only this editor's failed-save overlay when an inactive tab has the same id", () => {
    const foreign = document.createElement("div");
    foreign.id = "editor-saving-failed-overlay";
    foreign.style.display = "flex";
    document.body.insertBefore(foreign, container);
    try {
      render();
      const own = container.querySelector<HTMLElement>(
        "#editor-saving-failed-overlay"
      )!;
      own.style.display = "flex";
      press(own.querySelector("button")!);
      expect(own.style.display).toBe("none");
      expect(foreign.style.display).toBe("flex");
    } finally {
      foreign.remove();
    }
  });
  it("renders the actual list origin with the real saved date and clears it on unrelated note open", () => {
    mockCurrentTab.session = {
      noteId: "note-a",
      origin: { id: "book-b", title: "Selected collection" }
    };
    editorDate.set(mockTabId, "14 Oct, 12:00");
    render();
    const header = () => container.querySelector('[data-testid="header"]');
    expect(header()?.getAttribute("data-collection-in-header")).toBe("true");
    // The date is real and the caption is delegated once to the Header.
    expect(container.textContent).toContain("14 Oct, 12:00");
    expect(container.textContent).not.toContain("Selected collection");
    mockSettings = makeSettings({ pagedPresentation: true });
    render();
    expect(header()?.getAttribute("data-collection-in-header")).toBe("false");
    expect(container.textContent).toContain(
      "Selected collection · 14 Oct, 12:00"
    );
    mockSettings = makeSettings({ deviceMode: "mobile" });
    render();
    expect(header()?.getAttribute("data-collection-in-header")).toBe("false");
    expect(container.textContent).toContain(
      "Selected collection · 14 Oct, 12:00"
    );
    mockCurrentTab = {
      id: mockTabId,
      session: { noteId: "note-b", origin: null }
    };
    render();
    expect(container.textContent).not.toContain("Selected collection");
  });
});
