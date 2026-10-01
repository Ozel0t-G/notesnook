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

import { ScopedThemeProvider, useThemeColors } from "@notesnook/theme";
import React from "react";
import { View } from "react-native";
import { MacSidebar } from "./mac-sidebar";
import { useSettingStore } from "../stores/use-setting-store";
import { useMacSidebarVisible } from "../stores/use-mac-sidebar-store";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { isMacCatalyst } from "../utils/constants";
import { macSidebarWidth } from "../utils/mac-layout";

/**
 * One wrapper per wrapped screen, so a `getComponent` closure that calls
 * `withMacSidebar` more than once keeps returning the same component type.
 * A fresh component type on every call would make React Navigation unmount and
 * remount the screen (losing scroll position and local state) even though it is
 * already on screen.
 */
const wrappers = new WeakMap<
  React.ComponentType<any>,
  React.ComponentType<any>
>();

/**
 * Puts the Mac source list (MacSidebar) next to a top-level section screen.
 *
 * The Library section gets its sidebar from `navigation/fluid-panels-view.tsx`,
 * which mounts `MacSidebar` as the leftmost of the three `FluidPanels` columns.
 * The Tasks and GlobalSearch sections are routes of their own, siblings of
 * `FluidPanelsView`, so they have to bring the same sidebar pane with them or
 * the sidebar's Library/Tasks/Search rows - the only way back to the other
 * sections on Mac - would not be reachable from Tasks or Search.
 *
 * On Mac the wrapped screen is rendered as a horizontal row:
 *
 *   [ MacSidebar pane ][ section screen, flex: 1 ]
 *
 * The sidebar pane mirrors the one in `fluid-panels-view.tsx`: the same
 * `macSidebarWidth` (0 pt when View > Toggle Sidebar hides it), the same
 * hairline border, the same `overflow` clip while hidden, and the same
 * `ScopedThemeProvider value="list"` so the source list keeps the theme role it
 * has in the Library section. The screen itself takes the rest of the row with
 * `flex: 1` and `minWidth: 0`, so a wide note list can never push the sidebar
 * off-screen.
 *
 * Both panes clear the native window toolbar on their own: the sidebar pads
 * with `macToolbarInset` inside `MacSidebar`, and the section screens keep the
 * `SafeAreaView` that reads the padded top inset published by
 * `navigation/navigation-stack.tsx`. Only one of them is on top, so there is no
 * double padding.
 *
 * iPhone and iPad have no such sidebar: `withMacSidebar` returns the screen
 * unchanged there, so their navigation stays identical.
 */
export function withMacSidebar<P extends object>(
  Screen: React.ComponentType<P>
): React.ComponentType<P> {
  if (!isMacCatalyst()) return Screen;

  const cached = wrappers.get(Screen);
  if (cached) return cached as React.ComponentType<P>;

  function MacSectionLayout(props: P) {
    const { colors, isDark } = useThemeColors();
    const visual = getAppleVisualTokens(colors, isDark);
    const windowWidth = useSettingStore((state) => state.dimensions.width);
    const sidebarVisible = useMacSidebarVisible(windowWidth);

    return (
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View
          style={{
            height: "100%",
            // 0 when View > Toggle Sidebar hides the source list; the section
            // screen then takes the whole width.
            width: macSidebarWidth(windowWidth, sidebarVisible),
            // The hairline separates the source list from the section, so it
            // goes away with the sidebar.
            borderRightWidth: sidebarVisible ? 0.5 : 0,
            borderRightColor: visual.separator,
            // A zero-width pane keeps its children mounted (the source list
            // keeps its scroll position), and iOS Views do not clip by default.
            overflow: sidebarVisible ? "visible" : "hidden"
          }}
        >
          <ScopedThemeProvider value="list">
            <MacSidebar />
          </ScopedThemeProvider>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Screen {...props} />
        </View>
      </View>
    );
  }

  MacSectionLayout.displayName = `withMacSidebar(${
    Screen.displayName || "Screen"
  })`;

  wrappers.set(Screen, MacSectionLayout);
  return MacSectionLayout as React.ComponentType<P>;
}

export default withMacSidebar;
