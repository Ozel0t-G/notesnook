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
 * The B2c toolbar-picker routing contract.
 *
 * The real `ConfigureToolbar` (the source that mounts the scoped sheet host),
 * the real `ToolSheet.present` (the source that picks the context) and the
 * real `SheetProvider` (the context filter + `eOpenSheet`/`eCloseSheet`
 * subscription) all run here, wired to a *functional* event bus that behaves
 * like the app's `EventManager` (a name-keyed map of handlers, published
 * synchronously). Only the leaf native/animation/theme/db/locale seams are
 * declared: the `ActionSheet` wrapper is a controllable primitive that records
 * every `setModalVisible` call, so "the scoped provider opened/hid exactly one
 * sheet" is an observable fact of the real provider logic, never an assertion
 * about a mocked helper.
 *
 * Before this change `ToolSheet.present` published a context-less `eOpenSheet`
 * and `ConfigureToolbar` mounted no provider at all, so the picker could only
 * ever be presented by the root/global provider - the UIKit
 * "already presenting RNSScreen" crash on the iPad Settings modal. These cases
 * fail against that old routing (no scoped surface opens) and pass only when
 * one `SheetProvider context='configure-toolbar'` lives inside the Settings
 * subtree and `present` targets the same context.
 */

import React from "react";
import { View } from "react-native";
import {
  act,
  create,
  ReactTestInstance,
  ReactTestRenderer
} from "react-test-renderer";

const ROOT_HOST = "root-global-host";
const SCOPED_HOST = "scoped-settings-host";
const SURFACE = "SheetSurface";
const PRESSABLE = "Pressable";
const PARAGRAPH = "Paragraph";
const EVENT_OPEN_SHEET = "open-sheet";
const EVENT_CLOSE_SHEET = "close-sheet";

const hostType = (name: string) => name as unknown as React.ElementType;

/** A real MMKV shape (both the RN API and zustand's `StateStorage`). */
const mockMmkvData = new Map<string, string>();
const mockMmkv = {
  getString: (key: string) => mockMmkvData.get(key),
  setString: (key: string, value: string) => {
    mockMmkvData.set(key, value);
  },
  contains: (key: string) => mockMmkvData.has(key),
  removeItem: (key: string) => {
    mockMmkvData.delete(key);
  },
  getItem: (key: string) => mockMmkvData.get(key) ?? null,
  setItem: (key: string, value: string) => {
    mockMmkvData.set(key, value);
  }
};

const mockSettingState: { deviceMode: string; isAppLoading: boolean } = {
  deviceMode: "mobile",
  isAppLoading: true
};

const mockGetUser = jest.fn();
const mockGetToolbarConfig = jest.fn();
const mockSetToolbarConfig = jest.fn();
const mockDb = {
  user: { getUser: mockGetUser },
  settings: {
    getToolbarConfig: mockGetToolbarConfig,
    setToolbarConfig: mockSetToolbarConfig
  }
};

/**
 * Every `SheetWrapper` the real providers mount, in mount order, with the
 * exact `setModalVisible` call log of that instance. A provider only mounts
 * its wrapper once it has a matching payload, so mount order also identifies
 * which provider opened.
 */
const mockSheetRegistry: { calls: string[]; onClose: () => void }[] = [];

const mockIsMacCatalyst = jest.fn(() => false);

// ---------------------------------------------------------------------------
// Declared leaf seams (native / animation / theme / db / locale). None of them
// replace the routing logic under test.
// ---------------------------------------------------------------------------

jest.mock("react-native", () => ({
  View: "View",
  ActivityIndicator: "ActivityIndicator",
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: (style: unknown) => style
  },
  Platform: { OS: "ios", isPad: true, isMacCatalyst: false }
}));

jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) =>
      React.createElement("MaterialIcon", props)
  };
});

jest.mock("react-native-drax", () => {
  const React = require("react");
  return {
    DraxProvider: (props: { children?: React.ReactNode }) =>
      React.createElement("DraxProvider", null, props.children),
    DraxScrollView: (props: { children?: React.ReactNode }) =>
      React.createElement("DraxScrollView", null, props.children)
  };
});

jest.mock("react-native-reanimated", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: {
      View: (props: Record<string, unknown>) =>
        React.createElement("AnimatedView", props)
    },
    FadeInDown: { entering: true },
    FadeOutDown: { exiting: true },
    Layout: {}
  };
});

jest.mock("react-native-actions-sheet", () => {
  const React = require("react");
  return {
    ScrollView: (props: { children?: React.ReactNode }) =>
      React.createElement("ActionSheetScrollView", null, props.children)
  };
});

jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: {
      primary: {
        paragraph: "#111",
        icon: "#222",
        accent: "#0a84ff",
        backdrop: "#000"
      },
      secondary: {
        background: "#eee",
        paragraph: "#333",
        icon: "#444"
      },
      selected: { background: "#ddd", paragraph: "#000" }
    },
    isDark: false
  })
}));

/**
 * Titles resolve to the label *name* (`bold`, `noteLink`, ...) - distinct,
 * deterministic, and still exactly the real `tool.title` the source renders.
 */
jest.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, {
    get: (_target, key) => () => String(key)
  }) as Record<string, () => string>
}));

jest.mock("../../../utils/constants", () => ({
  isMacCatalyst: mockIsMacCatalyst
}));

jest.mock("../../../utils/size", () => ({
  AppFontSize: { xs: 11, sm: 13, md: 16, lg: 18, xl: 20 },
  defaultBorderRadius: 5
}));

jest.mock("../../../utils/styles", () => ({
  DefaultAppStyles: { GAP: 12, GAP_VERTICAL: 12, GAP_VERTICAL_SMALL: 6 }
}));

jest.mock("../../../utils/time", () => ({ sleep: () => Promise.resolve() }));

jest.mock("../../../screens/editor/tiptap/utils", () => ({
  editorState: () => ({ keyboardState: false, isFocused: false })
}));

jest.mock("../../../common/database", () => ({
  db: mockDb,
  DatabaseLogger: { log: jest.fn(), info: jest.fn(), error: jest.fn() }
}));

jest.mock("../../../common/database/mmkv", () => ({ MMKV: mockMmkv }));

jest.mock("../../../stores/use-setting-store", () => ({
  useSettingStore: { getState: () => mockSettingState }
}));

jest.mock("@notesnook/common", () => ({
  CURRENT_TOOLBAR_VERSION: 2,
  migrateToolbar: async (_platform: unknown, tools: unknown) => tools,
  isFeatureAvailable: async () => ({ isAllowed: true })
}));

/**
 * The REAL shared toolbar resolver (so ids/titles/order are the production
 * ones); only the built `dist` module id is redirected - the same seam
 * `state.test.ts` uses. The icon map is irrelevant to routing.
 */
jest.mock("@notesnook/editor/dist/cjs/toolbar/icons", () => ({ Icons: {} }));
jest.mock("@notesnook/editor/dist/cjs/toolbar/tool-definitions", () =>
  jest.requireActual(
    "../../../../../../packages/editor/src/toolbar/tool-definitions"
  )
);

jest.mock("../../../utils/events", () => ({
  eOpenSheet: "open-sheet",
  eCloseSheet: "close-sheet"
}));

/**
 * A working event bus with the same shape and synchronous delivery as the
 * app's `EventManager`: the real `SheetProvider` subscribes to it and the real
 * `ToolSheet.present` publishes through it. `__bus` observes the subscription
 * lifecycle (a leaked listener would keep counting after unmount).
 */
jest.mock("../../../services/event-manager", () => {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const publish = (name: string, ...args: unknown[]) =>
    handlers.get(name)?.forEach((handler) => handler(...args));
  return {
    __bus: {
      subscriberCount: (name: string) => handlers.get(name)?.size ?? 0,
      reset: () => handlers.clear()
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
    eSendEvent: (name: string, ...args: unknown[]) => publish(name, ...args),
    presentSheet: (data: unknown) => publish("open-sheet", data),
    hideSheet: () => publish("close-sheet"),
    ToastManager: { show: jest.fn(), hide: jest.fn(), error: jest.fn() }
  };
});

jest.mock("../../../components/ui/button", () => ({ Button: "Button" }));
jest.mock("../../../components/ui/notice", () => ({ Notice: "Notice" }));
jest.mock("../../../components/ui/svg", () => ({ SvgView: "SvgView" }));
jest.mock("../../../components/ui/pressable", () => ({ Pressable: "Pressable" }));
jest.mock("../../../components/ui/typography/paragraph", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: (props: { children?: React.ReactNode }) =>
      React.createElement("Paragraph", props, props.children)
  };
});
jest.mock("../../../components/ui/typography/heading", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: (props: { children?: React.ReactNode }) =>
      React.createElement("Heading", props, props.children)
  };
});

/**
 * The real `Group` drag surface is a declared Drax seam; rows are exercised
 * through the real `ToolSheet` the provider renders.
 */
jest.mock("./group", () => ({ Group: "Group" }));

/**
 * The native `ActionSheet` wrapper as a controllable primitive: it exposes the
 * `setModalVisible`/`show`/`hide` surface the provider's `ActionSheetRef`
 * calls, records every call, and renders its children only while shown. The
 * provider's own filtering/subscribe logic is untouched.
 */
jest.mock("../../../components/ui/sheet", () => {
  const React: typeof import("react") = require("react");
  return {
    __esModule: true,
    default: ({
      children,
      fwdRef,
      onClose
    }: {
      children?: React.ReactNode;
      fwdRef?: { current: unknown };
      onClose?: () => void;
    }) => {
      const [visible, setVisible] = React.useState(false);
      const calls = React.useRef<string[]>([]);
      const api = React.useMemo(
        () => ({
          setModalVisible: (value: boolean) => {
            calls.current.push(value ? "show" : "hide");
            setVisible(value);
          },
          show: () => {
            calls.current.push("show");
            setVisible(true);
          },
          hide: () => {
            calls.current.push("hide");
            setVisible(false);
          }
        }),
        []
      );
      React.useImperativeHandle(fwdRef as never, () => api, [api]);
      React.useEffect(() => {
        mockSheetRegistry.push({
          calls: calls.current,
          onClose: onClose as () => void
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return visible
        ? React.createElement(
            SURFACE,
            { testID: "sheet-surface", onClose },
            children
          )
        : null;
    }
  };
});

import type { ToolbarGroupDefinition } from "@notesnook/editor";

import SheetProvider from "../../../components/sheet-provider";
import {
  eSendEvent,
  hideSheet,
  presentSheet
} from "../../../services/event-manager";
import { eCloseSheet } from "../../../utils/events";
import { ConfigureToolbar } from "./configure-toolbar";
import { useDragState } from "./state";
import ToolSheet, { TOOL_SHEET_CONTEXT } from "./tool-sheet";
import { tools } from "./toolbar-definition";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const bus = require("../../../services/event-manager").__bus as {
  subscriberCount: (name: string) => number;
  reset: () => void;
};

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A toolbar tree with a top-level group, a nested "more" subgroup and a second
 * group: enough to prove an add touches exactly one leaf.
 */
const SEED: ToolbarGroupDefinition[] = [
  ["bold", "italic", ["superscript", "subscript"]],
  ["underline"]
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function surfaces(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAllByType(hostType(SURFACE));
}

function ancestorTestIds(node: ReactTestInstance): string[] {
  const ids: string[] = [];
  let current: ReactTestInstance | null = node;
  while (current) {
    if (typeof current.props?.testID === "string") {
      ids.push(current.props.testID);
    }
    current = current.parent;
  }
  return ids;
}

/** The real `tool.title` a row's `accessibilityLabel` must equal. */
function toolIdForTitle(title: string): string | undefined {
  const all = tools() as unknown as Record<string, { title: string }>;
  return Object.keys(all).find((id) => all[id].title === title);
}

function rowsOf(surface: ReactTestInstance): ReactTestInstance[] {
  return surface.findAllByType(hostType(PRESSABLE));
}

/**
 * Every root created through `renderHost`, so a case that fails before its own
 * `unmount` still tears its provider down: the real `SheetProvider` unsubscribes
 * in its effect cleanup, and a leaked root would leave stale listeners on the
 * bus and make `subscriberCount`/`mockSheetRegistry` order-dependent.
 */
const mountedRoots = new Set<ReactTestRenderer>();

function renderHost(hostTestID: string, body: React.ReactNode) {
  let renderer: ReactTestRenderer | undefined;
  // React 19: `create` must run inside `act`, otherwise the concurrent root is
  // never committed, `.root` is inaccessible and every later update is
  // unwrapped. The callback is synchronous on purpose - an async variant would
  // make `renderHost` return a Promise instead of the committed renderer.
  act(() => {
    renderer = create(
      <View testID={hostTestID}>{body}</View> as React.ReactElement
    );
  });
  const root = renderer!;
  const unmount = root.unmount.bind(root);
  mountedRoots.add(root);
  // Keep the tracked set accurate when a case unmounts a root itself (the
  // lifecycle case unmounts both of its trees explicitly), so `afterEach`
  // never double-unmounts a root.
  root.unmount = () => {
    if (!mountedRoots.delete(root)) return;
    unmount();
  };
  return root;
}

describe("ConfigureToolbar toolbar-picker routing", () => {
  let tree: ReactTestRenderer | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSheetRegistry.length = 0;
    mockMmkvData.clear();
    bus.reset();
    mockIsMacCatalyst.mockReturnValue(false);
    mockGetUser.mockResolvedValue(null);
    mockGetToolbarConfig.mockReturnValue(undefined);
    mockSettingState.deviceMode = "mobile";
    mockSettingState.isAppLoading = true;
    (globalThis as { logger?: unknown }).logger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };
    useDragState.setState({
      data: clone(SEED),
      preset: "custom",
      customInitialized: true,
      dragged: {}
    });
  });

  afterEach(() => {
    tree = undefined;
    if (mountedRoots.size) {
      const roots = Array.from(mountedRoots);
      act(() => {
        for (const root of roots) root.unmount();
      });
    }
  });

  it("mounts exactly one scoped sheet provider inside the Settings subtree", () => {
    tree = renderHost(SCOPED_HOST, <ConfigureToolbar />);

    const providers = tree.root.findAllByType(SheetProvider);
    expect(providers).toHaveLength(1);
    expect(providers[0].props.context).toBe(TOOL_SHEET_CONTEXT);
    // Not the root/global provider: a "global" value would collide with every
    // other sheet in the app (and re-create the UIKit already-presenting bug).
    expect(TOOL_SHEET_CONTEXT).not.toBe("global");
  });

  it("opens only the scoped provider for the picker; the root global provider stays closed", () => {
    tree = renderHost(
      "app-root",
      <>
        <View testID={ROOT_HOST}>
          <SheetProvider />
        </View>
        <View testID={SCOPED_HOST}>
          <ConfigureToolbar />
        </View>
      </>
    );

    expect(surfaces(tree)).toHaveLength(0);

    act(() => {
      ToolSheet.present({ item: SEED[0], index: 0 });
    });

    // The global provider never mounted a sheet: only the scoped one opened.
    expect(mockSheetRegistry).toHaveLength(1);
    expect(mockSheetRegistry[0].calls).toEqual(["show"]);
    const open = surfaces(tree);
    expect(open).toHaveLength(1);
    const lineage = ancestorTestIds(open[0]);
    expect(lineage).toContain(SCOPED_HOST);
    expect(lineage).not.toContain(ROOT_HOST);
  });

  it("a context-less global present still opens only the root global provider", () => {
    tree = renderHost(
      "app-root",
      <>
        <View testID={ROOT_HOST}>
          <SheetProvider />
        </View>
        <View testID={SCOPED_HOST}>
          <ConfigureToolbar />
        </View>
      </>
    );

    act(() => {
      presentSheet({ component: React.createElement(hostType("GlobalSheetBody")) });
    });

    expect(mockSheetRegistry).toHaveLength(1);
    const open = surfaces(tree);
    expect(open).toHaveLength(1);
    expect(ancestorTestIds(open[0])).toContain(ROOT_HOST);
    expect(ancestorTestIds(open[0])).not.toContain(SCOPED_HOST);
  });

  it("keeps one single scoped sheet across repeated presents", () => {
    tree = renderHost(SCOPED_HOST, <ConfigureToolbar />);

    act(() => {
      ToolSheet.present({ item: SEED[0], index: 0 });
    });
    act(() => {
      ToolSheet.present({ item: SEED[1], index: 1 });
    });

    expect(mockSheetRegistry).toHaveLength(1);
    expect(surfaces(tree)).toHaveLength(1);
  });

  it("labels each row as a button with the tool's real translated title", () => {
    tree = renderHost(SCOPED_HOST, <ConfigureToolbar />);
    act(() => {
      ToolSheet.present({ item: SEED[0], index: 0 });
    });

    const rows = rowsOf(surfaces(tree)[0]);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.props.accessibilityRole).toBe("button");
      const label = row.props.accessibilityLabel;
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
      // The label is not invented: it is one of the real translated titles...
      expect(toolIdForTitle(label)).toBeDefined();
      // ...and it matches the visibly rendered text of the same row.
      const text = row.findAllByType(hostType(PARAGRAPH))[0].props.children;
      expect(label).toBe(text);
    }
  });

  it("adds a tool to the target group without disturbing nested subgroups or order", () => {
    const payload = { item: SEED[0], index: 0 };
    tree = renderHost(SCOPED_HOST, <ConfigureToolbar />);
    act(() => {
      ToolSheet.present(payload);
    });

    const rows = rowsOf(surfaces(tree)[0]);
    const addedId = toolIdForTitle(rows[0].props.accessibilityLabel);
    expect(addedId).toBeDefined();

    act(() => {
      rows[0].props.onPress();
    });

    const data = useDragState.getState().data;
    expect(data).toEqual([
      [addedId, "bold", "italic", ["superscript", "subscript"]],
      ["underline"]
    ]);
    // The nested subgroup and the second group keep their identity/order.
    expect(data[0][3]).toEqual(["superscript", "subscript"]);
    expect(data[1]).toEqual(["underline"]);
    expect(mockSetToolbarConfig).toHaveBeenCalledTimes(1);
    expect(mockSetToolbarConfig).toHaveBeenCalledWith(
      "mobile",
      expect.objectContaining({ preset: "custom", config: data })
    );
  });

  it("adds into the correct nested subgroup when the payload carries group indices", () => {
    const payload = { item: SEED[0][2], index: 2, groupIndex: 0 };
    tree = renderHost(SCOPED_HOST, <ConfigureToolbar />);
    act(() => {
      ToolSheet.present(payload);
    });

    const rows = rowsOf(surfaces(tree)[0]);
    const addedId = toolIdForTitle(rows[0].props.accessibilityLabel);

    act(() => {
      rows[0].props.onPress();
    });

    const data = useDragState.getState().data;
    expect(data).toEqual([
      ["bold", "italic", [addedId, "superscript", "subscript"]],
      ["underline"]
    ]);
  });

  it("closes the scoped sheet on backdrop/cancel without mutating the toolbar config", () => {
    tree = renderHost(SCOPED_HOST, <ConfigureToolbar />);
    act(() => {
      ToolSheet.present({ item: SEED[0], index: 0 });
    });

    const before = clone(useDragState.getState().data);
    const surface = surfaces(tree)[0];

    act(() => {
      surface.props.onClose();
    });

    expect(useDragState.getState().data).toEqual(before);
    expect(mockSetToolbarConfig).not.toHaveBeenCalled();
    expect(surfaces(tree)).toHaveLength(0);
  });

  it("a bare global close does not half-close the scoped picker", () => {
    tree = renderHost(
      "app-root",
      <>
        <View testID={ROOT_HOST}>
          <SheetProvider />
        </View>
        <View testID={SCOPED_HOST}>
          <ConfigureToolbar />
        </View>
      </>
    );
    act(() => {
      ToolSheet.present({ item: SEED[0], index: 0 });
    });
    expect(surfaces(tree)).toHaveLength(1);

    act(() => {
      hideSheet();
    });

    // Still open: the scoped provider only reacts to its own context.
    expect(surfaces(tree)).toHaveLength(1);
    expect(mockSheetRegistry[0].calls).toEqual(["show"]);
  });

  it("on screen unmount hides the scoped sheet, leaves the global sheet alone and unsubscribes", () => {
    const globalTree = renderHost(ROOT_HOST, <SheetProvider />);
    const scopedTree = renderHost(SCOPED_HOST, <ConfigureToolbar />);

    act(() => {
      presentSheet({ component: React.createElement(hostType("GlobalSheetBody")) });
    });
    act(() => {
      ToolSheet.present({ item: SEED[0], index: 0 });
    });

    expect(mockSheetRegistry).toHaveLength(2);
    const globalEntry = mockSheetRegistry[0];
    const scopedEntry = mockSheetRegistry[1];
    expect(globalEntry.calls).toEqual(["show"]);
    expect(scopedEntry.calls).toEqual(["show"]);
    expect(bus.subscriberCount(EVENT_CLOSE_SHEET)).toBe(2);

    act(() => {
      scopedTree.unmount();
    });

    // The scoped teardown ran while its provider was still subscribed, so it
    // actually hid the mounted sheet...
    expect(scopedEntry.calls).toContain("hide");
    // ...without touching the unrelated global sheet...
    expect(globalEntry.calls).toEqual(["show"]);
    // ...and the scoped provider removed its listeners.
    expect(bus.subscriberCount(EVENT_CLOSE_SHEET)).toBe(1);
    expect(bus.subscriberCount(EVENT_OPEN_SHEET)).toBe(1);

    // A stale scoped subscription would have reacted to this global close, so
    // the scoped instance must still show exactly its one unmount hide.
    act(() => {
      hideSheet();
    });
    expect(globalEntry.calls).toContain("hide");
    expect(scopedEntry.calls.filter((call) => call === "hide")).toHaveLength(1);

    act(() => globalTree.unmount());
  });

  it("does not react to another sheet context", () => {
    tree = renderHost(SCOPED_HOST, <ConfigureToolbar />);

    act(() => {
      presentSheet({
        component: React.createElement(hostType("SyncProgress")),
        context: "sync_progress"
      });
    });
    expect(mockSheetRegistry).toHaveLength(0);
    expect(surfaces(tree)).toHaveLength(0);

    act(() => {
      ToolSheet.present({ item: SEED[0], index: 0 });
    });
    expect(mockSheetRegistry).toHaveLength(1);

    // A close for a different context must not dismiss the scoped picker.
    act(() => {
      eSendEvent(eCloseSheet, "sync_progress");
    });
    expect(surfaces(tree)).toHaveLength(1);
  });
});
