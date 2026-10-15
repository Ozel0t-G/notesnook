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
import type { Note } from "@notesnook/core";
import { getFormattedDate } from "@notesnook/common";
import { formatMacNoteDate } from "../../../utils/mac-note-date";
import NoteItem from "./index";
import { MacNoteRowContent } from "../../mac-note-row-content";
import Paragraph from "../../ui/typography/paragraph";

const flattenStyle = jest.requireActual<{
  default: (style: unknown) => Record<string, unknown>;
}>("react-native/Libraries/StyleSheet/flattenStyle").default;

let mockCompact = false;
let mockMac = false;
let mockIos = true;
let mockPad = false;
let mockDark = false;
let mockSelection: string | undefined;
let mockEditing = false;
jest.mock("react-native", () => ({
  I18nManager: { isRTL: false },
  View: "View",
  Text: "Text",
  Platform: {
    get OS() {
      return mockIos ? "ios" : "android";
    },
    get isPad() {
      return mockPad;
    }
  }
}));
jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: {
      primary: { icon: mockDark ? "dark-icon" : "icon" },
      secondary: {},
      selected: { icon: mockDark ? "dark-selected-icon" : "selected-icon" },
      static: {},
      error: {}
    },
    isDark: mockDark
  })
}));
jest.mock("@notesnook/common", () => ({ getFormattedDate: jest.fn(() => "12:00") }));
jest.mock("@notesnook/intl", () => ({
  strings: { untitledNote: () => "Untitled", note: () => "Note" }
}));
jest.mock("../../../hooks/use-is-compact-mode-enabled", () => ({
  useIsCompactModeEnabled: () => mockCompact
}));
jest.mock("../../../utils/size", () => ({
  AppFontSize: { xxxs: 11.5, xxs: 12.5, xs: 13.5, sm: 14.5, md: 16.5, lg: 20 }
}));
jest.mock("../../../utils/constants", () => ({ isMacCatalyst: () => mockMac }));
jest.mock("../../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    ios: mockIos,
    secondaryText: mockDark ? "dark-secondary" : "secondary"
  })
}));
jest.mock("../../../utils/mac-note-date", () => ({
  formatMacNoteDate: jest.fn(() => "Today")
}));
jest.mock("../../../utils/ios-system-colors", () => ({
  systemColor: () => "orange"
}));
jest.mock("../../../screens/editor/tiptap/use-tab-store", () => ({
  useTabStore: (select: (state: unknown) => unknown) =>
    select({
      currentTab: "tab",
      tabs: mockEditing
        ? [{ id: "tab", session: { noteId: "synthetic-row" } }]
        : []
    })
}));
jest.mock("../../../stores/use-selection-store", () => ({
  useSelectionStore: (select: (state: unknown) => unknown) =>
    select({ selectionMode: mockSelection })
}));
jest.mock("../../../hooks/use-selected", () => ({
  __esModule: true,
  default: () => [false]
}));
jest.mock("../../../stores/use-relation-store", () => ({
  useRelationStore: (select: (state: unknown) => unknown) =>
    select({ updater: 0 })
}));
jest.mock("../../../stores/use-navigation-store", () => ({
  __esModule: true,
  default: jest.fn()
}));
jest.mock("../../../common/database", () => ({ db: {} }));
jest.mock("../../properties", () => ({ Properties: { present: jest.fn() } }));
jest.mock("react-native-vector-icons/MaterialCommunityIcons", () => "Icon");
jest.mock("../../ui/AppIcon", () => "AppIcon");
jest.mock("../../ui/icon-button", () => ({ IconButton: "IconButton" }));
jest.mock("../../ui/typography/heading", () => "Heading");
jest.mock("../../ui/time-since", () => ({ TimeSince: "TimeSince" }));
jest.mock("../../ui/expiry-date", () => ({ ExpiryDate: "ExpiryDate" }));
jest.mock("../../task-symbol-view", () => ({
  TaskSymbolView: "TaskSymbolView"
}));
jest.mock("./note-thumbnail", () => ({ NoteThumbnail: "NoteThumbnail" }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const item = {
  id: "synthetic-row",
  type: "note",
  title: "A long synthetic title that needs a second line",
  headline: "One preview line",
  dateEdited: 1000,
  readonly: true
} as Note;

describe("actual note row title reachability", () => {
  let tree: ReactTestRenderer;
  beforeEach(() => {
    mockCompact = false;
    mockMac = false;
    mockIos = true;
    mockPad = false;
    mockDark = false;
    mockSelection = undefined;
    mockEditing = false;
    jest.mocked(getFormattedDate).mockReset().mockReturnValue("12:00");
    jest.mocked(formatMacNoteDate).mockReset().mockReturnValue("Today");
  });
  afterEach(() => {
    act(() => tree?.unmount());
    jest.useRealTimers();
  });
  const render = (
    overrides: Partial<React.ComponentProps<typeof NoteItem>> = {}
  ) => {
    act(() => {
      tree = create(
        <NoteItem
          item={item}
          index={0}
          attachmentsCount={2}
          date={1000}
          renderedInRoute="AllNotes"
          {...overrides}
        />
      );
    });
  };
  it("keeps two-line normal Apple titles, one preview and read-only/attachment metadata", () => {
    render();
    expect(tree.root.findByType("Heading" as never).props.numberOfLines).toBe(
      2
    );
    expect(JSON.stringify(tree.toJSON())).toContain(item.title);
    expect(JSON.stringify(tree.toJSON())).toContain("One preview line");
    expect(tree.root.findByProps({ testID: "pencil-lock" }).props.name).toBe(
      "pencil-lock"
    );
    expect(tree.root.findAllByProps({ name: "paperclip" })).toHaveLength(1);
    expect(JSON.stringify(tree.toJSON())).toContain("12:00");
  });
  it.each([false, true])(
    "uses semantic phone metadata and native text in dark=%s",
    (dark) => {
      mockDark = dark;
      render();
      const heading = tree.root.findByType("Heading" as never);
      expect(heading.props.style.paddingRight).toBe(0);
      const preview = tree.root
        .findAllByType(Paragraph)
        .find((n) => n.props.children === item.headline)!;
      expect(preview.props.style.color).toBe(
        dark ? "dark-secondary" : "secondary"
      );
      const assertSystemFont = (paragraph: typeof preview) => {
        const nativeText = paragraph.findByType("Text" as never);
        expect(nativeText.props.style[0].fontFamily).toBe("Inter-Regular");
        expect(
          Object.prototype.hasOwnProperty.call(
            paragraph.props.style,
            "fontFamily"
          )
        ).toBe(true);
        const merged = flattenStyle(nativeText.props.style);
        expect(Object.prototype.hasOwnProperty.call(merged, "fontFamily")).toBe(
          true
        );
        expect(merged.fontFamily).toBeUndefined();
      };
      assertSystemFont(preview);
      const clip = tree.root.findByProps({ name: "paperclip" });
      expect(clip.props.color).toBe(dark ? "dark-icon" : "icon");
      const date = tree.root
        .findAllByType(Paragraph)
        .find((n) => n.props.children === "12:00")!;
      expect(date.props.style.fontSize).toBe(12.5);
      assertSystemFont(date);
      const attachmentCount = tree.root
        .findAllByType(Paragraph)
        .find((n) => n.props.children === 2)!;
      assertSystemFont(attachmentCount);
      expect(heading.parent!.props.style.paddingRight).toBe(8);
      expect(tree.root.findAllByType("IconButton" as never)).toHaveLength(0);
    }
  );
  it("keeps iPad geometry and metadata untouched", () => {
    mockPad = true;
    render();
    expect(tree.root.findByType("Heading" as never).props.numberOfLines).toBe(2);
    expect(
      tree.root.findByType("Heading" as never).props.style.paddingRight
    ).toBe(10);
    expect(tree.root.findAllByProps({ name: "attachment" })).toHaveLength(1);
    const date = tree.root
      .findAllByType(Paragraph)
      .find((n) => n.props.children === "12:00")!;
    expect(date.props.style.fontSize).toBe(11.5);
    expect(
      flattenStyle(date.findByType("Text" as never).props.style).fontFamily
    ).toBe("Inter-Regular");
    expect(
      tree.root.findByType("Heading" as never).parent!.props.style.paddingRight
    ).toBeUndefined();
  });
  it.each(["checkbox", "thumbnail"])(
    "keeps an 8pt phone text gutter beside the %s",
    (kind) => {
      mockSelection = kind === "checkbox" ? "note" : undefined;
      const thumbnail = { id: "synthetic-image", hash: "synthetic-hash", mimeType: "image/png" };
      render({ thumbnail: kind === "thumbnail" ? thumbnail : undefined });
      const heading = tree.root.findByType("Heading" as never);
      expect(heading.parent!.props.style.paddingRight).toBe(8);
      const preview = tree.root
        .findAllByType(Paragraph)
        .find((n) => n.props.children === item.headline)!;
      expect(preview.parent).toBe(heading.parent);
      expect(
        tree.root.findAllByType(
          (kind === "checkbox" ? "AppIcon" : "NoteThumbnail") as never
        )
      ).toHaveLength(1);
      if (kind === "thumbnail") {
        expect(tree.root.findByType("NoteThumbnail" as never).props).toMatchObject({ thumbnail, enabled: true });
      }
    }
  );
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])(
    "keeps paperclip on the existing readonly icon role (dark=%s, editing=%s)",
    (dark, editing) => {
      mockDark = dark;
      mockEditing = editing;
      mockSelection = "note";
      render();
      const clip = tree.root.findByProps({ name: "paperclip" });
      expect(clip.props.color).toBe(
        tree.root.findByProps({ testID: "pencil-lock" }).props.color
      );
      expect(clip.props.color).toBe(
        editing
          ? dark
            ? "dark-selected-icon"
            : "selected-icon"
          : dark
          ? "dark-icon"
          : "icon"
      );
    }
  );
  it("preserves status indicators and replaces thumbnails with the selection affordance", () => {
    mockSelection = "note";
    render({
      item: {
        ...item,
        localOnly: true,
        pinned: true,
        favorite: true,
        conflicted: true
      },
      locked: true
    });
    for (const testID of [
      "sync-off",
      "icon-pinned",
      "icon-star",
      "pencil-lock",
      "note-locked-icon"
    ]) {
      expect(tree.root.findAllByProps({ testID })).toHaveLength(1);
    }
    expect(tree.root.findAllByType("NoteThumbnail" as never)).toHaveLength(0);
    expect(tree.root.findAllByType("AppIcon" as never)).toHaveLength(1);
  });
  // Local constructors deliberately follow the runtime's existing calendar;
  // no test timezone override or production timezone policy is introduced.
  const fixedClock = () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 9, 15, 10, 30));
    jest
      .mocked(getFormattedDate)
      .mockImplementation((_date, format) =>
        format === "time" ? "LOCALIZED_TIME" : "LOCALIZED_DATE"
      );
  };
  it.each([
    ["today early", 15, 0, 5, "time"],
    ["today late", 15, 23, 55, "time"],
    ["yesterday early", 14, 0, 5, "time"],
    ["yesterday late", 14, 23, 55, "time"],
    ["older", 13, 23, 55, "date"],
    ["future keeps the legacy time", 16, 0, 5, "time"]
  ] as const)(
    "renders %s through the existing localized formatter in the normal Phone row",
    (_label, day, hour, minute, format) => {
      fixedClock();
      const date = new Date(2026, 9, day, hour, minute).getTime();
      const note = Object.freeze({ ...item, dateEdited: date });
      render({ date, item: note });
      expect(getFormattedDate).toHaveBeenCalledTimes(1);
      expect(getFormattedDate).toHaveBeenCalledWith(date, format);
      const text = format === "time" ? "LOCALIZED_TIME" : "LOCALIZED_DATE";
      const metadata = tree.root
        .findAllByType(Paragraph)
        .find((node) => node.props.children === text);
      expect(metadata).toBeDefined();
      expect(metadata!.findByType("Text" as never).props.children).toBe(text);
      expect(note.dateEdited).toBe(date);
    }
  );
  it.each(["compact", "iPad", "Mac", "Android", "sheet", "trash"])(
    "keeps the existing %s date presentation for yesterday early",
    (kind) => {
      fixedClock();
      mockCompact = kind === "compact";
      mockPad = kind === "iPad";
      mockMac = kind === "Mac";
      mockIos = kind !== "Android";
      const date = new Date(2026, 9, 14, 0, 5).getTime();
      render({ date, isSheet: kind === "sheet", isTrash: kind === "trash" });
      if (kind === "compact") {
        expect(getFormattedDate).not.toHaveBeenCalled();
        expect(tree.root.findByType("TimeSince" as never).props.time).toBe(date);
      } else if (kind === "Mac") {
        expect(getFormattedDate).not.toHaveBeenCalled();
        expect(formatMacNoteDate).toHaveBeenCalledWith(date);
        const content = tree.root.findByType(MacNoteRowContent);
        expect(content.props.dateText).toBe("Today");
        expect(content.props.preview).toBe(item.headline);
        const macDate = content.findAllByType(Paragraph).find((node) => node.props.children === "Today")!;
        expect(macDate.findByType("Text" as never).props.children).toBe("Today");
      } else {
        expect(getFormattedDate).toHaveBeenCalledTimes(1);
        expect(getFormattedDate).toHaveBeenCalledWith(date, "date");
        expect(JSON.stringify(tree.toJSON())).toContain("LOCALIZED_DATE");
      }
    }
  );
  it.each(["iPad", "Android"])(
    "keeps the existing late-yesterday time fallback on %s",
    (kind) => {
      fixedClock();
      mockPad = kind === "iPad";
      mockIos = kind !== "Android";
      const date = new Date(2026, 9, 14, 23, 55).getTime();
      render({ date });
      expect(getFormattedDate).toHaveBeenCalledTimes(1);
      expect(getFormattedDate).toHaveBeenCalledWith(date, "time");
      expect(JSON.stringify(tree.toJSON())).toContain("LOCALIZED_TIME");
    }
  );
  it.each([false, true])("renders Mac title/date and separate preview without losing row actions in dark=%s", (dark) => {
    mockMac = true;
    mockDark = dark;
    mockSelection = "note";
    render({ item: { ...item, pinned: true, conflicted: true }, locked: true });
    const content = tree.root.findByType(MacNoteRowContent);
    expect(content.findByType("Heading" as never).props.children).toBe(item.title);
    expect(content.findByType("Heading" as never).props.numberOfLines).toBe(2);
    expect(content.findByType("Heading" as never).parent!.props.style.paddingRight).toBeUndefined();
    expect(content.props.dateText).toBe("Today");
    expect(content.props.preview).toBe(item.headline);
    expect(content.findAllByType(Paragraph).map((n) => n.props.children)).toEqual(["Today", item.headline]);
    const wholeRow = JSON.stringify(tree.toJSON());
    expect(wholeRow.split("Today")).toHaveLength(2);
    if (!item.headline) throw new Error("Expected populated note preview fixture");
    expect(wholeRow.split(item.headline)).toHaveLength(2);
    expect(wholeRow).not.toContain(" · ");
    expect(content.findAllByType(Paragraph)[0].props.color).toBe(dark ? "dark-secondary" : "secondary");
    expect(tree.root.findAllByProps({ testID: "icon-pinned" })).toHaveLength(1);
    expect(tree.root.findAllByProps({ testID: "pencil-lock" })).toHaveLength(1);
    expect(tree.root.findAllByProps({ testID: "note-locked-icon" })).toHaveLength(1);
    // Mac selection uses the existing row highlight, never a touch checkbox.
    expect(tree.root.findAllByType("AppIcon" as never)).toHaveLength(0);
    expect(tree.root.findAllByType("NoteThumbnail" as never)).toHaveLength(0);
  });
  it.each(["compact", "trash", "sheet", "iPad", "iPhone", "Android"])("does not mount Mac content for %s", (kind) => {
    mockMac = ["compact", "trash", "sheet"].includes(kind);
    mockCompact = kind === "compact";
    mockPad = kind === "iPad";
    mockIos = kind !== "Android";
    render({ isTrash: kind === "trash", isSheet: kind === "sheet" });
    expect(tree.root.findAllByType(MacNoteRowContent)).toHaveLength(0);
  });
  it.each([false, true])("retains compact single-line titles with Mac=%s", (mac) => {
    mockMac = mac;
    mockCompact = true;
    render();
    expect(tree.root.findAllByType("Heading" as never)).toHaveLength(0);
    expect(tree.root.findAllByType(MacNoteRowContent)).toHaveLength(0);
    const title = tree.root
      .findAllByType(Paragraph)
      .find((node) => node.props.children === item.title);
    expect(title?.props.numberOfLines).toBe(1);
    expect(title?.parent!.props.style.paddingRight).toBeUndefined();
  });
  it.each(["Android", "sheet", "trash"])(
    "does not change the existing %s title limit",
    (kind) => {
      mockIos = kind !== "Android";
      render({ isSheet: kind === "sheet", isTrash: kind === "trash" });
      const heading = tree.root.findByType("Heading" as never);
      expect(heading.props.numberOfLines).toBe(1);
      expect(heading.parent!.props.style.paddingRight).toBeUndefined();
    }
  );
});
