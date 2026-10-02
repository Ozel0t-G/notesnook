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

import { NavigationContext } from "@react-navigation/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import useGlobalSafeAreaInsets from "../../hooks/use-global-safe-area-insets";
import { MAC_TOOLBAR_HEIGHT, macToolbarInset } from "../../utils/mac-layout";
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
import { useMacListTitleStore } from "../../utils/mac-window-title";
import { useMacWindowStore } from "../../stores/use-mac-window-store";
import { useAppleNavigationStore } from "../../stores/use-apple-navigation-store";
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
  onCompose,
  count
}: {
  onLeftMenuButtonPress?: () => void;
  renderedInRoute?: RouteName;
  id?: string;
  title?: string;
  /**
   * Number of items in the list this header names, used only on Mac: it is
   * published with the list's title so the window's subtitle shows the count
   * line ("12 notes"). Optional; lists that cannot count themselves leave it
   * out and the window's subtitle stays empty.
   */
  count?: number;
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
  const insets = useGlobalSafeAreaInsets();
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

  /**
   * Mac's window toolbar owns the list column's chrome: the list's name (the
   * window title) and the list's ⋮ menu, which it opens through its
   * `listOptions` command (hooks/use-mac-menu-commands.ts). The list header is
   * the only place that builds that menu (useListViewMenu), so it publishes it
   * here - together with the list's title - while it is the list on screen; the
   * effects below are inert on iPhone/iPad.
   */
  const isMac = isMacCatalyst();
  const hasListMenu = !!listMenu;
  const listMenuSignature = listMenu
    ? listMenu.items
        .map((item) => `${item.id ?? item.title}:${item.checked ? 1 : 0}`)
        .join("|")
    : "";
  // `items`/`onSelect` are rebuilt on every render, so the effect keys off the
  // signature above and reads the current menu through this ref.
  const listMenuRef = useRef(listMenu);
  listMenuRef.current = listMenu;
  /**
   * The list's item count, read at publish time. It changes far more often than
   * the list itself (every note created, deleted or refiled re-renders the
   * screen), so it is carried in a ref instead of in the effect's dependencies:
   * a dependency would re-run the publication effect on every count change and
   * briefly clear the window title each time.
   */
  const listCountRef = useRef(count);
  listCountRef.current = count;
  /**
   * The navigation object of the screen this header belongs to. A list header
   * stays mounted while the next list is pushed over it (and while the Tasks and
   * Search sections take the window over), so the publication has to follow
   * navigation focus, not mounts: only the focused header may own the toolbar's
   * menu / the window's title. Headers outside any navigator (the note-preview
   * configure screen) treat themselves as focused.
   */
  const navigationContext = React.useContext(NavigationContext);
  // Identity of what this header last published, so its cleanup never clears
  // another (focused) header's publication.
  const publishedMenuRef = useRef<((id: string) => void) | undefined>(undefined);
  const publishedTitleRef = useRef<string | undefined>(undefined);

  const publishMacListChrome = useCallback(() => {
    const currentMenu = listMenuRef.current;
    if (currentMenu) {
      publishedMenuRef.current = currentMenu.onSelect;
      useMacWindowStore.getState().setListMenu({
        items: currentMenu.items,
        onSelect: currentMenu.onSelect
      });
    }
    if (title) {
      publishedTitleRef.current = title;
      // Title and count go together: the window's subtitle is the count line
      // (see hooks/use-mac-window-title.ts).
      useMacListTitleStore
        .getState()
        .setListTitle(title, listCountRef.current);
    }
  }, [title]);

  const clearMacListChrome = useCallback(() => {
    const currentMenu = useMacWindowStore.getState().listMenu;
    if (currentMenu && currentMenu.onSelect === publishedMenuRef.current) {
      useMacWindowStore.getState().setListMenu(undefined);
    }
    publishedMenuRef.current = undefined;
    if (
      publishedTitleRef.current !== undefined &&
      useMacListTitleStore.getState().listTitle === publishedTitleRef.current
    ) {
      useMacListTitleStore.getState().setListTitle(undefined);
    }
    publishedTitleRef.current = undefined;
  }, []);

  /**
   * Publish while this header is *the* list on screen - its screen focused, the
   * Library section on top and no selection in progress - and clear what this
   * header published otherwise. Runs on navigation focus/blur and on every
   * section change, so a switch to Tasks/Search (whose toolbar has no list menu)
   * can never leave a stale menu behind.
   */
  const syncMacListChrome = useCallback(() => {
    const onLibrary = useAppleNavigationStore.getState().section === "library";
    const focused = !navigationContext || navigationContext.isFocused();
    if (!selectionMode && onLibrary && focused) publishMacListChrome();
    else clearMacListChrome();
  }, [
    navigationContext,
    publishMacListChrome,
    clearMacListChrome,
    selectionMode
  ]);

  useEffect(() => {
    if (!isMac || !hasListMenu) return;
    syncMacListChrome();
    const unsubscribeSection =
      useAppleNavigationStore.subscribe(syncMacListChrome);
    const unsubscribeFocus = navigationContext?.addListener(
      "focus",
      syncMacListChrome
    );
    const unsubscribeBlur = navigationContext?.addListener(
      "blur",
      syncMacListChrome
    );
    return () => {
      unsubscribeSection();
      unsubscribeFocus?.();
      unsubscribeBlur?.();
      clearMacListChrome();
    };
    // `listMenuSignature` stands in for the rebuilt `items` array; the refs
    // above carry the fresh values into the listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMac, hasListMenu, listMenuSignature, syncMacListChrome]);

  /**
   * The list's item count changes without focus or section changing (a note is
   * created, deleted or refiled), so the publication above would not run. This
   * updates it in place - but only while this header owns the published title
   * (`publishedTitleRef` is set by -publishMacListChrome), so a header that is
   * mounted but blurred (the next list pushed over it) can never re-grab the
   * window title when its own count changes.
   */
  useEffect(() => {
    if (!isMac || !hasListMenu) return;
    if (publishedTitleRef.current === undefined) return;
    publishMacListChrome();
  }, [isMac, hasListMenu, title, count, publishMacListChrome]);

  if (visual.ios) {
    const back = () => {
      if (onLeftMenuButtonPress) return onLeftMenuButtonPress();
      Navigation.goBack();
    };
    const iosRight = rightButton
      ? IOS_RIGHT_BUTTON_SYMBOLS[rightButton.name as string]
      : undefined;
    // Mac's list column is the middle column's top screen (the sidebar owns
    // list switching), so its bar shows no "‹ Library" button. A Settings
    // sub-page is a real push under the Settings sheet, though, and needs a way
    // back that is not only Esc.
    const showBack =
      !selectionMode &&
      canGoBack === true &&
      (!isMac || renderedInRoute === "Settings");
    /**
     * Mac's window toolbar is the list column's single chrome band - list name,
     * sort/view menu and the only search field - so the column's own header
     * (the one that builds that menu, `hasListMenu`) draws no 44 pt IosNavBar
     * and no second IosSearchField under it. Selection mode ("N selected" +
     * Done) keeps its compact bar, and every header without a list menu keeps
     * its bar as today: sheets and pushed screens (Settings, Add Reminder,
     * Move Notes, ...) carry their back / cancel / save buttons there, and the
     * toolbar does not.
     */
    const showHeaderBar = !isMac || selectionMode || !hasListMenu;
    if (!showHeaderBar) return null;
    return (
      <View
        style={{
          // Mac's window content is one background (the theme's primary
          // background, see apple-visual-tokens' `withMacSemanticColors`), so
          // every in-column bar - the list's selection bar and the pushed
          // screens (Settings, Move Notes, ...) - paints that same colour and
          // disappears into the column behind it.
          backgroundColor: isMac
            ? colors.primary.background
            : visual.screenBackground,
          // The list column no longer reserves a band for the native toolbar
          // (see navigation/fluid-panels-view.tsx), so the one Mac header that
          // still draws in the column - selection mode's "N selected" bar -
          // pads itself below the toolbar. Floored at the known toolbar height
          // so a not-yet-measured safe area cannot leave the bar under it.
          paddingTop:
            isMac && hasListMenu
              ? Math.max(macToolbarInset(insets.top), MAC_TOOLBAR_HEIGHT)
              : 0
        }}
      >
        <IosNavBar
          backTitle={
            showBack ? backTitle || strings.routes.Library() : undefined
          }
          onBack={showBack ? back : undefined}
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
