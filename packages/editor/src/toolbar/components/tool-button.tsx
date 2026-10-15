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

import { useContext } from "react";
import { Theme } from "@notesnook/theme";
import { SchemeColors } from "@notesnook/theme";
import React from "react";
import { ButtonProps } from "@theme-ui/components";
import { IconNames, Icons } from "../icons.js";
import { ToolButtonVariant } from "../types.js";
import { Button } from "../../components/button.js";
import { Icon } from "@notesnook/ui";
import {
  IosFormatContext,
  PopupParentContext,
  PopupIdScopeContext,
  useIsMacCatalyst,
  useIsMobile
} from "../stores/toolbar-store.js";

export type ToolButtonProps = ButtonProps & {
  icon: IconNames;
  iconColor?: SchemeColors;
  iconSize?: keyof Theme["iconSizes"] | number;
  toggled?: boolean;
  buttonRef?: React.RefObject<HTMLButtonElement>;
  variant?: ToolButtonVariant;
};
export const ToolButton = React.memo(
  function ToolButton(props: ToolButtonProps) {
    const {
      id,
      icon,
      iconSize,
      iconColor,
      toggled,
      sx,
      buttonRef,
      children,
      variant = "normal",
      ...buttonProps
    } = props;
    const isMobile = useIsMobile();
    const isIosFormat = useContext(IosFormatContext);
    const popupParent = useContext(PopupParentContext);
    const popupScope = useContext(PopupIdScopeContext);
    const isMacCatalyst = useIsMacCatalyst();

    return (
      <Button
        variant="secondary"
        ref={buttonRef}
        tabIndex={isIosFormat || popupScope ? 0 : -1}
        id={`tool-${popupScope}${
          isIosFormat && popupParent ? `${popupParent}-` : ""
        }${id || icon}`}
        sx={{
          height: "unset",
          flexShrink: 0,
          p: variant === "small" ? "small" : 1,
          borderRadius: variant === "small" ? "small" : "default",
          ...(isMacCatalyst
            ? {
                // The Mac format bar's buttons are 28 pt (a 16 pt icon plus
                // 6 pt of padding) and are spaced by their group's 4 pt gap.
                p: "6px",
                mr: 0,
                borderRadius: "5px"
              }
            : {}),
          ...(isIosFormat ? { minWidth: 44, minHeight: 44 } : {}),
          m: 0,
          bg: toggled ? "background-selected" : "transparent",
          mr: variant === "small" || isMacCatalyst || isIosFormat ? 0 : 1,
          ":last-of-type": {
            mr: 0
          },
          ":hover:not(:disabled):not(:active)": !isMobile
            ? undefined
            : {
                bg: "transparent"
              },
          ...sx
        }}
        onMouseDown={(e) => {
          // iOS must preserve the text focus even while native keyboard events
          // lag (or a hardware keyboard is attached). Otherwise mousedown can
          // dismiss the keyboard and move this button before click arrives.
          if (isIosFormat || globalThis.keyboardShown) {
            e.preventDefault();
          }
        }}
        {...buttonProps}
      >
        <Icon
          path={Icons[icon]}
          color={iconColor || (toggled ? "icon-selected" : "icon")}
          size={
            iconSize ||
            (isIosFormat ? 22 : variant === "small" ? "medium" : "big")
          }
        />
        {children}
      </Button>
    );
  },
  (prev, next) => {
    return (
      prev.toggled === next.toggled &&
      prev.children === next.children &&
      prev.icon === next.icon &&
      prev.disabled === next.disabled &&
      prev.onClick === next.onClick &&
      JSON.stringify(prev.sx) === JSON.stringify(next.sx)
    );
  }
);
