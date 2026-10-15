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

import { useContext, useRef } from "react";
import { Text } from "@theme-ui/components";
import { Icon, MenuItem, MenuPresenter } from "@notesnook/ui";
import { Icons } from "../icons.js";
import {
  IosFormatContext,
  PopupParentContext,
  ToolbarPopupVisibilityContext,
  useIsMobile,
  usePopupManager,
  useToolbarLocation
} from "../stores/toolbar-store.js";
import { getToolbarElement } from "../utils/dom.js";
import { Button } from "../../components/button.js";

type DropdownProps = {
  id: string;
  group: string;
  selectedItem: string | JSX.Element;
  items: MenuItem[];
  buttonRef?: React.MutableRefObject<HTMLButtonElement | undefined>;
  menuWidth?: number;
  disabled?: boolean;
  /**
   * Opts the popup into a single bounded vertical column instead of the
   * default bottom-toolbar horizontal row. `undefined` (the default) keeps
   * every existing Dropdown's layout exactly as it was. Only `MacFormat`'s
   * "Aa" menu sets this, for the iPhone/iPad "Aa" presentation.
   */
  menuLayout?: "column";
  /** Accessible name for the trigger button; does not change its visible label. */
  ariaLabel?: string;
};
export function Dropdown(props: DropdownProps) {
  const {
    id,
    group,
    items,
    selectedItem,
    buttonRef,
    menuWidth,
    disabled,
    menuLayout,
    ariaLabel
  } = props;
  const internalRef = useRef<HTMLButtonElement>();
  const toolbarLocation = useToolbarLocation();
  const isMobile = useIsMobile();
  const isBottom = toolbarLocation === "bottom";
  const isIosFormat = useContext(IosFormatContext);
  // A dropdown rendered inside the "more" popup is nested in it: remembering
  // the parent keeps More open when this menu opens and lets closing More
  // cascade to this menu. `MoreTools` provides the id for everything it
  // renders; a top-level dropdown has no parent.
  const parent = useContext(PopupParentContext);
  const { isOpen, toggle, close } = usePopupManager({ group, id, parent });
  // Unconditional, like `PopupWrapper`: every `Dropdown`'s presenter honours
  // its enclosing `Toolbar`'s quiet-presentation flag; the context default
  // (`true`) keeps a `Dropdown` rendered outside any `Toolbar` unaffected.
  const popupsVisible = useContext(ToolbarPopupVisibilityContext);

  return (
    <>
      <Button
        variant="secondary"
        ref={(ref) => {
          internalRef.current = ref || undefined;
          if (buttonRef) buttonRef.current = ref || undefined;
        }}
        aria-label={ariaLabel}
        sx={{
          p: 1,
          m: 0,
          bg: isOpen ? "hover" : "transparent",
          height: "100%",
          ...(isIosFormat ? { minWidth: 44, minHeight: 44 } : {}),
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          ":last-of-type": {
            mr: 0
          },
          ":hover:not(:disabled):not(:active)": !isMobile
            ? undefined
            : {
                bg: "transparent"
              }
        }}
        disabled={disabled}
        onClick={toggle}
        onMouseDown={(e) => e.preventDefault()}
      >
        {typeof selectedItem === "string" ? (
          <Text
            sx={{
              fontSize: isIosFormat ? "title" : "subBody",
              mr: 1,
              color: isOpen ? "accent" : "paragraph",
              flexShrink: 0
            }}
          >
            {selectedItem}
          </Text>
        ) : (
          selectedItem
        )}
        <Icon
          path={
            isBottom
              ? isOpen
                ? Icons.chevronDown
                : Icons.chevronUp
              : isOpen
              ? Icons.chevronUp
              : Icons.chevronDown
          }
          color={isOpen ? "accent" : "paragraph"}
          size={"small"}
        />
      </Button>

      <MenuPresenter
        isOpen={isOpen && popupsVisible}
        items={items}
        onClose={close}
        menuLayout={menuLayout}
        position={{
          target: isBottom
            ? getToolbarElement()
            : internalRef.current || "mouse",
          isTargetAbsolute: true,
          location: isBottom ? "top" : "below",
          align: "center",
          yOffset: 5
        }}
        blocking={!isMobile}
        focusOnRender={!isMobile}
        onMouseDown={(e) => {
          if (globalThis.keyboardShown) {
            e.preventDefault();
          }
        }}
        sx={{
          minWidth:
            menuLayout === "column" && menuWidth
              ? `min(${menuWidth}px, 95vw)`
              : menuWidth,
          maxWidth:
            menuLayout === "column" && menuWidth
              ? `min(${menuWidth}px, 95vw)`
              : isBottom
              ? "95vw"
              : "auto",
          flexDirection:
            menuLayout === "column" ? "column" : isBottom ? "row" : "column",
          overflowX:
            menuLayout === "column" ? "hidden" : isBottom ? "auto" : "hidden",
          marginRight: isBottom ? "10px" : 0,
          display: "flex",
          alignItems:
            menuLayout === "column" ? "unset" : isBottom ? "center" : "unset",
          mr: isBottom ? 0 : 2,
          // Bounded, reusing the same 70vh cap `MoreTools` already uses for
          // its wrapped mobile popup. The outer `<ul>` sets its own
          // `overflowY: hidden` here (alongside `overflowX: hidden`) so it
          // is not itself user-scrollable; `hidden` still permits
          // programmatic scrolling (e.g. `scrollIntoView`/focus) - this is
          // not a claim that the outer `<ul>` is no scroll container at
          // all, only that it no longer offers its own user-driven
          // scrollbar/touch-scroll alongside the inner one. The inner
          // `ScrollContainer` (see `menuLayout` on `MenuContainer`) is left
          // as the sole *user*-scrollable element, shrinking to (and
          // scrolling within) this cap. Two nested elements both offering
          // their own user-scroll is consistent with the symptom this is
          // working around - the column menu rendering blank until a
          // touch/drag nudged layout - but that has not been confirmed
          // against the rendering engine; it is a hypothesis consistent with
          // the symptom, not a verified root cause.
          ...(menuLayout === "column"
            ? { maxHeight: "70vh", overflowY: "hidden" }
            : {})
        }}
      />
    </>
  );
}
