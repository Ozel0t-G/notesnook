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

import { expect } from "vitest";
import { isConnectError } from "../../src/connect/errors.js";

export function connectErrorCode(error: unknown): string | undefined {
  return isConnectError(error) ? error.code : undefined;
}

/** Await a promise and assert the bounded Connect error code it rejected with. */
export async function expectCode(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined)
    throw new Error(`Expected rejection with ${code}, but it resolved.`);
  expect(connectErrorCode(caught), `expected ${code}`).toBe(code);
}
