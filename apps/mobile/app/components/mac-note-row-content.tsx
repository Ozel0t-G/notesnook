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
import { I18nManager, View } from "react-native";
import { isMacCatalyst } from "../utils/constants";
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

/** Normal Mac rows in a width-constrained list; caller owns actions/accessories.
 * The outer View fills its parent text column. Ordinary dates trail the title.
 * Long localized dates wrap in full below it rather than crush the title or
 * silently truncate the existing formatter. This is the narrow-column fallback.
 */
export function MacNoteRowContent({
  title,
  dateText,
  preview
}: MacNoteRowContentProps) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const systemFont = isMacCatalyst() ? { fontFamily: undefined } : {};

  return (
    <View
      style={{ width: "100%", minWidth: 0, maxWidth: "100%", flexShrink: 1 }}
    >
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
            textAlign: I18nManager.isRTL ? "left" : "right",
            ...systemFont
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
            ...systemFont
          }}
        >
          {preview}
        </Paragraph>
      ) : null}
    </View>
  );
}
