import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { Platform } from "react-native";
import { AppleTabBar } from "./apple-tab-bar";
import { useAppleNavigationStore } from "../stores/use-apple-navigation-store";

let mockIsDark = false;

jest.mock("react-native", () => ({
  Platform: { OS: "ios", isPad: false },
  requireNativeComponent: () => "NativeTabBar",
  StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles },
  View: "View"
}));
jest.mock("@notesnook/intl", () => ({
  strings: {
    dataTypesPluralCamelCase: { note: () => "Notes" },
    tasksTitle: () => "Tasks",
    search: () => "Search"
  }
}));
jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: { primary: { accent: "accent" } },
    isDark: mockIsDark
  })
}));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 20 })
}));
jest.mock("../utils/constants", () => ({ isMacCatalyst: () => false }));
jest.mock("../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({ screenBackground: "surface" })
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Apple Notes / Tasks / Search bar", () => {
  let tree: ReactTestRenderer;
  afterEach(() => act(() => tree?.unmount()));

  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])(
    "renders reachable destinations and effective appearance on iPad=%s dark=%s",
    (isPad, isDark) => {
      mockIsDark = isDark;
      (Platform as unknown as { isPad: boolean }).isPad = isPad;
      useAppleNavigationStore.setState({
        section: "library",
        settingsVisible: false
      });
      const select = jest.fn();
      act(() => {
        tree = create(<AppleTabBar onSelect={select} />);
      });
      const bar = () => tree.root.findByType("NativeTabBar" as never);
      expect(bar().props.isDark).toBe(isDark);
      expect(bar().props.itemTitles).toEqual({
        library: "Notes",
        tasks: "Tasks",
        search: "Search"
      });
      expect(bar().props.selectedSection).toBe("library");
      act(() => bar().props.onSelect({ nativeEvent: { section: "search" } }));
      expect(select).toHaveBeenCalledTimes(1);
      expect(select).toHaveBeenCalledWith("search");
      act(() => useAppleNavigationStore.getState().setSection("search"));
      expect(bar().props.selectedSection).toBe("search");
      act(() => useAppleNavigationStore.getState().setSettingsVisible(true));
      expect(bar().props.selectedSection).toBe("search");
      act(() => useAppleNavigationStore.getState().setSettingsVisible(false));
      expect(bar().props.selectedSection).toBe("search");
      act(() => {
        mockIsDark = !isDark;
        tree.update(<AppleTabBar onSelect={select} />);
      });
      expect(bar().props.isDark).toBe(!isDark);
      expect(bar().props.selectedSection).toBe("search");
    }
  );
});
