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
import { Text, View } from "react-native";
import { MacNoteRowContent } from "./mac-note-row-content";
import Heading from "./ui/typography/heading";
import Paragraph from "./ui/typography/paragraph";
import { AppFontSize } from "../utils/size";
import { DefaultAppStyles } from "../utils/styles";

const flattenStyle = jest.requireActual<{
  default: (style: unknown) => Record<string, unknown>;
}>("react-native/Libraries/StyleSheet/flattenStyle").default;

let mockDark = false;
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});
jest.mock("react-native", () => ({
  Text: "Text",
  View: "View",
  Platform: { OS: "ios" }
}));
jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: {
      primary: { heading: mockDark ? "light-heading" : "dark-heading" },
      secondary: { paragraph: mockDark ? "light-secondary" : "dark-secondary" },
      selected: { background: "selected" }
    },
    isDark: mockDark
  }),
  resolveAppleSurfaces: () => ({})
}));
jest.mock("../utils/mac-layout", () => ({
  activeAppleThemeIdentity: () => undefined
}));
jest.mock("../utils/size", () => ({
  AppFontSize: { xxxs: 11.5, xxs: 12.5, xs: 13.5, xl: 22 }
}));

describe.each([false, true])("MacNoteRowContent dark=%s", (dark) => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    mockDark = dark;
  });

  afterEach(() => {
    if (renderer) act(() => renderer.unmount());
  });

  function render(
    preview?: string,
    titleText = "Synthetic note",
    dateText = "Today 7:34 AM"
  ) {
    const title = (
      <Heading accessibilityRole="header" size={AppFontSize.xs}>
        {titleText}
      </Heading>
    );
    act(() => {
      renderer = create(
        <MacNoteRowContent
          title={title}
          dateText={dateText}
          preview={preview}
        />
      );
    });
    return { title, root: renderer.root };
  }

  it("keeps the title and complete date together, with a separate secondary preview", () => {
    const { title, root } = render("A separate first line");
    const content = root.findByType(MacNoteRowContent);
    expect(content.props.title).toBe(title);
    const views = root.findAllByType(View);
    const header = views[1];
    expect(header.findByType(Heading).props.children).toBe("Synthetic note");
    expect(header.findByType(Paragraph).props.children).toBe("Today 7:34 AM");
    const paragraphs = root.findAllByType(Paragraph);
    expect(paragraphs.map((node) => node.props.children)).toEqual([
      "Today 7:34 AM",
      "A separate first line"
    ]);
    expect(paragraphs[1].parent).toBe(views[0]);
    const secondary = dark ? "light-secondary" : "dark-secondary";
    for (const paragraph of paragraphs) {
      const text = paragraph.findByType(Text);
      const style = flattenStyle(text.props.style);
      expect(style.color).toBe(secondary);
      expect(style.fontFamily).toBeUndefined();
      expect(text.props.allowFontScaling).toBe(true);
    }
    expect(
      flattenStyle(paragraphs[0].findByType(Text).props.style).fontSize
    ).toBe(AppFontSize.xxxs);
    expect(
      flattenStyle(paragraphs[1].findByType(Text).props.style).fontSize
    ).toBe(AppFontSize.xxs);
    expect(
      root.findByType(Heading).findByType(Text).props.accessibilityRole
    ).toBe("header");
  });

  it.each([undefined, ""])(
    "omits an absent preview (%s) without removing title/date",
    (preview) => {
      const { root } = render(preview);
      expect(root.findAllByType(Paragraph)).toHaveLength(1);
      expect(root.findByType(Heading).props.children).toBe("Synthetic note");
      expect(root.findByType(Paragraph).props.children).toBe("Today 7:34 AM");
    }
  );

  it("allows long localized title/date to wrap within a flexible row", () => {
    const longTitle = "Ein sehr langer synthetischer Notiztitel 日本語 ".repeat(
      8
    );
    const longDate = "Gestern, Mittwoch, 14. Oktober 2026, 11:59 nachmittags";
    const longPreview = "Eine unabhängige Vorschau ".repeat(12);
    const { root } = render(longPreview, longTitle, longDate);
    const views = root.findAllByType(View);
    const outerStyle = flattenStyle(views[0].props.style);
    const headerStyle = flattenStyle(views[1].props.style);
    const titleStyle = flattenStyle(views[2].props.style);
    expect(outerStyle).toMatchObject({
      minWidth: 0,
      maxWidth: "100%",
      flexShrink: 1
    });
    expect(outerStyle.height).toBeUndefined();
    expect(outerStyle.overflow).toBeUndefined();
    expect(headerStyle).toMatchObject({
      flexDirection: "row",
      flexWrap: "wrap",
      columnGap: DefaultAppStyles.GAP_SMALL
    });
    expect(titleStyle).toMatchObject({
      minWidth: 0,
      maxWidth: "100%",
      flexGrow: 1,
      flexShrink: 1
    });
    const title = root.findByType(Heading).findByType(Text);
    expect(title.props.children).toBe(longTitle);
    expect(title.props.numberOfLines).toBeUndefined();
    const date = root.findAllByType(Paragraph)[0].findByType(Text);
    expect(date.props.children).toBe(longDate);
    expect(date.props.numberOfLines).toBeUndefined();
    expect(date.props.adjustsFontSizeToFit).toBeUndefined();
    expect(flattenStyle(date.props.style)).toMatchObject({
      maxWidth: "100%",
      flexShrink: 1,
      marginStart: "auto",
      textAlign: "right"
    });
    expect(root.findAllByType(Paragraph)[1].props.children).toBe(longPreview);
  });
});

it("updates semantic secondary text on appearance change without remounting the caller title", () => {
  let mounts = 0;
  let unmounts = 0;
  function StatefulTitle() {
    React.useEffect(() => {
      mounts++;
      return () => {
        unmounts++;
      };
    }, []);
    return <Heading>Synthetic persistent title</Heading>;
  }
  const title = <StatefulTitle />;
  let renderer: ReactTestRenderer | undefined;
  mockDark = false;
  act(() => {
    renderer = create(
      <MacNoteRowContent
        title={title}
        dateText="Yesterday 11:59 PM"
        preview="Preview"
      />
    );
  });
  if (!renderer) throw new Error("Expected the row to mount");
  const mounted = renderer;
  try {
    expect(
      flattenStyle(
        mounted.root.findAllByType(Paragraph)[0].findByType(Text).props.style
      ).color
    ).toBe("dark-secondary");
    mockDark = true;
    act(() => {
      mounted.update(
        <MacNoteRowContent
          title={title}
          dateText="Yesterday 11:59 PM"
          preview="Preview"
        />
      );
    });
    expect(
      flattenStyle(
        mounted.root.findAllByType(Paragraph)[0].findByType(Text).props.style
      ).color
    ).toBe("light-secondary");
    expect(mounted.root.findByType(Heading).props.children).toBe(
      "Synthetic persistent title"
    );
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  } finally {
    act(() => mounted.unmount());
  }
  expect(unmounts).toBe(1);
});
