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

import { afterEach, expect, it } from "vitest";
import Config from "../src/utils/config";

afterEach(() => window.localStorage.clear());

it("does not use the previously saved Notesnook CORS default", () => {
  window.localStorage.setItem("corsProxy", '"https://cors.notesnook.com/"');
  expect(Config.get("corsProxy", "")).toBe("");
  Config.set("corsProxy", "http://cors.notesnook.com");
  expect(window.localStorage.getItem("corsProxy")).toBe('""');
});

it("preserves an explicitly configured non-upstream proxy", () => {
  Config.set("corsProxy", "https://proxy.example.test");
  expect(Config.get("corsProxy", "")).toBe("https://proxy.example.test");
});
