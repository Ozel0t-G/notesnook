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
import React, { useEffect, useRef } from "react";
import {
  NativeEventEmitter,
  NativeModules,
  Platform,
  View
} from "react-native";
import ActionSheet from "react-native-actions-sheet";
import useGlobalSafeAreaInsets from "../../../hooks/use-global-safe-area-insets";
import { useSettingStore } from "../../../stores/use-setting-store";
import { useUserStore } from "../../../stores/use-user-store";
import { getContainerBorder } from "../../../utils/colors";
import { isMacCatalyst } from "../../../utils/constants";
import { NotesnookModule } from "../../../utils/notesnook-module";
import { Toast } from "../../toast";
import { useReduceMotion } from "../../../hooks/use-reduce-motion";
import { getAppleVisualTokens } from "../../../utils/apple-visual-tokens";

/**
 * Collapses the grabber on the Mac panel: a zero-sized, fully transparent
 * indicator in place of the iOS/Android drag handle (`indicatorColor` is made
 * transparent for the same reason). The rest of the library's styling is left
 * alone, so nothing else about the sheet changes.
 */
const HIDDEN_INDICATOR_STYLE = { width: 0, height: 0, opacity: 0 };

/**
 *
 * @param {any} param0
 * @returns
 */
const SheetWrapper = ({
  children,
  fwdRef,
  gestureEnabled = true,
  onClose,
  onOpen,
  closeOnTouchBackdrop = true,
  onHasReachedTop,
  overlay,
  overlayOpacity = 0.7,
  enableGesturesInScrollView = false,
  bottomPadding = true,
  keyboardHandlerDisabled
}) => {
  const localRef = useRef(null);
  const { colors, isDark } = useThemeColors("sheet");
  const visual = getAppleVisualTokens(colors, isDark);
  // Mac Catalyst presents the same content as a formsheet-style panel, not as a
  // bottom sheet: no grabber, no drag-to-dismiss, detached from the window
  // bottom. iPhone/iPad/Android keep the bottom sheet untouched, so every Mac
  // difference below is fenced behind this flag.
  const isMac = isMacCatalyst();
  const deviceMode = useSettingStore((state) => state.deviceMode);
  const sheetKeyboardHandler = useSettingStore(
    (state) => state.sheetKeyboardHandler
  );
  const isReduceMotionEnabled = useReduceMotion();
  const isAnimated = !isReduceMotionEnabled;

  const largeTablet = deviceMode === "tablet";
  const smallTablet = deviceMode === "smallTablet";
  const dimensions = useSettingStore((state) => state.dimensions);
  const insets = useGlobalSafeAreaInsets();
  const lockEvents = useRef(false);
  const locked = useUserStore((state) => state.appLocked);
  let width = dimensions.width > 600 ? 600 : 500;
  const isGestureNavigationEnabled =
    NotesnookModule.isGestureNavigationEnabled();
  const bottomInsets = insets.bottom || (isGestureNavigationEnabled ? 20 : 49);
  const style = React.useMemo(() => {
    if (isMac) {
      // A Mac formsheet: a centred panel that floats above the window bottom
      // instead of being welded to it. Rounded on all four corners and bordered
      // on all four sides (the bottom border included), with a hairline width.
      // `marginLeft/right: auto` in addition to alignSelf, because the library's
      // container may be absolutely positioned (where alignSelf alone does not
      // centre a fixed-width box).
      return {
        width: Math.min(520, dimensions.width - 48),
        maxHeight: dimensions.height * 0.85,
        backgroundColor: visual.contentSurface,
        zIndex: 10,
        borderTopRightRadius: 10,
        borderTopLeftRadius: 10,
        borderBottomRightRadius: 10,
        borderBottomLeftRadius: 10,
        alignSelf: "center",
        left: 0,
        right: 0,
        marginLeft: "auto",
        marginRight: "auto",
        marginBottom: 24,
        ...getContainerBorder(visual.separator, 0.5)
      };
    }
    return {
      width: largeTablet || smallTablet ? width : "100%",
      backgroundColor: visual.contentSurface,
      zIndex: 10,
      borderTopRightRadius: visual.sheetRadius,
      borderTopLeftRadius: visual.sheetRadius,
      alignSelf: "center",
      borderBottomRightRadius: 0,
      borderBottomLeftRadius: 0,
      ...getContainerBorder(visual.separator, visual.ios ? 0 : 0.5),
      borderBottomWidth: 0,
      paddingBottom:
        Platform.OS === "android" && !bottomInsets
          ? isGestureNavigationEnabled
            ? 0
            : 30
          : 0
    };
  }, [
    isMac,
    largeTablet,
    smallTablet,
    width,
    visual.contentSurface,
    visual.separator,
    visual.sheetRadius,
    visual.ios,
    bottomInsets,
    isGestureNavigationEnabled,
    dimensions.width,
    dimensions.height
  ]);

  const indicatorStyle = {
    width: visual.ios ? 36 : 100,
    backgroundColor: visual.ios
      ? visual.tertiaryText
      : colors.secondary.background
  };

  const _onOpen = () => {
    if (lockEvents.current) return;
    onOpen && onOpen();
  };

  const _onClose = async () => {
    if (lockEvents.current) return;
    if (onClose) {
      onClose();
    }
  };

  useEffect(() => {
    if (locked) {
      const ref = fwdRef || localRef;
      ref?.current?.hide();
      if (useUserStore.getState().appLocked) {
        lockEvents.current = true;
        const unsub = useUserStore.subscribe((state) => {
          if (!state.appLocked) {
            ref?.current?.show();
            unsub();
            lockEvents.current = false;
          }
        });
      }
    }
  }, [locked, fwdRef]);

  // Mac Catalyst only: Escape closes the sheet. The library's own
  // `closeOnPressBack` is Android's hardware back button, so Escape arrives
  // through the VeyraNMacMenu key command that hooks/use-mac-menu-commands.ts
  // already handles app-wide (the native side never emits it while a text field
  // is focused, so typing inside a sheet is safe). That handler closes
  // "global"-context sheets via eCloseSheet; the sheets living in the other
  // SheetProvider contexts have no eCloseSheet listener, so each one closes
  // itself here from the same command. Sheets that disabled backdrop dismissal
  // (progress spinners, the database migration) ignore Escape as well.
  useEffect(() => {
    if (!isMac || !closeOnTouchBackdrop) return;
    const nativeModule = NativeModules?.VeyraNMacMenu;
    if (!nativeModule) return;

    const emitter = new NativeEventEmitter(nativeModule);
    const subscription = emitter.addListener("VeyraNMacMenuCommand", (body) => {
      if (body?.command !== "escape") return;
      const ref = fwdRef || localRef;
      ref?.current?.hide();
    });
    return () => subscription.remove();
  }, [isMac, closeOnTouchBackdrop, fwdRef]);

  return (
    <ScopedThemeProvider value="sheet">
      <ActionSheet
        ref={fwdRef || localRef}
        animated={isAnimated}
        testIDs={{
          backdrop: "sheet-backdrop"
        }}
        indicatorStyle={isMac ? HIDDEN_INDICATOR_STYLE : indicatorStyle}
        statusBarTranslucent
        drawUnderStatusBar={true}
        containerStyle={style}
        gestureEnabled={isMac ? false : gestureEnabled}
        onPositionChanged={onHasReachedTop}
        closeOnTouchBackdrop={closeOnTouchBackdrop}
        keyboardHandlerEnabled={
          keyboardHandlerDisabled ? false : sheetKeyboardHandler
        }
        closeOnPressBack={closeOnTouchBackdrop}
        indicatorColor={isMac ? "transparent" : colors.secondary.background}
        onOpen={_onOpen}
        enableGesturesInScrollView={isMac ? false : enableGesturesInScrollView}
        defaultOverlayOpacity={overlayOpacity}
        overlayColor={colors.primary.backdrop}
        ExtraOverlayComponent={
          <>
            {overlay}
            <Toast context="local" />
          </>
        }
        onClose={_onClose}
      >
        {children}

        {bottomPadding ? (
          <View
            style={{
              height: 10
            }}
          />
        ) : null}
      </ActionSheet>
    </ScopedThemeProvider>
  );
};

export default SheetWrapper;
