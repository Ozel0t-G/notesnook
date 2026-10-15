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

import {
  IPAD_ALL_NOTES_MENU_ITEM_ID,
  IPAD_ALL_NOTES_ROUTE_ID,
  IPAD_MEDIUM_LIST_WIDTH,
  IPAD_NARROW_MAX_WIDTH,
  IPAD_WIDE_LIST_WIDTH,
  IPAD_WIDE_MIN_WIDTH,
  IPAD_WIDE_SIDEBAR_WIDTH,
  IPadPaneMode,
  IPadPagerPage,
  ipadDrawerEnabled,
  ipadMediumSidebarWidth,
  ipadPagerMaxOffset,
  ipadPagerOffset,
  ipadPagingEnabled,
  ipadPaneWidths,
  ipadPanGestureEnabled,
  ipadShowsNoteCollection,
  ipadSidebarPaneVisible,
  resolveIPadDrawerResize,
  resolveIPadDrawerSnap,
  resolveIPadGoToIndex,
  resolveIPadPaneMode,
  resolveIPadSideMenuItem
} from "./ipad-layout";

const MODES: IPadPaneMode[] = ["narrow", "medium", "wide"];
const PAGES: IPadPagerPage[] = ["home", "editor"];

describe("iPad pane mode boundaries", () => {
  test("classifies the width bands at the exact documented boundaries", () => {
    expect(resolveIPadPaneMode(0)).toBe("narrow");
    expect(resolveIPadPaneMode(699)).toBe("narrow");
    // The boundary itself belongs to the band above it.
    expect(resolveIPadPaneMode(699.9)).toBe("narrow");
    expect(resolveIPadPaneMode(IPAD_NARROW_MAX_WIDTH)).toBe("medium");
    expect(resolveIPadPaneMode(1024)).toBe("medium");
    expect(resolveIPadPaneMode(1099)).toBe("medium");
    expect(resolveIPadPaneMode(IPAD_WIDE_MIN_WIDTH)).toBe("wide");
    expect(resolveIPadPaneMode(1366)).toBe("wide");
    expect(resolveIPadPaneMode(100000)).toBe("wide");
  });

  test("is monotonic: a wider root never drops to a narrower mode", () => {
    const order: Record<IPadPaneMode, number> = {
      narrow: 0,
      medium: 1,
      wide: 2
    };
    let previous = resolveIPadPaneMode(0);
    for (let width = 0; width <= 3000; width += 7) {
      const mode = resolveIPadPaneMode(width);
      expect(order[mode]).toBeGreaterThanOrEqual(order[previous]);
      previous = mode;
    }
  });

  test("the mode only depends on the width, never on the previous mode", () => {
    // No stored state: the same width always answers the same mode, which is
    // what lets a resize re-derive instead of remembering.
    for (const width of [320, 700, 900, 1099, 1100, 1366]) {
      const first = resolveIPadPaneMode(width);
      expect(resolveIPadPaneMode(width)).toBe(first);
      expect(resolveIPadPaneMode(width)).toBe(first);
    }
  });
});

describe("iPad pane widths", () => {
  test("wide pins the source list and the note list, the document takes the rest", () => {
    const widths = ipadPaneWidths(1366);
    expect(resolveIPadPaneMode(1366)).toBe("wide");
    // The exact contract values, once.
    expect(widths.sidebar).toBe(260);
    expect(widths.list).toBe(320);
    // ...and everything else derived from the root width.
    expect(widths.sidebar).toBe(IPAD_WIDE_SIDEBAR_WIDTH);
    expect(widths.list).toBe(IPAD_WIDE_LIST_WIDTH);
    expect(widths.editor).toBe(1366 - 260 - 320);
    expect(widths.sidebar + widths.list + widths.editor).toBe(1366);
  });

  test("wide at the boundary still leaves a usable document", () => {
    const widths = ipadPaneWidths(IPAD_WIDE_MIN_WIDTH);
    expect(widths.editor).toBeGreaterThanOrEqual(520);
    expect(widths.editor).toBeGreaterThan(0);
    expect(widths.sidebar + widths.list + widths.editor).toBe(
      IPAD_WIDE_MIN_WIDTH
    );
  });

  test("medium keeps the note list at 300 and the document fills the column", () => {
    const widths = ipadPaneWidths(1024);
    expect(resolveIPadPaneMode(1024)).toBe("medium");
    expect(widths.list).toBe(IPAD_MEDIUM_LIST_WIDTH);
    expect(widths.editor).toBeGreaterThanOrEqual(0);
    // Both visible panes add up to the root width: nothing is pushed out of the
    // window when the document is the logical page.
    expect(widths.list + widths.editor).toBe(1024);
    // The drawer is the same clamped 30% the iPad drawer always had.
    expect(widths.sidebar).toBe(ipadMediumSidebarWidth(1024));
    expect(widths.sidebar).toBeGreaterThanOrEqual(300);
    expect(widths.sidebar).toBeLessThanOrEqual(350);
  });

  test("medium at the boundary still leaves at least 400 pt of document", () => {
    const widths = ipadPaneWidths(IPAD_NARROW_MAX_WIDTH);
    expect(widths.editor).toBeGreaterThanOrEqual(400);
    expect(widths.list + widths.editor).toBe(IPAD_NARROW_MAX_WIDTH);
    expect(widths.sidebar).toBe(300);
  });

  test("medium clamps the drawer between its bounds", () => {
    expect(ipadMediumSidebarWidth(700)).toBe(300);
    expect(ipadMediumSidebarWidth(0)).toBe(300);
    expect(ipadMediumSidebarWidth(1099)).toBeCloseTo(329.7, 6);
    expect(ipadMediumSidebarWidth(100000)).toBe(350);
  });

  test("narrow has no sidebar and two full-width panes", () => {
    for (const width of [0, 320, 699]) {
      const widths = ipadPaneWidths(width);
      expect(widths.sidebar).toBe(0);
      expect(widths.list).toBe(width);
      expect(widths.editor).toBe(width);
    }
  });

  test("no width ever produces a negative or overflowing pane set", () => {
    // The mode a width resolves to is the mode its panes are laid out in.
    for (let width = 0; width <= 2000; width += 1) {
      const mode = resolveIPadPaneMode(width);
      const widths = ipadPaneWidths(width);
      expect(widths.sidebar).toBeGreaterThanOrEqual(0);
      expect(widths.list).toBeGreaterThanOrEqual(0);
      expect(widths.editor).toBeGreaterThanOrEqual(0);
      if (mode === "wide") {
        expect(widths.sidebar + widths.list + widths.editor).toBe(width);
      }
      if (mode === "medium") {
        // Only the note list and the document are visible.
        expect(widths.list + widths.editor).toBe(width);
      }
      if (mode === "narrow") {
        expect(widths.sidebar).toBe(0);
        expect(widths.list).toBe(width);
        expect(widths.editor).toBe(width);
      }
    }

    // And the explicit forms, at widths inside every band.
    for (const width of [1100, 1200, 1366, 2048]) {
      const widths = ipadPaneWidths(width, "wide");
      expect(widths.sidebar + widths.list + widths.editor).toBe(width);
    }
    for (const width of [700, 768, 900, 1099]) {
      const widths = ipadPaneWidths(width, "medium");
      expect(widths.list + widths.editor).toBe(width);
      expect(widths.editor).toBeGreaterThan(0);
    }
    for (const width of [0, 320, 500, 699]) {
      const widths = ipadPaneWidths(width, "narrow");
      expect(widths.sidebar).toBe(0);
      expect(widths.list).toBe(width);
      expect(widths.editor).toBe(width);
    }
  });
});

describe("iPad pager positions", () => {
  test("wide never moves the pager, whichever page is logical", () => {
    const widths = ipadPaneWidths(1366);
    expect(ipadPagerOffset("wide", "home", widths)).toBe(0);
    expect(ipadPagerOffset("wide", "editor", widths)).toBe(0);
    expect(ipadPagerMaxOffset("wide", widths)).toBe(0);
    expect(ipadPanGestureEnabled("wide")).toBe(false);
  });

  test("medium rests on the drawer's width for both pages", () => {
    const widths = ipadPaneWidths(768);
    // Both pages: the note list and the document stay side by side, so the
    // document page must not slide the note list out of the window.
    for (const page of PAGES) {
      expect(ipadPagerOffset("medium", page, widths)).toBe(widths.sidebar);
    }
    // The drag limit is the drawer, not the document.
    expect(ipadPagerMaxOffset("medium", widths)).toBe(widths.sidebar);
    expect(ipadPagingEnabled("medium")).toBe(false);
  });

  test("narrow keeps the existing logical pages: list at 0, document at full width", () => {
    const widths = ipadPaneWidths(500);
    expect(ipadPagerOffset("narrow", "home", widths)).toBe(0);
    expect(ipadPagerOffset("narrow", "editor", widths)).toBe(500);
    expect(ipadPagerOffset("narrow", "editor", widths)).toBe(
      widths.sidebar + widths.list
    );
    expect(ipadPagerMaxOffset("narrow", widths)).toBe(
      widths.sidebar + widths.list
    );
    expect(ipadPagingEnabled("narrow")).toBe(true);
  });

  test("a resize re-derives the same page at the new widths", () => {
    // The contract the pager has to keep: the offset is a function of
    // (mode, page, widths) alone. A rotation therefore moves the pager to where
    // the *same* page lives at the new width - it can never read as a reset to
    // home, and it tells the pager nothing about which page to show.
    for (const mode of MODES) {
      for (const width of [320, 699, 700, 900, 1099, 1100, 1366, 2048]) {
        const before = ipadPaneWidths(width, mode);
        const after = ipadPaneWidths(width + 1, mode);
        for (const page of PAGES) {
          const beforeOffset = ipadPagerOffset(mode, page, before);
          const afterOffset = ipadPagerOffset(mode, page, after);
          expect(Number.isFinite(afterOffset)).toBe(true);
          expect(afterOffset).toBeGreaterThanOrEqual(0);
          expect(afterOffset).toBeLessThanOrEqual(
            ipadPagerMaxOffset(mode, after)
          );
          // Same page, so the same resting place for the same width...
          expect(ipadPagerOffset(mode, page, before)).toBe(beforeOffset);
          // ...and a page is never derived from the other page's offset.
          const other = page === "home" ? "editor" : "home";
          // Both pages rest in the same place exactly where one pane is
          // visible at a time and the pager pages (narrow); never elsewhere.
          expect(ipadPagerOffset(mode, other, after) === afterOffset).toBe(
            mode !== "narrow"
          );
        }
      }
    }
  });

  test("the document page is fully in view wherever the pager rests", () => {
    for (const mode of MODES) {
      for (const width of [320, 699, 700, 1099, 1100, 1366]) {
        const widths = ipadPaneWidths(width, mode);
        const offset = ipadPagerOffset(mode, "editor", widths);
        if (mode === "narrow") {
          // The translation parks the document pane at x 0, and the pane is the
          // full root width, so the document fills the window exactly.
          expect(offset).toBe(widths.sidebar + widths.list);
          expect(offset).toBe(width);
          expect(widths.editor).toBe(width);
        } else {
          // Wide and medium show it beside the note list, so its right edge is
          // the root width and its left edge is a visible pane's width.
          expect(offset).toBeLessThanOrEqual(widths.sidebar);
          expect(
            widths.sidebar + widths.list + widths.editor
          ).toBeGreaterThanOrEqual(width);
        }
      }
    }
  });
});

describe("iPad pane capabilities", () => {
  test("each mode owns the sidebar, the drawer and the paging it needs", () => {
    expect(ipadSidebarPaneVisible("narrow")).toBe(false);
    expect(ipadSidebarPaneVisible("medium")).toBe(true);
    expect(ipadSidebarPaneVisible("wide")).toBe(true);

    expect(ipadDrawerEnabled("narrow")).toBe(false);
    expect(ipadDrawerEnabled("medium")).toBe(true);
    expect(ipadDrawerEnabled("wide")).toBe(false);

    expect(ipadPanGestureEnabled("medium")).toBe(true);
    expect(ipadPanGestureEnabled("narrow")).toBe(true);

    expect(ipadShowsNoteCollection("wide")).toBe(true);
    expect(ipadShowsNoteCollection("medium")).toBe(true);
    // Narrow has no sidebar, so the column keeps the source list.
    expect(ipadShowsNoteCollection("narrow")).toBe(false);
  });
});

describe("iPad goToIndex plans", () => {
  test("index 0 is the drawer only where the mode has a drawer", () => {
    // Medium parks the drawer: index 0 opens it. Wide keeps the sidebar in the
    // row and narrow has no sidebar at all, so index 0 there is nothing this
    // pager owns - it must not behave like a page or mutate pager state.
    expect(resolveIPadGoToIndex(0, ipadDrawerEnabled("medium"))).toEqual({
      kind: "drawer"
    });
    for (const mode of ["narrow", "wide"] as IPadPaneMode[]) {
      expect(resolveIPadGoToIndex(0, ipadDrawerEnabled(mode))).toEqual({
        kind: "noop"
      });
    }
  });

  test("indexes 1 and 2 are the two logical pages in every mode", () => {
    // The pages exist even where the pager does not visibly move between them
    // (wide/medium): the logical page is still tracked, so the index has to
    // land on the page, not on the drawer or on nothing.
    for (const mode of MODES) {
      for (const drawerAllowed of [true, false]) {
        expect(resolveIPadGoToIndex(1, drawerAllowed)).toEqual({
          kind: "page",
          page: "home"
        });
        expect(resolveIPadGoToIndex(2, drawerAllowed)).toEqual({
          kind: "page",
          page: "editor"
        });
      }
    }
    // ...and the two pages are distinguishable, in the page order the pager
    // uses everywhere else.
    expect(resolveIPadGoToIndex(1, true)).not.toEqual(
      resolveIPadGoToIndex(2, true)
    );
    expect(resolveIPadGoToIndex(0, true)).not.toEqual(
      resolveIPadGoToIndex(1, true)
    );
  });

  test("an index without a plan is inert", () => {
    for (const index of [-1, -0.5, 0.5, 1.5, 2.5, 3, 4, 10, NaN, Infinity]) {
      for (const drawerAllowed of [true, false]) {
        expect(resolveIPadGoToIndex(index, drawerAllowed)).toEqual({
          kind: "noop"
        });
      }
    }
  });
});

describe("iPad drawer resize policy", () => {
  const ALL_MODES: (IPadPaneMode | undefined)[] = [undefined, ...MODES];

  test("an already-open medium drawer survives a medium -> medium resize", () => {
    // The drawer is parked at its own offset, not on a page: a width change in
    // medium must leave it open rather than snap it onto the closed page offset
    // and keep the flag lying.
    expect(resolveIPadDrawerResize("medium", "medium", true)).toEqual({
      keepDrawerOpen: true,
      reportClose: false
    });
  });

  test("leaving medium ends an open drawer and reports the close", () => {
    for (const nextMode of ["narrow", "wide"] as IPadPaneMode[]) {
      for (const previousMode of ALL_MODES) {
        expect(resolveIPadDrawerResize(previousMode, nextMode, true)).toEqual({
          keepDrawerOpen: false,
          reportClose: true
        });
      }
    }
  });

  test("a closed drawer is never kept open and never reported", () => {
    // The report is about a state that actually changed: a resize that has no
    // drawer must not tell the root a drawer closed, and it cannot open one.
    for (const previousMode of ALL_MODES) {
      for (const nextMode of MODES) {
        expect(resolveIPadDrawerResize(previousMode, nextMode, false)).toEqual({
          keepDrawerOpen: false,
          reportClose: false
        });
      }
    }
  });

  test("the drawer only ever survives a resize that stays inside a drawer mode", () => {
    for (const previousMode of ALL_MODES) {
      for (const nextMode of MODES) {
        for (const drawerOpen of [true, false]) {
          const outcome = resolveIPadDrawerResize(
            previousMode,
            nextMode,
            drawerOpen
          );
          const bothDrawerModes =
            previousMode !== undefined &&
            ipadDrawerEnabled(previousMode) &&
            ipadDrawerEnabled(nextMode);
          expect(outcome.keepDrawerOpen).toBe(bothDrawerModes && drawerOpen);
          // Keeping a drawer open and reporting it closed are contradictory.
          expect(outcome.keepDrawerOpen && outcome.reportClose).toBe(false);
          // An open drawer that cannot survive the resize is always reported as
          // closed - the flag is never left claiming a drawer that is gone -
          // and nothing is ever reported for a drawer that was not open.
          expect(outcome.reportClose).toBe(drawerOpen && !bothDrawerModes);
        }
      }
    }
  });
});

describe("iPad drawer snap decision", () => {
  // The drawer's offset is 0 while it is open and 300 (its own width) while it
  // is closed; a rightward flick has a positive `velocityX` and pulls it open,
  // so it *decreases* the projected offset. The values below are picked so that
  // a wrong sign flips the decision.
  const MAX = 300;

  test("a fast opening flick from the closed side snaps open", () => {
    // 260 - 125 = 135 < 150 -> open; the inverted projection would give 385.
    expect(resolveIPadDrawerSnap(260, 5000, MAX)).toBe("open");
  });

  test("a fast closing flick from the open side snaps closed", () => {
    // 40 + 125 = 165 >= 150 -> closed; the inverted projection would give -85.
    expect(resolveIPadDrawerSnap(40, -5000, MAX)).toBe("closed");
  });

  test("the flick's sign decides: opposite velocities flip the target", () => {
    // 150 - 100 = 50 (open) vs 150 + 100 = 250 (closed).
    expect(resolveIPadDrawerSnap(150, 4000, MAX)).toBe("open");
    expect(resolveIPadDrawerSnap(150, -4000, MAX)).toBe("closed");
    expect(resolveIPadDrawerSnap(150, 4000, MAX)).not.toBe(
      resolveIPadDrawerSnap(150, -4000, MAX)
    );
  });

  test("a slow drag snaps to the nearer endpoint", () => {
    // A small velocity only nudges the projection, so the position still wins:
    // only fast flicks change the result.
    expect(resolveIPadDrawerSnap(140, 400, MAX)).toBe("open"); // 130
    expect(resolveIPadDrawerSnap(160, 400, MAX)).toBe("closed"); // 150
  });

  test("with no velocity the position alone decides", () => {
    expect(resolveIPadDrawerSnap(0, 0, MAX)).toBe("open");
    expect(resolveIPadDrawerSnap(149, 0, MAX)).toBe("open");
    // Half is a tie, and the legacy snap keeps the strict `<`: tie -> closed.
    expect(resolveIPadDrawerSnap(150, 0, MAX)).toBe("closed");
    expect(resolveIPadDrawerSnap(MAX, 0, MAX)).toBe("closed");
  });

  test("an exact half projection counts as closed", () => {
    // 199 - 50 = 149 -> open, 200 - 50 = 150 -> closed (the strict boundary).
    expect(resolveIPadDrawerSnap(199, 2000, MAX)).toBe("open");
    expect(resolveIPadDrawerSnap(200, 2000, MAX)).toBe("closed");
  });

  test("increasing the velocity never turns an open target closed", () => {
    let everOpen = false;
    for (const velocityX of [-5000, -2000, -400, 0, 400, 2000, 5000]) {
      const target = resolveIPadDrawerSnap(190, velocityX, MAX);
      expect(["open", "closed"]).toContain(target);
      if (target === "open") everOpen = true;
      if (everOpen) expect(target).toBe("open");
    }
    // At offset 190 the 2000 flick is 140 -> open, so the loop must have opened.
    expect(everOpen).toBe(true);
  });
});

describe("iPad side menu rows", () => {
  const row = {
    id: "Notes",
    title: "Notes",
    icon: "note-outline",
    type: "side-menu-item"
  };

  test("the note-list row follows the All Notes collection", () => {
    const resolved = resolveIPadSideMenuItem(row, "All Notes");
    // The id - and with it the stored order, hidden state and note count - is
    // untouched.
    expect(resolved.id).toBe(IPAD_ALL_NOTES_MENU_ITEM_ID);
    // The label is the existing localized All Notes string...
    expect(resolved.title).toBe("All Notes");
    // ...and the row highlights while All Notes is the collection on screen.
    expect(resolved.focusedId).toBe(IPAD_ALL_NOTES_ROUTE_ID);
    expect(resolved.icon).toBe(row.icon);
    expect(row.title).toBe("Notes");
  });

  test("every other row is returned untouched", () => {
    for (const item of [
      { id: "Favorites", title: "Favorites" },
      { id: "Trash", title: "Trash" },
      { id: "Tasks", title: "Tasks" }
    ]) {
      expect(resolveIPadSideMenuItem(item, "All Notes")).toBe(item);
    }
  });

  test("resolving is idempotent", () => {
    const once = resolveIPadSideMenuItem(row, "All Notes");
    const twice = resolveIPadSideMenuItem(once, "All Notes");
    expect(twice).toEqual(once);
    expect(twice.focusedId).toBe(IPAD_ALL_NOTES_ROUTE_ID);
  });
});

describe("the helper stays pure", () => {
  test("it does not mutate the widths it is handed", () => {
    const widths = { sidebar: 1, list: 2, editor: 3 };
    const snapshot = { ...widths };
    ipadPagerOffset("medium", "editor", widths);
    ipadPagerMaxOffset("wide", widths);
    expect(widths).toEqual(snapshot);
  });
});
