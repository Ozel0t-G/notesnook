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

import { afterEach, expect, it, vi } from "vitest";
import { Debug } from "../debug.js";

afterEach(() => vi.restoreAllMocks());

it("does not send issue reports to an upstream service", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");

  await expect(
    Debug.report({ title: "Issue", body: "Private account details", userId: "id" })
  ).rejects.toThrow("VeyraN issue reporting is unavailable.");
  expect(fetch).not.toHaveBeenCalled();
});
