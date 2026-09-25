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

import { keyboardDockInset } from "./keyboard-dock";

const portrait = { x: 0, y: 0, width: 390, height: 844 };

describe("Task capture keyboard dock", () => {
  test("keeps the capture row above a docked phone keyboard", () => {
    expect(
      keyboardDockInset(
        { screenX: 0, screenY: 544, width: 390, height: 300 },
        portrait,
        34
      )
    ).toBe(266);
  });

  test("does not double offset when the OS has already resized the screen", () => {
    expect(
      keyboardDockInset(
        { screenX: 0, screenY: 544, width: 390, height: 300 },
        { ...portrait, height: 544 },
        0
      )
    ).toBe(0);
  });

  test("leaves the dock in place for a floating or external keyboard", () => {
    const ipad = { x: 0, y: 0, width: 1024, height: 1366 };
    expect(
      keyboardDockInset(
        { screenX: 500, screenY: 700, width: 350, height: 300 },
        ipad,
        20
      )
    ).toBe(0);
    expect(keyboardDockInset(null, ipad, 20)).toBe(0);
  });
});
