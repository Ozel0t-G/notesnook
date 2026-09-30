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
import { Editor, TiptapOptions, Toolbar, useTiptap } from "@notesnook/editor";
import { useEffect } from "react";
import { useTabContext } from "../hooks/useTabStore";
import { EmotionEditorToolbarTheme } from "../theme-factory";
import { Settings } from "../utils";
import {
  MAC_EDITOR_HEADER_HEIGHT,
  MAC_TOOLBAR_HEIGHT
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
  /**
   * Top of the Mac format bar: directly under the editor header, which fills
   * the window's title bar row (`header.tsx`) - or nothing when the header is
   * hidden, in which case the bar starts at the top of the pane itself.
   */
  const macToolbarTop = props.settings.noHeader ? 0 : MAC_EDITOR_HEADER_HEIGHT;

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
              minHeight: isMac ? MAC_TOOLBAR_HEIGHT : "45px",
              ...(isMac
                ? {
                    /**
                     * The Mac format bar is pinned to the top of the editor,
                     * right under the 52 pt header, the way Pages and Notes
                     * put it. It does not scroll: the editor's content is
                     * padded down by its height (see `editor.tsx`) and then
                     * scrolls underneath it.
                     */
                    position: "absolute",
                    top: macToolbarTop,
                    left: 0,
                    right: 0,
                    zIndex: 998,
                    height: MAC_TOOLBAR_HEIGHT,
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
            location={isMac ? "top" : "bottom"}
            tools={
              Array.isArray(props.settings.tools)
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
