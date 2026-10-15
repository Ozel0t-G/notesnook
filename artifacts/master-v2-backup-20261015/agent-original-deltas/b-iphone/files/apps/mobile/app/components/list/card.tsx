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
import { Dimensions, Platform, View } from "react-native";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";
import { Message, useMessageStore } from "../../stores/use-message-store";
import { isMacCatalyst } from "../../utils/constants";
import { AppFontSize } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import { TaskSymbolView } from "../task-symbol-view";
import { Pressable } from "../ui/pressable";
import Paragraph from "../ui/typography/paragraph";

const phoneMessageSymbols = new Map([
  ["account-outline", "person.crop.circle"],
  ["key", "key"],
  ["email", "envelope"]
]);

export const Card = ({
  color,
  customMessage
}: {
  color?: string;
  customMessage?: Omit<Message, "data">;
}) => {
  const { colors } = useThemeColors();
  color = color ? color : colors.primary.accent;
  const messageBoardState = useMessageStore(
    (state) => customMessage || state.message
  );
  const announcements = useMessageStore((state) => state.announcements);
  const fontScale = Dimensions.get("window").fontScale;
  const phone = Platform.OS === "ios" && !Platform.isPad && !isMacCatalyst();
  const phoneSymbol = phone
    ? phoneMessageSymbols.get(messageBoardState.icon)
    : undefined;
  const iconColor =
    messageBoardState.type === "error" ? colors.error.icon : color;

  return !messageBoardState.visible ||
    (announcements && announcements.length) ? null : (
    <View
      style={{
        width: "100%",
        paddingHorizontal: DefaultAppStyles.GAP,
        paddingVertical: phone
          ? DefaultAppStyles.GAP_SMALL / 2
          : DefaultAppStyles.GAP_VERTICAL
      }}
    >
      <Pressable
        onPress={messageBoardState.onPress}
        {...(phone ? { accessibilityRole: "button" as const } : {})}
        type="plain"
        style={{
          paddingVertical: phone
            ? DefaultAppStyles.GAP_VERTICAL_SMALL
            : DefaultAppStyles.GAP_VERTICAL,
          ...(phone ? { minHeight: 44 } : {}),
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%"
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            width: "100%"
          }}
        >
          <View
            style={{
              width: (phone ? DefaultAppStyles.GAP * 2 : 40) * fontScale,
              height: (phone ? DefaultAppStyles.GAP * 2 : 40) * fontScale,
              ...(phone ? { flexShrink: 0 } : {}),
              borderRadius: 100,
              alignItems: "center",
              justifyContent: "center"
            }}
          >
            {phoneSymbol ? (
              <TaskSymbolView
                name={phoneSymbol}
                size={AppFontSize.xl * fontScale}
                color={iconColor}
              />
            ) : (
              <Icon
                size={AppFontSize.xxxl}
                color={iconColor}
                allowFontScaling
                name={messageBoardState.icon}
              />
            )}
          </View>

          <View
            style={{
              marginLeft: phone ? DefaultAppStyles.GAP_SMALL : 10,
              marginRight: phone ? DefaultAppStyles.GAP_SMALL : 10,
              ...(phone ? { flex: 1, minWidth: 0 } : {})
            }}
          >
            <Paragraph
              style={{
                flexWrap: phone ? "wrap" : "nowrap",
                flexShrink: 1,
                ...(phone ? { fontFamily: undefined } : {})
              }}
              size={AppFontSize.sm}
              color={colors.primary.heading}
            >
              {messageBoardState.actionText}
            </Paragraph>
            <Paragraph
              color={colors.secondary.paragraph}
              size={AppFontSize.xs}
              style={phone ? { fontFamily: undefined } : undefined}
            >
              {messageBoardState.message}
            </Paragraph>
          </View>
        </View>
      </Pressable>
    </View>
  );
};
