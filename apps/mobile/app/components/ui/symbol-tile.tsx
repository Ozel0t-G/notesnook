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
import { View } from "react-native";
import { TaskSymbolView } from "../task-symbol-view";

/**
 * A white SF Symbol on a colored rounded square (iOS Settings) or circle
 * (Reminders smart lists).
 */
export function SymbolTile({
  symbol,
  color,
  size = 29,
  shape = "square"
}: {
  symbol: string;
  color: string;
  size?: number;
  shape?: "square" | "circle";
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: shape === "circle" ? size / 2 : Math.round(size * 0.24),
        backgroundColor: color,
        alignItems: "center",
        justifyContent: "center"
      }}
    >
      <TaskSymbolView
        name={symbol}
        color="#FFFFFF"
        size={Math.round(size * 0.6)}
      />
    </View>
  );
}
