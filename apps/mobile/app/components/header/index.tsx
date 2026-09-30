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
import { useThemeColors } from "@notesnook/theme";
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";
import {
  eSubscribeEvent,
  eUnSubscribeEvent
} from "../../services/event-manager";
import { RouteName } from "../../stores/use-navigation-store";
import { useSelectionStore } from "../../stores/use-selection-store";
import { eScrollEvent } from "../../utils/events";
import { AppFontSize } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { hexToRGBA } from "../../utils/colors";
import { IconButtonProps } from "../ui/icon-button";
import { Pressable } from "../ui/pressable";
import Heading from "../ui/typography/heading";
import Paragraph from "../ui/typography/paragraph";
import { LeftMenus } from "./left-menus";
import { RightMenus } from "./right-menus";
import {
  IosBarButton,
  IosLargeTitle,
  IosMoreMenu,
  IosNavBar,
  IosSearchField
} from "../ios-nav-bar";
import { ListViewMenuConfig, useListViewMenu } from "../list-view-menu";
import { isMacCatalyst } from "../../utils/constants";
import Navigation from "../../services/navigation";

/** SF Symbols for the Material icon names screens pass as `rightButton`. */
const IOS_RIGHT_BUTTON_SYMBOLS: Record<string, string> = {
  "dots-vertical": "ellipsis.circle",
  "dots-horizontal": "ellipsis.circle",
  plus: "plus",
  delete: "trash",
  restore: "arrow.counterclockwise",
  magnify: "magnifyingglass",
  cog: "gearshape"
};

export const Header = ({
  renderedInRoute,
  onLeftMenuButtonPress,
  title,
  id,
  canGoBack,
  hasSearch,
  onSearch,
  rightButton,
  backTitle,
  menu,
  onCompose
}: {
  onLeftMenuButtonPress?: () => void;
  renderedInRoute?: RouteName;
  id?: string;
  title?: string;
  canGoBack?: boolean;
  onPressDefaultRightButton?: () => void;
  hasSearch?: boolean;
  onSearch?: () => void;
  rightButton?: IconButtonProps;
  /** iOS: the previous screen's title shown next to the back chevron. */
  backTitle?: string;
  /** iOS: the list's "…" menu (Select, view, sort, group). */
  menu?: ListViewMenuConfig;
  /** iOS: shows the compose button (square.and.pencil) like in Notes. */
  onCompose?: () => void;
}) => {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const [borderHidden, setBorderHidden] = useState(true);
  const [selectedItemsList, selectionMode] = useSelectionStore((state) => [
    state.selectedItemsList,
    state.selectionMode
  ]);

  const onScroll = useCallback(
    (data: { x: number; y: number; id?: string; route: string }) => {
      if (data.route !== renderedInRoute || data.id !== id) return;
      if (data.y > 150) {
        if (!borderHidden) return;
        setBorderHidden(false);
      } else {
        if (borderHidden) return;
        setBorderHidden(true);
      }
    },
    [borderHidden, id, renderedInRoute]
  );

  useEffect(() => {
    eSubscribeEvent(eScrollEvent, onScroll);
    return () => {
      eUnSubscribeEvent(eScrollEvent, onScroll);
    };
  }, [borderHidden, onScroll]);

  const HeaderWrapper = hasSearch ? Pressable : View;
  const listMenu = useListViewMenu(menu);
  const clearSelection = useSelectionStore((state) => state.clearSelection);

  if (visual.ios) {
    const back = () => {
      if (onLeftMenuButtonPress) return onLeftMenuButtonPress();
      Navigation.goBack();
    };
    const iosRight = rightButton
      ? IOS_RIGHT_BUTTON_SYMBOLS[rightButton.name as string]
      : undefined;
    /**
     * Mac's sidebars have no large title: the list's name sits inline in the
     * bar row instead, right under the window's native toolbar.
     */
    const isMac = isMacCatalyst();
    return (
      <View
        style={{
          // Mac's list column is the content surface; the iPhone/iPad bar
          // matches the grouped background of the list behind it.
          backgroundColor: isMac
            ? visual.contentSurface
            : visual.screenBackground
        }}
      >
        <IosNavBar
          backTitle={
            isMac || selectionMode
              ? undefined
              : backTitle || strings.routes.Library()
          }
          // Mac's note list is the middle column's top screen (the sidebar owns
          // list switching), so its bar never shows a "‹ Library" back button.
          onBack={
            selectionMode || isMac ? undefined : canGoBack ? back : undefined
          }
          title={
            selectionMode
              ? strings.selectedCode(selectedItemsList.length)
              : isMac
              ? title
              : undefined
          }
          trailing={
            selectionMode ? (
              <IosBarButton
                label={strings.done()}
                bold
                onPress={() => clearSelection()}
              />
            ) : (
              <>
                {rightButton ? (
                  <IosBarButton
                    symbol={iosRight}
                    label={iosRight ? undefined : strings.done()}
                    accessibilityLabel={rightButton.accessibilityLabel}
                    testID={rightButton.testID}
                    onPress={() =>
                      (rightButton.onPress as (() => void) | undefined)?.()
                    }
                  />
                ) : null}
                {listMenu ? (
                  <IosMoreMenu
                    items={listMenu.items}
                    onSelect={listMenu.onSelect}
                    accessibilityLabel={strings.more()}
                    testID="header-more-menu"
                  />
                ) : null}
                {/* Mac's own New Note is the window toolbar's button (and
                    Cmd-N), so the list bar shows no compose button there. */}
                {onCompose && !isMac ? (
                  <IosBarButton
                    symbol="square.and.pencil"
                    accessibilityLabel={strings.newNoteTab()}
                    testID="header-compose"
                    onPress={onCompose}
                  />
                ) : null}
              </>
            )
          }
        />
        {selectionMode ? null : (
          <>
            {title && !isMac ? (
              <IosLargeTitle title={title} testID="header-large-title" />
            ) : null}
            {hasSearch ? (
              <IosSearchField
                testID="search-header"
                placeholder={strings.search()}
                onPress={() => onSearch?.()}
              />
            ) : null}
          </>
        )}
      </View>
    );
  }

  return (
    <View
      style={{
        paddingHorizontal: visual.ios
          ? visual.pagePadding
          : DefaultAppStyles.GAP,
        paddingVertical: visual.ios ? 12 : DefaultAppStyles.GAP_VERTICAL_SMALL,
        backgroundColor: hexToRGBA(
          visual.navigationSurface,
          visual.navigationMaterialOpacity
        ),
        borderBottomWidth: visual.ios ? 0.5 : borderHidden ? 0 : 0.5,
        borderBottomColor: visual.separator,
        ...(visual.ios ? {} : visual.subtleShadow)
      }}
    >
      {visual.ios ? (
        <>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              minHeight: 48
            }}
          >
            <LeftMenus
              canGoBack={canGoBack}
              onLeftButtonPress={onLeftMenuButtonPress}
            />
            <Heading
              numberOfLines={1}
              size={AppFontSize.xl}
              style={{ flex: 1, marginHorizontal: 12 }}
            >
              {selectionMode ? `${selectedItemsList.length} selected` : title}
            </Heading>
            <RightMenus rightButton={rightButton} />
          </View>
          {hasSearch ? (
            <Pressable
              testID="search-header"
              onPress={() => onSearch?.()}
              style={{
                flexDirection: "row",
                alignItems: "center",
                minHeight: 42,
                marginTop: 10,
                marginBottom: 4,
                paddingHorizontal: 14,
                gap: 8,
                borderRadius: visual.controlRadius,
                backgroundColor: visual.secondarySurface
              }}
            >
              <Icon
                name="magnify"
                size={AppFontSize.md}
                color={visual.tertiaryText}
              />
              <Paragraph color={visual.secondaryText}>
                {strings.searchInRoute(title || "")}
              </Paragraph>
            </Pressable>
          ) : null}
        </>
      ) : (
        <HeaderWrapper
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            borderRadius: visual.buttonRadius,
            paddingVertical: 5,
            borderWidth: hasSearch ? 0.5 : 0,
            borderColor: visual.separator,
            backgroundColor: hasSearch
              ? hexToRGBA(visual.surface, visual.materialOpacity)
              : "transparent",
            paddingHorizontal: !hasSearch ? 0 : DefaultAppStyles.GAP_SMALL,
            alignItems: "center"
          }}
          testID="search-header"
          onPress={() => {
            onSearch?.();
          }}
        >
          <LeftMenus
            canGoBack={canGoBack}
            onLeftButtonPress={onLeftMenuButtonPress}
          />

          {!title ? (
            <View
              style={{
                width: 100,
                backgroundColor: colors.primary.hover,
                height: 10,
                borderRadius: 100
              }}
            />
          ) : hasSearch ? (
            <Paragraph>
              {selectionMode
                ? `${selectedItemsList.length} selected`
                : strings.searchInRoute(title)}
            </Paragraph>
          ) : (
            <Heading size={AppFontSize.lg}>{title}</Heading>
          )}

          <RightMenus rightButton={rightButton} />
        </HeaderWrapper>
      )}
    </View>
  );
};
