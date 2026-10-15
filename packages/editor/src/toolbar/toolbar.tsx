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
import { useThemeColors } from "@notesnook/theme";
import {
  getDefaultPresets,
  IOS_TOOLBAR_GROUPS,
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
  IosFormatContext,
  LinkSettingsAutoOpenContext,
  ToolbarLocation,
  ToolbarPopupVisibilityContext,
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
  /**
   * Whether selecting a link may *automatically* open the `linkSettings`
   * popup. Defaults to `true` - the previous behaviour on every platform.
   *
   * The iOS quiet reading presentation supplies `false`: the toolbar stays
   * mounted (stores, tools and lifecycle untouched) but is hidden in CSS, and
   * its zero-size rect would anchor the automatic popup at the origin, clipped
   * above the status bar. Only the automatic popup is gated; the tool and its
   * commands remain reachable as soon as the flag is back to `true`.
   */
  linkSettingsAutoOpen?: boolean;
  /**
   * Requests the iPhone/iPad "Aa" format presentation: the existing Mac
   * format bar's "Aa" menu (`MacFormat`), reused as-is with every one of its
   * commands, but laid out as a single bounded vertical column instead of the
   * toolbar's default horizontal bottom row. Defaults to `false`, keeping
   * every other platform's layout unchanged.
   *
   * Normalized against `macCatalyst` for the Mac Catalyst capsule, which keeps
   * its own row layout regardless of this flag - see `isIosFormat` below.
   */
  ios?: boolean;
  /**
   * Whether the toolbar's own popups ("more", "Aa", any nested menu) may be
   * shown. Defaults to `true` - the previous behaviour on every platform.
   *
   * The iOS quiet reading presentation supplies `false`: the toolbar stays
   * mounted but is hidden in CSS only, while an already-open popup renders
   * through its own portal outside the toolbar's DOM subtree, so hiding the
   * bar does not hide it - it survives, anchored at the toolbar's clipped
   * origin. This flag gates only the popup's rendered *visibility*; its
   * `openedPopups` record (open, pinned, nested) is left completely alone, so
   * the popup reappears exactly as it was the moment the flag returns to
   * `true`.
   */
  popupsVisible?: boolean;
};

/**
 * How the toolbar row decides which groups fit.
 *
 * `mac` (Mac Catalyst capsule) and `mobile` (iPhone/iPad/Android bottom bar)
 * both render a single, non-wrapping row and move every group that does not
 * fit into the existing, localized "more" popup. `none` is the desktop web
 * toolbar: it keeps flowing and wrapping, so it is never measured.
 */
type ToolbarMeasureMode = "mac" | "mobile" | "none";

/**
 * Horizontal padding inside the Mac floating format capsule (each side).
 */
const MAC_TOOLBAR_ROW_PADDING = 14;
/**
 * Gap between the tool buttons inside the Mac floating format capsule.
 */
const MAC_TOOLBAR_BUTTON_GAP = 18;
/**
 * Corner radius of the Mac floating format capsule (half its 42 pt height).
 */
const MAC_TOOLBAR_CAPSULE_RADIUS = 21;
/**
 * Margin kept between the Mac floating capsule and the pane edges (20 pt each
 * side). Must match the `maxWidth: calc(100% - 40px)` the mobile app sets on
 * the toolbar in `tiptap.tsx`.
 */
const MAC_TOOLBAR_CAPSULE_MARGIN = 40;
/**
 * Width reserved for the "more" button while deciding how many groups fit.
 * Close enough to a 29 pt icon button plus its gap; the row is measured again
 * once the button is actually rendered, which settles the count.
 */
const MAC_MORE_BUTTON_WIDTH = 47;
/**
 * Width reserved for the "more" button on the measured mobile row before its
 * real width has been observed. It is a separate constant because the mobile
 * bar does not share the capsule's margins, padding or gaps; the row is
 * measured again once the button is rendered, which settles the count.
 */
const MOBILE_MORE_BUTTON_WIDTH = 47;

export function Toolbar(props: ToolbarProps) {
  const {
    editor,
    location,
    tools = getDefaultPresets().default,
    defaultFontFamily,
    defaultFontSize,
    macCatalyst,
    linkSettingsAutoOpen = true,
    ios = false,
    popupsVisible = true,
    sx,
    className = "",
    ...flexProps
  } = props;
  const isMobile = useIsMobile();
  const isMac = !!macCatalyst;
  // The Mac Catalyst capsule always keeps its own row layout: a toolbar can
  // only ever be one platform's presentation, so `ios` is ignored whenever
  // `macCatalyst` is also set.
  const isIosFormat = ios && !isMac;
  // Mac Catalyst runs inside the mobile WebView too (`isMobile` is true), so
  // the capsule branch wins, exactly like the row's `flexWrap`/`overflowX`.
  const measureMode: ToolbarMeasureMode = isMac
    ? "mac"
    : isMobile
    ? "mobile"
    : "none";
  const isMeasuredRow = measureMode !== "none";
  const { isDark } = useThemeColors();
  const isIosStandard =
    isIosFormat && JSON.stringify(tools) === JSON.stringify(IOS_TOOLBAR_GROUPS);
  const toolbarTools = useMemo(() => {
    if (!isMobile)
      return editor.isEditable ? [...STATIC_TOOLBAR_GROUPS, ...tools] : [];
    if (!editor.isEditable) return READONLY_MOBILE_STATIC_TOOLBAR_GROUPS;
    // The configured Insert owns its position, including inside More. Other
    // custom tools keep their order and the contextual prefix they had before.
    const hasInsert = tools.some((group) =>
      group.some((tool) =>
        Array.isArray(tool)
          ? tool.includes("insertBlock")
          : tool === "insertBlock"
      )
    );
    const context =
      isIosFormat && hasInsert
        ? MOBILE_STATIC_TOOLBAR_GROUPS.map((group) =>
            group.filter((tool) => tool !== "insertBlock")
          )
        : MOBILE_STATIC_TOOLBAR_GROUPS;
    return isIosStandard ? [...tools, ...context] : [...context, ...tools];
  }, [tools, editor.isEditable, isMobile, isIosFormat, isIosStandard]);

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
   * the group count when everything fits.
   */
  const [overflowFrom, setOverflowFrom] = useState(toolbarTools.length);
  const measuredWidths = useRef<number[]>([]);
  const moreButtonWidth = useRef(
    measureMode === "mac" ? MAC_MORE_BUTTON_WIDTH : MOBILE_MORE_BUTTON_WIDTH
  );
  // The `Flex` this measures renders a div, so the ref is typed to match.
  const rowRef = useRef<HTMLDivElement>(null);
  /**
   * Identity of the tools themselves. `tools` is a fresh array on every render
   * of the embedding app, so the groups are compared by their contents: only a
   * real change re-measures the row. Serialized structurally, not joined, so a
   * nested "more" subgroup cannot collide with a flat group of the same tools
   * (a custom preset can nest groups on every platform).
   */
  const toolsKey = useMemo(() => JSON.stringify(toolbarTools), [toolbarTools]);
  /**
   * Tools *and* row mode: the Mac capsule and the mobile bar have different
   * paddings, gaps and button metrics, so a switch between them must forget
   * the widths measured for the other one.
   */
  const measureKey = `${measureMode}:${toolsKey}`;
  const measuredKey = useRef(measureKey);

  useLayoutEffect(() => {
    if (measureMode === "none") {
      // Desktop web keeps its flowing, wrapping row: every group stays in the
      // DOM, so there is nothing to measure and nothing to collapse.
      measuredWidths.current = [];
      measuredKey.current = measureKey;
      if (overflowFrom !== toolbarTools.length)
        setOverflowFrom(toolbarTools.length);
      return;
    }
    const row = rowRef.current;
    if (!row) return;

    if (measuredKey.current !== measureKey) {
      // Different tools - or the row switched between the Mac capsule and the
      // mobile bar. Start again from a row that shows every group, which is
      // what measures them.
      measuredKey.current = measureKey;
      measuredWidths.current = [];
      moreButtonWidth.current =
        measureMode === "mac"
          ? MAC_MORE_BUTTON_WIDTH
          : MOBILE_MORE_BUTTON_WIDTH;
      if (overflowFrom !== toolbarTools.length) {
        setOverflowFrom(toolbarTools.length);
        return;
      }
    }

    const measure = () => {
      /**
       * The Mac capsule hugs its content, so measuring the row itself would
       * make the budget shrink as groups collapse (a feedback loop). The
       * mobile bar is likewise a full-width sibling whose own width must not
       * depend on how many groups are left in it. Measure the pane instead:
       * it is the stable width the row is fitted into.
       */
      const paneWidth = row.parentElement?.clientWidth || row.clientWidth;
      if (!paneWidth) return;

      /**
       * The Mac capsule floats with a 20 pt margin on each side, pads its row
       * and spaces its buttons; the mobile bar spans the pane edge to edge and
       * its groups carry their own padding and separators. The budget is
       * derived from those real metrics - never from the other platform's.
       */
      const available =
        measureMode === "mac"
          ? paneWidth -
            MAC_TOOLBAR_CAPSULE_MARGIN -
            MAC_TOOLBAR_ROW_PADDING * 2 -
            2
          : paneWidth;
      const gap = measureMode === "mac" ? MAC_TOOLBAR_BUTTON_GAP : 0;

      const children = Array.from(row.children).filter((child) =>
        child.classList.contains("toolbar-group")
      ) as HTMLElement[];
      const rendered = Math.min(children.length, toolbarTools.length);
      for (let i = 0; i < rendered; i++) {
        const width = children[i].offsetWidth;
        // The rendered child at the overflow boundary is the "more" group when
        // anything is collapsed; remember its real width for the next
        // measurement. Every other child is a natural group and keeps its
        // width until the tools or the mode change, so a later, wider viewport
        // can restore the groups that were collapsed here.
        if (i >= overflowFrom) moreButtonWidth.current = width;
        else measuredWidths.current[i] = width;
      }

      // No layout information at all (a hidden pane, a layout-less
      // environment): keep every group instead of collapsing the whole row
      // into "more" on a budget that does not exist.
      if (!measuredWidths.current.some((measured) => measured > 0)) return;

      /**
       * The complete row with no "more" button at all: every natural group plus
       * the real gaps *between* them, each gap counted exactly once. This is
       * decided only when every natural width is known, because a group that
       * has not been measured yet must never be treated as 0 - that would fake
       * an "everything fits" row. When the whole row fits, nothing has to be
       * collapsed, so no "more" budget is reserved for it.
       */
      let fullRowWidth = 0;
      let allKnown = true;
      for (let i = 0; i < toolbarTools.length; i++) {
        const width = measuredWidths.current[i];
        if (typeof width !== "number") {
          allKnown = false;
          break;
        }
        fullRowWidth += width;
      }
      if (allKnown) fullRowWidth += Math.max(toolbarTools.length - 1, 0) * gap;

      let fit = 0;
      if (allKnown && fullRowWidth <= available) {
        // The whole row fits as-is: keep every group and reserve no "more".
        fit = toolbarTools.length;
      } else {
        let used = 0;
        for (let i = 0; i < toolbarTools.length; i++) {
          const width = measuredWidths.current[i] ?? Number.MAX_SAFE_INTEGER;
          const hidden = toolbarTools.length - (i + 1);
          // Everything after group `i` collapses into the single trailing "more"
          // button, so the row then holds `i + 1` groups plus that one button.
          // The button is reserved exactly once, at this boundary - never once
          // per hidden group - and adds one gap of its own.
          const childrenCount = i + 1 + (hidden > 0 ? 1 : 0);
          const gaps = Math.max(childrenCount - 1, 0) * gap;
          const total =
            used + width + gaps + (hidden > 0 ? moreButtonWidth.current : 0);
          if (total > available) break;
          used += width;
          fit = i + 1;
        }
      }

      if (fit !== overflowFrom) setOverflowFrom(fit);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    // The pane's width sets the row's budget, and a content-hugging row does
    // not change size while it still fits, so watch the pane as well.
    if (row.parentElement) observer.observe(row.parentElement);
    return () => observer.disconnect();
    // `overflowFrom` is a dependency on purpose: a collapse renders the row
    // again, which confirms (or corrects) the count with the real widths.
  }, [measureMode, measureKey, overflowFrom, toolbarTools.length]);

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
    <LinkSettingsAutoOpenContext.Provider value={linkSettingsAutoOpen}>
      <IosFormatContext.Provider value={isIosFormat}>
        <ToolbarPopupVisibilityContext.Provider value={popupsVisible}>
          {isEmptyReadonlyToolbar ? null : (
            <Flex
              ref={isMeasuredRow ? rowRef : undefined}
              className={["editor-toolbar", className].join(" ")}
              sx={{
                // Both measured rows are a single line; only the desktop web row
                // flows onto a second line.
                flexWrap: isMeasuredRow ? "nowrap" : "wrap",
                // The mobile bar keeps its horizontal scroll as a fallback for a
                // row that is measured before it has any geometry.
                overflowX: measureMode === "mobile" ? "auto" : "hidden",
                ...(isMac
                  ? {
                      /**
                       * The Mac format bar is a floating "Liquid Glass" capsule:
                       * translucent background, blurred behind, hairline inset
                       * border and a soft shadow. See `utils/mac.ts` for the
                       * metrics and `tiptap.tsx` for its position.
                       */
                      alignItems: "center",
                      gap: `${MAC_TOOLBAR_BUTTON_GAP}px`,
                      px: `${MAC_TOOLBAR_ROW_PADDING}px`,
                      minWidth: 0,
                      boxSizing: "border-box",
                      borderRadius: `${MAC_TOOLBAR_CAPSULE_RADIUS}px`,
                      background: isDark
                        ? "rgba(58, 58, 66, 0.55)"
                        : "rgba(255, 255, 255, 0.65)",
                      backdropFilter: "blur(30px) saturate(1.8)",
                      WebkitBackdropFilter: "blur(30px) saturate(1.8)",
                      border: isDark
                        ? "1px solid rgba(255, 255, 255, 0.16)"
                        : "1px solid rgba(0, 0, 0, 0.08)",
                      boxShadow: "0 8px 30px rgba(0, 0, 0, 0.35)"
                    }
                  : {
                      bg: "background",
                      borderRadius: isMobile ? "0px" : "default"
                    }),
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
                            // Uniform 18 pt gaps between the capsule's buttons:
                            // neither the group nor the row adds extra padding or
                            // separators, so the rhythm is the same inside a group
                            // and across a group boundary.
                            p: 0,
                            px: 0,
                            gap: `${MAC_TOOLBAR_BUTTON_GAP}px`
                          }
                        : isIosFormat
                        ? { p: "2px", gap: 0 }
                        : {
                            borderRight: "1px solid var(--separator)",
                            ":last-of-type": { borderRight: "none" }
                          }),
                      alignItems: "center"
                    }}
                  />
                );
              })}
            </Flex>
          )}
        </ToolbarPopupVisibilityContext.Provider>
        <EditorFloatingMenus editor={editor} />
      </IosFormatContext.Provider>
    </LinkSettingsAutoOpenContext.Provider>
  );
}
