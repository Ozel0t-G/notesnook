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

jest.mock("../common/database", () => ({ db: {}, DatabaseLogger: {} }));
jest.mock("../common/database/mmkv", () => ({ MMKV: {} }));

import { generatedTitleUpdate } from "./note-title-migration";

describe("generatedTitleUpdate", () => {
  it("uses the first line for generated titles", () => {
    expect(
      generatedTitleUpdate({
        title: "Note 29-09-2026 01:00 PM",
        headline: "QA save reopen body 0929\nsecond line",
        isGeneratedTitle: true
      })
    ).toBe("QA save reopen body 0929");
  });

  it("never touches titles the user typed", () => {
    expect(
      generatedTitleUpdate({
        title: "My title",
        headline: "Body",
        isGeneratedTitle: false
      })
    ).toBeUndefined();
  });

  it("keeps a generated title when there is no text", () => {
    expect(
      generatedTitleUpdate({
        title: "Note 29-09-2026 01:00 PM",
        headline: "",
        isGeneratedTitle: true
      })
    ).toBeUndefined();
  });
});
