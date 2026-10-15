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

/** Real component, typography and Apple semantic resolver; native hosts/symbol,
 * theme context/identity, font metrics and translations are seams. No mounted
 * consumer, real Yoga layout, native hit testing or spoken VoiceOver is proven.
 */
import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { IPadPrimaryDestinations } from "./ipad-primary-destinations";

let mockDark = false;
let mockLongLabels = false;
const mockColors = () => ({
  primary: {
    heading: mockDark ? "#f2f2f4" : "#18181b",
    paragraph: mockDark ? "#f2f2f4" : "#18181b",
    accent: mockDark ? "#86dba2" : "#087c3e",
    hover: mockDark ? "#36363a" : "#dddde3"
  },
  secondary: { paragraph: "#888888", icon: "#999999" }
});
const mockLabel = (value: string) =>
  mockLongLabels
    ? `${value} mit sehr langer lokalisierter Bereichsbezeichnung`
    : value;

jest.mock("react-native", () => ({
  Platform: { OS: "ios", isPad: true, isMacCatalyst: false },
  View: "View",
  Text: "Text",
  Pressable: "NativePressable",
  requireNativeComponent: () => "NativeSymbol"
}));
jest.mock(
  "react-native-vector-icons/MaterialCommunityIcons",
  () => "FallbackIcon"
);
jest.mock("@notesnook/intl", () => ({
  strings: {
    dataTypesPluralCamelCase: { note: () => mockLabel("Notes") },
    tasksTitle: () => mockLabel("Tasks"),
    search: () => mockLabel("Search")
  }
}));
jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({ colors: mockColors(), isDark: mockDark }),
  resolveAppleSurfaces: jest.requireActual(
    "../../../../packages/theme/src/theme-engine/apple-surfaces"
  ).resolveAppleSurfaces
}));
jest.mock("../utils/mac-layout", () => ({
  activeAppleThemeIdentity: () => ({
    id: mockDark ? "veyran-dark" : "veyran-light",
    colorScheme: mockDark ? "dark" : "light"
  })
}));
jest.mock("../utils/size", () => ({ AppFontSize: { md: 16.5, lg: 20 } }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let tree: ReactTestRenderer;
beforeEach(() => {
  mockDark = false;
  mockLongLabels = false;
});
afterEach(() => act(() => tree?.unmount()));
const ids = ["library", "tasks", "search"] as const;
const labels = ["Notes", "Tasks", "Search"];
const symbols = ["doc.text", "checkmark.circle", "magnifyingglass"];
const buttons = () => tree.root.findAllByType("NativePressable" as never);
const rowStyle = (index: number, pressed = false) =>
  buttons()[index].props.style({ pressed });

it.each(
  ids.flatMap((selection) => [false, true].map((dark) => ({ selection, dark })))
)(
  "renders controlled destinations with semantic appearance selection=$selection dark=$dark",
  ({ selection, dark }) => {
    mockDark = dark;
    const onSelect = jest.fn();
    act(() => {
      tree = create(
        <IPadPrimaryDestinations selection={selection} onSelect={onSelect} />
      );
    });
    expect(buttons()).toHaveLength(3);
    ids.forEach((id, index) => {
      const button = buttons()[index];
      expect(button.props.testID).toBe(`ipad-primary-${id}`);
      expect(button.props.accessible).toBe(true);
      expect(button.props.accessibilityRole).toBe("button");
      expect(button.props.accessibilityLabel).toBe(labels[index]);
      expect(button.props.accessibilityState).toEqual({
        selected: id === selection
      });
      const style = rowStyle(index);
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
      expect(style.minWidth).toBeGreaterThanOrEqual(44);
      expect(style.height).toBeUndefined();
      expect(style.maxHeight).toBeUndefined();
      expect(style.backgroundColor).toBe("transparent");
      expect(rowStyle(index, true).backgroundColor).toBe(
        mockColors().primary.hover
      );
      const symbol = button.findByType("NativeSymbol" as never);
      const text = button.findByType("Text" as never);
      const expected =
        id === selection
          ? mockColors().primary.accent
          : mockColors().primary.heading;
      expect(symbol.props.symbolName).toBe(symbols[index]);
      expect(symbol.props.symbolColor).toBe(expected);
      expect(symbol.props.accessible).toBe(false);
      expect(text.props.children).toBe(labels[index]);
      expect(text.props.style[0].color).toBe(expected);
      act(() => button.props.onPress());
      expect(onSelect.mock.calls[index]).toEqual([id]);
    });
    expect(onSelect).toHaveBeenCalledTimes(3);
    // Pressing delegates even the current destination; only the parent selects.
    expect(
      buttons().filter((button) => button.props.accessibilityState.selected)
    ).toHaveLength(1);
    expect(
      buttons()[ids.indexOf(selection)].props.accessibilityState.selected
    ).toBe(true);
    const next = selection === "search" ? "library" : "search";
    act(() => {
      mockDark = !dark;
      tree.update(
        <IPadPrimaryDestinations selection={next} onSelect={onSelect} />
      );
    });
    expect(buttons()[ids.indexOf(next)].props.accessibilityState.selected).toBe(
      true
    );
    expect(
      buttons()[ids.indexOf(next)].findByType("NativeSymbol" as never).props
        .symbolColor
    ).toBe(mockColors().primary.accent);
    expect(onSelect).toHaveBeenCalledTimes(3);
  }
);

it("keeps localized labels complete and flexible without shrinking or truncating text", () => {
  mockLongLabels = true;
  act(() => {
    tree = create(
      <IPadPrimaryDestinations selection="library" onSelect={jest.fn()} />
    );
  });
  buttons().forEach((button, index) => {
    const text = button.findByType("Text" as never);
    expect(button.props.accessibilityLabel).toBe(mockLabel(labels[index]));
    expect(text.props.children).toBe(mockLabel(labels[index]));
    expect(text.props.numberOfLines).toBeUndefined();
    expect(text.props.adjustsFontSizeToFit).not.toBe(true);
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(text.props.style[1]).toMatchObject({ flex: 1, flexShrink: 1 });
    expect(rowStyle(index).height).toBeUndefined();
  });
});
