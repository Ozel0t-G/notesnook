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

/**
 * UIKit system colors (light / dark variants). Used for the colored symbol
 * tiles and smart-list circles that iOS apps use for recognition at a glance.
 */
const SYSTEM_COLORS = {
  red: ["#FF3B30", "#FF453A"],
  orange: ["#FF9500", "#FF9F0A"],
  yellow: ["#FFCC00", "#FFD60A"],
  green: ["#34C759", "#30D158"],
  teal: ["#30B0C7", "#40C8E0"],
  blue: ["#007AFF", "#0A84FF"],
  indigo: ["#5856D6", "#5E5CE6"],
  purple: ["#AF52DE", "#BF5AF2"],
  pink: ["#FF2D55", "#FF375F"],
  gray: ["#8E8E93", "#8E8E93"],
  darkGray: ["#636366", "#636366"]
} as const;

export type SystemColorName = keyof typeof SYSTEM_COLORS;

export function systemColor(name: SystemColorName, isDark: boolean) {
  return SYSTEM_COLORS[name][isDark ? 1 : 0];
}
