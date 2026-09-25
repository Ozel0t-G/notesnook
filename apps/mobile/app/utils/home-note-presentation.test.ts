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

import type { GroupOptions, Note } from "@notesnook/core";
import {
  homeNoteDateGroup,
  homeNoteDisplaySnippet,
  homeNoteDisplayTitle
} from "./home-note-presentation";

const options: GroupOptions = {
  groupBy: "default",
  sortBy: "dateEdited",
  sortDirection: "desc"
};

function note(overrides: Partial<Note>): Note {
  return {
    id: "test",
    title: "Note 25-09-2026 12:34",
    dateCreated: new Date(2026, 8, 25, 12).getTime(),
    dateEdited: new Date(2026, 8, 25, 12).getTime(),
    ...overrides
  } as Note;
}

describe("iOS Notes home presentation", () => {
  test("shows a meaningful first line only for generated titles", () => {
    const generated = note({
      isGeneratedTitle: true,
      headline: "  Plan &amp; review\nMore detail"
    });
    expect(homeNoteDisplayTitle(generated)).toBe("Plan & review");
    expect(generated.title).toBe("Note 25-09-2026 12:34");
    expect(homeNoteDisplaySnippet(generated)).toBe("More detail");
    expect(
      homeNoteDisplayTitle({ ...generated, isGeneratedTitle: false })
    ).toBe(generated.title);
    expect(
      homeNoteDisplaySnippet({ ...generated, isGeneratedTitle: false })
    ).toBe("Plan & review More detail");
    expect(homeNoteDisplayTitle({ ...generated, headline: "" })).toBe(
      generated.title
    );
  });

  test("uses local calendar boundaries and keeps pinned notes separate", () => {
    const now = new Date(2026, 2, 29, 12).getTime();
    const today = note({ dateEdited: new Date(2026, 2, 29, 1).getTime() });
    const yesterday = note({ dateEdited: new Date(2026, 2, 28, 23).getTime() });
    const older = note({ dateEdited: new Date(2026, 1, 1, 12).getTime() });

    expect(homeNoteDateGroup(today, options, now)).not.toBe(
      homeNoteDateGroup(yesterday, options, now)
    );
    expect(homeNoteDateGroup(older, options, now)).toMatch(/2026/);
    expect(homeNoteDateGroup({ ...today, pinned: true }, options, now)).toBe(
      "Pinned"
    );
  });

  test("groups by the selected date field", () => {
    const now = new Date(2026, 8, 25, 12).getTime();
    const created = note({
      dateCreated: new Date(2026, 7, 1, 12).getTime(),
      dateEdited: now
    });
    expect(homeNoteDateGroup(created, options, now)).not.toBe(
      homeNoteDateGroup(created, { ...options, sortBy: "dateCreated" }, now)
    );
  });
});
