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

import { getFontById, replaceDateTime } from "@notesnook/editor";
import React, { RefObject, useCallback, useEffect, useRef } from "react";
import { EditorController } from "../hooks/useEditorController";
import { useTabContext } from "../hooks/useTabStore";
import {
  MAC_TEXT_COLUMN_MAX_WIDTH,
  MAC_TEXT_COLUMN_PADDING,
  MAC_TITLE_FONT_SIZE,
  MAC_TITLE_LINE_HEIGHT
} from "../utils/mac";
import styles from "./styles.module.css";
function Title({
  controller,
  title,
  titlePlaceholder,
  readonly,
  fontFamily,
  dateFormat,
  timeFormat,
  loading
}: {
  controller: RefObject<EditorController>;
  title: string;
  titlePlaceholder: string;
  readonly: boolean;
  fontFamily: string;
  dateFormat: string;
  timeFormat: string;
  loading?: boolean;
}) {
  const tab = useTabContext();
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const titleSizeDiv = useRef<HTMLDivElement>(null);
  /**
   * E1/R7 + E2: on Mac the title shares the centered 46 rem text column of
   * the note body and is set at 22 pt/700 with a matching line height. The
   * hidden measuring div and the textarea use the exact same metrics, so the
   * textarea keeps auto-growing to the right height. iPhone, iPad and Android
   * keep the 25 pt title at the full pane width.
   */
  const isMacCatalyst = globalThis.isMacCatalyst ?? false;
  const titleFontSize = isMacCatalyst ? MAC_TITLE_FONT_SIZE : 25;
  const titleFontWeight = isMacCatalyst ? 700 : 600;
  const titleLineHeight = isMacCatalyst
    ? `${MAC_TITLE_LINE_HEIGHT}px`
    : undefined;
  const titlePadding = isMacCatalyst ? MAC_TEXT_COLUMN_PADDING : 16;
  const titleColumnStyle: React.CSSProperties = isMacCatalyst
    ? { maxWidth: MAC_TEXT_COLUMN_MAX_WIDTH, margin: "0 auto" }
    : {};

  const resizeTextarea = useCallback(() => {
    if (!titleSizeDiv.current || !titleRef.current) return;
    titleSizeDiv.current.innerText = titleRef.current.value;
    titleRef.current.style.height = `${titleSizeDiv.current.clientHeight}px`;
    titleRef.current.style.minHeight = `${titleSizeDiv.current.clientHeight}px`;
    titleSizeDiv.current.style.width = `${titleRef.current.clientWidth}px`;
  }, []);
  useEffect(() => {
    if (titleRef.current) {
      titleRef.current.value = title;
      resizeTextarea();
    }

    window.addEventListener("resize", resizeTextarea);
    return () => {
      window.removeEventListener("resize", resizeTextarea);
    };
  }, [resizeTextarea, title]);

  useEffect(() => {
    globalThis.editorTitles[tab.id] = titleRef;
    return () => {
      globalThis.editorTitles[tab.id] = undefined;
    };
  }, [tab.id, titleRef]);

  useEffect(() => {
    if (!loading) {
      resizeTextarea();
      setTimeout(() => {
        resizeTextarea();
      }, 100);
    }
  }, [loading, resizeTextarea]);

  return loading ? null : (
    <>
      <div
        ref={titleSizeDiv}
        style={{
          width: "100%",
          maxWidth: isMacCatalyst ? MAC_TEXT_COLUMN_MAX_WIDTH : "100%",
          minHeight: 40,
          opacity: 0,
          paddingRight: titlePadding,
          paddingLeft: titlePadding,
          fontWeight: titleFontWeight,
          lineHeight: titleLineHeight,
          fontFamily: getFontById(fontFamily)?.font || "Inter",
          boxSizing: "border-box",
          fontSize: titleFontSize,
          zIndex: -1,
          position: "absolute",
          userSelect: "none",
          WebkitUserSelect: "none",
          pointerEvents: "none",
          overflowWrap: "anywhere",
          paddingTop: 3,
          whiteSpace: "break-spaces"
        }}
      />
      <textarea
        ref={titleRef}
        className={styles.titleBar}
        id="editor-title"
        rows={1}
        contentEditable={!readonly}
        readOnly={readonly}
        defaultValue={title}
        style={{
          ...titleColumnStyle,
          height: 40,
          minHeight: 40,
          fontSize: titleFontSize,
          width: "100%",
          boxSizing: "border-box",
          border: 0,
          opacity: 1,
          paddingRight: titlePadding,
          paddingLeft: titlePadding,
          fontWeight: titleFontWeight,
          lineHeight: titleLineHeight,
          fontFamily: getFontById(fontFamily)?.font || "Inter",
          backgroundColor: "transparent",
          color: "var(--nn_primary_heading)",
          caretColor: "var(--nn_primary_accent)",
          borderRadius: 0,
          overflow: "hidden",
          overflowX: "hidden",
          overflowY: "hidden"
        }}
        maxLength={1000}
        onInput={(event) => {
          resizeTextarea();
          (event.target as HTMLTextAreaElement).value = replaceDateTime(
            (event.target as HTMLTextAreaElement).value,
            dateFormat,
            timeFormat as "12-hour" | "24-hour"
          );
          controller.current?.titleChange(
            (event.target as HTMLTextAreaElement).value
          );
        }}
        onKeyDown={(e) => {
          const editor = editors[tab.id];
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            editor?.commands.focus();
          }
        }}
        onPaste={() => {
          resizeTextarea();
        }}
        onCut={() => {
          resizeTextarea();
        }}
        placeholder={titlePlaceholder}
      />
    </>
  );
}

export default React.memo(Title, (prev, next) => {
  if (
    prev.title !== next.title ||
    prev.titlePlaceholder !== next.titlePlaceholder ||
    prev.readonly !== next.readonly ||
    prev.fontFamily !== next.fontFamily ||
    prev.loading !== next.loading
  )
    return false;

  return true;
});
