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
import {
  Platform,
  requireNativeComponent,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle
} from "react-native";
import { isMacCatalyst } from "../utils/constants";
import { getColorLinearShade } from "../utils/colors";
import {
  macGlassPanelBackground,
  macWindowBackground
} from "../utils/mac-layout";

/**
 * The native Mac Catalyst Liquid Glass surface (`VeyraNGlassView`).
 *
 * On Mac this renders the native material as a background layer of its own:
 * the native view fills the container with `absoluteFill` and the React
 * children are ordinary siblings on top of it, in a plain `View`. The children
 * are deliberately *not* the native view's own React subviews: keeping them in
 * a plain container means the panel's flex layout (list `flex: 1`, footer last)
 * is resolved by React Native's layout engine like any other view, which is
 * what pins the sidebar's account footer to the panel's bottom instead of
 * letting it land at the top of the panel.
 *
 * Everywhere else it degrades to a plain `View` with the same style, so a
 * caller is safe to use it without a platform check.
 *
 * `variant` picks the corner treatment: "sidebar" and "card" use
 * `cornerRadius`, "capsule" derives it from the view's height. `interactive`
 * and `tint` only reach the native glass on Mac; the glass's appearance always
 * follows the *app* theme (`useThemeColors().isDark`), not the system's.
 *
 * The tint defaults to a few-percent shade of the theme's primary background -
 * lighter in dark mode, darker in light mode - so the panel reads as the same
 * surface as the window, just slightly lifted, instead of the bright grey slab
 * the un-tinted system material renders over the near-black window. Callers can
 * still pass their own `tint`.
 *
 * The tint alone is not enough: on macOS 26 the Liquid Glass material still
 * composites to a much lighter grey than the window (measured ~#454449 over a
 * #17181a window in dark mode) because the glass blurs and lifts whatever is
 * behind it. So for the panel variants ("sidebar", "card") a solid overlay of
 * the theme's primary background is drawn on top of the glass at `dimOpacity`
 * (0.82 dark / 0.7 light), pulling the fill back to roughly the window colour
 * (#1f2023) while the native glass rim underneath stays visible. "capsule" is
 * a small, self-contained control and keeps the raw material.
 */

export type MacGlassVariant = "sidebar" | "card" | "capsule";

/**
 * Default opacity of the panel-colour overlay over the glass, per appearance.
 * Chosen so the sidebar reads as the same surface, only slightly lifted, and
 * never disappears into the window: dark (#454449 glass over a #17181a window
 * -> ~#1f2023 at 0.82) and light (the glass over the #F3F3F5 window is dimmed
 * to the slightly darker #E9E9EC sidebar grey at 0.82).
 */
const DEFAULT_DIM_OPACITY_DARK = 0.82;
const DEFAULT_DIM_OPACITY_LIGHT = 0.82;

/**
 * The native glass draws its 1 px specular rim *inside* its bounds, so the
 * overlay is inset by 1 px to leave that edge highlight visible.
 */
const GLASS_EDGE_INSET = 1;

type NativeGlassProps = {
  cornerRadius?: number;
  variant?: MacGlassVariant;
  interactive?: boolean;
  tint?: string;
  /** Forces the material into the app's appearance (Mac Catalyst only). */
  dark?: boolean;
  /**
   * Opacity of the solid theme-background overlay drawn over the glass for the
   * "sidebar"/"card" variants (ignored for "capsule"). Defaults to 0.82 in
   * dark mode and 0.7 in light mode; pass a value to tune the lift.
   */
  dimOpacity?: number;
  /** The glass is a background layer: it must never take touches. */
  pointerEvents?: "none" | "box-none" | "box-only" | "auto";
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

const NativeGlassView =
  Platform.OS === "ios"
    ? requireNativeComponent<NativeGlassProps>("VeyraNGlassView")
    : undefined;

export function MacGlassView({
  variant = "card",
  cornerRadius = 0,
  interactive = false,
  tint,
  dimOpacity,
  style,
  children
}: NativeGlassProps) {
  const { colors, isDark } = useThemeColors();
  // "capsule" derives its radius from the view's height, which is only known
  // after layout; the container below needs it to clip the children to the
  // same rounded shape as the glass.
  const [capsuleRadius, setCapsuleRadius] = React.useState(0);
  /**
   * The default glass tint: the window's primary background lifted a few
   * percent, so the panel is only just distinguishable from the surface it
   * floats over (macOS 26 Notes' sidebar). `getColorLinearShade` lightens in
   * dark mode and darkens in light mode, so both appearances get the same
   * subtle lift. The shade itself is applied by the native view as the glass's
   * `tintColor` (see VeyraNGlassView.swift).
   */
  const themeTint = React.useMemo(
    () => getColorLinearShade(macWindowBackground(colors, isDark), 0.05, isDark),
    [colors.primary.background, isDark]
  );

  if (!isMacCatalyst() || !NativeGlassView)
    return <View style={style}>{children}</View>;

  const radius = variant === "capsule" ? capsuleRadius : cornerRadius;
  // Only the panel variants get the overlay: a "capsule" is a small control
  // whose material should stay as-is.
  const dimmed = variant !== "capsule";
  const resolvedDimOpacity =
    dimOpacity ??
    (isDark ? DEFAULT_DIM_OPACITY_DARK : DEFAULT_DIM_OPACITY_LIGHT);

  return (
    <View
      style={[style, { borderRadius: radius, overflow: "hidden" }]}
      onLayout={
        variant === "capsule"
          ? (event) => setCapsuleRadius(event.nativeEvent.layout.height / 2)
          : undefined
      }
    >
      <NativeGlassView
        variant={variant}
        cornerRadius={cornerRadius}
        interactive={interactive}
        tint={tint ?? themeTint}
        // The glass follows the app theme, not only the window's/system's
        // appearance (see VeyraNGlassView.swift).
        dark={isDark}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
      {dimmed ? (
        // Solid wash of the panel's own colour over the material, so the panel
        // reads as the same surface just slightly lifted instead of the much
        // lighter grey the un-dimmed glass composites to. Dark: the window
        // background; light: the slightly darker sidebar grey (see
        // `macGlassPanelBackground`). Inset by 1 px so it never covers the
        // native glass's specular edge highlight; the container's
        // `overflow: hidden` clips its corners to the glass radius.
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: GLASS_EDGE_INSET,
            left: GLASS_EDGE_INSET,
            right: GLASS_EDGE_INSET,
            bottom: GLASS_EDGE_INSET,
            borderRadius: Math.max(radius - GLASS_EDGE_INSET, 0),
            backgroundColor: macGlassPanelBackground(colors, isDark),
            opacity: resolvedDimOpacity
          }}
        />
      ) : null}
      {children}
    </View>
  );
}

export default MacGlassView;
