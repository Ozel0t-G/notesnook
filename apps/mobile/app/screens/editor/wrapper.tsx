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
import React, { useEffect, useRef } from "react";
import {
  AppState,
  AppStateStatus,
  KeyboardAvoidingView,
  Platform,
  TextInput,
  View
} from "react-native";
import Editor from ".";
import useGlobalSafeAreaInsets from "../../hooks/use-global-safe-area-insets";
import useIsFloatingKeyboard from "../../hooks/use-is-floating-keyboard";
import { DDS } from "../../services/device-detection";
import { useSettingStore } from "../../stores/use-setting-store";
import { editorRef } from "../../utils/global-refs";
import { editorController, textInput } from "./tiptap/utils";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { isMacCatalyst } from "../../utils/constants";
import { macToolbarInset, macWindowBackground } from "../../utils/mac-layout";

export type PaneWidths = {
  mobile: {
    sidebar: number;
    list: number;
    editor: number;
  };
  smallTablet: {
    sidebar: number;
    list: number;
    editor: number;
  };
  tablet: {
    sidebar: number;
    list: number;
    editor: number;
  };
};

export const EditorWrapper = ({ widths }: { widths: PaneWidths }) => {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const { colors: toolBarColors } = useThemeColors("editorToolbar");
  const deviceMode = useSettingStore((state) => state.deviceMode);
  const loading = false;
  const insets = useGlobalSafeAreaInsets();
  const floating = useIsFloatingKeyboard();
  const introCompleted = useSettingStore(
    (state) => state.settings.introCompleted
  );
  const prevState = useRef<AppStateStatus>(undefined);
  const isFullscreen = useSettingStore((state) => state.fullscreen);
  const dimensions = useSettingStore((state) => state.dimensions);

  /**
   * iPad's full-screen editor is the note and nothing else: the wrapper is
   * already `dimensions.width` wide there, so the 15% side padding iPhone
   * uses to keep a comfortable reading column only painted this view's own
   * background as a dark strip down each edge (reported as black bars on both
   * sides of the iPad landscape editor). iPad therefore takes no side padding.
   * Mac Catalyst and Android's large tablet also report `deviceMode ===
   * "tablet"` but are not iPads, and `smallTablet` already had none, so this
   * is scoped to iPad alone - iPhone, Android, Mac Catalyst and the safe
   * area/toolbar behaviour are unchanged.
   */
  const isIPad =
    Platform.OS === "ios" && Platform.isPad === true && !isMacCatalyst();

  const onAppStateChanged = async (state: AppStateStatus) => {
    if (!prevState.current) {
      prevState.current = state;
      return;
    }
    if (useSettingStore.getState().appDidEnterBackgroundForAction) return;
    if (state === "active") {
      editorController.current.onReady();
      editorController.current.overlay(false);
    } else {
      prevState.current = state;
    }
  };

  useEffect(() => {
    if (loading) return;
    const sub = AppState.addEventListener("change", onAppStateChanged);
    return () => {
      sub?.remove();
    };
  }, [loading]);

  return (
    <View
      testID="editor-wrapper"
      ref={editorRef}
      style={[
        {
          width: isFullscreen
            ? dimensions.width
            : widths[
                !introCompleted ? "mobile" : (deviceMode as keyof PaneWidths)
              ]?.editor,
          height: "100%",
          minHeight: "100%",
          /**
           * The editor WebView is transparent and paints its own background, so
           * whatever shows through it (a rounding gap, the 0.5px hairline under
           * the header, the rounding gap at the top of the pane) has to be the
           * editor's own background. On Mac the window is one colour: the
           * editor pane uses the same theme primary background as the note list
           * column and the React root (see navigation/fluid-panels-view.tsx and
           * apple-visual-tokens' `withMacSemanticColors`); `editorSurround` -
           * the iPad choice - is a different (lighter) surface and showed up as
           * a strip above the header.
           */
          backgroundColor: isMacCatalyst()
            ? macWindowBackground(colors, isDark)
            : visual.ios
            ? visual.editorSurround
            : toolBarColors.primary.background,
          paddingLeft: isFullscreen
            ? isIPad || deviceMode === "smallTablet"
              ? 0
              : dimensions.width * 0.15
            : null,
          paddingRight: isFullscreen
            ? isIPad || deviceMode === "smallTablet"
              ? 0
              : dimensions.width * 0.15
            : insets.right,
          /**
           * Mac's window chrome (the native toolbar and the traffic lights) is
           * drawn by the system above the window's content area, and UIKit
           * reports its height as the window's top safe-area inset. This
           * wrapper - not the WebView, which keeps top inset 0 (see
           * tiptap/use-editor.ts) - takes the padding, so the pane's first row
           * is the editor's own 52pt web header, right under the toolbar. The
           * padding shows this view's backgroundColor, i.e. the editor's own
           * surface, so the strip under the toolbar is not a gap of another
           * color. iPhone and iPad keep their own layout (no top padding here).
           */
          paddingTop: isMacCatalyst() ? macToolbarInset(insets.top) : null,
          // No hard separator between the note list and the editor on Mac: the
          // two backgrounds (secondary vs. primary) and the spacing are the
          // separation. iPad keeps its hairline.
          borderLeftWidth: isMacCatalyst()
            ? 0
            : DDS.isTab
            ? visual.ios
              ? 0.5
              : 1
            : 0,
          borderLeftColor: DDS.isTab ? visual.separator : "transparent",
          paddingBottom: insets.bottom
        }
      ]}
    >
      {loading || !introCompleted ? null : (
        <KeyboardAvoidingView
          behavior="padding"
          style={{
            // Mac's editor surface is the same primary background as the
            // wrapper above and the WebView's page behind it (see
            // packages/editor-mobile/src/index.css); the iPad surface is a
            // different (lighter) tone and would show through any gap.
            backgroundColor: isMacCatalyst()
              ? macWindowBackground(colors, isDark)
              : visual.contentSurface,
            flex: 1
          }}
          enabled={!floating}
          keyboardVerticalOffset={0}
        >
          <TextInput
            key="input"
            ref={textInput}
            style={{ height: 1, padding: 0, width: 1, position: "absolute" }}
            blurOnSubmit={false}
          />
          <Editor key="editor" withController={true} />
        </KeyboardAvoidingView>
      )}
    </View>
  );
};

export default EditorWrapper;
