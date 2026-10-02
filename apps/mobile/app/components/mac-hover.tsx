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

import { useThemeColors } from "@notesnook/theme";
import React from "react";
import { StyleProp, View, ViewStyle } from "react-native";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { isMacCatalyst } from "../utils/constants";

/**
 * Mac pointer feedback.
 *
 * A mouse has no touch-down before the click, so every row and bar button of
 * the Mac interface draws a subtle highlight while the pointer is over it.
 * `onHoverIn`/`onHoverOut` come from the indirect pointer events Catalyst
 * delivers for the mouse; iPhone and iPad never fire them (there is no pointer
 * unless hardware is attached, and the app ignores it there anyway because
 * `useMacHover` is a no-op off Mac).
 */

/** Corner radius of a hover highlight: the same 6 pt as a Mac row's selection. */
export const MAC_HOVER_RADIUS = 6;

/**
 * Opacity of the hover highlight: lower than the 0.2 accent of a selected row
 * so a hovered row can never be mistaken for the selected one.
 */
export const MAC_HOVER_OPACITY = 0.5;

/**
 * The note list's own hover wash (part 2 of the Mac glass design): a neutral
 * white over the dark list and black over the light one, weak enough that it
 * only reads as pointer feedback. Unlike the theme-driven default above, the
 * colour is baked in at this opacity and the layer is applied at full strength.
 */
export function macNoteRowHoverFill(isDark: boolean): {
  color: string;
  opacity: number;
} {
  return isDark
    ? { color: "#FFFFFF", opacity: 0.06 }
    : { color: "#000000", opacity: 0.04 };
}

type HoverProps = {
  onHoverIn?: () => void;
  onHoverOut?: () => void;
};

/**
 * `hovered` plus the props that drive it. Pass `hoverProps` to the Pressable
 * that owns the row/button and render `MacHoverHighlight` with `hovered`.
 */
export function useMacHover(enabled = true): {
  hovered: boolean;
  hoverProps: HoverProps;
} {
  const [pointerInside, setPointerInside] = React.useState(false);
  // `isMacCatalyst()` is `boolean | undefined` (Platform.isMacCatalyst is
  // optional), hence the explicit coercion.
  const active = enabled && isMacCatalyst() === true;
  const onHoverIn = React.useCallback(() => setPointerInside(true), []);
  const onHoverOut = React.useCallback(() => setPointerInside(false), []);
  return {
    hovered: active && pointerInside,
    // Spread into a Pressable (or a plain RN Pressable): the handlers are
    // inert where the platform never fires them.
    hoverProps: active ? { onHoverIn, onHoverOut } : {}
  };
}

/**
 * The highlight itself: a layer of its own (like the selection highlight) so
 * custom themes and their non-hex colors keep working, absolutely positioned
 * over the row/button it belongs to. Render it as the first child of the
 * pressed surface, with `hovered` from `useMacHover` and `visible` false
 * wherever a selection highlight already wins.
 */
export function MacHoverHighlight({
  visible,
  radius = MAC_HOVER_RADIUS,
  color,
  opacity = MAC_HOVER_OPACITY,
  style
}: {
  visible: boolean;
  radius?: number;
  /**
   * Override the wash's colour. The note list passes the neutral macOS hover
   * (see `macNoteRowHoverFill`) instead of the theme's hover colour.
   */
  color?: string;
  /** Override the wash's opacity (defaults to MAC_HOVER_OPACITY). */
  opacity?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  if (!visible) return null;
  return (
    <View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: radius,
          backgroundColor: color || visual.hoverSurface,
          opacity
        },
        style
      ]}
    />
  );
}
