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
import {
  Editor,
  resolveToolbarGroups,
  TiptapOptions,
  Toolbar,
  useTiptap
} from "@notesnook/editor";
import { useEffect } from "react";
import { useTabContext } from "../hooks/useTabStore";
import { EmotionEditorToolbarTheme } from "../theme-factory";
import { Settings } from "../utils";
import {
  MAC_TOOLBAR_CAPSULE_BOTTOM,
  MAC_TOOLBAR_CAPSULE_HEIGHT
} from "../utils/mac";
export default function TiptapEditorWrapper(props: {
  options: Partial<TiptapOptions>;
  onEditorUpdate: (editor: Editor) => void;
  settings: Settings;
  /**
   * iOS document chrome only. `true` is the calm reading presentation: the
   * formatting toolbar stays *mounted* (its stores, tools and lifecycle are
   * untouched) but is hidden in CSS. Optional and defaulting to the previous
   * behaviour, so every other caller renders exactly as before.
   */
  readingPresentation?: boolean;
}) {
  const tab = useTabContext();
  const editor = useTiptap(props.options, [props.options]);
  globalThis.editors[tab.id] = editor;
  const isMac = props.settings.isMacCatalyst;
  /**
   * The compact iPhone/iPad toolbar is an opt-in of the *host*, not of the
   * settings payload: `__PLATFORM__` is injected by the native app before this
   * bundle runs (apps/mobile/app/screens/editor/index.tsx) and is `"ios"` for
   * iPhone, iPad *and* Mac Catalyst. Mac Catalyst is an iOS build, so its
   * `"ios"` is normalized off here - the Mac presentation (`isMac`) always
   * wins - and any other or unknown host (`"android"`, an unset global) stays
   * `false`, which keeps the previous web/Android toolbar exactly as it was.
   */
  const ios = globalThis.__PLATFORM__ === "ios" && !isMac;

  useEffect(() => {
    props.onEditorUpdate(editor);
  }, [editor, props]);

  return (
    <>
      {tab.session?.locked ? null : (
        <EmotionEditorToolbarTheme>
          <Toolbar
            className="theme-scope-editorToolbar"
            macCatalyst={isMac}
            /**
             * The host's compact-bar opt-in, forwarded alongside the Mac flag.
             * The shared toolbar uses it for the iOS-specific presentation of
             * the "Aa" format column; it stays `false` everywhere else, so the
             * previous web/Android bar is untouched.
             */
            ios={ios}
            sx={{
              /**
               * `noToolbar` is always honoured; the iOS quiet reading
               * presentation merely hides the (still mounted) toolbar. When
               * neither applies the bar is the previous flex row.
               */
              display:
                props.settings.noToolbar || props.readingPresentation
                  ? "none"
                  : "flex",
              overflowY: "hidden",
              minHeight: isMac ? MAC_TOOLBAR_CAPSULE_HEIGHT : "45px",
              ...(isMac
                ? {
                    /**
                     * The Mac format bar is a floating glass capsule centered
                     * horizontally 20 pt above the bottom of the editor pane,
                     * the way Pages floats its format bar over the page. It
                     * does not scroll: the note scroller reserves bottom
                     * padding for it (see `editor.tsx`).
                     */
                    position: "absolute",
                    bottom: MAC_TOOLBAR_CAPSULE_BOTTOM,
                    left: "50%",
                    transform: "translateX(-50%)",
                    zIndex: 998,
                    height: MAC_TOOLBAR_CAPSULE_HEIGHT,
                    maxWidth: "calc(100% - 40px)",
                    alignItems: "center"
                  }
                : globalThis.__PLATFORM__ === "ios" && {
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    right: 0
                  })
            }}
            editor={editor}
            /**
             * The Mac capsule floats at the bottom of the pane now, so its
             * popovers ("Aa", the "more" overflow) open upwards like the iOS
             * and Android bottom toolbar instead of downward past the edge.
             */
            location="bottom"
            /**
             * The quiet reading presentation hides the toolbar in CSS only. Its
             * zero-size rect must not anchor the automatic LinkSettings popup
             * (that would clip it above the status bar), so the automatic popup
             * is disabled while reading and returns with `Edit` (the tool and
             * its commands stay exactly as they are).
             */
            linkSettingsAutoOpen={!props.readingPresentation}
            /**
             * Same quiet-reading rationale as `linkSettingsAutoOpen` above,
             * for the toolbar's own popups ("more", "Aa", any nested menu):
             * an already-open popup renders through its own portal outside
             * the toolbar's (hidden) DOM subtree, so CSS alone cannot hide
             * it - it survives at the toolbar's clipped origin, above the
             * native app's own chrome. This gates only the popup's rendered
             * visibility; its open/pinned state in the toolbar store is left
             * untouched and reappears exactly as it was once `Edit` returns.
             */
            popupsVisible={!props.readingPresentation}
            tools={
              /**
               * The configured toolbar, resolved by the shared resolver from
               * the settings the native app sends: an explicit preset wins
               * (Mac Catalyst's "default" is the Notes-style simplified format
               * bar: one "Aa" popover plus list buttons), a legacy payload
               * without a preset keeps its exact stored groups, and a
               * first-frame payload without either gets the host default:
               * Mac Catalyst the Notes-style format bar, the opted-in iOS host
               * the compact iPhone/iPad bar.
               */
              resolveToolbarGroups({
                toolbarPreset: props.settings.toolbarPreset,
                tools: props.settings.tools,
                macCatalyst: isMac,
                ios
              })
            }
            defaultFontFamily={props.settings.fontFamily}
            defaultFontSize={props.settings.fontSize}
          />
        </EmotionEditorToolbarTheme>
      )}
    </>
  );
}
