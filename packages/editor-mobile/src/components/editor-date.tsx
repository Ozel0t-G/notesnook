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

import React, { useEffect, useState } from "react";
import { useTabContext } from "../hooks/useTabStore";
import { editorDate } from "../utils/editor-date";
import {
  MAC_TEXT_COLUMN_MAX_WIDTH,
  MAC_TEXT_COLUMN_PADDING
} from "../utils/mac";

/**
 * The note's last-edited date/time, shown above the note title in 12 pt
 * secondary text. The value comes from the existing `setStatus` command (see
 * `utils/editor-date.ts`) - a real, app-supplied date, never a fabricated
 * "now". It renders on Mac Catalyst (inside the centered text column) and in
 * the iOS document chrome (at the note's ordinary full width); Android and any
 * other host render nothing. Renders nothing until the app has reported a date
 * for the tab, so locked/empty notes stay clean.
 */
function EditorDate({ showOrigin = true }: { showOrigin?: boolean }) {
  const tab = useTabContext();
  const [date, setDate] = useState(() => editorDate.get(tab.id));
  useEffect(() => {
    setDate(editorDate.get(tab.id));
    return editorDate.subscribe(tab.id, setDate);
  }, [tab.id]);

  const origin =
    showOrigin && !globalThis.isMacCatalyst && globalThis.__PLATFORM__ === "ios"
      ? tab.session?.origin
      : undefined;
  if (!date && !origin?.title) return null;

  /**
   * Mac centers the note in a 46 rem text column and pads it 24 pt; iPhone and
   * iPad keep the full-width note column with its usual 16 pt inset, so the
   * date lines up with the title and body on either surface.
   */
  const isMacCatalyst = globalThis.isMacCatalyst ?? false;

  return (
    <p
      style={{
        width: "100%",
        ...(isMacCatalyst
          ? {
              maxWidth: MAC_TEXT_COLUMN_MAX_WIDTH,
              margin: "0 auto",
              paddingLeft: MAC_TEXT_COLUMN_PADDING,
              paddingRight: MAC_TEXT_COLUMN_PADDING
            }
          : {
              paddingLeft: 16,
              paddingRight: 16,
              marginTop: 0,
              marginBottom: 8,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }),
        boxSizing: "border-box",
        fontSize: 12,
        lineHeight: "16px",
        color: "var(--nn_secondary_paragraph)",
        fontFamily: isMacCatalyst
          ? "Inter"
          : "-apple-system, BlinkMacSystemFont, sans-serif",
        userSelect: "none"
      }}
    >
      {origin?.title ? (
        <>
          <span title={origin.title}>{origin.title}</span>
          {date ? " · " : ""}
        </>
      ) : null}
      {date}
    </p>
  );
}

export default React.memo(EditorDate);
