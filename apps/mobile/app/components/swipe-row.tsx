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
import { Pressable, Text, View } from "react-native";
import ReanimatedSwipeable, {
  SwipeableMethods
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { TaskSymbolView } from "./task-symbol-view";

export type SwipeAction = {
  key: string;
  label: string;
  symbol: string;
  color: string;
  onPress: () => void;
};

const ACTION_WIDTH = 76;

/**
 * UITableView-style swipe actions: `leading` actions are revealed by swiping
 * right, `trailing` by swiping left. A full swipe runs the outermost action.
 */
export function SwipeRow({
  leading = [],
  trailing = [],
  children,
  enabled = true
}: {
  leading?: SwipeAction[];
  trailing?: SwipeAction[];
  children: React.ReactNode;
  enabled?: boolean;
}) {
  const ref = React.useRef<SwipeableMethods>(null);
  const run = (action: SwipeAction) => {
    ref.current?.close();
    action.onPress();
  };
  const renderActions = (actions: SwipeAction[], side: "left" | "right") =>
    actions.length ? (
      <View style={{ flexDirection: "row" }}>
        {(side === "left" ? actions : [...actions].reverse()).map((action) => (
          <Pressable
            key={action.key}
            onPress={() => run(action)}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            style={{
              width: ACTION_WIDTH,
              backgroundColor: action.color,
              alignItems: "center",
              justifyContent: "center",
              gap: 4
            }}
          >
            <TaskSymbolView name={action.symbol} size={22} color="#FFFFFF" />
            <Text
              numberOfLines={1}
              style={{ color: "#FFFFFF", fontSize: 13, fontWeight: "500" }}
            >
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>
    ) : null;

  if (!enabled || (!leading.length && !trailing.length))
    return <>{children}</>;

  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={1}
      overshootFriction={8}
      leftThreshold={ACTION_WIDTH * 0.6}
      rightThreshold={ACTION_WIDTH * 0.6}
      renderLeftActions={
        leading.length ? () => renderActions(leading, "left") : undefined
      }
      renderRightActions={
        trailing.length ? () => renderActions(trailing, "right") : undefined
      }
      onSwipeableWillOpen={() => {}}
    >
      {children}
    </ReanimatedSwipeable>
  );
}
