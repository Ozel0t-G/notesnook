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
import { strings } from "@notesnook/intl";
import { IPadSourceSymbol, isIPadSourceList } from "./ipad-source-navigation";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import { Image, View } from "react-native";
import { useUserStore } from "../../stores/use-user-store";
import { AppFontSize } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { UserSheet } from "../sheets/user";
import AppIcon from "../ui/AppIcon";
import { IconButton, IconButtonProps } from "../ui/icon-button";
import { Pressable } from "../ui/pressable";
import Paragraph from "../ui/typography/paragraph";
import Heading from "../ui/typography/heading";
import { useSideBarDraggingStore } from "./dragging-store";
import SyncStatusButton from "./sync-status-button";

export const SideMenuSettings = ({
  labeled = false,
  compact = false
}: { labeled?: boolean; compact?: boolean } = {}) => {
  const { colors } = useThemeColors();
  const userProfile = useUserStore((state) => state.profile);

  return (
    <Pressable
      onPress={() => {
        if (useSideBarDraggingStore.getState().dragging) return;
        UserSheet.present();
      }}
      testID="sidemenu-settings-icon"
      {...(isIPadSourceList()
        ? {
            accessibilityRole: "button" as const,
            accessibilityLabel: strings.settings()
          }
        : {})}
      style={{
        width: labeled
          ? compact
            ? "auto"
            : "100%"
          : isIPadSourceList()
          ? 44
          : 40,
        flex: labeled && compact ? 1 : undefined,
        minWidth: labeled && compact ? 44 : undefined,
        flexDirection: labeled ? "row" : undefined,
        gap: labeled ? DefaultAppStyles.GAP_SMALL : undefined,
        justifyContent: labeled ? "flex-start" : "center",
        paddingHorizontal: labeled
          ? compact
            ? 0
            : DefaultAppStyles.GAP
          : undefined,
        height: labeled ? undefined : isIPadSourceList() ? 44 : 40,
        minHeight: labeled ? 44 : undefined
      }}
    >
      {userProfile?.profilePicture ? (
        <Image
          source={{
            uri: userProfile?.profilePicture
          }}
          style={{
            width: 25,
            height: 25,
            borderRadius: 100
          }}
        />
      ) : isIPadSourceList() ? (
        <IPadSourceSymbol
          name="gearshape"
          color={colors.primary.icon}
          size={AppFontSize.lg}
        />
      ) : (
        <AppIcon
          name="cog-outline"
          color={colors.primary.icon}
          size={AppFontSize.lg}
        />
      )}
      {labeled ? (
        <Paragraph style={compact ? { flexShrink: 1 } : undefined}>
          {strings.settings()}
        </Paragraph>
      ) : null}
    </Pressable>
  );
};

export const SideMenuHeader = (props: {
  rightButtons?: IconButtonProps[];
  compact?: boolean;
}) => {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        borderBottomWidth: visual.ios ? 0 : 1,
        borderBottomColor: visual.separator,
        paddingBottom: props.compact
          ? DefaultAppStyles.GAP_VERTICAL_SMALL
          : visual.ios
          ? 16
          : DefaultAppStyles.GAP,
        minHeight: props.compact ? 44 : undefined,
        paddingHorizontal: visual.ios
          ? visual.pagePadding
          : DefaultAppStyles.GAP
      }}
    >
      <View
        style={{
          flexDirection: "row",
          gap: DefaultAppStyles.GAP_SMALL,
          alignItems: "center"
        }}
      >
        <Image
          source={require("../../assets/images/veyran-icon.png")}
          style={{ width: 28, height: 28 }}
        />
        <Heading size={AppFontSize.lg}>VeyraN</Heading>
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: DefaultAppStyles.GAP_SMALL
        }}
      >
        {props.rightButtons?.map((button, index) => (
          <IconButton
            key={index}
            {...button}
            style={{
              width: 28,
              height: 28
            }}
            color={colors.primary.icon}
            size={AppFontSize.lg}
          />
        ))}
        <SyncStatusButton />
        {props.compact ? null : <SideMenuSettings />}
      </View>
    </View>
  );
};
