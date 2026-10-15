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

import { useThemeColors } from "@notesnook/theme";
import React from "react";
import { View } from "react-native";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { AppFontSize } from "../utils/size";
import { DefaultAppStyles } from "../utils/styles";
import Paragraph from "./ui/typography/paragraph";

export type MacNoteRowContentProps = {
  /** Caller-owned Heading, including its color and wrapping policy. */
  title: React.ReactNode;
  /** Already formatted by the existing Mac date formatter. */
  dateText: string;
  preview?: string;
};

/** Presentation for normal Mac rows; the caller owns actions and accessories. */
export function MacNoteRowContent({
  title,
  dateText,
  preview
}: MacNoteRowContentProps) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);

  return (
    <View style={{ minWidth: 0, maxWidth: "100%", flexShrink: 1 }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "flex-start",
          columnGap: DefaultAppStyles.GAP_SMALL,
          rowGap: DefaultAppStyles.GAP_VERTICAL_SMALL / 2
        }}
      >
        <View
          style={{
            minWidth: 0,
            maxWidth: "100%",
            flexBasis: "50%",
            flexGrow: 1,
            flexShrink: 1
          }}
        >
          {title}
        </View>
        <Paragraph
          allowFontScaling={true}
          size={AppFontSize.xxxs}
          color={visual.secondaryText}
          style={{
            maxWidth: "100%",
            flexShrink: 1,
            marginStart: "auto",
            textAlign: "right",
            fontFamily: undefined
          }}
        >
          {dateText}
        </Paragraph>
      </View>
      {preview ? (
        <Paragraph
          allowFontScaling={true}
          numberOfLines={1}
          ellipsizeMode="tail"
          size={AppFontSize.xxs}
          color={visual.secondaryText}
          style={{
            marginTop: DefaultAppStyles.GAP_VERTICAL_SMALL / 2,
            fontFamily: undefined
          }}
        >
          {preview}
        </Paragraph>
      ) : null}
    </View>
  );
}
