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

import React from "react";
import { act, create } from "react-test-renderer";

const mockToggleInspector = jest.fn();
const mockFormat = jest.fn();
const mockDismissPopup = jest.fn();
const mockOpenInsert = jest.fn();
const mockOpenFormatting = jest.fn();
let mockTabId: string | null = null;
let mockSection = "library";

jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({ colors: {} })
}));

jest.mock("react-native", () => {
  class FakeEmitter {
    listeners = new Map<string, Set<(body: unknown) => void>>();
    constructor(_module: unknown) {}
    addListener(event: string, cb: (body: unknown) => void) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(cb);
      return { remove: () => this.listeners.get(event)?.delete(cb) };
    }
  }
  (globalThis as any).__emitterInstances = [];
  return {
    Linking: { openURL: jest.fn(() => Promise.resolve()) },
    NativeEventEmitter: class extends FakeEmitter {
      constructor(mod: unknown) {
        super(mod);
        (globalThis as any).__emitterInstances.push(this);
      }
    },
    NativeModules: {
      VeyraNMacMenu: { setSelectedSection: jest.fn(), setContext: jest.fn() }
    },
    Platform: { OS: "ios", isMacCatalyst: true },
    Pressable: "Pressable",
    Text: "Text",
    View: "View"
  };
});

jest.mock("../common/database", () => ({ db: {} }));
jest.mock("../components/mac-note-commands", () => ({
  runMacNoteAction: jest.fn()
}));
jest.mock("../components/native-menu", () => ({}));
jest.mock("../components/properties", () => ({
  Properties: { present: jest.fn() }
}));
jest.mock("../components/sheets/add-notebook", () => ({
  AddNotebookSheet: { present: jest.fn() }
}));
jest.mock("../components/ui/AppIcon", () => ({
  __esModule: true,
  default: "AppIcon"
}));
jest.mock("../screens/notes/common", () => ({
  openEditor: jest.fn(),
  setOnFirstSaveUnassigned: jest.fn()
}));
jest.mock("../screens/settings/types", () => ({}));
jest.mock("../screens/editor/tiptap/use-tab-store", () => ({
  useTabStore: {
    getState: () => ({
      currentTab: mockTabId,
      getNoteIdForTab: () => undefined,
      getCurrentNoteId: () => undefined
    }),
    subscribe: () => () => {}
  }
}));
jest.mock("../screens/editor/tiptap/utils", () => ({
  editorController: {
    current: {
      commands: {
        format: mockFormat,
        dismissPopup: mockDismissPopup,
        openInsert: mockOpenInsert,
        openFormatting: mockOpenFormatting
      }
    }
  }
}));
jest.mock("../services/templates", () => ({ saveNoteAsTemplate: jest.fn() }));
jest.mock("../stores/use-setting-store", () => ({
  useSettingStore: {
    getState: () => ({
      settings: { introCompleted: true },
      dimensions: { width: 400 }
    })
  }
}));
jest.mock("../stores/use-apple-navigation-store", () => ({
  useAppleNavigationStore: {
    getState: () => ({ section: mockSection }),
    subscribe: () => () => {}
  }
}));
jest.mock("../stores/use-global-search-store", () => ({
  useGlobalSearchStore: {
    getState: () => ({ setQuery: jest.fn(), submitQuery: jest.fn() })
  }
}));
jest.mock("../stores/use-navigation-store", () => ({
  __esModule: true,
  default: { getState: () => ({ focusedRouteId: null }) }
}));
jest.mock("../stores/use-mac-sidebar-store", () => ({
  useMacSidebarStore: { getState: () => ({ toggle: jest.fn() }) }
}));
jest.mock("../stores/use-mac-list-focus-store", () => ({
  nextListIndex: jest.fn(),
  useMacListFocusStore: { getState: () => ({ lists: {} }) }
}));
jest.mock("../components/list-items/note/wrapper", () => ({
  openNote: jest.fn()
}));
jest.mock("../stores/use-mac-window-store", () => ({
  useMacWindowStore: {
    getState: () => ({ listMenu: null, toggleInspector: mockToggleInspector }),
    subscribe: () => () => {}
  }
}));
jest.mock("../utils/events", () => ({ eCreateTaskRequest: "create-task" }));
jest.mock("../navigation/navigation-stack", () => ({
  selectAppleSection: jest.fn()
}));
jest.mock("../services/event-manager", () => ({
  eSendEvent: jest.fn(),
  hideSheet: jest.fn(),
  presentSheet: jest.fn(),
  ToastManager: { show: jest.fn(), error: jest.fn() }
}));
jest.mock("../services/navigation", () => ({
  __esModule: true,
  default: { goBack: jest.fn(), navigate: jest.fn(), push: jest.fn() }
}));

const navRef: {
  current: {
    getState: () => {
      index?: number;
      routes: { name: string; key?: string }[];
    };
  } | null;
} = {
  current: null
};
jest.mock("../utils/global-refs", () => ({ rootNavigatorRef: navRef }));

import { useMacMenuCommands } from "./use-mac-menu-commands";
import {
  __resetMacModalStackForTests,
  registerMacModal
} from "../services/mac-modal-stack";
import { hideSheet } from "../services/event-manager";
import Navigation from "../services/navigation";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function HookHost() {
  useMacMenuCommands();
  return null;
}

function emitCommand(command: string) {
  const emitters = (globalThis as any).__emitterInstances as {
    listeners: Map<string, Set<(body: unknown) => void>>;
  }[];
  const emitter = emitters[emitters.length - 1];
  emitter.listeners
    .get("VeyraNMacMenuCommand")
    ?.forEach((cb) => cb({ command }));
}

describe("useMacMenuCommands Escape ownership", () => {
  beforeEach(() => {
    __resetMacModalStackForTests();
    jest.clearAllMocks();
    mockTabId = null;
    mockSection = "library";
    mockDismissPopup.mockReset().mockResolvedValue(false);
    (globalThis as any).__emitterInstances = [];
    navRef.current = { getState: () => ({ routes: [{ name: "Library" }] }) };
  });

  it("routes upper Insert to the existing editor controller without navigation", () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(React.createElement(HookHost));
    });
    emitCommand("insertBlock");
    expect(mockOpenInsert).toHaveBeenCalledTimes(1);
    expect(Navigation.goBack).not.toHaveBeenCalled();
    act(() => tree!.unmount());
  });

  it("routes upper More Formatting once through the zero-argument editor facade without other actions", () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(React.createElement(HookHost));
    });
    emitCommand("openFormatting");
    expect(mockOpenFormatting).toHaveBeenCalledTimes(1);
    expect(mockOpenFormatting).toHaveBeenCalledWith();
    expect(mockFormat).not.toHaveBeenCalled();
    expect(mockOpenInsert).not.toHaveBeenCalled();
    expect(Navigation.navigate).not.toHaveBeenCalled();
    expect(Navigation.push).not.toHaveBeenCalled();
    expect(Navigation.goBack).not.toHaveBeenCalled();
    expect(hideSheet).not.toHaveBeenCalled();
    act(() => tree.unmount());
    emitCommand("openFormatting");
    expect(mockOpenFormatting).toHaveBeenCalledTimes(1);
  });

  it("routes the native Inspector toggle without navigating or closing a modal", () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(React.createElement(HookHost));
    });
    emitCommand("toggleAssistantInspector");
    expect(mockToggleInspector).toHaveBeenCalledTimes(1);
    expect(hideSheet).not.toHaveBeenCalled();
    expect(Navigation.goBack).not.toHaveBeenCalled();
    act(() => tree!.unmount());
  });

  it.each(["title", "checklist", "bold", "link", "clearFormatting"])(
    "routes native format:%s through the active editor command interface",
    (name) => {
      let tree: ReturnType<typeof create>;
      act(() => {
        tree = create(React.createElement(HookHost));
      });
      emitCommand(`format:${name}`);
      expect(mockFormat).toHaveBeenCalledTimes(1);
      expect(mockFormat).toHaveBeenCalledWith(name);
      expect(Navigation.goBack).not.toHaveBeenCalled();
      expect(hideSheet).not.toHaveBeenCalled();
      act(() => tree!.unmount());
    }
  );

  it("asks the foreground editor once for two rapid Escapes and never pops a route later", async () => {
    mockTabId = "qa-a";
    navRef.current = {
      getState: () => ({ routes: [{ name: "FluidPanelsView", key: "main" }] })
    };
    let finish!: (value: boolean) => void;
    mockDismissPopup.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<HookHost />);
    });
    emitCommand("escape");
    emitCommand("escape");
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockDismissPopup).toHaveBeenCalledTimes(1);
    const valid = mockDismissPopup.mock.calls[0][0] as () => boolean;
    expect(valid()).toBe(true);
    mockTabId = "qa-b";
    expect(valid()).toBe(false);
    await act(async () => {
      finish(true);
      await Promise.resolve();
    });
    expect(Navigation.goBack).not.toHaveBeenCalled();
    act(() => tree!.unmount());
  });

  it("keeps native modal and Settings priority ahead of a background Web dialog", async () => {
    mockTabId = "qa-a";
    navRef.current = {
      getState: () => ({ routes: [{ name: "Settings", key: "settings" }] })
    };
    const close = jest.fn();
    const modal = registerMacModal("dialog", () => true, close);
    modal.present();
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<HookHost />);
    });
    emitCommand("escape");
    emitCommand("escape");
    expect(close).toHaveBeenCalledTimes(1);
    expect(mockDismissPopup).not.toHaveBeenCalled();
    expect(Navigation.goBack).not.toHaveBeenCalled();
    modal.dismissed();
    emitCommand("escape");
    expect(Navigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockDismissPopup).not.toHaveBeenCalled();
    act(() => tree!.unmount());
  });

  it("rejects a queued Web dismissal after a new native modal, root change or unmount", async () => {
    mockTabId = "qa-a";
    navRef.current = {
      getState: () => ({ routes: [{ name: "FluidPanelsView", key: "main" }] })
    };
    let finish!: (value: boolean) => void;
    mockDismissPopup.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<HookHost />);
    });
    emitCommand("escape");
    await act(async () => {
      await Promise.resolve();
    });
    const valid = mockDismissPopup.mock.calls[0][0] as () => boolean;
    const modal = registerMacModal("dialog", () => true, jest.fn());
    modal.present();
    expect(valid()).toBe(false);
    modal.dismissed();
    expect(valid()).toBe(true);
    navRef.current = {
      getState: () => ({ routes: [{ name: "Settings", key: "new" }] })
    };
    expect(valid()).toBe(false);
    navRef.current = {
      getState: () => ({ routes: [{ name: "FluidPanelsView", key: "main" }] })
    };
    act(() => tree!.unmount());
    expect(valid()).toBe(false);
    await act(async () => {
      finish(false);
      await Promise.resolve();
    });
    expect(Navigation.goBack).not.toHaveBeenCalled();
  });

  it("does not target a note's Web dialog from Tasks", async () => {
    mockTabId = "qa-a";
    mockSection = "tasks";
    navRef.current = {
      getState: () => ({ routes: [{ name: "FluidPanelsView", key: "main" }] })
    };
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<HookHost />);
    });
    emitCommand("escape");
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockDismissPopup).not.toHaveBeenCalled();
    expect(Navigation.goBack).not.toHaveBeenCalled();
    act(() => tree!.unmount());
  });

  it("closes the most recently presented owned entry without navigating or broadcasting", () => {
    const close = jest.fn();
    const entry = registerMacModal("sheet", () => true, close);
    entry.present();

    act(() => {
      create(React.createElement(HookHost));
    });
    emitCommand("escape");

    expect(close).toHaveBeenCalledTimes(1);
    expect(hideSheet).not.toHaveBeenCalled();
    expect(Navigation.goBack).not.toHaveBeenCalled();
  });

  it("closes the most recently presented owned dialog entry ahead of an older sheet", () => {
    const closeSheet = jest.fn();
    const closeDialog = jest.fn();
    const sheet = registerMacModal("sheet", () => true, closeSheet);
    const dialog = registerMacModal("dialog", () => true, closeDialog);
    sheet.present();
    dialog.present();

    act(() => {
      create(React.createElement(HookHost));
    });
    emitCommand("escape");

    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(closeSheet).not.toHaveBeenCalled();
  });

  it("falls back to navigation on a dismissable route when nothing is active", () => {
    navRef.current = { getState: () => ({ routes: [{ name: "Settings" }] }) };

    act(() => {
      create(React.createElement(HookHost));
    });
    emitCommand("escape");

    expect(Navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it("does not navigate on a non-dismissable route when nothing is active", () => {
    navRef.current = { getState: () => ({ routes: [{ name: "Library" }] }) };

    act(() => {
      create(React.createElement(HookHost));
    });
    emitCommand("escape");

    expect(Navigation.goBack).not.toHaveBeenCalled();
  });
});
