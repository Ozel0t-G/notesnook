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

import { Text } from "@theme-ui/components";
import { useContext, useEffect, useRef } from "react";
import { PopupWrapper } from "../../components/popup-presenter/index.js";
import { ToolButton } from "../components/tool-button.js";
import {
  PopupParentContext,
  IosFormatContext,
  usePopupManager,
  useIsMobile,
  useIsMacCatalyst,
  useToolbarLocation
} from "../stores/toolbar-store.js";
import { ToolProps } from "../types.js";
import { getToolbarElement } from "../utils/dom.js";
import { ToolId } from "../tools/index.js";
import { ToolbarGroup } from "./toolbar-group.js";

type MoreToolsProps = ToolProps & {
  popupId: string;
  triggerId?: string;
  visibleLabel?: string;
  tools: ToolId[];
  autoCloseOnUnmount?: boolean;
  autoOpen?: boolean;
  group?: string;
};
export function MoreTools(props: MoreToolsProps) {
  const { popupId, editor, tools, autoCloseOnUnmount, autoOpen } = props;
  const { triggerId, visibleLabel, ...triggerProps } = props;
  const toolbarLocation = useToolbarLocation();
  const isBottom = toolbarLocation === "bottom";
  const group = isBottom ? "mobile" : "toolbarGroup";
  const buttonRef = useRef<HTMLButtonElement>(null);
  // When this "more" button is itself rendered inside another popup (a nested
  // "more" group), remember that parent so opening it does not close the popup
  // it lives in. Top-level "more" buttons have no parent.
  //
  // The parent must come *only* from the enclosing popup context - never from
  // the `parentGroup` toolbar-group id. A group's id is the join of its tool
  // ids, so a collapsed single-tool group has `groupId === popupId` (e.g.
  // `[["headings"]]` in group `"headings"`): taking that id as the parent would
  // record the popup as its own parent, and `togglePinned` /
  // `toggleChildState` would then recurse on that self-record forever.
  const parent = useContext(PopupParentContext);
  const { open, toggle, isOpen, isPinned, togglePinned } = usePopupManager({
    id: popupId,
    group,
    parent
  });
  const isMobile = useIsMobile();
  const isMacCatalyst = useIsMacCatalyst();
  const useMobileWrap = isMobile && !isMacCatalyst;
  const isIosFormat = useContext(IosFormatContext);

  useEffect(() => {
    if (autoOpen) {
      open();
      togglePinned();
    }
  }, [autoOpen]);

  return (
    <>
      <ToolButton
        {...triggerProps}
        id={triggerId}
        sx={
          visibleLabel
            ? {
                width: "100%",
                display: "flex",
                alignItems: "center",
                flexDirection: "row-reverse",
                justifyContent: "space-between",
                border: "1px solid",
                borderColor: "border",
                px: "small"
              }
            : undefined
        }
        toggled={isOpen}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        buttonRef={buttonRef}
        onClick={toggle}
      >
        {visibleLabel ? (
          <Text sx={{ mr: "small", fontSize: "title", whiteSpace: "nowrap" }}>
            {visibleLabel}
          </Text>
        ) : null}
      </ToolButton>
      <PopupWrapper
        scope="editorToolbar"
        group={group}
        id={popupId}
        position={{
          isTargetAbsolute: true,
          target: isBottom ? getToolbarElement() : buttonRef.current || "mouse",
          align: "center",
          location: isBottom ? "top" : "below",
          yOffset: 10
        }}
        autoCloseOnUnmount={autoCloseOnUnmount}
        focusOnRender={false}
        blocking={false}
        sx={{
          display: "flex",
          boxShadow: "menu",
          bg: "background",
          // the [0, 0, "small"] breakpoint array collapses to 0 on mobile, which
          // would leave wrapped rows flush against each other; reuse the same
          // "4px" token already used for padding below as an explicit row gap.
          gap: useMobileWrap ? "4px" : [0, 0, "small"],
          p: ["4px", "4px", "small"],
          flex: 1,
          borderRadius: "default",
          maxWidth: "95vw",
          ...(useMobileWrap
            ? {
                flexWrap: "wrap",
                boxSizing: "border-box",
                overflowX: "hidden",
                overflowY: "auto",
                maxHeight: "70vh"
              }
            : {
                overflowX: "auto"
              })
        }}
      >
        {/* Everything rendered inside this popup is a child of `popupId`, so a
            nested dropdown/tool popup records it as its `parent`. This keeps
            More open while the child menu is used and lets closing More close
            the child. The provider renders no DOM node. */}
        <PopupParentContext.Provider value={popupId}>
          <ToolbarGroup
            tools={tools}
            editor={editor}
            groupId={popupId}
            sx={{
              p: 0,
              borderRight: autoOpen ? "none" : "1px solid var(--border)",
              pr: autoOpen ? 0 : ["4px", "4px", "small"],
              mr: autoOpen ? 0 : ["4px", "4px", "small"],
              ...(useMobileWrap
                ? {
                    flexWrap: "wrap",
                    minWidth: 0,
                    flexShrink: 1,
                    gap: "4px",
                    ...(isIosFormat
                      ? {
                          alignItems: "center",
                          alignContent: "flex-start",
                          // WKWebView must size controls by their own wrapped row,
                          // not 100% of the whole group. Double specificity beats
                          // each child's legacy height regardless of Emotion order.
                          "&& > *": { height: "auto", minHeight: 44 }
                        }
                      : {})
                  }
                : {})
            }}
          />
          {autoOpen ? null : (
            <ToolButton
              toggled={isPinned}
              onClick={togglePinned}
              icon="pin"
              variant="small"
            />
          )}
        </PopupParentContext.Provider>
      </PopupWrapper>
    </>
  );
}
