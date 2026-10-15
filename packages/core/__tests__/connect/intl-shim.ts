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
 * Minimal stand-in for `@notesnook/intl` used only while running the isolated
 * core test suite. `packages/core` imports `strings` (unused) from the real
 * package; building the real lingui bundle is out of scope for this sandbox,
 * so the import resolves here. Value access returns the property path.
 */
export const strings: Record<string, unknown> = new Proxy(
  {},
  {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      return () => property;
    }
  }
);
