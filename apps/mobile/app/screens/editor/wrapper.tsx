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
import React, { useContext, useEffect, useRef, useState } from "react";
import {
  AppState,
  AppStateStatus,
  KeyboardAvoidingView,
  Platform,
  TextInput,
  View
} from "react-native";
import Editor from ".";
import { ASSISTANT_SIDEBAR_WIDTH } from "../../components/veyran-assistant-sidebar";
import { MacAssistantInspector } from "../../components/mac-assistant-inspector";
import { useMacWindowStore } from "../../stores/use-mac-window-store";
import { isSIWCPlatformSupported } from "../../services/veyran-siwc";
import useGlobalSafeAreaInsets from "../../hooks/use-global-safe-area-insets";
import useIsFloatingKeyboard from "../../hooks/use-is-floating-keyboard";
import { DDS } from "../../services/device-detection";
import { useSettingStore } from "../../stores/use-setting-store";
import { editorRef } from "../../utils/global-refs";
import { editorController, textInput } from "./tiptap/utils";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { isMacCatalyst } from "../../utils/constants";
import { macToolbarInset } from "../../utils/mac-layout";
import { AppleTabBarOffsetContext } from "../../components/apple-tab-bar-layout";

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

export const EditorWrapper = ({
  widths,
  editorWidth,
  paneHidden
}: {
  widths: PaneWidths;
  /**
   * iPad only: the width of the document pane, resolved by the root from the
   * *measured* root width and the width-derived pane mode (see
   * utils/ipad-layout.ts). On the iPad the three panes are not the device
   * mode's percentages, so the resolved width is the only correct one there;
   * everywhere else this is undefined and the pane keeps taking its width from
   * `widths[deviceMode]` exactly as before. Guarded by `isIPad` rather than by
   * presence alone, so a stray value could never change a non-iPad client.
   */
  editorWidth?: number;
  /**
   * iPad only: this pane is the pager's off-screen page. The narrow iPad shows
   * one full-width page at a time, and the pager slides the other one out of
   * the window - but the pane stays mounted (its tab, caret and note survive),
   * so it must be told to take no touches and to stay out of VoiceOver. Set by
   * the root for the narrow iPad's inactive page only; `undefined` everywhere
   * else leaves the pane exactly as it was (see navigation/fluid-panels-view).
   */
  paneHidden?: boolean;
}) => {
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

  /**
   * The iPad top tab bar strip's actual rendered height, published by the
   * root (see navigation-stack.tsx's `AppleTabBarOffsetContext.Provider`) -
   * 0 everywhere the strip is not drawn. Read unconditionally so this
   * component always subscribes to the same context; only the iPad branch
   * below uses the value.
   */
  const topTabBarOffset = useContext(AppleTabBarOffsetContext);

  /**
   * The document pane's width. On the iPad the root resolves it from the
   * measured width and the width-derived pane mode (`editorWidth`, see
   * utils/ipad-layout.ts) - the device-mode percentages below are not the iPad's
   * layout any more, and the intro gate existed only to pick between them while
   * the editor was not yet shown, so the iPad pane keeps its resolved width
   * throughout. Every other client keeps the lookup, unchanged, including the
   * intro gate and the `mobile` fallback.
   */
  const resolvedEditorWidth =
    isIPad && editorWidth !== undefined
      ? editorWidth
      : widths[!introCompleted ? "mobile" : (deviceMode as keyof PaneWidths)]
          ?.editor;

  const inspectorVisible = useMacWindowStore((state) => state.inspectorVisible);
  const [workspaceSize, setWorkspaceSize] = useState({ width: 0, height: 0 });
  // Measure inside the wrapper's reading padding and actual sidebar layout.
  // Until layout is known, keep the full writing width with a bottom Inspector.
  const inspectorDocked = workspaceSize.width >= 560 + ASSISTANT_SIDEBAR_WIDTH;

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

  /**
   * The hidden iPad page is off the window but still mounted, so the subtree
   * (the editor WebView included) takes no touches and is hidden from VoiceOver
   * for as long as it is parked there. Derived from `isIPad` *and* an explicit
   * `true`: `paneHidden` is undefined on every other client and merely falsy on
   * a visible iPad pane, and both cases have to keep the platform defaults of
   * all three props rather than an explicit `"auto"`/`false`.
   */
  const paneIsHidden = isIPad && paneHidden === true;

  return (
    <View
      pointerEvents={paneIsHidden ? "none" : undefined}
      accessibilityElementsHidden={paneIsHidden ? true : undefined}
      importantForAccessibility={
        paneIsHidden ? "no-hide-descendants" : undefined
      }
      testID="editor-wrapper"
      ref={editorRef}
      style={[
        {
          // Fullscreen is the note and nothing else: the whole measured width,
          // which on the iPad is exactly the pane the mode resolves for it (see
          // `resolvedEditorWidth` above).
          width: isFullscreen ? dimensions.width : resolvedEditorWidth,
          height: "100%",
          minHeight: "100%",
          /**
           * The editor WebView is transparent and paints its own background, so
           * whatever shows through it (a rounding gap, the 0.5px hairline under
           * the header, the rounding gap at the top of the pane) has to be the
           * editor's own background. The editor is the *document* pane of the
           * workspace, on Mac Catalyst and iPad alike, so it paints the shared
           * document surface (`visual.documentSurface`) - the same neutral role
           * the WebView's own page resolves to (see
           * packages/editor-mobile/src/App.tsx), which is what keeps the strip
           * above the header the same colour as the note behind it. Android and
           * other non-Apple clients keep their editor-toolbar surface.
           */
          backgroundColor: visual.ios
            ? visual.documentSurface
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
            // The editor surface is the shared document role on every Apple
            // client - the same value the wrapper above and the WebView's own
            // page use (see packages/editor-mobile/src/index.css) - so no gap
            // or keyboard-avoidance edge shows a different tone. Non-Apple
            // clients keep the elevated surface they had.
            backgroundColor: visual.ios
              ? visual.documentSurface
              : visual.contentSurface,
            flex: 1
          }}
          enabled={!floating}
          /**
           * iPad only: compensates for the top tab bar strip drawn above the
           * navigator (navigation-stack.tsx), which RN's own frame.y does not
           * include - without this, KeyboardAvoidingView undercounts the
           * keyboard by exactly that strip's height. This is correct as of
           * the first keyboardWillShow; it is a prop, not a live
           * subscription, so if the strip's height and this pane's height
           * ever moved independently of each other (no such case exists
           * today - a root layout change that changes one changes the
           * other, and that same layout change is what makes
           * KeyboardAvoidingView's own `onLayout` recompute) an offset-only
           * update with no layout height change would not by itself trigger
           * that recompute. Every other client keeps 0, unchanged.
           */
          keyboardVerticalOffset={isIPad ? topTabBarOffset : 0}
        >
          <TextInput
            key="input"
            ref={textInput}
            style={{ height: 1, padding: 0, width: 1, position: "absolute" }}
            blurOnSubmit={false}
          />
          {/**
           * The editor flexes; on Mac Catalyst a bounded assistant sidebar sits
           * beside it only when space allows; otherwise it is below. The layout lives inside the existing KeyboardAvoidingView, so
           * keyboard avoidance, insets and the fullscreen/pane sizing are
           * unchanged. Everywhere else the editor is rendered exactly as before
           * (the provider, and therefore the sidebar, is unsupported there).
           *
           * There is deliberately **no** "replace selected text" assistant
           * action in this slice. Documented blocker: the RN side has no
           * reliable *current* text selection to review against. The editor's
           * live ProseMirror selection never reaches RN — `EditorEvents.selection`
           * is unhandled here, `useEditorController.selectionChange` is a no-op
           * and the tab store's `session.selection` is only refreshed on a
           * debounced scroll or a note-load restore, so it can be stale/moved by
           * the time the user presses a button. An undoable replace therefore
           * exists only inside the editor-mobile WebView (e.g.
           * `commands.insertTemplate`'s single-transaction `insertContent`),
           * which also has *no* bridge command to read the selection back and
           * would silently whole-note-replace an empty note. Adding a reviewable
           * replace would require a new editor-mobile bridge command (read
           * selection + replace with undo) in `packages/editor-mobile`, which is
           * outside this task's allowed change scope — so the button is omitted
           * rather than faked against a stale selection.
           */}
          {isMacCatalyst() && isSIWCPlatformSupported() ? (
            <View
              testID="mac-editor-workspace"
              onLayout={(event) => {
                const { width, height } = event.nativeEvent.layout;
                setWorkspaceSize({ width, height });
              }}
              style={{
                flex: 1,
                flexDirection: inspectorDocked ? "row" : "column"
              }}
            >
              <View
                testID="mac-writing-pane"
                style={{ flex: 1, minWidth: 0, minHeight: 0 }}
              >
                <Editor key="editor" withController={true} />
              </View>
              <MacAssistantInspector
                visible={inspectorVisible}
                docked={inspectorDocked}
                height={
                  workspaceSize.height ||
                  Math.max(
                    0,
                    dimensions.height -
                      macToolbarInset(insets.top) -
                      insets.bottom
                  )
                }
                onClose={() =>
                  useMacWindowStore.getState().setInspectorVisible(false)
                }
              />
            </View>
          ) : (
            <Editor key="editor" withController={true} />
          )}
        </KeyboardAvoidingView>
      )}
    </View>
  );
};

export default EditorWrapper;
