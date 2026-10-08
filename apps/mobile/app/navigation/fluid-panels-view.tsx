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

import { ScopedThemeProvider, useThemeColors } from "@notesnook/theme";
import {
  activateKeepAwake,
  deactivateKeepAwake
} from "@sayem314/react-native-keep-awake";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { LayoutChangeEvent, Platform, View } from "react-native";
import Orientation, {
  OrientationType,
  useDeviceOrientationChange
} from "react-native-orientation-locker";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from "react-native-reanimated";
import { notesnook } from "../../e2e/test.ids";
import { db } from "../common/database";
import { FluidPanels } from "../components/fluid-panels";
import { MacScrollEdgeFade } from "../components/mac-scroll-edge-fade";
import { MacSidebar } from "../components/mac-sidebar";
import { useSideBarDraggingStore } from "../components/side-menu/dragging-store";
import useGlobalSafeAreaInsets from "../hooks/use-global-safe-area-insets";
import { hideAllTooltips } from "../hooks/use-tooltip";
import { useTabStore } from "../screens/editor/tiptap/use-tab-store";
import { editorController, editorState } from "../screens/editor/tiptap/utils";
import { DDS } from "../services/device-detection";
import {
  eSendEvent,
  eSubscribeEvent,
  eUnSubscribeEvent
} from "../services/event-manager";
import { useSettingStore } from "../stores/use-setting-store";
import {
  eCloseFullscreenEditor,
  eOnEnterEditor,
  eOnExitEditor,
  eOpenFullscreenEditor,
  eUnlockNote
} from "../utils/events";
import { valueLimiter } from "../utils/functions";
import { fluidTabsRef } from "../utils/global-refs";
import { AppNavigationStack } from "./navigation-stack";
import type { PaneWidths } from "../screens/editor/wrapper";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { NavigationProps } from "../services/navigation";
import { useAppleNavigationStore } from "../stores/use-apple-navigation-store";
import { useMacSidebarVisible } from "../stores/use-mac-sidebar-store";
import { isMacCatalyst } from "../utils/constants";
import {
  MAC_SCROLL_EDGE_FADE_HEIGHT,
  macEditorWidth,
  macListWidth,
  macSidebarWidth,
  macToolbarInset,
  macWindowBackground
} from "../utils/mac-layout";

/**
 * iPhone has no drawer: the bottom bar owns top-level navigation, so the
 * sidebar pane collapses to zero width and is not mounted at all.
 * iPad keeps its sidebar pane (see PANE_WIDTHS below).
 */
const MOBILE_SIDEBAR_SIZE = Platform.OS === "ios" ? 0 : 0.85;

let SideMenu: any = null;
let EditorWrapper: any = null;

export const FluidPanelsView = React.memo(
  ({ route }: NavigationProps<"FluidPanelsView">) => {
    const { colors, isDark } = useThemeColors();
    const visual = getAppleVisualTokens(colors, isDark);
    const deviceMode = useSettingStore((state) => state.deviceMode);
    const setFullscreen = useSettingStore((state) => state.setFullscreen);
    const fullscreen = useSettingStore((state) => state.fullscreen);
    const setDeviceModeState = useSettingStore((state) => state.setDeviceMode);
    const dimensions = useSettingStore((state) => state.dimensions);
    const setDimensions = useSettingStore((state) => state.setDimensions);
    /**
     * The top-level section the app is showing. Mac's Tasks and Search are
     * screens of their own that cover this one (see MAC_SECTION_SCREEN_OPTIONS
     * in navigation-stack.tsx); the section is what tells this screen they are
     * up. On iPhone/iPad the floating bar keeps the same value and nothing here
     * reads it: those sections cover the panes the same way they always did.
     */
    const section = useAppleNavigationStore((state) => state.section);
    const macSection = isMacCatalyst() && section !== "library";
    /**
     * View > Toggle Sidebar's flag. Mac only: it decides whether the source
     * list pane is part of the layout (see PANE_WIDTHS below).
     */
    const macSidebarVisible = useMacSidebarVisible(dimensions.width);
    const insets = useGlobalSafeAreaInsets();
    const animatedOpacity = useSharedValue(0);
    const animatedTranslateY = useSharedValue(-9999);
    const overlayRef = useRef<Animated.View>(null);
    const [orientation, setOrientation] = useState<OrientationType>(
      Orientation.getInitialOrientation()
    );
    const appLoading = useSettingStore((state) => state.isAppLoading);
    const introCompleted = useSettingStore(
      (state) => state.settings.introCompleted
    );
    const [isLoading, setIsLoading] = useState(false);
    /**
     * iPad in landscape (a large tablet in `tablet` mode) lays out like a
     * two-pane Notes: the fixed left source-list sidebar is removed entirely
     * (0 width, not mounted, drawer off) so the note list keeps its ~30% and
     * the editor absorbs the freed width, filling the window. The account/sync
     * affordance that the sidebar used to carry moves to the Library's nav bar
     * (see screens/library/index.tsx). `!isMacCatalyst()` is required: Mac also
     * reports `deviceMode === "tablet"` (and historically answered
     * `Platform.isPad`), and Android's large tablet keeps its sidebar.
     *
     * Outside that mode the drawer stays the iPad/Android affordance it was:
     * iPhone (bottom bar only) and Mac (sections in the list column) never
     * mount the sidebar pane.
     */
    const hideTabletSidebar =
      Platform.OS === "ios" &&
      Platform.isPad === true &&
      !isMacCatalyst() &&
      deviceMode === "tablet";

    const drawerEnabled =
      !isMacCatalyst() &&
      !hideTabletSidebar &&
      (Platform.OS !== "ios" || deviceMode !== "mobile");

    const toggleView = useCallback(
      (show: boolean) => {
        animatedTranslateY.value = show ? 0 : -9999;
      },
      [animatedTranslateY]
    );

    useDeviceOrientationChange((o) => {
      if (
        o !== OrientationType.UNKNOWN &&
        o !== OrientationType["FACE-UP"] &&
        o !== OrientationType["FACE-DOWN"] &&
        o !== OrientationType["PORTRAIT-UPSIDEDOWN"]
      ) {
        setOrientation(o);
      }
    });
    React.useEffect(() => {
      const shortcut = useSettingStore.getState().pendingShortcut;

      if (shortcut?.type === "notesnook.action.newnote") {
        useSettingStore.setState({
          pendingShortcut: null
        });
      }
    }, []);

    useEffect(() => {
      if (!appLoading) {
        setTimeout(() => {
          setIsLoading(false);
        }, 200);
      }
    }, [appLoading]);

    const showFullScreenEditor = useCallback(() => {
      setFullscreen(true);
      if (deviceMode === "smallTablet") {
        fluidTabsRef.current?.openDrawer(false);
      }
    }, [deviceMode, setFullscreen]);

    const closeFullScreenEditor = useCallback(
      (current: string) => {
        const _deviceMode = current || deviceMode;
        if (_deviceMode === "smallTablet") {
          fluidTabsRef.current?.closeDrawer(false);
        }
        setFullscreen(false);
        editorController.current?.commands.updateSettings({
          fullscreen: false
        });
        if (_deviceMode === "smallTablet") {
          fluidTabsRef.current?.goToIndex(1, false);
        }
        if (_deviceMode === "mobile") {
          fluidTabsRef.current?.goToIndex(2, false);
        }
      },
      [deviceMode, setFullscreen]
    );

    useEffect(() => {
      if (!fluidTabsRef.current?.isDrawerOpen()) toggleView(false);
      eSubscribeEvent(eOpenFullscreenEditor, showFullScreenEditor);
      eSubscribeEvent(eCloseFullscreenEditor, closeFullScreenEditor);

      return () => {
        eUnSubscribeEvent(eOpenFullscreenEditor, showFullScreenEditor);
        eUnSubscribeEvent(eCloseFullscreenEditor, closeFullScreenEditor);
      };
    }, [
      deviceMode,
      dimensions,
      colors,
      showFullScreenEditor,
      closeFullScreenEditor,
      toggleView
    ]);

    const setDeviceMode = React.useCallback(
      (current: string | null, size: { width: number; height: number }) => {
        setDeviceModeState(current);

        if (fullscreen && current === "mobile") {
          eSendEvent(eCloseFullscreenEditor, current);
        }

        setTimeout(() => {
          switch (current) {
            case "tablet":
              fluidTabsRef.current?.goToIndex(0, false);
              break;
            case "smallTablet":
              if (!fullscreen) {
                fluidTabsRef.current?.closeDrawer(false);
              }
              break;
            case "mobile":
              fluidTabsRef.current?.goToPage(
                fluidTabsRef.current?.page(),
                false
              );
              break;
          }
        }, 0);
      },
      [fullscreen, setDeviceModeState]
    );

    const checkDeviceType = React.useCallback(
      (size: { width: number; height: number }) => {
        if (DDS.width === size.width && orientation === DDS.orientation) return;
        DDS.setSize(size, orientation);
        /**
         * Mac always lays out like the tablet: the three panes sit side by
         * side and the pager stays at x 0, so nothing can slide over the
         * editor or push it out of the window.
         */
        const nextDeviceMode = isMacCatalyst()
          ? "tablet"
          : DDS.isLargeTablet()
          ? "tablet"
          : DDS.isSmallTab
          ? "smallTablet"
          : "mobile";
        setDeviceMode(nextDeviceMode, size);
      },
      [orientation, setDeviceMode]
    );

    useEffect(() => {
      if (orientation !== "UNKNOWN") {
        checkDeviceType(dimensions);
      }
    }, [orientation, dimensions, checkDeviceType]);

    const _onLayout = React.useCallback(
      (event: LayoutChangeEvent) => {
        const size = event?.nativeEvent?.layout;
        setDimensions({
          width: size.width,
          height: size.height
        });
        if (size.width > size.height) {
          setOrientation(OrientationType["LANDSCAPE-RIGHT"]);
        } else {
          setOrientation(OrientationType["PORTRAIT"]);
        }
      },
      [setDimensions]
    );

    const PANE_WIDTHS: PaneWidths = useMemo(() => {
      const panes: PaneWidths = {
        mobile: {
          sidebar: dimensions.width * MOBILE_SIDEBAR_SIZE,
          list: dimensions.width,
          editor: dimensions.width
        },
        smallTablet: {
          sidebar: valueLimiter(dimensions.width * 0.3, 300, 350),
          list: valueLimiter(dimensions.width * 0.4, 300, 450),
          editor:
            dimensions.width - valueLimiter(dimensions.width * 0.4, 300, 450)
        },
        tablet: {
          // iPad landscape large: no sidebar, so the list keeps its ~30% and
          // the editor takes the freed 22%, filling the window (the three
          // widths still add up to the window width). Android's large tablet
          // keeps the 22% sidebar; Mac overrides below.
          sidebar: hideTabletSidebar ? 0 : dimensions.width * 0.22,
          list: dimensions.width * 0.3,
          editor: hideTabletSidebar
            ? dimensions.width * 0.7
            : dimensions.width * 0.48
        }
      };

      if (isMacCatalyst()) {
        /**
         * Mac lays out like macOS Notes: a persistent source-list sidebar, the
         * note list, and the editor taking exactly what is left of the window.
         * The three widths add up to the window width (see mac-layout.ts), which
         * is what keeps the editor's right edge - the "Add tag" button and the
         * header menu - inside the window; the clamped iPad widths overflowed it.
         *
         * With the sidebar hidden (View > Toggle Sidebar) its width is 0 and
         * the editor grows by that much, so the note list keeps its width and
         * the two remaining panes fill the window.
         */
        const macPanes = {
          sidebar: macSidebarWidth(dimensions.width, macSidebarVisible),
          list: macListWidth(dimensions.width),
          editor: macEditorWidth(dimensions.width, macSidebarVisible)
        };
        panes.smallTablet = macPanes;
        panes.tablet = macPanes;
      }

      return panes;
    }, [dimensions.width, macSidebarVisible, hideTabletSidebar]);

    const onScroll = React.useCallback(
      (scrollOffset: number) => {
        if (!deviceMode) return;
        hideAllTooltips();
        if (Platform.OS === "ios" || deviceMode !== "mobile") return;
        const sidebarOffset = dimensions.width * MOBILE_SIDEBAR_SIZE;
        if (scrollOffset > sidebarOffset - 10) {
          animatedOpacity.value = 0;
          toggleView(false);
        } else {
          const o = scrollOffset / 300;
          const opacity = o < 0 ? 1 : 1 - o;
          animatedOpacity.value = opacity;
          toggleView(opacity >= 0.1);
        }
      },
      [animatedOpacity, deviceMode, dimensions.width, toggleView]
    );

    const animatedStyle = useAnimatedStyle(() => ({
      opacity: animatedOpacity.value,
      transform: [{ translateY: animatedTranslateY.value }]
    }));

    if (!isLoading && !SideMenu && !EditorWrapper) {
      SideMenu = require("../components/side-menu").SideMenu;
      EditorWrapper = require("../screens/editor/wrapper").EditorWrapper;
    }

    return (
      <View
        onLayout={_onLayout}
        testID={notesnook.ids.default.root}
        style={{
          height: "100%",
          width: "100%",
          // The root is opaque on every platform, Mac included: Catalyst does
          // not show the desktop through a clear UIWindow, so the Mac window is
          // opaque too (see SceneDelegate.m) and the glass sidebar needs a real
          // colour behind it, not a blank/light backdrop. On Mac
          // `screenBackground` resolves to the theme's primary background
          // (apple-visual-tokens' `withMacSemanticColors`), the same colour the
          // note list column, the editor pane and the band behind the toolbar
          // paint, so the strip between the floating glass panel and the window
          // edge matches the rest of the window instead of showing through as a
          // different corner. The list and editor panes still bring their own
          // opaque surfaces; only the sidebar pane stays transparent.
          backgroundColor: visual.screenBackground
        }}
      >
        {deviceMode && PANE_WIDTHS[deviceMode as keyof typeof PANE_WIDTHS] ? (
          <FluidPanels
            ref={fluidTabsRef}
            dimensions={dimensions}
            widths={PANE_WIDTHS[deviceMode as keyof typeof PANE_WIDTHS]}
            enabled={deviceMode !== "tablet" && !fullscreen}
            drawerEnabled={drawerEnabled}
            initialPage={route.params?.initialPage}
            onScroll={onScroll}
            onChangeTab={onChangeTab}
            onDrawerStateChange={(state) => {
              if (!state) {
                useSideBarDraggingStore.setState({
                  dragging: false
                });
              }
            }}
          >
            {/* Mac's sidebar pane: a persistent source list (Library) at the
                left edge of the window, the leftmost of the three columns. It
                is not the side menu and has no drawer: selecting a row opens
                the note list in the middle column. The pane itself is
                transparent — the floating glass panel inside it is what paints
                the sidebar (see components/mac-sidebar.tsx) — so the opaque
                root below it (the app's window colour) shows through the
                material and through the 9 pt strip around the panel. */}
            {isMacCatalyst() ? (
              <View
                key="1"
                style={{
                  height: "100%",
                  // 0 both when the editor takes the whole window and when the
                  // sidebar is hidden (View > Toggle Sidebar, which makes
                  // PANE_WIDTHS.sidebar 0 as well).
                  width: fullscreen
                    ? 0
                    : PANE_WIDTHS[deviceMode as keyof typeof PANE_WIDTHS]
                        ?.sidebar,
                  // The floating glass panel draws its own rounded edge; a
                  // hairline here would cut across it, so the separator is
                  // gone with the opaque column.
                  borderRightWidth: 0,
                  // A zero-width pane keeps its children mounted (the source
                  // list keeps its scroll position), and iOS Views do not clip
                  // by default: without this the list would still paint over
                  // the note list.
                  overflow: macSidebarVisible ? "visible" : "hidden"
                }}
              >
                <ScopedThemeProvider value="list">
                  <MacSidebar />
                </ScopedThemeProvider>
              </View>
            ) : drawerEnabled ? (
              <View
                key="1"
                style={{
                  height: "100%",
                  width: fullscreen
                    ? 0
                    : PANE_WIDTHS[deviceMode as keyof typeof PANE_WIDTHS]
                        ?.sidebar,
                  borderRightWidth:
                    visual.ios && deviceMode === "tablet" ? 0.5 : 0,
                  borderRightColor: visual.separator
                }}
              >
                <ScopedThemeProvider value="navigationMenu">
                  {isLoading ? null : <SideMenu />}
                </ScopedThemeProvider>
              </View>
            ) : null}

            <View
              key="2"
              style={{
                height: "100%",
                width: fullscreen
                  ? 0
                  : PANE_WIDTHS[deviceMode as keyof typeof PANE_WIDTHS]?.list,
                // Mac's note list column is the *same* background as the
                // editor and the rest of the window: the Mac window background
                // (macOS 26 Notes keeps one colour across the whole window).
                // Opaque on purpose (F5): the sidebar's glass panel is the only
                // translucent surface, and it sits on the opaque root (the
                // app's window colour), never on this column.
                backgroundColor: isMacCatalyst()
                  ? macWindowBackground(colors, isDark)
                  : visual.screenBackground,
                // The separator between the list and the editor on Mac is the
                // 1 px line below, not a border on this column: it must start
                // at the toolbar's bottom edge, not run under the toolbar.
                borderRightWidth: isMacCatalyst()
                  ? 0
                  : visual.ios && deviceMode === "tablet"
                  ? 0.5
                  : 0,
                borderRightColor: visual.separator
              }}
            >
              <ScopedThemeProvider value="list">
                {Platform.OS !== "ios" && deviceMode === "mobile" ? (
                  <Animated.View
                    onTouchEnd={() => {
                      if (useSideBarDraggingStore.getState().dragging) {
                        useSideBarDraggingStore.setState({ dragging: false });
                        return;
                      }
                      fluidTabsRef.current?.closeDrawer();
                      animatedOpacity.value = withTiming(0);
                      animatedTranslateY.value = withTiming(-9999);
                    }}
                    style={[
                      {
                        position: "absolute",
                        width: "100%",
                        height: "100%",
                        zIndex: 999,
                        backgroundColor: colors.primary.backdrop
                      },
                      animatedStyle
                    ]}
                    ref={overlayRef}
                  />
                ) : null}
                <View
                  style={{
                    flex: 1,
                    // Mac: no band for the toolbar here. The list's own scroll
                    // content pads itself by `macToolbarInset` (components/
                    // list/index.tsx), so it starts below the borderless
                    // toolbar but still slides under it; the fade overlay below
                    // dissolves whatever reaches the top. iPhone/iPad keep the
                    // safe-area padding that puts the list below their opaque
                    // nav bar.
                    paddingTop: isMacCatalyst() ? 0 : insets.top,
                    // On iOS the bottom bar is laid out below this pane and
                    // already covers the home indicator; padding here as well
                    // would leave a dead strip above the bar.
                    paddingBottom: Platform.OS === "ios" ? 0 : insets.bottom
                  }}
                >
                  <AppNavigationStack />
                </View>
                {/* Mac's scroll-edge fade: the note list's background at the
                    top, transparent 56 pt down, over the scrolling content and
                    under the transparent toolbar. Not touchable, so the list
                    underneath keeps every scroll and press. Its opaque end
                    matches the list column above: the theme's primary
                    background. */}
                {isMacCatalyst() ? (
                  <MacScrollEdgeFade
                    color={macWindowBackground(colors, isDark)}
                    height={MAC_SCROLL_EDGE_FADE_HEIGHT}
                  />
                ) : null}
              </ScopedThemeProvider>
              {/* Mac's list/editor separation: a 1 px hairline at the list
                  column's right edge, from the toolbar's bottom edge to the
                  window bottom. It stops under the toolbar band so the title
                  row stays clean, and both sides keep the same window
                  background. */}
              {isMacCatalyst() && !fullscreen ? (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: macToolbarInset(insets.top),
                    bottom: 0,
                    right: 0,
                    width: 1,
                    backgroundColor: colors.primary.border,
                    opacity: 0.6
                  }}
                />
              ) : null}
            </View>

            <ScopedThemeProvider value="editor">
              {isLoading ? null : <EditorWrapper widths={PANE_WIDTHS} />}
            </ScopedThemeProvider>
          </FluidPanels>
        ) : null}

        {/*
          Mac: while Tasks or Search owns the content area, the sidebar pane
          stays where it is and the section's screen fills everything to its
          right (the section routes bring their own source-list pane, see
          components/mac-section-layout.tsx). This covers the Library's note
          list and editor columns - whose own surfaces are painted on top of
          each other - with the screen background the section screens use, so
          none of the Library layout can show through the section. It starts at
          the sidebar's right edge, so it never covers the source list; with the
          sidebar hidden that edge is 0 and it covers the whole window.

          It is not touchable - the section's screen is above this one - and the
          panes stay mounted underneath, so the editor keeps its state and the
          three-column layout comes back exactly as it was when the Library
          section returns.
        */}
        {macSection ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: macSidebarWidth(dimensions.width, macSidebarVisible),
              right: 0,
              bottom: 0,
              backgroundColor: visual.screenBackground
            }}
          />
        ) : null}
      </View>
    );
  },
  () => true
);
FluidPanelsView.displayName = "FluidPanelsView";

export default FluidPanelsView;

const onChangeTab = async (event: { i: number; from: number }) => {
  useAppleNavigationStore.getState().setEditorVisible(event.i === 2);
  if (event.i === 2) {
    editorState().movedAway = false;
    editorState().isFocused = true;
    if (useSettingStore.getState().settings.keepScreenOn) {
      activateKeepAwake();
    }
    eSendEvent(eOnEnterEditor);

    if (
      useTabStore.getState().getTab(useTabStore.getState().currentTab)?.session
        ?.locked
    ) {
      eSendEvent(eUnlockNote);
    }

    if (
      fluidTabsRef.current?.tabChangedFromSwipeAction.value &&
      !useTabStore.getState().getNoteIdForTab(useTabStore.getState().currentTab)
    ) {
      editorController?.current?.commands?.focus(
        useTabStore.getState().currentTab
      );
    }
  } else {
    if (event.from === 2) {
      deactivateKeepAwake();
      editorState().movedAway = true;
      editorState().isFocused = false;
      eSendEvent(eOnExitEditor);

      // Lock all tabs with locked notes...
      for (const tab of useTabStore.getState().tabs) {
        const noteId = useTabStore.getState().getTab(tab.id)?.session?.noteId;
        if (!noteId) continue;
        const note = await db.notes.note(noteId);
        const locked = note && (await db.vaults.itemExists(note));
        if (locked) {
          useTabStore.getState().updateTab(tab.id, {
            session: {
              locked: true
            }
          });
        }
      }
    }
  }
};
