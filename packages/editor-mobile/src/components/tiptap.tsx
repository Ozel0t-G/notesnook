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
  getMacToolbarGroups,
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
}) {
  const tab = useTabContext();
  const editor = useTiptap(props.options, [props.options]);
  globalThis.editors[tab.id] = editor;
  const isMac = props.settings.isMacCatalyst;

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
            sx={{
              display: props.settings.noToolbar ? "none" : "flex",
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
            tools={
              /**
               * On Mac the toolbar is the Notes-style simplified format bar
               * (WP08 R6): one "Aa" popover plus list buttons instead of the
               * mobile web toolbar. Every other platform keeps the toolbar
               * from the app settings unchanged.
               */
              isMac
                ? getMacToolbarGroups()
                : Array.isArray(props.settings.tools)
                ? [...props.settings.tools]
                : []
            }
            defaultFontFamily={props.settings.fontFamily}
            defaultFontSize={props.settings.fontSize}
          />
        </EmotionEditorToolbarTheme>
      )}
    </>
  );
}
