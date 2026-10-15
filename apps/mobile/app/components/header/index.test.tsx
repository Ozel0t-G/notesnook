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
 * The real `Header` together with the real `IosNavBar`.
 *
 * Everything unrelated is mocked (theme, native primitives, the Menus, the
 * list menu/sort dependencies), but the navigation bar the iPad note
 * collections depend on is the production one: this suite proves the back
 * button and the leading account affordance coexist in one bar, and that
 * selection mode swaps in the "N selected"/Done bar without a back button.
 */

import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";

let mockPlatformOS = "ios";
let mockIsPad = true;
let mockMac = false;
let mockIsDark = false;
let mockFieldSurface = "semantic-field";

let mockSelectionMode: string | undefined;
let mockSelectedItems: string[] = [];
let mockClearSelection = jest.fn();
let mockListMenu:
  | { items: { id: string; title: string }[]; onSelect: jest.Mock }
  | undefined;

jest.mock("@notesnook/intl", () => {
  const routes: Record<string, string> = {
    Library: "Library",
    AllNotes: "All Notes",
    Inbox: "Inbox"
  };
  const routeProxy = new Proxy(
    {},
    {
      get: (_target, key) => {
        const route = routes[String(key)];
        return route === undefined ? undefined : () => route;
      }
    }
  );
  return {
    strings: new Proxy(
      {},
      {
        get: (_target, key) => {
          const name = String(key);
          if (name === "routes") return routeProxy;
          if (name === "selectedCode") return (n: number) => `${n} selected`;
          if (name === "notes") return (n: number) => `${n} notes`;
          if (name === "searchInRoute")
            return (title: string) => `Search in ${title}`;
          if (name === "done") return () => "Done";
          if (name === "newNoteTab") return () => "New note";
          if (name === "more") return () => "More";
          if (name === "search") return () => "Search";
          return () => name;
        }
      }
    )
  };
});

jest.mock("@notesnook/theme", () => ({
  resolveAppleSurfaces: jest.requireActual(
    "../../../../../packages/theme/src/theme-engine/apple-surfaces"
  ).resolveAppleSurfaces,
  useThemeColors: () => ({
    colors: {
      primary: { accent: "#0a84ff", heading: "#000" },
      secondary: { icon: "#666" },
      error: { icon: "#ff0000" },
      success: { icon: "#00ff00" },
      static: { yellow: "#ffcc00" }
    },
    isDark: mockIsDark
  })
}));

jest.mock("@react-navigation/core", () => ({
  NavigationContext: require("react").createContext(undefined)
}));

jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  Platform: {
    get OS() {
      return mockPlatformOS;
    },
    get isPad() {
      return mockIsPad;
    },
    get isMacCatalyst() {
      return mockMac;
    }
  }
}));

jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("Icon", props);
  }
}));

jest.mock("../mac-hover", () => ({
  useMacHover: () => ({ hovered: false, hoverProps: {} }),
  MacHoverHighlight: () => null
}));

jest.mock("../native-menu", () => {
  const React = require("react");
  return {
    MenuButton: (props: { children?: React.ReactNode }) =>
      React.createElement("MenuButton", null, props.children)
  };
});

jest.mock("../task-symbol-view", () => {
  const React = require("react");
  return {
    TaskSymbolView: (props: Record<string, unknown>) =>
      React.createElement("TaskSymbolView", props)
  };
});

jest.mock("../ui/icon-button", () => {
  const React = require("react");
  return {
    IconButton: (props: Record<string, unknown>) =>
      React.createElement("IconButton", props)
  };
});

jest.mock("../ui/pressable", () => {
  const React = require("react");
  return {
    Pressable: (props: Record<string, unknown>) => {
      const { children, ...rest } = props;
      return React.createElement("Pressable", rest, children);
    }
  };
});

jest.mock("../ui/typography/heading", () => ({
  __esModule: true,
  default: "Heading"
}));

jest.mock("../ui/typography/paragraph", () => {
  const React = require("react");
  const Paragraph = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("Paragraph", null, children);
  return { __esModule: true, default: Paragraph };
});

jest.mock("./left-menus", () => {
  const React = require("react");
  return {
    LeftMenus: (props: Record<string, unknown>) =>
      React.createElement("LeftMenus", props)
  };
});

jest.mock("./right-menus", () => {
  const React = require("react");
  return {
    RightMenus: (props: Record<string, unknown>) =>
      React.createElement("RightMenus", props)
  };
});

jest.mock("../list-view-menu", () => ({
  useListViewMenu: () => mockListMenu
}));

jest.mock("../sheets/sort", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("Sort", props);
  }
}));

jest.mock("../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    ios: mockPlatformOS === "ios",
    secondarySurface: mockFieldSurface,
    screenBackground: "#ffffff",
    primaryText: "#000000",
    secondaryText: "#666666",
    tertiaryText: "#999999",
    separator: "#dddddd",
    controlRadius: 10,
    pagePadding: 20
  })
}));

jest.mock("../../utils/colors", () => ({
  hexToRGBA: (value: string) => value
}));

jest.mock("../../utils/constants", () => ({
  isMacCatalyst: () => mockMac
}));

jest.mock("../../utils/events", () => ({ eScrollEvent: "eScrollEvent" }));

jest.mock("../../utils/mac-layout", () => ({
  MAC_TOOLBAR_HEIGHT: 52,
  macToolbarInset: (top: number) => top,
  macWindowBackground: () => "#ffffff"
}));

jest.mock("../../utils/mac-window-title", () => ({
  useMacListTitleStore: Object.assign(() => undefined, {
    getState: () => ({ listTitle: undefined, setListTitle: jest.fn() })
  })
}));

jest.mock("../../utils/size", () => ({
  AppFontSize: { xl: 20, lg: 18, md: 16, sm: 14, xxs: 11 }
}));

jest.mock("../../utils/styles", () => ({
  DefaultAppStyles: { GAP: 12, GAP_VERTICAL: 8, GAP_VERTICAL_SMALL: 4 }
}));

jest.mock("../../hooks/use-global-safe-area-insets", () => ({
  __esModule: true,
  default: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}));

jest.mock("../../hooks/use-is-compact-mode-enabled", () => ({
  useIsCompactModeEnabled: () => false
}));

jest.mock("../../hooks/use-group-options", () => ({
  useGroupOptions: () => ({ sortDirection: "asc" })
}));

jest.mock("../../services/event-manager", () => ({
  eSubscribeEvent: jest.fn(),
  eUnSubscribeEvent: jest.fn(),
  presentSheet: jest.fn()
}));

jest.mock("../../services/settings", () => ({
  __esModule: true,
  default: { set: jest.fn() }
}));

jest.mock("../../services/navigation", () => ({
  __esModule: true,
  default: { goBack: jest.fn(), navigate: jest.fn(), openDrawer: jest.fn() }
}));

// The real `AccountAffordance` the header synthesizes for note lists whose
// sidebar is off screen pulls in the account/sheet edges; only those are mocked.
jest.mock("../../stores/use-user-store", () => ({
  SyncStatus: { Failed: "failed" },
  useUserStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: undefined,
      profile: undefined,
      lastSyncStatus: undefined
    })
}));

jest.mock("../sheets/user", () => ({
  UserSheet: { present: jest.fn() }
}));

jest.mock("../../utils/functions", () => ({
  getObfuscatedEmail: (email: string) => email
}));

jest.mock("../../stores/use-selection-store", () => {
  const selectorHook = (selector: (state: unknown) => unknown) =>
    selector({
      selectedItemsList: mockSelectedItems,
      selectionMode: mockSelectionMode,
      clearSelection: () => mockClearSelection()
    });
  return { useSelectionStore: selectorHook };
});

jest.mock("../../stores/use-mac-window-store", () => ({
  useMacWindowStore: Object.assign(() => undefined, {
    getState: () => ({ listMenu: undefined, setListMenu: jest.fn() }),
    subscribe: () => () => undefined
  })
}));

jest.mock("../../stores/use-apple-navigation-store", () => ({
  useAppleNavigationStore: Object.assign(() => undefined, {
    getState: () => ({ section: "library" }),
    subscribe: () => () => undefined
  })
}));

import { Header } from "./index";
import { IosMoreMenu, IosNavBar, IosSearchField } from "../ios-nav-bar";
import { IPadWorkspaceProvider } from "../ipad-workspace-context";
import Navigation from "../../services/navigation";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Annotated with the real component props so the literal `menu.group`/
// `menu.dataType` (and `renderedInRoute`) do not widen to `string`.
const headerProps: React.ComponentProps<typeof Header> = {
  renderedInRoute: "AllNotes",
  title: "All Notes",
  id: "AllNotes",
  hasSearch: true,
  menu: { group: "home", dataType: "note", selectable: true },
  onSearch: jest.fn(),
  onCompose: jest.fn()
};

const accountProbe = React.createElement("AccountAffordance", {
  testID: "header-account"
});

describe("Header iOS navigation bar", () => {
  let tree: ReactTestRenderer | undefined;
  let onLeftMenuButtonPress: jest.Mock;

  const render = (overrides: Record<string, unknown> = {}) => {
    onLeftMenuButtonPress = jest.fn();
    act(() => {
      tree = create(
        <Header
          {...headerProps}
          canGoBack={true}
          onLeftMenuButtonPress={onLeftMenuButtonPress}
          leading={accountProbe}
          {...overrides}
        />
      );
    });
  };

  const navBar = () =>
    tree?.root.findByType(IosNavBar).props as Record<string, unknown>;

  // --- iPad workspace: the header reads the real `useIPadWorkspace`. --------
  type PaneMode = "narrow" | "medium" | "wide";
  let mockPaneMode: PaneMode = "wide";
  let mockSidebarVisible = true;

  const ipadValue = () => ({
    paneMode: mockPaneMode,
    sidebarVisible: mockSidebarVisible
  });

  const renderIpad = (overrides: Record<string, unknown> = {}) => {
    act(() => {
      tree = create(
        <IPadWorkspaceProvider value={ipadValue()}>
          <Header {...headerProps} canGoBack={false} {...overrides} />
        </IPadWorkspaceProvider>
      );
    });
  };

  const setIpad = (mode: PaneMode, sidebarVisible: boolean) => {
    mockPaneMode = mode;
    mockSidebarVisible = sidebarVisible;
    act(() => {
      tree?.update(
        <IPadWorkspaceProvider value={ipadValue()}>
          <Header {...headerProps} canGoBack={false} />
        </IPadWorkspaceProvider>
      );
    });
  };

  const backButton = () =>
    tree?.root.findAllByProps({ testID: "ios-nav-back" })[0];

  const account = () =>
    tree?.root.findAllByProps({ testID: "header-account" })[0];

  beforeEach(() => {
    mockSelectionMode = undefined;
    mockSelectedItems = [];
    mockClearSelection = jest.fn();
    mockListMenu = undefined;
    mockPaneMode = "wide";
    mockSidebarVisible = true;
    (Navigation.navigate as jest.Mock).mockClear();
    (Navigation.openDrawer as jest.Mock).mockClear();
    (Navigation.goBack as jest.Mock).mockClear();
  });

  afterEach(() => {
    if (tree) act(() => tree?.unmount());
    tree = undefined;
  });

  it("shows a named search field while keeping existing list actions in More", () => {
    mockListMenu = {
      items: [
        { id: "list:compact", title: "Compact list" },
        { id: "sort:dateEdited", title: "Edited date" }
      ],
      onSelect: jest.fn()
    };
    const search = jest.fn();
    render({ count: 7, onSearch: search });
    const field = tree?.root.findByType(IosSearchField);
    expect(field?.props.placeholder).toBe("Search in All Notes");
    expect(
      tree?.root.findAllByProps({ accessibilityRole: "search" }).length
    ).toBeGreaterThan(0);
    act(() => field?.props.onPress());
    expect(search).toHaveBeenCalledTimes(1);
    const more = tree?.root.findByType(IosMoreMenu);
    expect(more?.props.items).toBe(mockListMenu.items);
    act(() => more?.props.onSelect("list:compact"));
    expect(mockListMenu.onSelect).toHaveBeenCalledWith("list:compact");
    expect(tree?.root.findAllByProps({ testID: "icon-sort" })).toHaveLength(0);
    expect(
      tree?.root.findAllByProps({ testID: "icon-compact-mode" })
    ).toHaveLength(0);
  });

  it("shows the back button and the leading account affordance in the same bar", () => {
    render();

    const bar = navBar();
    expect(typeof bar.onBack).toBe("function");
    expect(bar.backTitle).toBe("Library");
    expect(bar.leading).toBeTruthy();

    expect(tree?.root.findByProps({ testID: "ios-nav-back" })).toBeTruthy();
    expect(tree?.root.findByProps({ testID: "header-account" })).toBeTruthy();

    act(() => {
      (
        tree?.root.findByProps({ testID: "ios-nav-back" }).props
          .onPress as () => void
      )();
    });
    expect(onLeftMenuButtonPress).toHaveBeenCalledTimes(1);
  });

  it("keeps the leading affordance when there is no back button", () => {
    render({ canGoBack: false });

    expect(navBar().onBack).toBeUndefined();
    expect(tree?.root.findAllByProps({ testID: "ios-nav-back" })).toHaveLength(
      0
    );
    expect(tree?.root.findByProps({ testID: "header-account" })).toBeTruthy();
  });

  it("swaps in the selection bar without a back button and keeps leading", () => {
    mockSelectionMode = "note";
    mockSelectedItems = ["note-a", "note-b"];
    render();

    expect(tree?.root.findAllByProps({ testID: "ios-nav-back" })).toHaveLength(
      0
    );
    expect(navBar().title).toBe("2 selected");
    // The leading slot is still rendered next to the selection actions.
    expect(tree?.root.findByProps({ testID: "header-account" })).toBeTruthy();
    // Selection mode hides the large title/search row.
    expect(
      tree?.root.findAllByProps({ testID: "header-large-title" })
    ).toHaveLength(0);

    const done = tree?.root.findAllByProps({ accessibilityLabel: "Done" })[0];
    expect(done).toBeTruthy();
    act(() => {
      (done?.props.onPress as () => void)();
    });
    expect(mockClearSelection).toHaveBeenCalledTimes(1);
  });

  it("keeps the back button while not selecting", () => {
    render();
    expect(navBar().backTitle).toBe("Library");
    expect(navBar().title).toBeUndefined();
  });

  it("gives an iPad note list with no back history a mode-appropriate way to its sources", () => {
    // The Notebook opened from the iPad sidebar: `canGoBack: false`, an actual
    // note-list menu, and no caller leading.
    renderIpad();

    // wide: the source column is already there - no redundant leading nav.
    expect(backButton()).toBeUndefined();
    expect(account()).toBeUndefined();

    // medium: the source list is the swipe-in drawer, so the leading control
    // opens the real drawer.
    setIpad("medium", false);
    const mediumBack = backButton();
    expect(mediumBack).toBeTruthy();
    expect(mediumBack?.props.accessibilityLabel).toBe("expandSidebar");
    expect(account()).toBeTruthy();
    act(() => {
      (mediumBack?.props.onPress as () => void)();
    });
    expect(Navigation.openDrawer).toHaveBeenCalledTimes(1);
    expect(Navigation.navigate).not.toHaveBeenCalled();

    (Navigation.openDrawer as jest.Mock).mockClear();
    (Navigation.navigate as jest.Mock).mockClear();

    // narrow: there is no sidebar at all, so the explicit return to the
    // Library's source categories stays - and it is a return, not the drawer.
    setIpad("narrow", false);
    const narrowBack = backButton();
    expect(narrowBack).toBeTruthy();
    expect(narrowBack?.props.accessibilityLabel).toBe("Library");
    expect(account()).toBeTruthy();
    act(() => {
      (narrowBack?.props.onPress as () => void)();
    });
    expect(Navigation.navigate).toHaveBeenCalledWith("Library");
    expect(Navigation.openDrawer).not.toHaveBeenCalled();
  });

  it("keeps a real back button on an iPad note list instead of synthesizing one", () => {
    mockPaneMode = "narrow";
    mockSidebarVisible = false;
    onLeftMenuButtonPress = jest.fn();
    act(() => {
      tree = create(
        <IPadWorkspaceProvider value={ipadValue()}>
          <Header
            {...headerProps}
            canGoBack={true}
            onLeftMenuButtonPress={onLeftMenuButtonPress}
          />
        </IPadWorkspaceProvider>
      );
    });

    const backBtn = backButton();
    expect(backBtn).toBeTruthy();
    expect(backBtn?.props.accessibilityLabel).toBe("Library");
    act(() => {
      (backBtn?.props.onPress as () => void)();
    });
    expect(onLeftMenuButtonPress).toHaveBeenCalledTimes(1);
    expect(Navigation.navigate).not.toHaveBeenCalled();
    expect(Navigation.openDrawer).not.toHaveBeenCalled();
    // The account affordance is still reachable while the sidebar is off screen.
    expect(account()).toBeTruthy();
  });

  it("never adds a second account affordance when the caller supplies a leading", () => {
    mockPaneMode = "narrow";
    mockSidebarVisible = false;
    renderIpad({ leading: accountProbe });

    expect(
      tree?.root.findAllByProps({ testID: "header-account" })
    ).toHaveLength(1);
    // The synthesized Library return coexists with the caller's own leading.
    expect(backButton()).toBeTruthy();
  });

  it("leaves the iPad selection bar without a synthesized nav", () => {
    mockSelectionMode = "note";
    mockSelectedItems = ["note-a"];
    mockPaneMode = "narrow";
    mockSidebarVisible = false;
    renderIpad();

    expect(tree?.root.findAllByProps({ testID: "ios-nav-back" })).toHaveLength(
      0
    );
    expect(account()).toBeUndefined();
  });

  it("adds nothing to a note list when there is no iPad workspace", () => {
    render({ canGoBack: false, leading: undefined });

    expect(tree?.root.findAllByProps({ testID: "ios-nav-back" })).toHaveLength(
      0
    );
    expect(
      tree?.root.findAllByProps({ testID: "header-account" })
    ).toHaveLength(0);
    expect(Navigation.openDrawer).not.toHaveBeenCalled();
  });
});

describe("real IosSearchField phone-dark semantic surface", () => {
  let tree: ReactTestRenderer | undefined;
  const renderedTree = () => {
    if (!tree) throw new Error("Search field has not been rendered");
    return tree;
  };
  const resetAppearance = () => {
    mockPlatformOS = "ios";
    mockIsPad = true;
    mockMac = false;
    mockIsDark = false;
    mockFieldSurface = "semantic-field";
  };
  beforeEach(resetAppearance);
  afterEach(() => {
    act(() => tree?.unmount());
    tree = undefined;
    resetAppearance();
  });

  it.each(["standard", "custom"] as const)(
    "consumes the nonempty field from the real %s dark surface resolver",
    (kind) => {
      const { getAppleVisualTokens } = jest.requireActual<
        typeof import("../../utils/apple-visual-tokens")
      >("../../utils/apple-visual-tokens");
      const { APPLE_SURFACE_NEUTRALS } = jest.requireActual<
        typeof import("../../../../../packages/theme/src/theme-engine/apple-surfaces")
      >("../../../../../packages/theme/src/theme-engine/apple-surfaces");
      mockIsPad = false;
      mockIsDark = true;
      const colors = {
        primary: { background: "authored-document", heading: "heading" },
        secondary: {
          background: "authored-field",
          paragraph: "body",
          icon: "icon"
        },
        selected: { background: "selection" }
      } as Parameters<typeof getAppleVisualTokens>[0];
      const tokens = getAppleVisualTokens(colors, true, {
        id: kind === "standard" ? "veyran-dark" : "custom-dark",
        colorScheme: "dark"
      });
      expect(tokens.secondarySurface).toBe(
        kind === "standard"
          ? APPLE_SURFACE_NEUTRALS.dark.elevatedSurface
          : colors.secondary.background
      );
      expect(typeof tokens.secondarySurface).toBe("string");
      expect(tokens.secondarySurface.length).toBeGreaterThan(0);
      mockFieldSurface = tokens.secondarySurface;
      const onSearch = jest.fn();
      act(() => {
        tree = create(
          <IosSearchField placeholder="Search" onPress={onSearch} />
        );
      });
      const press = renderedTree().root.findByType("Pressable" as never);
      expect(press.props.style.backgroundColor).toBe(tokens.secondarySurface);
      act(() => press.props.onPress());
      expect(onSearch).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    [
      "phone dark",
      "ios",
      false,
      false,
      true,
      "semantic-field",
      "semantic-field"
    ],
    [
      "custom phone dark",
      "ios",
      false,
      false,
      true,
      "custom-authored-field",
      "custom-authored-field"
    ],
    [
      "phone light",
      "ios",
      false,
      false,
      false,
      "unused-light-field",
      "rgba(118,118,128,0.12)"
    ],
    ["iPad dark", "ios", true, false, true, "unused-ipad-field", "#1C1C1E"],
    [
      "iPad light",
      "ios",
      true,
      false,
      false,
      "unused-ipad-field",
      "rgba(118,118,128,0.12)"
    ],
    // Catalyst must stay on its existing token branch even when isPad=false.
    [
      "Mac dark",
      "ios",
      false,
      true,
      true,
      "mac-control-field",
      "mac-control-field"
    ],
    [
      "Mac light",
      "ios",
      false,
      true,
      false,
      "mac-control-field",
      "mac-control-field"
    ],
    [
      "Android dark",
      "android",
      false,
      false,
      true,
      "unused-android-field",
      "#1C1C1E"
    ],
    [
      "Android light",
      "android",
      false,
      false,
      false,
      "unused-android-field",
      "rgba(118,118,128,0.12)"
    ]
  ] as const)(
    "uses the intended fill and preserves geometry/content/callback for %s",
    (_label, os, pad, mac, dark, field, expected) => {
      mockPlatformOS = os;
      mockIsPad = pad;
      mockMac = mac;
      mockIsDark = dark;
      mockFieldSurface = field;
      const onSearch = jest.fn();
      const placeholder = "In Projektübersicht suchen";
      act(() => {
        tree = create(
          <IosSearchField
            placeholder={placeholder}
            onPress={onSearch}
            testID="surface-search"
          />
        );
      });
      const press = renderedTree().root.findByType("Pressable" as never);
      expect(press.props.style).toEqual({
        marginHorizontal: mac ? 12 : 16,
        marginBottom: mac ? 8 : 10,
        minHeight: mac ? 28 : 36,
        borderRadius: mac ? 7 : 10,
        paddingHorizontal: mac ? 6 : 8,
        flexDirection: "row",
        alignItems: "center",
        gap: mac ? 4 : 6,
        backgroundColor: expected
      });
      expect(press.props).toMatchObject({
        testID: "surface-search",
        accessibilityRole: "search",
        accessibilityLabel: placeholder,
        onPress: onSearch
      });
      const symbol = renderedTree().root.findByType("TaskSymbolView" as never);
      expect(symbol.props).toMatchObject({
        name: "magnifyingglass",
        size: mac ? 13 : 16,
        color: "#999999"
      });
      const text = renderedTree().root.findByType("Text" as never);
      expect(text.props.children).toBe(placeholder);
      expect(text.props.style).toEqual({
        color: "#999999",
        fontSize: mac ? 13 : 17
      });
      expect(onSearch).not.toHaveBeenCalled();
      act(() => press.props.onPress());
      expect(onSearch).toHaveBeenCalledTimes(1);
      expect(onSearch).toHaveBeenCalledWith();
    }
  );

  it("updates the real field token across phone appearance/theme changes without changing the handler", () => {
    mockIsPad = false;
    const onSearch = jest.fn();
    const props = { placeholder: "Search in All Notes", onPress: onSearch };
    act(() => {
      tree = create(<IosSearchField {...props} />);
    });
    const press = () => renderedTree().root.findByType("Pressable" as never);
    expect(press().props.style.backgroundColor).toBe("rgba(118,118,128,0.12)");
    mockIsDark = true;
    mockFieldSurface = "first-dark-theme-field";
    act(() => {
      renderedTree().update(<IosSearchField {...props} />);
    });
    expect(press().props.style.backgroundColor).toBe("first-dark-theme-field");
    mockFieldSurface = "second-custom-dark-field";
    act(() => {
      renderedTree().update(<IosSearchField {...props} />);
    });
    expect(press().props.style.backgroundColor).toBe(
      "second-custom-dark-field"
    );
    expect(press().props.onPress).toBe(onSearch);
    expect(onSearch).not.toHaveBeenCalled();
    act(() => press().props.onPress());
    expect(onSearch).toHaveBeenCalledTimes(1);
  });
});
