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
import { SectionHeader } from "./section-header";
let mockPad = false,
  mockMac = false,
  mockDark = false;
let mockOS = "ios";
jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
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
    colors: { primary: { accent: "accent" }, secondary: { icon: "icon" } },
    isDark: mockDark
  })
}));
jest.mock("@notesnook/intl", () => ({
  strings: { pinned: () => "Pinned", results: (n: number) => `${n} results` }
}));
jest.mock("../../../hooks/use-is-compact-mode-enabled", () => ({
  useIsCompactModeEnabled: () => false
}));
jest.mock("../../../services/event-manager", () => ({
  presentSheet: jest.fn()
}));
jest.mock("../../../services/settings", () => ({
  __esModule: true,
  default: { set: jest.fn() }
}));
jest.mock("../../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    ios: mockOS === "ios",
    listInset: 16,
    rowInset: 18,
    sectionSpacing: 20,
    secondaryText: mockDark ? "dark-secondary" : "secondary",
    primaryText: "primary"
  })
}));
jest.mock("../../../utils/constants", () => ({ isMacCatalyst: () => mockMac }));
jest.mock("../../../utils/size", () => ({ AppFontSize: { md: 16.5, lg: 20 } }));
jest.mock("../../../utils/home-note-presentation", () => ({
  isHomeNoteRoute: () => false
}));
jest.mock("../../sheets/sort", () => ({
  __esModule: true,
  default: () => null
}));
jest.mock("../../ui/icon-button", () => ({ IconButton: "IconButton" }));
jest.mock("../../ui/pressable", () => ({ Pressable: "Pressable" }));
jest.mock("../../ui/typography/heading", () => ({
  __esModule: true,
  default: "Heading"
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
describe("real note day header presentation and jump action", () => {
  let tree: ReactTestRenderer;
  beforeEach(() => {
    mockPad = mockMac = mockDark = false;
    mockOS = "ios";
  });
  afterEach(() => act(() => tree?.unmount()));
  const jump = jest.fn();
  const render = (
    overrides: Partial<React.ComponentProps<typeof SectionHeader>> = {}
  ) =>
    act(() => {
      tree = create(
        <SectionHeader
          item={{
            type: "header",
            id: "day",
            title: "Gestern – gemischter Titel"
          }}
          index={0}
          dataType="note"
          screen="AllNotes"
          group="notes"
          groupOptions={{
            groupBy: "default",
            sortBy: "dateEdited",
            sortDirection: "desc"
          }}
          onOpenJumpToDialog={jump}
          {...overrides}
        />
      );
    });
  it.each([false, true])(
    "keeps phone headings quiet, reachable and localized in dark=%s",
    (dark) => {
      mockDark = dark;
      render();
      const press = tree.root.findByType("Pressable" as never);
      const title = tree.root.findByType("Heading" as never);
      expect(press.props).toMatchObject({
        accessibilityRole: "button",
        accessibilityLabel: "Gestern – gemischter Titel"
      });
      expect(press.props.style.minHeight).toBe(44);
      expect(press.parent!.props.style.paddingHorizontal).toBe(20);
      expect(title.props).toMatchObject({
        numberOfLines: 2,
        size: 16.5,
        color: dark ? "dark-secondary" : "secondary",
        children: "Gestern – gemischter Titel"
      });
      jump.mockClear();
      act(() => press.props.onPress());
      expect(jump).toHaveBeenCalledTimes(1);
      expect(tree.root.findAllByType("IconButton" as never)).toHaveLength(0);
    }
  );
  it("keeps ungrouped All suppressed while preserving Pinned", () => {
    render({
      item: { type: "header", id: "all", title: "All" },
      groupOptions: {
        groupBy: "none",
        sortBy: "dateEdited",
        sortDirection: "desc"
      }
    });
    expect(tree.toJSON()).toBeNull();
    act(() => tree.unmount());
    render({
      item: { type: "header", id: "pinned", title: "Pinned" },
      groupOptions: {
        groupBy: "none",
        sortBy: "dateEdited",
        sortDirection: "desc"
      }
    });
    expect(tree.root.findByType("Heading" as never).props.children).toBe(
      "Pinned"
    );
  });
  it("preserves the iPad note header geometry", () => {
    mockPad = true;
    render();
    const press = tree.root.findByType("Pressable" as never);
    expect(press.props.accessibilityRole).toBeUndefined();
    expect(press.props.accessibilityLabel).toBeUndefined();
    expect(press.props.style.minHeight).toBeUndefined();
    expect(press.parent!.props.style).toMatchObject({
      paddingHorizontal: 34,
      paddingTop: 16,
      marginBottom: 8
    });
    expect(tree.root.findByType("Heading" as never).props).toMatchObject({
      numberOfLines: 1,
      size: 17
    });
  });
  it.each([false, true])(
    "updates a retained empty-title header and its phone-only AX label when only screen changes (iPad=%s)",
    (pad) => {
      mockPad = pad;
      const props: React.ComponentProps<typeof SectionHeader> = {
        item: { type: "header", id: "empty", title: "" },
        index: 0,
        dataType: "note",
        screen: "AllNotes",
        group: "notes",
        itemCount: 5,
        groupOptions: {
          groupBy: "default",
          sortBy: "dateEdited",
          sortDirection: "desc"
        },
        onOpenJumpToDialog: jump
      };
      const assertHeader = (label: string) => {
        expect(tree.root.findByType("Heading" as never).props.children).toBe(
          label
        );
        const press = tree.root.findByType("Pressable" as never);
        expect(press.props.accessibilityRole).toBe(pad ? undefined : "button");
        expect(press.props.accessibilityLabel).toBe(pad ? undefined : label);
        expect(press.props.style.minHeight).toBe(pad ? undefined : 44);
        expect(
          tree.root.findByType("Heading" as never).props.numberOfLines
        ).toBe(pad ? 1 : 2);
      };
      act(() => {
        tree = create(<SectionHeader {...props} />);
      });
      assertHeader("Pinned");
      // Same tree/type/key and identical item/count/options/handler references;
      // screen is the only prop changed. This must cross the real memo boundary.
      act(() => {
        tree.update(<SectionHeader {...props} screen="Search" />);
      });
      assertHeader("5 results");
      act(() => {
        tree.update(<SectionHeader {...props} />);
      });
      assertHeader("Pinned");
    }
  );
  it.each(["Mac", "Android", "trash"])(
    "keeps %s on its existing non-phone header",
    (kind) => {
      mockMac = kind === "Mac";
      mockOS = kind === "Android" ? "android" : "ios";
      render({ dataType: kind === "trash" ? "trash" : "note" });
      expect(
        tree.root.findAllByProps({ accessibilityRole: "button" })
      ).toHaveLength(0);
      expect(tree.root.findAllByProps({ size: 16.5 })).toHaveLength(0);
    }
  );
});
