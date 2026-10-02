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
 */

export type MacGlassVariant = "sidebar" | "card" | "capsule";

type NativeGlassProps = {
  cornerRadius?: number;
  variant?: MacGlassVariant;
  interactive?: boolean;
  tint?: string;
  /** Forces the material into the app's appearance (Mac Catalyst only). */
  dark?: boolean;
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
  style,
  children
}: NativeGlassProps) {
  const { isDark } = useThemeColors();
  // "capsule" derives its radius from the view's height, which is only known
  // after layout; the container below needs it to clip the children to the
  // same rounded shape as the glass.
  const [capsuleRadius, setCapsuleRadius] = React.useState(0);

  if (!isMacCatalyst() || !NativeGlassView)
    return <View style={style}>{children}</View>;

  const radius = variant === "capsule" ? capsuleRadius : cornerRadius;

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
        tint={tint}
        // The glass follows the app theme, not only the window's/system's
        // appearance (see VeyraNGlassView.swift).
        dark={isDark}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

export default MacGlassView;
