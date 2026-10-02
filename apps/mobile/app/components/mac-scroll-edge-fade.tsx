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

import React from "react";
import { StyleProp, View, ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

/**
 * Mac Catalyst's scroll-edge fade (part 2 of the Mac glass design).
 *
 * The native toolbar is transparent and the window's content runs under it, so
 * every scrolling column draws this non-interactive gradient across its top:
 * the column's own background colour at the top edge, fully transparent by the
 * bottom, over the scroll content. Content sliding under the toolbar therefore
 * dissolves into the background instead of being clipped by an opaque band.
 *
 * iPhone/iPad never mount this: their headers are opaque and the scroll content
 * is laid out below them, so there is nothing to fade.
 */
export function MacScrollEdgeFade({
  color,
  height,
  style
}: {
  /** The column's background colour; the fade's opaque end. */
  color: string;
  /** Fade height in points (see MAC_SCROLL_EDGE_FADE_HEIGHT). */
  height: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height
        },
        style
      ]}
    >
      {/*
        The gradient spans exactly the fade's own pixels (`userSpaceOnUse` with
        the height as the y2), so it is always a smooth opaque -> transparent
        ramp: no object-bounding-box rounding can collapse it into a solid band
        and no second stop is needed to soften the bottom edge.
      */}
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient
            id="macScrollEdgeFade"
            x1="0"
            y1="0"
            x2="0"
            y2={height}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0" stopColor={color} stopOpacity={1} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="url(#macScrollEdgeFade)"
        />
      </Svg>
    </View>
  );
}

export default MacScrollEdgeFade;
