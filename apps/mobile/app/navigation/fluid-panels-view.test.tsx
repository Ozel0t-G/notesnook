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
 * The real `FluidPanelsView` root on an iPad, rendered by `react-test-renderer`
 * at the three widths that decide the pane mode (1376 wide, 1032 medium, 600
 * narrow).
 *
 * Only the peripheral edges are mocked: the native primitives, Reanimated, the
 * pager's animation, the navigation stack and the editor screen. The production
 * code under test is left in place - the root's own pane JSX and accessibility
 * calculations, the real pane arithmetic (`utils/ipad-layout`), the real iPad
 * workspace context (a mocked `SideMenu` reads it back through the real
 * `useIPadWorkspace`) and the real `EditorWrapper`.
 *
 * The width is driven exactly the way the device drives it: a mutable,
 * subscribable setting store (the same `dimensions`/`deviceMode`/`fullscreen`
 * store the app uses) plus the root's own `onLayout` callback. The pager is a
 * mock because its gesture/animation machinery is native; its reports come back
 * through the root's real `onChangeTab`/`onDrawerStateChange` props.
 */

import React from "react";
import {
  act,
  create,
  ReactTestInstance,
  ReactTestRenderer
} from "react-test-renderer";
import { Platform } from "react-native";

jest.mock("react-native", () => ({
  View: "View",
  TextInput: "TextInput",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Platform: { OS: "ios", isPad: true, isMacCatalyst: false },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) }
}));

jest.mock("@notesnook/theme", () => {
  const React = require("react");
  return {
    ScopedThemeProvider: (props: { children?: React.ReactNode }) =>
      React.createElement("ScopedThemeProvider", null, props.children),
    useThemeColors: () => ({
      colors: { primary: { accent: "#0a84ff", backdrop: "#000000" } },
      isDark: false
    })
  };
});

jest.mock("@sayem314/react-native-keep-awake", () => ({
  activateKeepAwake: jest.fn(),
  deactivateKeepAwake: jest.fn()
}));

jest.mock("react-native-orientation-locker", () => {
  const OrientationType = {
    UNKNOWN: "UNKNOWN",
    PORTRAIT: "PORTRAIT",
    "PORTRAIT-UPSIDEDOWN": "PORTRAIT-UPSIDEDOWN",
    "LANDSCAPE-LEFT": "LANDSCAPE-LEFT",
    "LANDSCAPE-RIGHT": "LANDSCAPE-RIGHT",
    "FACE-UP": "FACE-UP",
    "FACE-DOWN": "FACE-DOWN"
  };
  return {
    __esModule: true,
    default: { getInitialOrientation: () => OrientationType.PORTRAIT },
    OrientationType,
    useDeviceOrientationChange: jest.fn()
  };
});

jest.mock("react-native-reanimated", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: {
      View: React.forwardRef((props: Record<string, unknown>) =>
        React.createElement("AnimatedView", props)
      )
    },
    // A stable holder, like the real shared value: an identity that changed on
    // every render would make the root's effects re-run with it.
    useSharedValue: (initial: unknown) => {
      const ref = React.useRef(null);
      if (!ref.current) ref.current = { value: initial };
      return ref.current;
    },
    useAnimatedStyle: () => ({}),
    withTiming: (value: unknown) => value
  };
});

jest.mock("../common/database", () => ({
  db: {
    isInitialized: true,
    notes: { note: jest.fn(async () => undefined) },
    vaults: { itemExists: jest.fn(async () => false) },
    eventManager: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) },
    settings: { setSideBarOrder: jest.fn(), setSideBarHiddenItems: jest.fn() }
  }
}));

/**
 * The pager: its gestures, springs and page arithmetic are native/animated, so
 * the root only ever talks to this handle. `__pager` is the same object the
 * root holds in `fluidTabsRef` (a `forwardRef` handle), which is what lets the
 * suite prove a pure resize never pages, opens or closes anything.
 */
jest.mock("../components/fluid-panels", () => {
  const React = require("react");
  /**
   * The pager keeps the logical page it is on, and `goToPage` reports the page
   * change back through the root's own `onChangeTab` prop - exactly the path the
   * real pager's `useAnimatedReaction` on `currentTab` takes once its
   * translation has moved to the new page. That is what makes a "note opened on
   * a narrow iPad" assertion go through the real root reaction (the list pane's
   * accessibility flags and the store's logical page), not through a mocked
   * call.
   */
  const state: {
    page: string;
    props: Record<string, unknown> | undefined;
  } = { page: "home", props: undefined };
  const pager = {
    goToPage: jest.fn((page: string) => {
      state.page = page;
      const onChangeTab = state.props?.onChangeTab as
        | ((event: { i: number; from: number }) => void)
        | undefined;
      onChangeTab?.({
        i: page === "editor" ? 2 : 1,
        from: page === "editor" ? 1 : 2
      });
    }),
    goToIndex: jest.fn(),
    openDrawer: jest.fn(),
    closeDrawer: jest.fn(),
    page: jest.fn(() => state.page),
    isDrawerOpen: jest.fn(() => false),
    setScrollEnabled: jest.fn(() => true),
    unlock: jest.fn(() => false),
    lock: jest.fn(() => false),
    tabChangedFromSwipeAction: { value: false },
    node: { current: null }
  };
  const FluidPanels = React.forwardRef(
    (props: { children?: unknown } & Record<string, unknown>, ref: unknown) => {
      React.useImperativeHandle(ref, () => pager, []);
      state.props = props;
      const { children, ...rest } = props;
      return React.createElement("FluidPanels", rest, children);
    }
  );
  return { FluidPanels, __pager: pager, __pagerState: state };
});

jest.mock("../components/mac-scroll-edge-fade", () => ({
  MacScrollEdgeFade: () => null
}));

jest.mock("../components/mac-sidebar", () => ({
  MacSidebar: () => null
}));

/**
 * The iPad source sidebar. It is a probe, but it reads the *real* workspace
 * context through the *real* `useIPadWorkspace` hook, so the context value the
 * suite asserts is the one the root actually publishes. Its mount counter
 * proves the sidebar node is retained through every width.
 */
jest.mock("../components/side-menu", () => {
  const React = require("react");
  const { useIPadWorkspace } = require("../components/ipad-workspace-context");
  const state: {
    mounts: number;
    unmounts: number;
    workspace: { paneMode: string; sidebarVisible: boolean } | undefined;
  } = { mounts: 0, unmounts: 0, workspace: undefined };
  const SideMenu = () => {
    const workspace = useIPadWorkspace();
    state.workspace = workspace;
    React.useEffect(() => {
      state.mounts += 1;
      return () => {
        state.unmounts += 1;
      };
    }, []);
    return React.createElement("SideMenu", { workspace });
  };
  return { SideMenu, __probeState: state };
});

jest.mock("../components/veyran-assistant-sidebar", () => ({
  VeyranAssistantSidebar: () => null
}));

jest.mock("../components/side-menu/dragging-store", () => ({
  useSideBarDraggingStore: {
    getState: () => ({ dragging: false }),
    setState: jest.fn()
  }
}));

jest.mock("../hooks/use-global-safe-area-insets", () => ({
  __esModule: true,
  default: () => ({ top: 24, bottom: 20, left: 0, right: 0 })
}));

jest.mock("../hooks/use-is-floating-keyboard", () => ({
  __esModule: true,
  default: () => false
}));

jest.mock("../hooks/use-tooltip", () => ({
  hideAllTooltips: jest.fn()
}));

/**
 * The editor screen: a probe with a mount counter, so the suite can prove the
 * document pane's subtree survives every width change instead of remounting.
 */
jest.mock("../screens/editor", () => {
  const React = require("react");
  const state = { mounts: 0, unmounts: 0 };
  const Editor = (props: Record<string, unknown>) => {
    React.useEffect(() => {
      state.mounts += 1;
      return () => {
        state.unmounts += 1;
      };
    }, []);
    return React.createElement("EditorProbe", props);
  };
  return { __esModule: true, default: Editor, __probeState: state };
});

jest.mock("../screens/editor/tiptap/use-tab-store", () => {
  const state = {
    tabs: [] as unknown[],
    currentTab: "tab-1",
    getTab: () => undefined,
    getNoteIdForTab: () => undefined,
    updateTab: jest.fn()
  };
  return {
    useTabStore: Object.assign(jest.fn(), { getState: () => state })
  };
});

jest.mock("../screens/editor/tiptap/utils", () => {
  const editorStateValue = { movedAway: false, isFocused: false };
  return {
    editorController: {
      current: {
        commands: {
          focus: jest.fn(),
          blur: jest.fn(),
          clear: jest.fn(),
          updateSettings: jest.fn()
        },
        onReady: jest.fn(),
        overlay: jest.fn()
      }
    },
    editorState: () => editorStateValue,
    textInput: { current: null }
  };
});

jest.mock("../services/device-detection", () => ({
  DDS: {
    width: 0,
    orientation: "UNKNOWN",
    setSize: jest.fn(),
    isLargeTablet: jest.fn(() => true),
    isSmallTab: false
  }
}));

/**
 * A working event bus, the same shape as the app's `EventManager`: the suite
 * publishes the real events a note tap publishes and the root's own
 * subscription receives them. `__bus` is how the suite proves the subscription
 * is installed and (on unmount) removed.
 */
jest.mock("../services/event-manager", () => {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    __bus: {
      subscriberCount: (name: string) => handlers.get(name)?.size ?? 0,
      publish: (name: string, ...args: unknown[]) =>
        handlers.get(name)?.forEach((handler) => handler(...args)),
      // A leaked subscription (a mount that outlived its test) would both
      // double-report the page and break the subscriber count below, so the
      // fixture starts every test from an empty bus instead of trusting the
      // previous test's unmount.
      reset: () => handlers.clear()
    },
    eSendEvent: (name: string, ...args: unknown[]) => {
      handlers.get(name)?.forEach((handler) => handler(...args));
    },
    eSubscribeEvent: (name: string, handler: (...args: unknown[]) => void) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(handler);
      return { unsubscribe: () => handlers.get(name)?.delete(handler) };
    },
    eUnSubscribeEvent: (
      name: string,
      handler: (...args: unknown[]) => void
    ) => {
      handlers.get(name)?.delete(handler);
    },
    presentSheet: jest.fn()
  };
});

jest.mock("../services/navigation", () => ({
  __esModule: true,
  default: {
    navigate: jest.fn(),
    push: jest.fn(),
    goBack: jest.fn(),
    openDrawer: jest.fn(),
    closeDrawer: jest.fn()
  }
}));

jest.mock("../services/veyran-siwc", () => ({
  isSIWCPlatformSupported: () => false
}));

/**
 * The width/device store. It is subscribable (through `useSyncExternalStore`),
 * because the root is `React.memo` with a comparator that never re-renders on
 * props alone: a width change has to come from the store, exactly as it does
 * from `onLayout` on the device.
 */
jest.mock("../stores/use-setting-store", () => {
  const React = require("react");
  type SettingState = {
    deviceMode?: string;
    dimensions: { width: number; height: number };
    fullscreen: boolean;
    isAppLoading: boolean;
    settings: { introCompleted: boolean; keepScreenOn: boolean };
    pendingShortcut: unknown;
    setFullscreen: (value: boolean) => void;
    setDimensions: (size: { width: number; height: number }) => void;
    setDeviceMode: (mode?: string | null) => void;
  };
  const listeners = new Set<() => void>();
  let state: SettingState = {
    deviceMode: undefined,
    dimensions: { width: 1376, height: 1024 },
    fullscreen: false,
    isAppLoading: false,
    settings: { introCompleted: true, keepScreenOn: false },
    pendingShortcut: null,
    setFullscreen: (value: boolean) => update({ fullscreen: value }),
    setDimensions: (size: { width: number; height: number }) =>
      update({ dimensions: size }),
    setDeviceMode: (mode?: string | null) =>
      update({ deviceMode: mode ?? undefined })
  };
  function update(patch: Partial<SettingState>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }
  const useSettingStore = (selector: (s: SettingState) => unknown) =>
    React.useSyncExternalStore(
      (onChange: () => void) => {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
      () => selector(state),
      () => selector(state)
    );
  return {
    __esModule: true,
    useSettingStore: Object.assign(useSettingStore, {
      getState: () => state,
      setState: (patch: Partial<SettingState>) => update(patch),
      __reset: (patch: Partial<SettingState>) => {
        state = { ...state, ...patch };
      }
    })
  };
});

/**
 * The pager's logical page ("editor" while the pager is on `i === 2`). It is
 * subscribable for the same reason as the width store: the root reads it, the
 * pager writes it, and nothing re-renders the memoized root on its own.
 */
jest.mock("../stores/use-apple-navigation-store", () => {
  const React = require("react");
  type AppleState = {
    section: string;
    editorVisible: boolean;
    setEditorVisible: (visible: boolean) => void;
  };
  const listeners = new Set<() => void>();
  let state: AppleState = {
    section: "library",
    editorVisible: false,
    setEditorVisible: (visible: boolean) => update({ editorVisible: visible })
  };
  function update(patch: Partial<AppleState>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }
  const useAppleNavigationStore = (selector: (s: AppleState) => unknown) =>
    React.useSyncExternalStore(
      (onChange: () => void) => {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
      () => selector(state),
      () => selector(state)
    );
  return {
    __esModule: true,
    useAppleNavigationStore: Object.assign(useAppleNavigationStore, {
      getState: () => state,
      __reset: (patch: Partial<AppleState>) => {
        state = { ...state, ...patch };
      }
    })
  };
});

jest.mock("../stores/use-mac-sidebar-store", () => ({
  useMacSidebarVisible: () => false
}));

jest.mock("../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    ios: true,
    screenBackground: "#ffffff",
    listSurface: "#f2f2f7",
    documentSurface: "#ffffff",
    contentSurface: "#f2f2f7",
    separator: "#dddddd"
  })
}));

jest.mock("../utils/constants", () => ({
  isMacCatalyst: jest.fn(() => false)
}));

jest.mock("../utils/events", () => ({
  eCloseFullscreenEditor: "eCloseFullscreenEditor",
  eOnEnterEditor: "eOnEnterEditor",
  eOnExitEditor: "eOnExitEditor",
  eOnLoadNote: "eOnLoadNote",
  eOpenFullscreenEditor: "eOpenFullscreenEditor",
  eUnlockNote: "eUnlockNote"
}));

jest.mock("../utils/functions", () => ({
  valueLimiter: (value: number, min: number, max: number) =>
    value < min ? min : value > max ? max : value
}));

jest.mock("../utils/global-refs", () => ({
  fluidTabsRef: { current: null },
  editorRef: { current: null }
}));

jest.mock("../utils/mac-layout", () => ({
  MAC_SCROLL_EDGE_FADE_HEIGHT: 56,
  macEditorWidth: () => 0,
  macListWidth: () => 0,
  macSidebarWidth: () => 0,
  macToolbarInset: (top: number) => top
}));

/**
 * The Library's own navigation stack: a probe with a mount counter, so the note
 * list column's children can be proven retained across widths.
 */
jest.mock("./navigation-stack", () => {
  const React = require("react");
  const state = { mounts: 0, unmounts: 0 };
  const AppNavigationStack = (props: Record<string, unknown>) => {
    React.useEffect(() => {
      state.mounts += 1;
      return () => {
        state.unmounts += 1;
      };
    }, []);
    return React.createElement("AppNavigationStack", props);
  };
  return { AppNavigationStack, __probeState: state };
});

import FluidPanelsView from "./fluid-panels-view";
import Navigation from "../services/navigation";
import { eSendEvent } from "../services/event-manager";
import { isMacCatalyst } from "../utils/constants";
import { eOnLoadNote } from "../utils/events";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ProbeState = { mounts: number; unmounts: number };
type WorkspaceProbeState = ProbeState & {
  workspace: { paneMode: string; sidebarVisible: boolean } | undefined;
};
type PagerMock = {
  goToPage: jest.Mock;
  goToIndex: jest.Mock;
  openDrawer: jest.Mock;
  closeDrawer: jest.Mock;
  page: jest.Mock;
  isDrawerOpen: jest.Mock;
  tabChangedFromSwipeAction: { value: boolean };
};
type PanelsProps = {
  widths: { sidebar: number; list: number; editor: number };
  paneMode?: string;
  enabled: boolean;
  drawerEnabled: boolean;
  initialPage?: string;
  onScroll: (offset: number) => void;
  onChangeTab: (event: { i: number; from: number }) => void;
  onDrawerStateChange: (open: boolean) => void;
};

const dds = () =>
  (
    jest.requireMock("../services/device-detection") as {
      DDS: {
        width: number;
        orientation: string;
        isLargeTablet: jest.Mock;
        isSmallTab: boolean;
      };
    }
  ).DDS;

const settingStore = () =>
  (
    jest.requireMock("../stores/use-setting-store") as {
      useSettingStore: {
        getState: () => {
          deviceMode?: string;
          dimensions: { width: number; height: number };
        };
        setState: (patch: Record<string, unknown>) => void;
        __reset: (patch: Record<string, unknown>) => void;
      };
    }
  ).useSettingStore;

const appleStore = () =>
  (
    jest.requireMock("../stores/use-apple-navigation-store") as {
      useAppleNavigationStore: {
        getState: () => { editorVisible: boolean };
        __reset: (patch: Record<string, unknown>) => void;
      };
    }
  ).useAppleNavigationStore;

const editorProbe = () =>
  (jest.requireMock("../screens/editor") as { __probeState: ProbeState })
    .__probeState;
const listProbe = () =>
  (jest.requireMock("./navigation-stack") as { __probeState: ProbeState })
    .__probeState;
const sideMenuProbe = () =>
  (
    jest.requireMock("../components/side-menu") as {
      __probeState: WorkspaceProbeState;
    }
  ).__probeState;
const commands = () =>
  (
    jest.requireMock("../screens/editor/tiptap/utils") as {
      editorController: { current: { commands: Record<string, jest.Mock> } };
    }
  ).editorController.current.commands;
const pager = () =>
  (
    jest.requireMock("../utils/global-refs") as {
      fluidTabsRef: { current: PagerMock | null };
    }
  ).fluidTabsRef.current as PagerMock;

/** The mocked pager's own logical page and the props the root passed it. */
const pagerState = () =>
  (
    jest.requireMock("../components/fluid-panels") as {
      __pagerState: {
        page: string;
        props: Record<string, unknown> | undefined;
      };
    }
  ).__pagerState;

/** The event bus the root actually subscribes through. */
const eventBus = () =>
  (
    jest.requireMock("../services/event-manager") as {
      __bus: {
        subscriberCount: (name: string) => number;
        reset: () => void;
      };
    }
  ).__bus;

/**
 * The active-tab store the listener re-validates against. Its `getState()` is
 * mutable, so the suite can move the active tab between an intent being queued
 * and the width that would deliver it.
 */
const tabStore = () =>
  (
    jest.requireMock("../screens/editor/tiptap/use-tab-store") as {
      useTabStore: { getState: () => { currentTab: string } };
    }
  ).useTabStore;

describe("FluidPanelsView iPad workspace", () => {
  let tree: ReactTestRenderer | undefined;

  const render = (params?: { initialPage?: "editor" | "home" }) => {
    const props = {
      route: { key: "fluid-panels", name: "FluidPanelsView", params },
      navigation: {}
    } as unknown as React.ComponentProps<typeof FluidPanelsView>;
    act(() => {
      tree = create(<FluidPanelsView {...props} />);
    });
  };

  const rootView = () => tree!.root.findByProps({ testID: "root" });

  /** The real `onLayout` the device calls, driven with a measured width. */
  const layout = (width: number, height = 1024) => {
    act(() => {
      (rootView().props.onLayout as (event: unknown) => void)({
        nativeEvent: { layout: { width, height } }
      });
    });
  };

  /**
   * Let every mount/layout macrotask run to completion. The root's legacy
   * `setDeviceMode` branches (the non-iPad `tablet`/`smallTablet`/`mobile`
   * imperative pager actions) run inside a `setTimeout(0)`, which a plain
   * microtask flush does not reach. Settling with a real zero-delay macrotask
   * drains them deterministically - including a command scheduled by a previous
   * mount - so a test's own baseline is not polluted by a stale timer.
   */
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  const panels = () =>
    tree!.root.findByType("FluidPanels" as never).props as PanelsProps;

  /**
   * The pager's sidebar/list pane `View` that contains the given probe. The
   * panes are the only `View`s that always carry an explicit `pointerEvents`
   * (the root and the inner layout views do not), which identifies them without
   * depending on the JSX order.
   */
  const pane = (childType: string): ReactTestInstance => {
    const paneViews = tree!.root
      .findAllByType("View" as never)
      .filter((view) => typeof view.props.pointerEvents === "string");
    const match = paneViews.find(
      (view) => view.findAllByType(childType as never).length > 0
    );
    if (!match) throw new Error(`no pane view contains ${childType}`);
    return match;
  };

  const listPane = () => pane("AppNavigationStack");
  const sidebarPane = () => pane("SideMenu");
  const editorPane = () => tree!.root.findByProps({ testID: "editor-wrapper" });
  const editorStyle = () =>
    (editorPane().props.style as Array<Record<string, unknown>>)[0];
  const sidebarStyle = () =>
    sidebarPane().props.style as Record<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    eventBus().reset();
    (Platform as { OS: string }).OS = "ios";
    (Platform as { isPad: boolean }).isPad = true;
    (isMacCatalyst as jest.Mock).mockReturnValue(false);
    dds().width = 0;
    dds().orientation = "UNKNOWN";
    dds().isLargeTablet.mockReturnValue(true);
    dds().isSmallTab = false;
    settingStore().__reset({
      deviceMode: undefined,
      dimensions: { width: 1376, height: 1024 },
      fullscreen: false,
      isAppLoading: false,
      settings: { introCompleted: true, keepScreenOn: false },
      pendingShortcut: null
    });
    appleStore().__reset({ section: "library", editorVisible: false });
    editorProbe().mounts = 0;
    editorProbe().unmounts = 0;
    listProbe().mounts = 0;
    listProbe().unmounts = 0;
    sideMenuProbe().mounts = 0;
    sideMenuProbe().unmounts = 0;
    sideMenuProbe().workspace = undefined;
    pagerState().page = "home";
    pagerState().props = undefined;
    // The tab-store mock is mutable and shared: a test that moves the active tab
    // would otherwise leak it into the next test's tab-match guard.
    tabStore().getState().currentTab = "tab-1";
  });

  afterEach(() => {
    if (tree) act(() => tree?.unmount());
    tree = undefined;
  });

  it("lays the wide root out with a persistent sidebar and hides nothing", () => {
    render();

    expect(settingStore().getState().dimensions.width).toBe(1376);
    expect(panels().paneMode).toBe("wide");
    expect(panels().widths).toEqual({ sidebar: 260, list: 320, editor: 796 });
    expect(sideMenuProbe().workspace).toEqual({
      paneMode: "wide",
      sidebarVisible: true
    });

    expect(sidebarPane().props.pointerEvents).toBe("auto");
    expect(sidebarPane().props.accessibilityElementsHidden).toBe(false);
    expect(sidebarPane().props.importantForAccessibility).toBe("auto");
    expect(sidebarStyle().width).toBe(260);
    expect(sidebarStyle().overflow).toBe("visible");

    expect(listPane().props.pointerEvents).toBe("auto");
    expect(listPane().props.accessibilityElementsHidden).toBe(false);
    expect(listPane().props.importantForAccessibility).toBe("auto");

    // Wide keeps both panes in the row, so the document pane is not hidden and
    // takes exactly what the sidebar and list leave.
    expect(editorPane().props.pointerEvents).toBeUndefined();
    expect(editorPane().props.accessibilityElementsHidden).toBeUndefined();
    expect(editorStyle().width).toBe(796);
  });

  it("pages a narrow root and hides whichever full-width pane is off screen", async () => {
    render();
    layout(600, 1024);

    expect(panels().paneMode).toBe("narrow");
    expect(panels().widths).toEqual({ sidebar: 0, list: 600, editor: 600 });
    expect(sideMenuProbe().workspace).toEqual({
      paneMode: "narrow",
      sidebarVisible: false
    });

    // The sidebar node stays mounted at width 0, out of touch and VoiceOver.
    expect(sidebarPane().props.pointerEvents).toBe("none");
    expect(sidebarPane().props.accessibilityElementsHidden).toBe(true);
    expect(sidebarPane().props.importantForAccessibility).toBe(
      "no-hide-descendants"
    );
    expect(sidebarStyle().width).toBe(0);
    expect(sidebarStyle().overflow).toBe("hidden");

    // Home page: the list is the page on screen, the document is parked.
    expect(listPane().props.pointerEvents).toBe("auto");
    expect(listPane().props.accessibilityElementsHidden).toBe(false);
    expect(listPane().props.importantForAccessibility).toBe("auto");
    expect(editorPane().props.pointerEvents).toBe("none");
    expect(editorPane().props.accessibilityElementsHidden).toBe(true);
    expect(editorPane().props.importantForAccessibility).toBe(
      "no-hide-descendants"
    );

    // The pager reports the document page through the root's real handler.
    await act(async () => {
      panels().onChangeTab({ i: 2, from: 1 });
    });

    expect(appleStore().getState().editorVisible).toBe(true);
    expect(listPane().props.pointerEvents).toBe("none");
    expect(listPane().props.accessibilityElementsHidden).toBe(true);
    expect(listPane().props.importantForAccessibility).toBe(
      "no-hide-descendants"
    );
    expect(editorPane().props.pointerEvents).toBeUndefined();
    expect(editorPane().props.accessibilityElementsHidden).toBeUndefined();
    expect(editorPane().props.importantForAccessibility).toBeUndefined();
  });

  it("shows the medium sidebar only while the drawer is open", () => {
    render();
    layout(1032, 1024);

    expect(panels().paneMode).toBe("medium");
    expect(panels().widths).toEqual({
      sidebar: 1032 * 0.3,
      list: 300,
      editor: 732
    });
    expect(sideMenuProbe().workspace).toEqual({
      paneMode: "medium",
      sidebarVisible: false
    });

    // Drawer closed: the sidebar pane is the clamped drawer width, off canvas.
    expect(sidebarPane().props.pointerEvents).toBe("none");
    expect(sidebarPane().props.accessibilityElementsHidden).toBe(true);
    expect(sidebarStyle().width).toBeCloseTo(309.6);
    // List and document are visible side by side in medium.
    expect(listPane().props.pointerEvents).toBe("auto");
    expect(editorPane().props.pointerEvents).toBeUndefined();

    act(() => {
      panels().onDrawerStateChange(true);
    });
    expect(sideMenuProbe().workspace).toEqual({
      paneMode: "medium",
      sidebarVisible: true
    });
    expect(sidebarPane().props.pointerEvents).toBe("auto");
    expect(sidebarPane().props.accessibilityElementsHidden).toBe(false);
    expect(sidebarPane().props.importantForAccessibility).toBe("auto");

    act(() => {
      panels().onDrawerStateChange(false);
    });
    expect(sideMenuProbe().workspace?.sidebarVisible).toBe(false);
    expect(sidebarPane().props.pointerEvents).toBe("none");
  });

  it("hides the sidebar and the zero-width list in fullscreen but keeps their nodes", () => {
    render();

    act(() => {
      settingStore().setState({ fullscreen: true });
    });

    expect(panels().widths).toEqual({ sidebar: 0, list: 0, editor: 1376 });
    expect(sideMenuProbe().workspace?.sidebarVisible).toBe(false);
    expect(sidebarPane().props.pointerEvents).toBe("none");
    expect(sidebarStyle().width).toBe(0);

    expect(listPane().props.pointerEvents).toBe("none");
    expect(listPane().props.accessibilityElementsHidden).toBe(true);
    expect(listPane().props.importantForAccessibility).toBe(
      "no-hide-descendants"
    );

    // Fullscreen is the whole window; the document page itself is not "hidden".
    expect(editorPane().props.pointerEvents).toBeUndefined();
    expect(editorStyle().width).toBe(1376);

    // Both panes stayed mounted at width 0.
    expect(sideMenuProbe().mounts).toBe(1);
    expect(sideMenuProbe().unmounts).toBe(0);
    expect(listProbe().mounts).toBe(1);
    expect(listProbe().unmounts).toBe(0);
  });

  it("retains the panes and the logical page across 1376 -> 1032 -> 600 -> 1376", async () => {
    render();

    layout(1032, 1024);
    layout(600, 1024);
    // While narrow, the pager reports the document page.
    await act(async () => {
      panels().onChangeTab({ i: 2, from: 1 });
    });
    layout(1376, 1024);

    expect(panels().paneMode).toBe("wide");
    // The logical page survives the resize instead of being reset home.
    expect(appleStore().getState().editorVisible).toBe(true);
    // The editor's pane is visible again but its subtree was never rebuilt.
    expect(editorPane().props.pointerEvents).toBeUndefined();

    expect(editorProbe().mounts).toBe(1);
    expect(editorProbe().unmounts).toBe(0);
    expect(listProbe().mounts).toBe(1);
    expect(listProbe().unmounts).toBe(0);
    expect(sideMenuProbe().mounts).toBe(1);
    expect(sideMenuProbe().unmounts).toBe(0);
  });

  it("does not page, focus, blur or navigate on a pure resize", () => {
    render();
    const pagerInstance = pager();
    expect(pagerInstance).toBeTruthy();

    layout(1032, 1024);
    layout(600, 1024);
    layout(1376, 1024);

    // The pager handle the root holds is the one the mock pager exposes; a
    // resize drove the store setters only.
    expect(settingStore().getState().dimensions.width).toBe(1376);
    expect(settingStore().getState().deviceMode).toBe("tablet");

    expect(pagerInstance.goToPage).not.toHaveBeenCalled();
    expect(pagerInstance.goToIndex).not.toHaveBeenCalled();
    expect(pagerInstance.openDrawer).not.toHaveBeenCalled();
    expect(pagerInstance.closeDrawer).not.toHaveBeenCalled();

    // No page was recorded either: with no note opened there is nothing to
    // remember, so the next narrow width still starts on the list.
    expect(pagerState().page).toBe("home");
    expect(appleStore().getState().editorVisible).toBe(false);

    expect(commands().focus).not.toHaveBeenCalled();
    expect(commands().blur).not.toHaveBeenCalled();
    expect(commands().clear).not.toHaveBeenCalled();

    expect(Navigation.navigate).not.toHaveBeenCalled();
    expect(Navigation.push).not.toHaveBeenCalled();
    expect(Navigation.goBack).not.toHaveBeenCalled();
  });

  it("seeds the initial page until the pager reports, even over a stale store value", async () => {
    // A stale `editorVisible` left over from a previous mount...
    appleStore().__reset({ editorVisible: true });
    render({ initialPage: "home" });
    layout(600, 1024);

    // ...must not win before the pager has reported: the route's initial page is
    // the page on screen, so the list is visible and the document is parked.
    expect(listPane().props.pointerEvents).toBe("auto");
    expect(editorPane().props.pointerEvents).toBe("none");

    // The pager now reports the document page. The store already holds `true`,
    // so the report is only observable because the root marks the first report
    // in React state and re-renders onto it.
    await act(async () => {
      panels().onChangeTab({ i: 2, from: 1 });
    });
    expect(appleStore().getState().editorVisible).toBe(true);
    expect(listPane().props.pointerEvents).toBe("none");
    expect(editorPane().props.pointerEvents).toBeUndefined();
  });

  it("switches to the list on the first report even when the store already holds the value", async () => {
    appleStore().__reset({ editorVisible: false });
    render({ initialPage: "editor" });
    layout(600, 1024);

    // Seeded from `initialPage` before any report: the document is the page.
    expect(editorPane().props.pointerEvents).toBeUndefined();
    expect(listPane().props.pointerEvents).toBe("none");

    // The pager reports the list page, and the store already held `false`, so
    // only the report marker can move the screen back onto the list.
    await act(async () => {
      panels().onChangeTab({ i: 1, from: 2 });
    });
    expect(appleStore().getState().editorVisible).toBe(false);
    expect(listPane().props.pointerEvents).toBe("auto");
    expect(editorPane().props.pointerEvents).toBe("none");
  });

  it("leaves the iPhone layout without a pane mode", () => {
    (Platform as { isPad: boolean }).isPad = false;
    dds().isLargeTablet.mockReturnValue(false);
    render();

    expect(panels().paneMode).toBeUndefined();
    expect(panels().widths).toEqual({ sidebar: 0, list: 1376, editor: 1376 });
    // iOS iPhone navigates with the bottom bar: no drawer and no sidebar pane.
    expect(panels().drawerEnabled).toBe(false);
    expect(tree!.root.findAllByType("SideMenu" as never)).toHaveLength(0);
    // No iPad width or hidden flag reaches the document pane.
    expect(editorPane().props.pointerEvents).toBeUndefined();
    expect(editorStyle().width).toBe(1376);
  });

  it("publishes the drawer's actual state through the real workspace context", () => {
    render();
    layout(1032, 1024);

    // The context exposes presentation state, not availability: closed drawer
    // means the sidebar is not on screen even though the pane exists.
    expect(sideMenuProbe().workspace?.sidebarVisible).toBe(false);
    act(() => {
      panels().onDrawerStateChange(true);
    });
    expect(sideMenuProbe().workspace).toEqual({
      paneMode: "medium",
      sidebarVisible: true
    });
  });

  /**
   * The load-note wiring: `openNote` publishes `eOnLoadNote` and then skips its
   * own `goToPage("editor")` because `DDS.isTab` is true on tablet hardware
   * (see components/list-items/note/wrapper.tsx), so on the narrow iPad the
   * document loaded behind the list and the editor stayed hidden. The root
   * supplies that page change for a settled iPad width - and only for a real
   * user-origin load, on a real iPad, outside fullscreen, once. Nothing but an
   * explicit note open may ever reach it.
   */
  describe("iPad note loading", () => {
    const openNote = (payload: unknown) => {
      act(() => {
        eSendEvent(eOnLoadNote, payload);
      });
    };

    it("pages to the document when a note is opened on a narrow iPad", async () => {
      render();
      layout(600, 1024);
      // Settle the mount/layout effects (and any legacy page command a previous
      // mount left pending), then take the baseline: only the note open itself
      // may add a pager command.
      await settle();
      pager().goToPage.mockClear();

      openNote({ item: { id: "note-1" } });
      await settle();

      // The page change went through the pager, which reported it back through
      // the root's real `onChangeTab`: the list pane is off touch/VoiceOver and
      // the document pane is on screen. Exactly one command was added, and it
      // targets the document.
      expect(pager().goToPage).toHaveBeenCalledTimes(1);
      expect(pager().goToPage).toHaveBeenCalledWith("editor");
      expect(pagerState().page).toBe("editor");
      expect(appleStore().getState().editorVisible).toBe(true);
      expect(listPane().props.pointerEvents).toBe("none");
      expect(listPane().props.accessibilityElementsHidden).toBe(true);
      expect(listPane().props.importantForAccessibility).toBe(
        "no-hide-descendants"
      );
      expect(editorPane().props.pointerEvents).toBeUndefined();
      expect(editorPane().props.accessibilityElementsHidden).toBeUndefined();
    });

    it("returns to the full document when reopening a note with the medium drawer open", async () => {
      render();
      layout(1032, 1024);
      await settle();
      openNote({ item: { id: "synthetic-note" } });
      await settle();
      expect(pager().page()).toBe("editor");
      pager().goToPage.mockClear();
      pager().isDrawerOpen.mockReturnValue(true);
      try {
        act(() => panels().onDrawerStateChange(true));
        expect(sideMenuProbe().workspace?.sidebarVisible).toBe(true);
        openNote({ item: { id: "synthetic-note" } });
        await settle();
        // The real pager's goToPage also closes the open medium drawer.
        // Being on the logical editor page alone is not sufficient here.
        expect(pager().goToPage).toHaveBeenCalledTimes(1);
        expect(pager().goToPage).toHaveBeenCalledWith("editor");
      } finally {
        pager().isDrawerOpen.mockReturnValue(false);
      }
    });

    it("pages for the new-note action and is idempotent once on the document", async () => {
      render();
      layout(600, 1024);

      openNote({ newNote: true });
      await act(async () => {});
      expect(pager().goToPage).toHaveBeenCalledTimes(1);
      expect(appleStore().getState().editorVisible).toBe(true);

      // A second load while the document is already the page must not page
      // again: `page()` is the pager's own truth and the switch is idempotent.
      openNote({ item: { id: "note-2" } });
      await act(async () => {});
      expect(pager().goToPage).toHaveBeenCalledTimes(1);

      // The document is still the page on screen.
      expect(listPane().props.pointerEvents).toBe("none");
      expect(appleStore().getState().editorVisible).toBe(true);
    });

    it("ignores a silent refresh and the editor's own new-note load", async () => {
      render();
      layout(600, 1024);

      // The vault unlock re-publishes the note the editor already has
      // (`refresh: true`): a silent refresh is not a user open.
      openNote({ item: { id: "note-1" }, refresh: true });
      await act(async () => {});
      expect(pager().goToPage).not.toHaveBeenCalled();

      // The editor's own "new note" arrives marked editor-origin.
      openNote({ newNote: true, tabId: "tab-1", loadedFromEditor: true });
      await act(async () => {});
      expect(pager().goToPage).not.toHaveBeenCalled();

      // A user-origin new note still pages, so the guard is the marker and not
      // the absence of an item.
      openNote({ newNote: true });
      await act(async () => {});
      expect(pager().goToPage).toHaveBeenCalledTimes(1);
      expect(appleStore().getState().editorVisible).toBe(true);
    });

    it("records a user-opened note as the logical editor page without moving the wide panes", async () => {
      render();
      layout(1376, 1024);
      expect(panels().paneMode).toBe("wide");
      expect(panels().widths).toEqual({ sidebar: 260, list: 320, editor: 796 });
      const widthsBeforeOpen = panels().widths;

      // The user opens a note in the wide workspace. Wide's pager offset is the
      // same for both logical pages, so nothing visibly moves - but the page has
      // to be recorded, or a later narrow width would show the wrong pane.
      openNote({ item: { id: "note-1" } });
      await act(async () => {});

      expect(pager().goToPage).toHaveBeenCalledTimes(1);
      expect(pager().goToPage).toHaveBeenCalledWith("editor");
      expect(pagerState().page).toBe("editor");
      expect(appleStore().getState().editorVisible).toBe(true);
      // The wide layout itself is untouched: the very same pane widths, both
      // panes in the row and reachable, the document still taking what the other
      // two leave.
      expect(panels().widths).toEqual(widthsBeforeOpen);
      expect(panels().widths).toEqual({ sidebar: 260, list: 320, editor: 796 });
      expect(listPane().props.pointerEvents).toBe("auto");
      expect(listPane().props.accessibilityElementsHidden).toBe(false);
      expect(editorPane().props.pointerEvents).toBeUndefined();
      expect(editorStyle().width).toBe(796);
    });

    it("keeps the writing surface the user opened when the workspace narrows", async () => {
      render();
      layout(1032, 1024);
      expect(panels().paneMode).toBe("medium");
      expect(panels().widths).toEqual({
        sidebar: 1032 * 0.3,
        list: 300,
        editor: 732
      });

      // The text input identity is what proves the document's subtree survived
      // the width changes instead of being rebuilt.
      const textInput = tree!.root.findByType("TextInput" as never);
      const widthsBeforeOpen = panels().widths;

      openNote({ item: { id: "note-1" } });
      await act(async () => {});
      expect(pager().goToPage).toHaveBeenCalledTimes(1);
      expect(pager().goToPage).toHaveBeenCalledWith("editor");
      expect(appleStore().getState().editorVisible).toBe(true);
      // Recording the page moved no medium pane: same widths, both panes
      // reachable side by side.
      expect(panels().widths).toEqual(widthsBeforeOpen);
      expect(listPane().props.pointerEvents).toBe("auto");
      expect(editorPane().props.pointerEvents).toBeUndefined();

      layout(600, 1024);
      expect(panels().paneMode).toBe("narrow");
      expect(panels().widths).toEqual({ sidebar: 0, list: 600, editor: 600 });

      // The document is the page the user was writing on, so narrowing keeps it
      // on screen instead of hiding it behind the note list: the list pane is
      // the one parked, off touch and VoiceOver.
      expect(appleStore().getState().editorVisible).toBe(true);
      expect(listPane().props.pointerEvents).toBe("none");
      expect(listPane().props.accessibilityElementsHidden).toBe(true);
      expect(listPane().props.importantForAccessibility).toBe(
        "no-hide-descendants"
      );
      expect(editorPane().props.pointerEvents).toBeUndefined();
      expect(editorPane().props.accessibilityElementsHidden).toBeUndefined();
      expect(editorPane().props.importantForAccessibility).toBeUndefined();

      // The document's own subtree is retained, the text input included: the
      // writing surface is the very same instance, not a rebuilt one.
      expect(tree!.root.findByType("TextInput" as never)).toBe(textInput);
      expect(editorProbe().mounts).toBe(1);
      expect(editorProbe().unmounts).toBe(0);
      // The resize itself paged nothing: the page was already the editor's.
      expect(pager().goToPage).toHaveBeenCalledTimes(1);
    });

    it("never pages on iPhone, Android or Mac Catalyst", async () => {
      // Each leg settles its own mount/layout effects and clears the pager
      // command history before the note open, so a legacy `mobile` branch's
      // mount command (a `goToPage` on iPhone) is baseline, not a note-open page.

      // iPhone: no pane mode at all.
      (Platform as { isPad: boolean }).isPad = false;
      dds().isLargeTablet.mockReturnValue(false);
      render();
      layout(390, 844);
      await settle();
      pager().goToPage.mockClear();
      openNote({ item: { id: "note-1" } });
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();
      act(() => tree?.unmount());
      tree = undefined;

      // Android tablet: iPad predicate is false even at a narrow width.
      (Platform as { OS: string }).OS = "android";
      (Platform as { isPad: boolean }).isPad = true;
      dds().isLargeTablet.mockReturnValue(true);
      render();
      layout(600, 1024);
      await settle();
      pager().goToPage.mockClear();
      openNote({ item: { id: "note-1" } });
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();
      act(() => tree?.unmount());
      tree = undefined;

      // Mac Catalyst: excluded by the iPad predicate.
      (Platform as { OS: string }).OS = "ios";
      (isMacCatalyst as jest.Mock).mockReturnValue(true);
      render();
      layout(600, 1024);
      await settle();
      pager().goToPage.mockClear();
      openNote({ item: { id: "note-1" } });
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();
    });

    it("holds a user-opened note until the width is measured, then pages once", async () => {
      /**
       * A zero width resolves to `narrow` through `resolveIPadPaneMode`, so
       * this is exactly the case the settled-width guard exists for: nothing
       * may page until the root has actually been measured. The intent is a
       * real user open, though, so it must not be *dropped* either.
       */
      settingStore().__reset({
        deviceMode: undefined,
        dimensions: { width: 0, height: 0 },
        fullscreen: false
      });
      render();
      // Settle the (empty, zero-width) mount before the baseline so no stale
      // command from an earlier mount can be mistaken for a page.
      await settle();
      pager().goToPage.mockClear();
      const panelsProps = panels();
      expect(panelsProps.paneMode).toBe("narrow");

      // The user opens a note before the root has been measured. There is no
      // width to page to, so no command may be issued yet - and no page may be
      // recorded either.
      openNote({ item: { id: "note-1" } });
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();
      expect(pagerState().page).toBe("home");
      expect(appleStore().getState().editorVisible).toBe(false);

      // The device reports a real width. No second event: the retained intent is
      // what pages, exactly once, through the pager's real report path - the
      // list pane goes off touch/VoiceOver and the document comes on screen.
      layout(600, 1024);
      await settle();
      expect(pager().goToPage).toHaveBeenCalledTimes(1);
      expect(pager().goToPage).toHaveBeenCalledWith("editor");
      expect(pagerState().page).toBe("editor");
      expect(appleStore().getState().editorVisible).toBe(true);
      expect(listPane().props.pointerEvents).toBe("none");
      expect(listPane().props.accessibilityElementsHidden).toBe(true);
      expect(listPane().props.importantForAccessibility).toBe(
        "no-hide-descendants"
      );
      expect(editorPane().props.pointerEvents).toBeUndefined();
      expect(editorPane().props.accessibilityElementsHidden).toBeUndefined();
      expect(editorPane().props.importantForAccessibility).toBeUndefined();

      // It was consumed once: a later pure resize never replays it.
      layout(1376, 1024);
      layout(600, 1024);
      await settle();
      expect(pager().goToPage).toHaveBeenCalledTimes(1);
    });

    it("holds the new-note action until the width is measured", async () => {
      settingStore().__reset({
        deviceMode: undefined,
        dimensions: { width: 0, height: 0 },
        fullscreen: false
      });
      render();
      await settle();
      pager().goToPage.mockClear();

      openNote({ newNote: true });
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();

      layout(600, 1024);
      await settle();
      expect(pager().goToPage).toHaveBeenCalledTimes(1);
      expect(pager().goToPage).toHaveBeenCalledWith("editor");
      expect(appleStore().getState().editorVisible).toBe(true);
    });

    it("ignores a forced document reload, measured or not", async () => {
      // Measured: a forced reload is a document rebuild, not an open, so the
      // narrow user stays on the list.
      render();
      layout(600, 1024);
      await settle();
      pager().goToPage.mockClear();

      openNote({ item: { id: "note-1" }, forced: true });
      openNote({ newNote: true, forced: true });
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();
      expect(appleStore().getState().editorVisible).toBe(false);
      expect(listPane().props.pointerEvents).toBe("auto");
      expect(listPane().props.accessibilityElementsHidden).toBe(false);

      // Unmeasured: forced is rejected outright, not merely deferred - a later
      // layout with no user event must still page nothing.
      act(() => tree?.unmount());
      tree = undefined;
      settingStore().__reset({
        deviceMode: undefined,
        dimensions: { width: 0, height: 0 },
        fullscreen: false
      });
      render();
      await settle();
      pager().goToPage.mockClear();

      openNote({ item: { id: "note-1" }, forced: true });
      openNote({ newNote: true, forced: true });
      await settle();
      layout(600, 1024);
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();
      expect(appleStore().getState().editorVisible).toBe(false);
    });

    it("never queues a background, editor-origin or other-tab load", async () => {
      settingStore().__reset({
        deviceMode: undefined,
        dimensions: { width: 0, height: 0 },
        fullscreen: false
      });
      render();
      await settle();
      pager().goToPage.mockClear();

      // Each of these is rejected at event time - it must not be retained for
      // the layout that follows.
      openNote({ item: { id: "note-1" }, refresh: true });
      openNote({ item: { id: "note-1" }, loadedFromEditor: true });
      openNote({ newNote: true, tabId: "tab-1", loadedFromEditor: true });
      openNote({ item: { id: "note-1" }, tabId: "tab-other" });
      openNote(undefined);
      openNote({});
      openNote({ tabId: "tab-1" });
      await settle();

      layout(600, 1024);
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();
      expect(appleStore().getState().editorVisible).toBe(false);
    });

    it("keeps a queued user open across an unrelated background reload", async () => {
      settingStore().__reset({
        deviceMode: undefined,
        dimensions: { width: 0, height: 0 },
        fullscreen: false
      });
      render();
      await settle();
      pager().goToPage.mockClear();

      // A real user open is queued...
      openNote({ item: { id: "note-1" } });
      // ...and a background forced reload of the same note arrives while it
      // waits. A background event is not the user changing their mind, so it
      // must not cancel the pending open.
      openNote({ item: { id: "note-1" }, forced: true });
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();

      layout(600, 1024);
      await settle();
      expect(pager().goToPage).toHaveBeenCalledTimes(1);
      expect(pager().goToPage).toHaveBeenCalledWith("editor");
      expect(appleStore().getState().editorVisible).toBe(true);
    });

    it("drops a queued open when fullscreen turns on before the width is measured", async () => {
      settingStore().__reset({
        deviceMode: undefined,
        dimensions: { width: 0, height: 0 },
        fullscreen: false
      });
      render();
      await settle();
      pager().goToPage.mockClear();

      openNote({ item: { id: "note-1" } });
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();

      act(() => {
        settingStore().setState({ fullscreen: true });
      });
      layout(600, 1024);
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();
      expect(appleStore().getState().editorVisible).toBe(false);
    });

    it("drops a queued open when the client stops being an iPad before the width is measured", async () => {
      settingStore().__reset({
        deviceMode: undefined,
        dimensions: { width: 0, height: 0 },
        fullscreen: false
      });
      render();
      await settle();
      pager().goToPage.mockClear();

      openNote({ item: { id: "note-1" } });
      await settle();

      (Platform as { isPad: boolean }).isPad = false;
      layout(600, 1024);
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();

      // The queued intent was cleared, not parked: it does not replay when the
      // client is an iPad again.
      (Platform as { isPad: boolean }).isPad = true;
      layout(1376, 1024);
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();
      expect(appleStore().getState().editorVisible).toBe(false);
    });

    it("drops a queued open when the active tab changes before the width is measured", async () => {
      settingStore().__reset({
        deviceMode: undefined,
        dimensions: { width: 0, height: 0 },
        fullscreen: false
      });
      render();
      await settle();
      pager().goToPage.mockClear();

      openNote({ item: { id: "note-1" }, tabId: "tab-1" });
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();

      // The user switches tabs while the open waits for the layout.
      tabStore().getState().currentTab = "tab-other";
      layout(600, 1024);
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();
      expect(appleStore().getState().editorVisible).toBe(false);
    });

    it("does not re-page a queued open once the pager is already on the document", async () => {
      settingStore().__reset({
        deviceMode: undefined,
        dimensions: { width: 0, height: 0 },
        fullscreen: false
      });
      render();
      await settle();
      pager().goToPage.mockClear();

      openNote({ item: { id: "note-1" } });
      await settle();

      // By the time the width settles the pager is already on the document.
      pagerState().page = "editor";
      layout(600, 1024);
      await settle();
      expect(pager().goToPage).not.toHaveBeenCalled();
    });

    it("never queues a user open on the other clients", async () => {
      (Platform as { isPad: boolean }).isPad = false;
      dds().isLargeTablet.mockReturnValue(false);
      settingStore().__reset({
        deviceMode: undefined,
        dimensions: { width: 0, height: 0 },
        fullscreen: false
      });
      render();
      await settle();

      // A note is opened while the phone's root is unmeasured: there is no pane
      // and no workspace page, so nothing is retained.
      openNote({ item: { id: "note-1" } });
      await settle();

      layout(390, 844);
      await settle();

      // The listener itself added no page command; the only pager call is the
      // legacy mobile branch re-paging the page it is already on.
      expect(pager().goToPage).not.toHaveBeenCalledWith("editor");
      expect(pagerState().page).toBe("home");
      expect(appleStore().getState().editorVisible).toBe(false);
    });

    it("ignores the editor's own reload and loads addressed to another tab", async () => {
      render();
      layout(600, 1024);

      // `tabFocused` republishes the note the editor already has; it is not a
      // user navigation.
      openNote({
        item: { id: "note-1" },
        tabId: "tab-1",
        loadedFromEditor: true
      });
      await act(async () => {});
      expect(pager().goToPage).not.toHaveBeenCalled();

      // An event for a tab that is not the current one belongs to that tab.
      openNote({ item: { id: "note-1" }, tabId: "tab-other" });
      await act(async () => {});
      expect(pager().goToPage).not.toHaveBeenCalled();

      // The current tab's own load does page.
      openNote({ item: { id: "note-1" }, tabId: "tab-1" });
      await act(async () => {});
      expect(pager().goToPage).toHaveBeenCalledTimes(1);
    });

    it("pages nothing for a payload with neither a note nor a new-note request", async () => {
      render();
      layout(600, 1024);

      openNote(undefined);
      openNote({});
      openNote({ tabId: "tab-1" });
      await act(async () => {});

      expect(pager().goToPage).not.toHaveBeenCalled();
    });

    it("ignores loads while fullscreen and does not page when fullscreen alone changes", async () => {
      render();
      layout(600, 1024);

      act(() => {
        settingStore().setState({ fullscreen: true });
      });
      expect(pager().goToPage).not.toHaveBeenCalled();

      openNote({ item: { id: "note-1" } });
      await act(async () => {});
      expect(pager().goToPage).not.toHaveBeenCalled();

      act(() => {
        settingStore().setState({ fullscreen: false });
      });
      // Leaving fullscreen is not a page change either.
      expect(pager().goToPage).not.toHaveBeenCalled();

      openNote({ item: { id: "note-1" } });
      await act(async () => {});
      expect(pager().goToPage).toHaveBeenCalledTimes(1);
    });

    it("installs the listener once and removes it on unmount", () => {
      render();
      expect(eventBus().subscriberCount("eOnLoadNote")).toBe(1);

      // A width change (and the store re-render it causes) must not re-subscribe.
      layout(600, 1024);
      layout(1376, 1024);
      expect(eventBus().subscriberCount("eOnLoadNote")).toBe(1);

      act(() => tree?.unmount());
      tree = undefined;
      expect(eventBus().subscriberCount("eOnLoadNote")).toBe(0);
    });
  });
});
