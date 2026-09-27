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

import { normalizeCorsProxy } from "./cors-proxy";

describe("VeyraN CORS proxy", () => {
  it("disables a saved Notesnook CORS endpoint", () => {
    expect(normalizeCorsProxy("https://cors.notesnook.com/")).toBe("");
    expect(normalizeCorsProxy("http://cors.notesnook.com")).toBe("");
  });

  it("preserves another explicit proxy", () => {
    expect(normalizeCorsProxy("https://proxy.example.test")).toBe(
      "https://proxy.example.test"
    );
  });
});
