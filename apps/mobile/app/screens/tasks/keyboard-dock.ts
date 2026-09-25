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

type Frame = { x: number; y: number; width: number; height: number };
type KeyboardFrame = {
  screenX: number;
  screenY: number;
  width: number;
  height: number;
};

/** Space the dock needs beyond the safe-area padding already on the screen. */
export function keyboardDockInset(
  keyboard: KeyboardFrame | null,
  screen: Frame,
  bottomSafeAreaInset: number
) {
  if (!keyboard) return 0;
  const screenBottom = screen.y + screen.height;
  const keyboardBottom = keyboard.screenY + keyboard.height;
  const overlapsHorizontally =
    keyboard.screenX < screen.x + screen.width &&
    keyboard.screenX + keyboard.width > screen.x;
  // A floating iPad keyboard does not displace a capture row at the bottom.
  if (!overlapsHorizontally || keyboardBottom < screenBottom - 1) return 0;
  return Math.max(0, screenBottom - keyboard.screenY - bottomSafeAreaInset);
}
