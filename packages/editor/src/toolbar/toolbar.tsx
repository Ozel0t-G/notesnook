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

import { Flex, FlexProps } from "@theme-ui/components";
import {
  getDefaultPresets,
  STATIC_TOOLBAR_GROUPS,
  MOBILE_STATIC_TOOLBAR_GROUPS,
  READONLY_MOBILE_STATIC_TOOLBAR_GROUPS,
  READONLY_MOBILE_TOOLBAR_NODES
} from "./tool-definitions.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Editor } from "../types.js";
import { ToolbarGroup } from "./components/toolbar-group.js";
import { EditorFloatingMenus } from "./floating-menus/index.js";
import {
  ToolbarLocation,
  useIsMobile,
  useToolbarStore
} from "./stores/toolbar-store.js";
import { ToolbarDefinition, ToolbarGroupDefinition } from "./types.js";
import { ToolId } from "./tools/index.js";

type ToolbarProps = FlexProps & {
  editor: Editor;
  location: ToolbarLocation;
  tools?: ToolbarDefinition;
  defaultFontFamily: string;
  defaultFontSize: number;
  /**
   * Renders the Mac Catalyst format bar: one compact row that never scrolls,
   * with every group that does not fit collapsed into the existing "more"
   * popup at its end. Set by the mobile app's editor WebView.
   */
  macCatalyst?: boolean;
};

/**
 * Horizontal padding of the Mac toolbar row (each side).
 */
const MAC_TOOLBAR_ROW_PADDING = 6;
/**
 * Width reserved for the "more" button while deciding how many groups fit.
 * Close enough to a 28 pt icon button plus its separator; the row is measured
 * again once the button is actually rendered, which settles the count.
 */
const MAC_MORE_BUTTON_WIDTH = 40;

export function Toolbar(props: ToolbarProps) {
  const {
    editor,
    location,
    tools = getDefaultPresets().default,
    defaultFontFamily,
    defaultFontSize,
    macCatalyst,
    sx,
    className = "",
    ...flexProps
  } = props;
  const isMobile = useIsMobile();
  const isMac = !!macCatalyst;
  const toolbarTools = useMemo(
    () =>
      isMobile
        ? editor.isEditable
          ? [...MOBILE_STATIC_TOOLBAR_GROUPS, ...tools]
          : READONLY_MOBILE_STATIC_TOOLBAR_GROUPS
        : editor.isEditable
        ? [...STATIC_TOOLBAR_GROUPS, ...tools]
        : [],
    [tools, editor.isEditable, isMobile]
  );

  const isEmptyReadonlyToolbar =
    isMobile &&
    !editor.isEditable &&
    !READONLY_MOBILE_TOOLBAR_NODES.some((node) => editor.isActive(node));

  const setToolbarLocation = useToolbarStore(
    (store) => store.setToolbarLocation
  );
  const setDefaultFontFamily = useToolbarStore((store) => store.setFontFamily);
  const setDefaultFontSize = useToolbarStore((store) => store.setFontSize);
  const setMacCatalyst = useToolbarStore((store) => store.setMacCatalyst);

  useEffect(() => {
    setToolbarLocation(location);
  }, [location, setToolbarLocation]);

  useEffect(() => {
    setMacCatalyst(isMac);
  }, [isMac, setMacCatalyst]);

  useEffect(() => {
    setDefaultFontFamily(defaultFontFamily);
    setDefaultFontSize(defaultFontSize);
  }, [
    defaultFontFamily,
    defaultFontSize,
    setDefaultFontFamily,
    setDefaultFontSize
  ]);

  /**
   * Index of the first group that is moved into the "more" popup; equal to
   * the group count when everything fits (the common case on Mac).
   */
  const [overflowFrom, setOverflowFrom] = useState(toolbarTools.length);
  const measuredWidths = useRef<number[]>([]);
  const moreButtonWidth = useRef(MAC_MORE_BUTTON_WIDTH);
  // The `Flex` this measures renders a div, so the ref is typed to match.
  const rowRef = useRef<HTMLDivElement>(null);
  /**
   * Identity of the tools themselves. `tools` is a fresh array on every render
   * of the embedding app, so the groups are compared by their contents: only a
   * real change re-measures the row.
   */
  const toolsKey = useMemo(
    () => toolbarTools.map((group) => group.join("|")).join("||"),
    [toolbarTools]
  );
  const measuredToolsKey = useRef(toolsKey);

  useLayoutEffect(() => {
    if (!isMac) {
      if (overflowFrom !== toolbarTools.length)
        setOverflowFrom(toolbarTools.length);
      return;
    }
    const row = rowRef.current;
    if (!row) return;

    if (measuredToolsKey.current !== toolsKey) {
      // Different tools: start again from a row that shows every group, which
      // is what measures them.
      measuredToolsKey.current = toolsKey;
      measuredWidths.current = [];
      if (overflowFrom !== toolbarTools.length) {
        setOverflowFrom(toolbarTools.length);
        return;
      }
    }

    const measure = () => {
      const rowWidth = row.clientWidth;
      if (!rowWidth) return;
      const available = rowWidth - MAC_TOOLBAR_ROW_PADDING * 2;

      const children = Array.from(row.children).filter((child) =>
        child.classList.contains("toolbar-group")
      ) as HTMLElement[];
      const rendered = Math.min(children.length, toolbarTools.length);
      for (let i = 0; i < rendered; i++) {
        const width = children[i].offsetWidth;
        // The last rendered child is the "more" group when anything is
        // collapsed; remember its real width for the next measurement.
        if (i >= overflowFrom) moreButtonWidth.current = width;
        else measuredWidths.current[i] = width;
      }

      let used = 0;
      let fit = 0;
      for (let i = 0; i < toolbarTools.length; i++) {
        const width = measuredWidths.current[i] ?? Number.MAX_SAFE_INTEGER;
        const hidden = toolbarTools.length - (i + 1);
        // Every hidden group costs nothing extra: it lives inside the same
        // "more" button. Only the first hidden group needs room for it.
        const reserved = hidden > 0 && fit === i ? moreButtonWidth.current : 0;
        if (used + width + reserved > available) break;
        used += width + reserved;
        fit = i + 1;
      }

      if (fit !== overflowFrom) setOverflowFrom(fit);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
    // `overflowFrom` is a dependency on purpose: a collapse renders the row
    // again, which confirms (or corrects) the count with the real widths.
  }, [isMac, toolsKey, overflowFrom, toolbarTools.length]);

  const groups: ToolbarGroupDefinition[] = toolbarTools.slice(0, overflowFrom);
  const overflowTools: ToolId[] = toolbarTools
    .slice(overflowFrom)
    .reduce<ToolId[]>(
      (all, group) => all.concat(...(Array.isArray(group) ? group : [group])),
      []
    );
  // A nested array is how a group asks for the "more" button, so the merged
  // groups become one: [ [tool, tool, ...] ].
  if (overflowTools.length) groups.push([overflowTools]);

  return (
    <>
      {isEmptyReadonlyToolbar ? null : (
        <Flex
          ref={isMac ? rowRef : undefined}
          className={["editor-toolbar", className].join(" ")}
          sx={{
            flexWrap: isMac ? "nowrap" : isMobile ? "nowrap" : "wrap",
            overflowX: isMac || !isMobile ? "hidden" : "auto",
            bg: "background",
            borderRadius: isMac ? "0px" : isMobile ? "0px" : "default",
            ...(isMac
              ? {
                  alignItems: "center",
                  px: `${MAC_TOOLBAR_ROW_PADDING}px`,
                  minWidth: 0
                }
              : {}),
            ...sx
          }}
          {...flexProps}
        >
          {groups.map((tools, index) => {
            const groupId = tools.join("");
            return (
              <ToolbarGroup
                // The collapsed groups share the id of the "more" group they
                // are merged into, so index it as well.
                key={`${groupId}-${index}`}
                tools={tools}
                editor={editor}
                groupId={groupId}
                sx={{
                  ...(isMac
                    ? {
                        // Compact desktop spacing: 4 pt gaps between the
                        // buttons and 4 pt around a group, so its separator
                        // sits that far from the icons on either side.
                        p: 0,
                        px: "4px",
                        gap: "4px"
                      }
                    : {}),
                  borderRight: "1px solid var(--separator)",
                  ":last-of-type": { borderRight: "none" },
                  alignItems: "center"
                }}
              />
            );
          })}
        </Flex>
      )}
      <EditorFloatingMenus editor={editor} />
    </>
  );
}
