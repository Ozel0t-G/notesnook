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
import { act, create, ReactTestRenderer } from "react-test-renderer";
import type { MessageStore } from "../../stores/use-message-store";
import Paragraph from "../ui/typography/paragraph";
import { Card } from "./card";

const flattenStyle = jest.requireActual<{
  default: (style: unknown) => Record<string, unknown>;
}>("react-native/Libraries/StyleSheet/flattenStyle").default;
let mockOS = "ios";
let mockPad = false;
let mockMac = false;
let mockDark = false;
let mockFontScale = 1;
let mockWidth = 320;
let mockState: Pick<MessageStore, "message" | "announcements">;
jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "NativePressable",
  Dimensions: {
    get: () => ({ width: mockWidth, height: 800, fontScale: mockFontScale })
  },
  useWindowDimensions: () => ({
    width: mockWidth,
    height: 800,
    fontScale: mockFontScale
  }),
  Platform: {
    get OS() {
      return mockOS;
    },
    get isPad() {
      return mockPad;
    }
  }
}));
jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    isDark: mockDark,
    colors: {
      primary: {
        accent: mockDark ? "dark-accent" : "accent",
        heading: mockDark ? "dark-heading" : "heading",
        paragraph: "paragraph",
        hover: "hover"
      },
      secondary: { paragraph: mockDark ? "dark-body" : "body" },
      selected: { background: "selected" },
      static: { white: "white", orange: "orange" },
      error: { icon: mockDark ? "dark-error" : "error" }
    }
  })
}));
jest.mock("../../stores/use-message-store", () => ({
  useMessageStore: (select: (state: typeof mockState) => unknown) =>
    select(mockState)
}));
jest.mock("../../utils/constants", () => ({ isMacCatalyst: () => mockMac }));
jest.mock("../../utils/size", () => ({
  AppFontSize: { sm: 14.5, xs: 13.5, xl: 22, xxxl: 30 },
  defaultBorderRadius: 16
}));
jest.mock("../../utils/colors", () => ({
  getColorLinearShade: (color: string) => color,
  hexToRGBA: (color: string) => color,
  RGB_Linear_Shade: (_alpha: number, color: string) => color
}));
jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => "Icon");
jest.mock("../task-symbol-view", () => ({ TaskSymbolView: "Symbol" }));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("real message Card density and retained actions", () => {
  let tree: ReactTestRenderer;
  const onPress = jest.fn();
  beforeEach(() => {
    mockOS = "ios";
    mockPad = mockMac = mockDark = false;
    mockFontScale = 1;
    mockWidth = 320;
    onPress.mockClear();
    mockState = {
      message: {
        id: "log-in",
        visible: true,
        actionText: "Sign in to encrypt and sync notes",
        message: "You are not logged in",
        icon: "account-outline",
        type: "normal",
        data: {},
        onPress
      },
      announcements: []
    };
  });
  afterEach(() => act(() => tree?.unmount()));
  const render = (props: React.ComponentProps<typeof Card> = {}) => {
    act(() => {
      tree = create(<Card {...props} />);
    });
  };
  const button = () => tree.root.findByType("NativePressable" as never);
  const buttonStyle = () =>
    flattenStyle(button().props.style({ pressed: false }));
  const text = (value: string | null) =>
    tree.root
      .findAllByType(Paragraph)
      .find((node) => node.props.children === value)!;
  const press = () => act(() => button().props.onPress({ nativeEvent: {} }));

  it.each([false, true])(
    "compacts phone-owned spacing, retaining title/body/action and semantic colors (dark=%s)",
    (dark) => {
      mockDark = dark;
      render();
      expect(
        tree.root.findAllByType("View" as never)[0].props.style
      ).toMatchObject({
        width: "100%",
        paddingHorizontal: 16,
        paddingVertical: 4
      });
      expect(buttonStyle()).toMatchObject({
        minHeight: 44,
        paddingVertical: 6,
        width: "100%"
      });
      expect(button().props.accessibilityRole).toBe("button");
      const title = text(mockState.message.actionText);
      const body = text(mockState.message.message);
      expect(title.findByType("Text" as never).props.children).toBe(
        mockState.message.actionText
      );
      expect(body.findByType("Text" as never).props.children).toBe(
        mockState.message.message
      );
      for (const paragraph of [title, body]) {
        const merged = flattenStyle(
          paragraph.findByType("Text" as never).props.style
        );
        expect(Object.prototype.hasOwnProperty.call(merged, "fontFamily")).toBe(
          true
        );
        expect(merged.fontFamily).toBeUndefined();
      }
      expect(title.props.color).toBe(dark ? "dark-heading" : "heading");
      expect(body.props.color).toBe(dark ? "dark-body" : "body");
      expect(tree.root.findByType("Symbol" as never).props).toMatchObject({
        name: "person.crop.circle",
        color: dark ? "dark-accent" : "accent"
      });
      expect(tree.root.findAllByType("Icon" as never)).toHaveLength(0);
      press();
      expect(onPress).toHaveBeenCalledTimes(1);
    }
  );

  it.each([1, 3])(
    "allows long localized title and body to wrap at narrow width and font scale %s",
    (scale) => {
      mockFontScale = scale;
      const actionText =
        "Mit dem Konto anmelden, um alle verschlüsselten Notizen sicher zu synchronisieren";
      const message =
        "SehrLangeLokalisierteStatusmeldungOhneLeerzeichen".repeat(5);
      mockState.message = Object.freeze({
        ...mockState.message,
        actionText,
        message
      });
      render();
      expect(text(actionText).parent!.props.style).toMatchObject({
        flex: 1,
        minWidth: 0,
        marginLeft: 8,
        marginRight: 8
      });
      expect(text(actionText).props.style.flexWrap).toBe("wrap");
      for (const paragraph of [text(actionText), text(message)]) {
        const native = paragraph.findByType("Text" as never);
        expect(native.props.children).toBe(paragraph.props.children);
        expect(native.props.numberOfLines).toBeUndefined();
        expect(native.props.ellipsizeMode).toBeUndefined();
        expect(native.props.allowFontScaling).not.toBe(false);
      }
      const style = buttonStyle();
      expect(style.minHeight).toBe(44);
      expect(style.height).toBeUndefined();
      expect(style.maxHeight).toBeUndefined();
      expect(style.overflow).toBeUndefined();
      const symbol = tree.root.findByType("Symbol" as never);
      expect(symbol.props.size).toBe(22 * scale);
      expect(symbol.parent!.props.style).toMatchObject({
        width: 32 * scale,
        height: 32 * scale,
        flexShrink: 0
      });
      press();
      expect(onPress).toHaveBeenCalledTimes(1);
      expect(mockState.message.message).toBe(message);
    }
  );

  it.each([false, true])(
    "retains error color over a custom accent (dark=%s)",
    (dark) => {
      mockDark = dark;
      mockState.message = {
        ...mockState.message,
        id: "confirm-email",
        icon: "email",
        type: "error"
      };
      render({ color: "custom-accent" });
      expect(tree.root.findByType("Symbol" as never).props).toMatchObject({
        name: "envelope",
        color: dark ? "dark-error" : "error"
      });
      expect(text(mockState.message.actionText)).toBeDefined();
      expect(text(mockState.message.message)).toBeDefined();
      press();
      expect(onPress).toHaveBeenCalledTimes(1);
    }
  );

  it("keeps recovery action and its SF key equivalent", () => {
    mockState.message = {
      ...mockState.message,
      id: "recovery-key",
      icon: "key"
    };
    render({ color: "custom-accent" });
    expect(tree.root.findByType("Symbol" as never).props).toMatchObject({
      name: "key",
      color: "custom-accent"
    });
    press();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("uses customMessage over the hidden store message, preserving its unknown icon and callback", () => {
    mockState.message = { ...mockState.message, visible: false };
    const customPress = jest.fn();
    const customMessage = Object.freeze({
      ...mockState.message,
      visible: true,
      actionText: "Custom action",
      message: "Custom body",
      icon: "custom-icon",
      onPress: customPress
    });
    render({ customMessage, color: "custom-accent" });
    expect(text("Custom action")).toBeDefined();
    expect(text("Custom body")).toBeDefined();
    expect(tree.root.findAllByType("Symbol" as never)).toHaveLength(0);
    expect(tree.root.findByType("Icon" as never).props).toMatchObject({
      name: "custom-icon",
      color: "custom-accent",
      allowFontScaling: true
    });
    press();
    expect(customPress).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it.each([
    "hidden-store",
    "hidden-custom",
    "announcement-store",
    "announcement-custom"
  ])("preserves %s suppression without an actionable card", (kind) => {
    if (kind === "hidden-store") mockState.message.visible = false;
    if (kind.startsWith("announcement"))
      mockState.announcements = [{} as MessageStore["announcements"][number]];
    const customMessage = kind.endsWith("custom")
      ? { ...mockState.message, visible: kind !== "hidden-custom" }
      : undefined;
    render({ customMessage });
    expect(tree.toJSON()).toBeNull();
    expect(onPress).not.toHaveBeenCalled();
  });

  it.each(["iPad", "Mac", "Android"])(
    "keeps %s legacy geometry, font, icon, colors and callback",
    (platform) => {
      mockPad = platform === "iPad";
      mockMac = platform === "Mac";
      mockOS = platform === "Android" ? "android" : "ios";
      mockFontScale = 2;
      render({ color: "custom-accent" });
      expect(tree.root.findAllByType("View" as never)[0].props.style).toEqual({
        width: "100%",
        paddingHorizontal: 16,
        paddingVertical: 10
      });
      expect(button().props.accessibilityRole).toBeUndefined();
      expect(buttonStyle()).toMatchObject({
        paddingVertical: 10,
        width: "100%"
      });
      expect(buttonStyle().minHeight).toBeUndefined();
      const title = text(mockState.message.actionText);
      expect(title.parent!.props.style).toEqual({
        marginLeft: 10,
        marginRight: 10
      });
      expect(title.props.style).toEqual({ flexWrap: "nowrap", flexShrink: 1 });
      for (const paragraph of [title, text(mockState.message.message)]) {
        expect(
          flattenStyle(paragraph.findByType("Text" as never).props.style)
            .fontFamily
        ).toBe("Inter-Regular");
      }
      expect(tree.root.findAllByType("Symbol" as never)).toHaveLength(0);
      const icon = tree.root.findByType("Icon" as never);
      expect(icon.props).toMatchObject({
        name: "account-outline",
        size: 30,
        color: "custom-accent",
        allowFontScaling: true
      });
      expect(icon.parent!.props.style).toEqual({
        width: 80,
        height: 80,
        borderRadius: 100,
        alignItems: "center",
        justifyContent: "center"
      });
      press();
      expect(onPress).toHaveBeenCalledTimes(1);
    }
  );
});
