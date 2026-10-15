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

import { createContext } from "react";

/** Height of a standard UITabBar, excluding the home indicator inset. */
export const APPLE_TAB_BAR_HEIGHT = 49;

/** Vertical spacing above and below the floating iPad top tab bar. */
export const APPLE_TAB_BAR_TOP_SPACING = 4;

/**
 * The iPad top tab bar strip's actual rendered height: the window's top safe
 * area inset, the spacing above and below the bar, and the bar itself. This
 * is the height the strip occupies in the flow above the navigator (see
 * navigation-stack.tsx), which RN's own keyboard avoidance frame does not
 * account for.
 */
export function getTopTabBarHeight(topInset: number): number {
  return topInset + APPLE_TAB_BAR_TOP_SPACING * 2 + APPLE_TAB_BAR_HEIGHT;
}

/**
 * The iPad top tab bar strip's actual height, published by the root
 * (navigation-stack.tsx) so the editor's KeyboardAvoidingView can account for
 * it. Defaults to 0 - no strip - outside the root's provider and on every
 * client that never mounts the strip.
 */
export const AppleTabBarOffsetContext = createContext(0);
