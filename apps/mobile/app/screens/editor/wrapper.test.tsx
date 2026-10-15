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
 * The real `EditorWrapper`, rendered by `react-test-renderer`.
 *
 * Only the peripheral edges are mocked: the native primitives, the editor
 * screen itself, the assistant sidebar, the SIWC platform probe, the tiptap
 * controller and the setting store. What the suite reads - the document pane's
 * resolved width, the hidden-pane pointer/accessibility props and the fullscreen
 * padding - is produced by the production wrapper, not by a stand-in.
 *
 * The two iPad-only props (`editorWidth`, `paneHidden`) are guarded by the
 * wrapper's own `isIPad` predicate rather than by their presence, so a stray
 * value must change nothing on iPhone, Android or Mac Catalyst. That guard, and
 * the device-mode fallback, are exactly what this suite pins down.
 */

import React from "react";
import {
  act,
  create,
  ReactTestInstance,
  ReactTestRenderer
} from "react-test-renderer";
import { Platform } from "react-native";

let mockSIWCSupported = false;

jest.mock("react-native", () => ({
  View: "View",
  TextInput: "TextInput",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Platform: { OS: "ios", isPad: true, isMacCatalyst: false },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) }
}));

jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: { primary: { background: "#ffffff" } },
    isDark: false
  })
}));

jest.mock("../../utils/constants", () => ({
  isMacCatalyst: jest.fn(() => false)
}));

jest.mock("../../utils/mac-layout", () => ({
  macToolbarInset: (top: number) => top
}));

jest.mock("../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    ios: true,
    documentSurface: "#ffffff",
    contentSurface: "#f2f2f7"
  })
}));

jest.mock("../../hooks/use-global-safe-area-insets", () => ({
  __esModule: true,
  default: () => ({ top: 47, bottom: 34, left: 0, right: 0 })
}));

jest.mock("../../hooks/use-is-floating-keyboard", () => ({
  __esModule: true,
  default: jest.fn(() => false)
}));

jest.mock("../../services/device-detection", () => ({
  DDS: { isTab: true }
}));

jest.mock("../../services/veyran-siwc", () => ({
  isSIWCPlatformSupported: () => mockSIWCSupported
}));

jest.mock("../../components/veyran-assistant-sidebar", () => ({
  ASSISTANT_SIDEBAR_WIDTH: 340,
  VeyranAssistantSidebar: () => null
}));

jest.mock("../../components/mac-assistant-inspector", () => ({
  MacAssistantInspector: (props: unknown) =>
    require("react").createElement("InspectorProbe", props)
}));

jest.mock("../../utils/global-refs", () => ({
  editorRef: { current: null }
}));

jest.mock("./tiptap/utils", () => ({
  editorController: {
    current: { onReady: jest.fn(), overlay: jest.fn() }
  },
  textInput: { current: null }
}));

/**
 * A mutable setting store. The wrapper reads `deviceMode`, `fullscreen`,
 * `dimensions` and the intro flag from it; the suite writes them between
 * renders. It is not subscribable on purpose - every render here is driven by
 * an explicit `tree.update`, so no store notification is needed.
 */
jest.mock("../../stores/use-setting-store", () => {
  let state: Record<string, unknown> = {
    deviceMode: "tablet",
    fullscreen: false,
    dimensions: { width: 1024, height: 768 },
    settings: { introCompleted: true }
  };
  const useSettingStore = (selector: (s: Record<string, unknown>) => unknown) =>
    selector(state);
  return {
    __esModule: true,
    useSettingStore: Object.assign(useSettingStore, {
      getState: () => state,
      __set: (patch: Record<string, unknown>) => {
        state = { ...state, ...patch };
      }
    })
  };
});

/**
 * A probe in place of the editor screen: the wrapper's own JSX decides whether
 * the editor subtree is mounted at all (the intro gate), and the probe makes
 * that observable without loading the real editor.
 */
jest.mock("./index", () => {
  const React = require("react");
  const Editor = (props: Record<string, unknown>) =>
    React.createElement("EditorProbe", props);
  return { __esModule: true, default: Editor };
});

import EditorWrapper from "./wrapper";
import { useMacWindowStore } from "../../stores/use-mac-window-store";
import type { PaneWidths } from "./wrapper";
import { isMacCatalyst } from "../../utils/constants";
import { AppleTabBarOffsetContext } from "../../components/apple-tab-bar-layout";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTHS: PaneWidths = {
  mobile: { sidebar: 0, list: 1024, editor: 1024 },
  smallTablet: { sidebar: 300, list: 400, editor: 624 },
  tablet: { sidebar: 225, list: 307, editor: 492 }
};

type SettingStoreMock = {
  getState: () => Record<string, unknown>;
  __set: (patch: Record<string, unknown>) => void;
};

const settingStore = () =>
  (
    jest.requireMock("../../stores/use-setting-store") as {
      useSettingStore: SettingStoreMock;
    }
  ).useSettingStore;

const setPlatform = (os: string, isPad: boolean) => {
  (Platform as { OS: string }).OS = os;
  (Platform as { isPad: boolean }).isPad = isPad;
};

const setCatalyst = (value: boolean) =>
  (isMacCatalyst as jest.Mock).mockReturnValue(value);

type WrapperProps = React.ComponentProps<typeof EditorWrapper>;

describe("EditorWrapper iPad pane", () => {
  let tree: ReactTestRenderer | undefined;

  const render = (props: Partial<WrapperProps> = {}) => {
    if (tree) {
      act(() => tree?.unmount());
      tree = undefined;
    }
    const full = { widths: WIDTHS, ...props } as WrapperProps;
    act(() => {
      tree = create(<EditorWrapper {...full} />);
    });
  };

  const update = (props: Partial<WrapperProps> = {}) => {
    const full = { widths: WIDTHS, ...props } as WrapperProps;
    act(() => {
      tree?.update(<EditorWrapper {...full} />);
    });
  };

  const wrapperView = () =>
    tree?.root.findByProps({ testID: "editor-wrapper" }) as ReactTestInstance;

  const paneStyle = () =>
    (wrapperView().props.style as Array<Record<string, unknown>>)[0];

  const editorProbes = () =>
    tree?.root.findAllByType("EditorProbe" as never).length ?? 0;

  beforeEach(() => {
    mockSIWCSupported = false;
    useMacWindowStore.getState().setInspectorVisible(false);
    setPlatform("ios", true);
    setCatalyst(false);
    settingStore().__set({
      deviceMode: "tablet",
      fullscreen: false,
      dimensions: { width: 1024, height: 768 },
      settings: { introCompleted: true }
    });
  });

  afterEach(() => {
    if (tree) act(() => tree?.unmount());
    tree = undefined;
  });

  it("never applies Mac Inspector geometry to an iPad even if a provider probe reports support", () => {
    mockSIWCSupported = true;
    render({ editorWidth: 512 });
    expect(editorProbes()).toBe(1);
    expect(tree!.root.findAllByType("InspectorProbe" as never)).toHaveLength(0);
    expect(paneStyle().width).toBe(512);
  });

  it("keeps Mac writing full width at 660pt and docks only with 560pt left for writing", () => {
    setCatalyst(true);
    mockSIWCSupported = true;
    const widths = {
      ...WIDTHS,
      tablet: { sidebar: 240, list: 300, editor: 660 }
    };
    render({ widths });
    const workspace = () =>
      tree!.root.findByProps({ testID: "mac-editor-workspace" });
    const inspector = () => tree!.root.findByType("InspectorProbe" as never);
    const editor = tree!.root.findByType("EditorProbe" as never);
    expect(paneStyle().width).toBe(660);
    expect(inspector().props.visible).toBe(false);
    expect(workspace().props.style.flexDirection).toBe("column");
    act(() => useMacWindowStore.getState().toggleInspector());
    expect(inspector().props.visible).toBe(true);
    expect(inspector().props.docked).toBe(false);
    expect(paneStyle().width).toBe(660);
    const measure = (width: number, height = 500) =>
      act(() =>
        workspace().props.onLayout({
          nativeEvent: { layout: { width, height } }
        })
      );
    measure(660);
    expect(inspector().props.height).toBe(500);
    // Actual layout, including a manual sidebar collapse, owns the decision;
    // the declared pane estimate still says 660pt.
    measure(1000);
    expect(paneStyle().width).toBe(660);
    expect(workspace().props.style.flexDirection).toBe("row");
    expect(inspector().props.docked).toBe(true);
    measure(899);
    expect(inspector().props.docked).toBe(false);
    measure(900);
    expect(inspector().props.docked).toBe(true);
    expect(inspector().props.visible).toBe(true);
    expect(tree!.root.findByType("EditorProbe" as never)).toBe(editor);
    act(() => inspector().props.onClose());
    expect(inspector().props.visible).toBe(false);
    expect(tree!.root.findByType("EditorProbe" as never)).toBe(editor);
  });

  it.each([900, 1200])(
    "uses the workspace inside fullscreen reading padding at %ipt",
    (windowWidth) => {
      setCatalyst(true);
      mockSIWCSupported = true;
      settingStore().__set({
        fullscreen: true,
        dimensions: { width: windowWidth, height: 600 }
      });
      render();
      const workspace = tree!.root.findByProps({
        testID: "mac-editor-workspace"
      });
      const inspector = () => tree!.root.findByType("InspectorProbe" as never);
      const editor = tree!.root.findByType("EditorProbe" as never);
      act(() => useMacWindowStore.getState().setInspectorVisible(true));
      // No declared/full-window fallback may dock before actual layout.
      expect(inspector().props.docked).toBe(false);
      act(() =>
        workspace.props.onLayout({
          nativeEvent: { layout: { width: windowWidth * 0.7, height: 548 } }
        })
      );
      expect(inspector().props.docked).toBe(false);
      expect(inspector().props.height).toBe(548);
      expect(workspace.props.style.flexDirection).toBe("column");
      expect(tree!.root.findByType("EditorProbe" as never)).toBe(editor);
    }
  );

  it("takes the resolved iPad width only on a real iPad and falls back otherwise", () => {
    render({ editorWidth: 500 });
    expect(paneStyle().width).toBe(500);

    // Without the root's resolved width the iPad pane keeps the device-mode
    // lookup it has always had.
    update({});
    expect(paneStyle().width).toBe(WIDTHS.tablet.editor);

    // The intro gate does not apply to the iPad: its resolved width is used
    // whether or not the intro has completed.
    settingStore().__set({ settings: { introCompleted: false } });
    update({ editorWidth: 500 });
    expect(paneStyle().width).toBe(500);
    expect(editorProbes()).toBe(0);
  });

  it("blocks touch and VoiceOver on the hidden iPad pane and leaves the defaults otherwise", () => {
    render({ editorWidth: 500, paneHidden: true });
    expect(wrapperView().props.pointerEvents).toBe("none");
    expect(wrapperView().props.accessibilityElementsHidden).toBe(true);
    expect(wrapperView().props.importantForAccessibility).toBe(
      "no-hide-descendants"
    );

    // A visible iPad pane keeps each platform default rather than an explicit
    // "auto"/false, so the pane is exactly as it was before.
    update({ editorWidth: 500, paneHidden: false });
    expect(wrapperView().props.pointerEvents).toBeUndefined();
    expect(wrapperView().props.accessibilityElementsHidden).toBeUndefined();
    expect(wrapperView().props.importantForAccessibility).toBeUndefined();

    update({ editorWidth: 500 });
    expect(wrapperView().props.pointerEvents).toBeUndefined();
    expect(wrapperView().props.accessibilityElementsHidden).toBeUndefined();
    expect(wrapperView().props.importantForAccessibility).toBeUndefined();
  });

  it("ignores a stray iPad width and hidden flag on iPhone, Android and Catalyst", () => {
    const stray = { editorWidth: 500, paneHidden: true };

    // iPhone: the width lookup is the only source, and the hidden flag is inert.
    setPlatform("ios", false);
    settingStore().__set({ deviceMode: "mobile" });
    render(stray);
    expect(paneStyle().width).toBe(WIDTHS.mobile.editor);
    expect(wrapperView().props.pointerEvents).toBeUndefined();
    expect(wrapperView().props.accessibilityElementsHidden).toBeUndefined();
    expect(wrapperView().props.importantForAccessibility).toBeUndefined();

    // Android.
    setPlatform("android", false);
    render(stray);
    expect(paneStyle().width).toBe(WIDTHS.mobile.editor);
    expect(wrapperView().props.pointerEvents).toBeUndefined();
    expect(wrapperView().props.importantForAccessibility).toBeUndefined();

    // Mac Catalyst answers `isPad` too, so the explicit exclusion is what keeps
    // the stray props out of the Mac pane as well.
    setPlatform("ios", true);
    setCatalyst(true);
    render(stray);
    expect(paneStyle().width).toBe(WIDTHS.mobile.editor);
    expect(wrapperView().props.pointerEvents).toBeUndefined();
    expect(wrapperView().props.accessibilityElementsHidden).toBeUndefined();
    expect(wrapperView().props.importantForAccessibility).toBeUndefined();
  });

  it("keeps the device-mode fallback until the intro completes and when the mode is unknown", () => {
    settingStore().__set({ settings: { introCompleted: false } });
    render({});
    // Before the intro, the wrapper has always laid itself out from `mobile`.
    expect(paneStyle().width).toBe(WIDTHS.mobile.editor);
    expect(editorProbes()).toBe(0);

    settingStore().__set({ settings: { introCompleted: true } });
    update({});
    expect(paneStyle().width).toBe(WIDTHS.tablet.editor);
    expect(editorProbes()).toBe(1);

    settingStore().__set({ deviceMode: undefined });
    update({});
    expect(paneStyle().width).toBeUndefined();
  });

  it("keeps the fullscreen width and the iPad side padding", () => {
    settingStore().__set({ fullscreen: true });
    render({ editorWidth: 500 });
    // Fullscreen is the whole measured width, not the pane width.
    expect(paneStyle().width).toBe(1024);
    expect(paneStyle().paddingLeft).toBe(0);
    expect(paneStyle().paddingRight).toBe(0);

    // The same width rule holds without the resolved pane width, and going back
    // out of fullscreen restores the pane's own width.
    update({});
    expect(paneStyle().width).toBe(1024);
    settingStore().__set({ fullscreen: false });
    update({});
    expect(paneStyle().width).toBe(WIDTHS.tablet.editor);
  });

  it("zeroes the fullscreen side padding on the small tablet but keeps iPhone's reading column", () => {
    setPlatform("ios", false);
    settingStore().__set({ deviceMode: "smallTablet", fullscreen: true });
    render({});
    expect(paneStyle().width).toBe(1024);
    expect(paneStyle().paddingLeft).toBe(0);
    expect(paneStyle().paddingRight).toBe(0);

    // iPhone (mobile) keeps the 15% side padding fullscreen has always applied.
    settingStore().__set({ deviceMode: "mobile" });
    render({});
    expect(paneStyle().paddingLeft).toBe(1024 * 0.15);
    expect(paneStyle().paddingRight).toBe(1024 * 0.15);
  });
});

describe("EditorWrapper's iPad keyboard offset", () => {
  let tree: ReactTestRenderer | undefined;

  const renderWithOffset = (
    offset: number | undefined,
    props: Partial<WrapperProps> = {}
  ) => {
    if (tree) {
      act(() => tree?.unmount());
      tree = undefined;
    }
    const full = { widths: WIDTHS, ...props } as WrapperProps;
    const element =
      offset === undefined ? (
        <EditorWrapper {...full} />
      ) : (
        <AppleTabBarOffsetContext.Provider value={offset}>
          <EditorWrapper {...full} />
        </AppleTabBarOffsetContext.Provider>
      );
    act(() => {
      tree = create(element);
    });
  };

  const keyboardAvoidingView = () =>
    tree?.root.findByType("KeyboardAvoidingView" as never) as ReactTestInstance;

  beforeEach(() => {
    setPlatform("ios", true);
    setCatalyst(false);
    settingStore().__set({
      deviceMode: "tablet",
      fullscreen: false,
      dimensions: { width: 1024, height: 768 },
      settings: { introCompleted: true }
    });
  });

  afterEach(() => {
    if (tree) act(() => tree?.unmount());
    tree = undefined;
  });

  it("takes the published top tab bar offset on a real iPad", () => {
    renderWithOffset(81, { editorWidth: 500 });
    expect(keyboardAvoidingView().props.keyboardVerticalOffset).toBe(81);
  });

  it("defaults to zero with no provider above it", () => {
    renderWithOffset(undefined, { editorWidth: 500 });
    expect(keyboardAvoidingView().props.keyboardVerticalOffset).toBe(0);
  });

  it("ignores a non-zero offset on iPhone, Android and Mac Catalyst", () => {
    setPlatform("ios", false);
    settingStore().__set({ deviceMode: "mobile" });
    renderWithOffset(81);
    expect(keyboardAvoidingView().props.keyboardVerticalOffset).toBe(0);

    setPlatform("android", false);
    renderWithOffset(81);
    expect(keyboardAvoidingView().props.keyboardVerticalOffset).toBe(0);

    setPlatform("ios", true);
    setCatalyst(true);
    renderWithOffset(81);
    expect(keyboardAvoidingView().props.keyboardVerticalOffset).toBe(0);
  });

  it("still disables for a floating keyboard while the offset stays non-zero", () => {
    const floatingHook = jest.requireMock(
      "../../hooks/use-is-floating-keyboard"
    ) as { default: jest.Mock };
    floatingHook.default.mockReturnValueOnce(true);

    renderWithOffset(81, { editorWidth: 500 });
    expect(keyboardAvoidingView().props.enabled).toBe(false);
    expect(keyboardAvoidingView().props.keyboardVerticalOffset).toBe(81);
  });
});
