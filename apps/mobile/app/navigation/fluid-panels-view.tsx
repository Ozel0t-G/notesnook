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
import { isMacCatalyst } from "../utils/constants";
import {
  macEditorWidth,
  macListWidth,
  macToolbarInset
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
     * The drawer is an iPad-only affordance now. On iPhone the bottom bar is
     * the only top-level navigation, so the sidebar pane and the
     * swipe-to-open gesture are both gone.
     *
     * Mac has no drawer either: its sections live in the section control at the
     * top of the list column, so the sidebar pane (and the sliver of it that
     * used to peek in at x 0) is not mounted at all.
     */
    const drawerEnabled =
      !isMacCatalyst() && (Platform.OS !== "ios" || deviceMode !== "mobile");

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
          sidebar: dimensions.width * 0.22,
          list: dimensions.width * 0.3,
          editor: dimensions.width * 0.48
        }
      };

      if (isMacCatalyst()) {
        /**
         * Mac: the Library/list column starts at x 0 (no sidebar rail) and the
         * editor takes exactly what is left of the window. The clamped iPad
         * widths overflowed the window, which clipped the editor's right edge
         * (the "Add tag" button and the header menu).
         */
        const macPanes = {
          sidebar: 0,
          list: macListWidth(dimensions.width),
          editor: macEditorWidth(dimensions.width)
        };
        panes.smallTablet = macPanes;
        panes.tablet = macPanes;
      }

      return panes;
    }, [dimensions.width]);

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
            {/* iPad sidebar pane. iPhone navigates with the bottom bar, so the
                side menu is neither sized nor mounted there. */}
            {drawerEnabled ? (
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
                backgroundColor: visual.screenBackground,
                borderRightWidth:
                  visual.ios && deviceMode === "tablet" ? 0.5 : 0,
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
                    // Mac's window chrome (the native toolbar and the traffic
                    // lights) is drawn by the system above the window's content
                    // area, and UIKit reports its height as the window's top
                    // safe-area inset: padding by it is what puts the list
                    // below the toolbar instead of under it. The padding sits
                    // on this column, whose own screenBackground is what shows
                    // through, so the strip under the toolbar has the list's
                    // color. See `macToolbarInset`.
                    paddingTop: isMacCatalyst()
                      ? macToolbarInset(insets.top)
                      : insets.top,
                    // On iOS the bottom bar is laid out below this pane and
                    // already covers the home indicator; padding here as well
                    // would leave a dead strip above the bar.
                    paddingBottom: Platform.OS === "ios" ? 0 : insets.bottom
                  }}
                >
                  <AppNavigationStack />
                </View>
              </ScopedThemeProvider>
            </View>

            <ScopedThemeProvider value="editor">
              {isLoading ? null : <EditorWrapper widths={PANE_WIDTHS} />}
            </ScopedThemeProvider>
          </FluidPanels>
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
