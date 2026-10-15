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
import { NavigationRouteContext } from "@react-navigation/native";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { MacSidebarAccountFooter } from "./mac-sidebar-account-footer";
import useNavigationStore from "../stores/use-navigation-store";
import Navigation from "../services/navigation";
import {
  openMacAccountSettings,
  openMacSettings
} from "../screens/settings/mac-account-settings";
import {
  MAC_ACCOUNT_CARD_HEIGHT,
  MAC_ACCOUNT_CARD_MARGIN
} from "../utils/mac-layout";

let mockUser: { email: string } | undefined;
let mockHostRoute = "FluidPanelsView";
let mockDark = false;
let mockSyncStatus = "synced";
let mockReduceMotion = true;
const mockAnimationStart = jest.fn();
const mockAnimationStop = jest.fn();
jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  NativeModules: {},
  Easing: { inOut: (value: unknown) => value, ease: () => 0 },
  Animated: {
    View: "AnimatedView",
    loop: () => ({ start: mockAnimationStart, stop: mockAnimationStop }),
    sequence: () => ({}),
    timing: () => ({}),
    Value: class {
      value: number;
      constructor(value: number) {
        this.value = value;
      }
      stopAnimation() {}
      setValue(value: number) {
        this.value = value;
      }
      interpolate() {
        return 1;
      }
    }
  }
}));
jest.mock("@notesnook/common", () => ({ useTimeAgo: () => "3m" }));
jest.mock("@notesnook/intl", () => ({
  strings: {
    routes: { Settings: () => "Settings" },
    notLoggedIn: () => "Not logged in",
    loginSuccess: () => "Signed in",
    synced: () => "Synced",
    syncFailed: () => "Sync failed"
  }
}));
jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: {
      primary: { accent: "custom-accent" },
      secondary: { background: "custom-avatar" }
    },
    isDark: mockDark
  })
}));
jest.mock("../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    primaryText: mockDark ? "dark-text" : "light-text",
    secondaryText: "secondary",
    hoverSurface: "hover"
  })
}));
jest.mock("../hooks/use-reduce-motion", () => ({
  useReduceMotion: () => mockReduceMotion
}));
jest.mock("../utils/constants", () => ({ isMacCatalyst: () => true }));
jest.mock("../utils/ios-system-colors", () => ({
  systemColor: (color: string) => `semantic-${color}`
}));
jest.mock("../stores/use-user-store", () => ({
  SyncStatus: { Failed: "failed" },
  useUserStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: mockUser,
      lastSyncStatus: mockSyncStatus,
      lastSynced: "2026-10-15T00:00:00Z"
    })
}));
jest.mock("@react-navigation/native", () =>
  jest.requireActual("@react-navigation/core")
);
jest.mock("../services/navigation", () => ({
  __esModule: true,
  default: { navigate: jest.fn() }
}));
jest.mock("../screens/settings/mac-account-settings", () => ({
  openMacAccountSettings: jest.fn(),
  openMacSettings: jest.fn()
}));
jest.mock("./auth/common", () => ({ AuthMode: { login: "login" } }));
jest.mock("./mac-glass-view", () => ({ MacGlassView: "Glass" }));
jest.mock("./ui/AppIcon", () => ({ __esModule: true, default: "Icon" }));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Mac sidebar compact account/settings footer", () => {
  let tree: ReactTestRenderer;
  const footer = () => (
    <NavigationRouteContext.Provider
      value={{ key: mockHostRoute, name: mockHostRoute }}
    >
      <MacSidebarAccountFooter />
    </NavigationRouteContext.Provider>
  );
  const render = () =>
    act(() => {
      tree = create(footer());
    });
  const host = (testID: string) => {
    const node = tree.root
      .findAllByProps({ testID })
      .find((x) => typeof x.type === "string");
    if (!node) throw new Error(`Missing host ${testID}`);
    return node;
  };
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = undefined;
    mockHostRoute = "FluidPanelsView";
    mockDark = false;
    mockSyncStatus = "synced";
    mockReduceMotion = true;
    useNavigationStore.setState({ currentRoute: "Notebook" });
  });
  afterEach(() => act(() => tree?.unmount()));

  it("uses one transparent pinned footer row, retaining compact geometry and separate login/settings targets", () => {
    render();
    expect(tree.root.findAllByType("Glass" as never)).toHaveLength(0);
    expect(host("mac-sidebar-account-footer").props.style).toMatchObject({
      height: MAC_ACCOUNT_CARD_HEIGHT,
      margin: MAC_ACCOUNT_CARD_MARGIN,
      flexShrink: 0
    });
    const account = host("mac-sidebar-account");
    const gear = host("mac-sidebar-settings");
    expect(account.props.accessibilityRole).toBe("button");
    expect(gear.props.accessibilityRole).toBe("button");
    expect(account.props.accessibilityLabel).toBe("Not logged in");
    act(() => account.props.onPress());
    expect(Navigation.navigate).toHaveBeenCalledWith("Auth", { mode: "login" });
    act(() => gear.props.onPress());
    expect(openMacSettings).toHaveBeenCalledTimes(1);
    expect(openMacAccountSettings).not.toHaveBeenCalled();
  });

  it("uses the enclosing Settings host even when the legacy store disagrees", () => {
    useNavigationStore.getState().update("Settings");
    render();
    expect(host("mac-sidebar-settings").props.accessibilityState.selected).toBe(
      false
    );
    act(() => {
      mockHostRoute = "Settings";
      tree.update(footer());
    });
    expect(host("mac-sidebar-settings").props.accessibilityState.selected).toBe(
      true
    );
    expect(
      host("mac-sidebar-settings").findByType("Icon" as never).props.color
    ).toBe("custom-accent");
    act(() => {
      mockHostRoute = "FluidPanelsView";
      tree.update(footer());
    });
    expect(useNavigationStore.getState().currentRoute).toBe("Settings");
    expect(host("mac-sidebar-settings").props.accessibilityState.selected).toBe(
      false
    );
    expect(Navigation.navigate).not.toHaveBeenCalled();
    expect(openMacSettings).not.toHaveBeenCalled();
  });

  it("retains pointer feedback and suppresses it when the Settings selection owns the fill", () => {
    render();
    const gear = host("mac-sidebar-settings");
    expect(gear.findAllByType("View" as never)).toHaveLength(0);
    act(() => gear.props.onHoverIn());
    expect(gear.findAllByType("View" as never)).toHaveLength(1);
    act(() => gear.props.onHoverOut());
    expect(gear.findAllByType("View" as never)).toHaveLength(0);
    act(() => {
      mockHostRoute = "Settings";
      tree.update(footer());
    });
    expect(gear.findAllByType("View" as never)).toHaveLength(1);
    act(() => gear.props.onHoverIn());
    expect(gear.findAllByType("View" as never)).toHaveLength(1);
  });

  it("starts the existing sync animation only without reduced motion and cleans it up on unmount", () => {
    mockUser = { email: "synthetic.qa@example.invalid" };
    mockReduceMotion = false;
    render();
    expect(mockAnimationStart).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
    expect(mockAnimationStop).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "preserves signed-in account action, email truncation, semantic status and appearance (dark=%s)",
    (dark) => {
      mockDark = dark;
      mockUser = { email: "synthetic.qa@example.invalid" };
      render();
      const email = host("mac-sidebar-account-email");
      expect(email.props.numberOfLines).toBe(1);
      expect(email.props.ellipsizeMode).toBe("tail");
      expect(email.props.style.color).toBe(dark ? "dark-text" : "light-text");
      expect(host("mac-sidebar-account").props.accessibilityLabel).toBe(
        "synthetic.qa@example.invalid, Signed in, Synced, 3m"
      );
      act(() => host("mac-sidebar-account").props.onPress());
      expect(openMacAccountSettings).toHaveBeenCalledTimes(1);
      expect(Navigation.navigate).not.toHaveBeenCalled();
      expect(host("mac-sidebar-sync-dot").props.accessibilityLabel).toBe(
        "Synced, 3m"
      );
    }
  );

  it("retains failed sync semantics without relabelling the account or sending anything", () => {
    mockUser = { email: "synthetic.qa@example.invalid" };
    mockSyncStatus = "failed";
    render();
    expect(host("mac-sidebar-sync-dot").props.accessibilityLabel).toBe(
      "Sync failed"
    );
    expect(host("mac-sidebar-account").props.accessibilityLabel).toContain(
      "Sync failed"
    );
    expect(
      tree.root.findByType("AnimatedView" as never).props.style.backgroundColor
    ).toBe("semantic-red");
    expect(openMacSettings).not.toHaveBeenCalled();
    expect(Navigation.navigate).not.toHaveBeenCalled();
  });
});
