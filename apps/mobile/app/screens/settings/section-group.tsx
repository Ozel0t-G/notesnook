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
import { View } from "react-native";
import Heading from "../../components/ui/typography/heading";
import { useThemeColors } from "@notesnook/theme";
import { AppFontSize } from "../../utils/size";
import { SectionItem } from "./section-item";
import { SettingSection } from "./types";
import { IosSettingsCard } from "./ios-appearance";
import { DefaultAppStyles } from "../../utils/styles";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
export const SectionGroup = ({ item }: { item: SettingSection }) => {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const current = item.useHook && item.useHook();
  const isHidden = item.hidden && item.hidden(current);
  if (isHidden) return null;
  if (visual.ios && item.sections)
    return (
      <IosSettingsCard header={item.name as string | undefined}>
        {item.sections.map((row, index) => (
          <SectionItem
            key={row.id}
            item={row}
            last={index === (item.sections?.length || 0) - 1}
          />
        ))}
      </IosSettingsCard>
    );
  return isHidden ? null : (
    <View
      style={{
        marginVertical: item.sections ? visual.sectionSpacing / 2 : 0
      }}
    >
      {item.name && item.sections ? (
        <Heading
          style={{
            paddingHorizontal: visual.ios
              ? visual.rowPadding
              : DefaultAppStyles.GAP,
            marginBottom: visual.ios ? 8 : 0
          }}
          color={visual.ios ? visual.secondaryText : colors.primary.accent}
          size={AppFontSize.xs}
        >
          {(item.name as string).toUpperCase()}
        </Heading>
      ) : null}

      <View
        style={
          visual.ios
            ? {
                backgroundColor: visual.contentSurface,
                borderRadius: visual.sectionRadius,
                overflow: "hidden"
              }
            : undefined
        }
      >
        {item.sections?.map((item) => (
          <SectionItem key={item.name as string} item={item} />
        ))}
      </View>
    </View>
  );
};
