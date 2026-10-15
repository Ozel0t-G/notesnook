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
 * iPad adaptive workspace metrics.
 *
 * The iPad lays out like a Notes workspace - a source sidebar, the note list
 * and the document - but how many of those panes fit is a question of the
 * *actual* root width the device reports, not of the device class. The shared
 * device detection (`DDS`) answers a hardware/orientation question and its
 * `deviceMode` is read by unrelated consumers (editor behaviour, sheets, the
 * side menu's drawer), so it is never overwritten for this: the width alone
 * decides the pane mode here.
 *
 * Everything in this module is pure and dependency-free (no React, no
 * react-native, no store) so the pane arithmetic and the boundary behaviour can
 * be tested without a runtime, and so a width change can never write to a
 * shared store as a side effect of laying out.
 */

export type IPadPaneMode = "narrow" | "medium" | "wide";

/** The logical page of the pager (see `components/fluid-panels`). */
export type IPadPagerPage = "home" | "editor";

export type IPadPaneWidths = {
  sidebar: number;
  list: number;
  editor: number;
};

/** Below this root width the iPad is a one-pane list/editor stack. */
export const IPAD_NARROW_MAX_WIDTH = 700;
/**
 * From this root width up the source sidebar is persistent, so the note list
 * and the document get fixed widths and the document takes what is left.
 */
export const IPAD_WIDE_MIN_WIDTH = 1100;

/** Wide: the persistent source list and the note list, in points. */
export const IPAD_WIDE_SIDEBAR_WIDTH = 260;
export const IPAD_WIDE_LIST_WIDTH = 320;

/** Medium: the note list's width; the sidebar is the swipe-in drawer. */
export const IPAD_MEDIUM_LIST_WIDTH = 300;
/**
 * Medium: the drawer's width, the same clamped 30%-of-root the iPad drawer has
 * always had (`PANE_WIDTHS.smallTablet` in navigation/fluid-panels-view.tsx).
 * Duplicated here - instead of imported from the app's function helpers - so
 * this module stays dependency-free; `ipadMediumSidebarWidth` is now the only
 * place the drawer's width is computed.
 */
export const IPAD_MEDIUM_SIDEBAR_RATIO = 0.3;
export const IPAD_MEDIUM_SIDEBAR_MIN = 300;
export const IPAD_MEDIUM_SIDEBAR_MAX = 350;

/**
 * The drawer's row that opens the note list is the legacy `Notes` route, which
 * on iOS only redirects through Library > All Notes. The All Notes collection
 * itself reports `AllNotes` as its focused route, so the iPad sidebar keeps the
 * row's id (`Notes`: its position, hidden state and count are stored under that
 * id) and follows `AllNotes` for its selection highlight instead.
 */
export const IPAD_ALL_NOTES_MENU_ITEM_ID = "Notes";
export const IPAD_ALL_NOTES_ROUTE_ID = "AllNotes";

/**
 * The iPad sidebar's direct Inbox row. Unlike the note list's own row it is not
 * a legacy route with a stored order or count, so it carries its own id, which
 * is also the focused route id its collection (`NoteCollection id="Inbox"`)
 * reports - the row highlights from the same fact as every other row.
 */
export const IPAD_INBOX_MENU_ITEM_ID = "Inbox";
export const IPAD_INBOX_ROUTE_ID = "Inbox";

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

/** The pane mode the given root width lays out in. */
export function resolveIPadPaneMode(width: number): IPadPaneMode {
  if (width < IPAD_NARROW_MAX_WIDTH) return "narrow";
  return width < IPAD_WIDE_MIN_WIDTH ? "medium" : "wide";
}

/** Width of the medium-mode drawer (the source list when it slides in). */
export function ipadMediumSidebarWidth(width: number): number {
  return clamp(
    width * IPAD_MEDIUM_SIDEBAR_RATIO,
    IPAD_MEDIUM_SIDEBAR_MIN,
    IPAD_MEDIUM_SIDEBAR_MAX
  );
}

/**
 * The three pane widths for a mode.
 *
 * - wide: the sidebar and the note list are persistently visible, so they are
 *   fixed (260/320) and the document takes exactly what is left. All three add
 *   up to the root width, which is what keeps the document's right edge - the
 *   editor's own toolbar - inside the window.
 * - medium: the sidebar is the drawer (not part of the visible row), the note
 *   list is 300 pt and the document takes the rest: `list + editor === width`.
 * - narrow: there is no sidebar (0) and the note list and the document are each
 *   the full width of the root, one page at a time.
 */
export function ipadPaneWidths(
  width: number,
  mode: IPadPaneMode = resolveIPadPaneMode(width)
): IPadPaneWidths {
  switch (mode) {
    case "wide":
      return {
        sidebar: IPAD_WIDE_SIDEBAR_WIDTH,
        list: IPAD_WIDE_LIST_WIDTH,
        editor: Math.max(
          0,
          width - IPAD_WIDE_LIST_WIDTH - IPAD_WIDE_SIDEBAR_WIDTH
        )
      };
    case "medium":
      return {
        sidebar: ipadMediumSidebarWidth(width),
        list: IPAD_MEDIUM_LIST_WIDTH,
        editor: Math.max(0, width - IPAD_MEDIUM_LIST_WIDTH)
      };
    default:
      return { sidebar: 0, list: width, editor: width };
  }
}

/**
 * Whether the source sidebar pane is mounted for this mode: persistent in wide,
 * the drawer in medium, gone (no touch and no accessibility reach at all, the
 * node is not mounted) in narrow.
 */
export function ipadSidebarPaneVisible(mode: IPadPaneMode): boolean {
  return mode !== "narrow";
}

/**
 * Whether the sidebar is a swipe-in drawer. Only in medium: wide keeps the
 * sidebar in the row, and narrow has no sidebar to draw at all.
 */
export function ipadDrawerEnabled(mode: IPadPaneMode): boolean {
  return mode === "medium";
}

/**
 * Whether the pager may be dragged at all. Wide lays every pane out side by
 * side and never pages; medium only ever drags the drawer; narrow keeps the
 * existing list/editor paging.
 */
export function ipadPanGestureEnabled(mode: IPadPaneMode): boolean {
  return mode !== "wide";
}

/** Whether the pager moves between the list and the editor pages. */
export function ipadPagingEnabled(mode: IPadPaneMode): boolean {
  return mode === "narrow";
}

/**
 * Whether the Library (the note list column) shows the selected note
 * collection instead of the source list. In wide and medium the sidebar is the
 * source list, so the column shows what it selected - All Notes by default. In
 * narrow there is no sidebar, so the column keeps the source list it has always
 * shown there.
 */
export function ipadShowsNoteCollection(mode: IPadPaneMode): boolean {
  return mode !== "narrow";
}

/**
 * The collection the Library's column opens on when the user has not selected
 * one.
 *
 * Wide and medium give the note list a column of its own (the sidebar is the
 * source list), so the column must always hold a collection and All Notes is
 * its default - exactly what Mac's list column does. Narrow returns undefined:
 * there the Library *is* the source list until the user opens a collection from
 * it, so the source categories stay the initial content.
 */
export function ipadDefaultCollection(
  mode: IPadPaneMode
): "all-notes" | undefined {
  return ipadShowsNoteCollection(mode) ? "all-notes" : undefined;
}

/**
 * The note collection's leading navigation slot in a pane mode.
 *
 * - narrow: "back" - there is no sidebar on screen, so the explicit way back to
 *   the source categories (the Library) has to stay reachable.
 * - medium: "drawer" - the source list is the swipe-in drawer, so the leading
 *   button *is* the way to it; sending the user "back" to a second copy of the
 *   Library in the column would be a lie.
 * - wide: "none" - the source list is a persistent column right next to the
 *   list, so a back button to it would only duplicate what is already on screen.
 * - undefined (no iPad workspace: iPhone, Android, Mac Catalyst, and any pane
 *   outside the provider): "back" - the collection is a pushed note list and
 *   goes back to the Library exactly as it always did.
 */
export type IPadCollectionLeading = "back" | "drawer" | "none";

export function resolveIPadCollectionLeading(
  mode: IPadPaneMode | undefined
): IPadCollectionLeading {
  if (mode === "wide") return "none";
  if (mode === "medium") return "drawer";
  return "back";
}

/**
 * The pager's resting translation for a logical page.
 *
 * It depends on nothing but the mode, the page and the pane widths, so a width
 * change re-derives the same page at the new metrics instead of resetting the
 * pager home, and it never moves the logical page (the editor, its caret and
 * the selected note) by itself.
 *
 * - wide: 0 - the three panes are already side by side, so the pager never
 *   moves; the logical page only says which pane has focus.
 * - medium: the drawer's width - list and document are visible side by side, so
 *   the document page does not push the note list out of the window.
 * - narrow: the existing logical pages - the list at 0, the document at
 *   `sidebar + list` (i.e. the full root width).
 */
export function ipadPagerOffset(
  mode: IPadPaneMode,
  page: IPadPagerPage,
  widths: IPadPaneWidths
): number {
  if (mode === "wide") return 0;
  if (mode === "medium") return widths.sidebar;
  return page === "editor" ? widths.sidebar + widths.list : widths.sidebar;
}

/**
 * The furthest the pager may ever be dragged in this mode: 0 in wide (nothing
 * may move), the drawer's width in medium (the drag is the drawer, and the note
 * list edge is its limit) and the document page in narrow.
 */
export function ipadPagerMaxOffset(
  mode: IPadPaneMode,
  widths: IPadPaneWidths
): number {
  if (mode === "narrow") return widths.sidebar + widths.list;
  if (mode === "medium") return widths.sidebar;
  return 0;
}

/**
 * What `goToIndex(index)` means on the iPad.
 *
 * Index 0 is the drawer, which only exists where the mode has one (medium);
 * indexes 1/2 are the home/editor logical pages - the same two pages in every
 * mode, even where the pager does not visibly move between them. Anything else
 * is not a page this pager owns: it is a no-op rather than a mutation of the
 * pager's swipe state, so an out-of-range index cannot make an unrelated event
 * look like a page change.
 */
export type IPadGoToIndexPlan =
  | { kind: "drawer" }
  | { kind: "page"; page: IPadPagerPage }
  | { kind: "noop" };

export function resolveIPadGoToIndex(
  index: number,
  drawerAllowed: boolean
): IPadGoToIndexPlan {
  if (index === 0) return drawerAllowed ? { kind: "drawer" } : { kind: "noop" };
  if (index === 1) return { kind: "page", page: "home" };
  if (index === 2) return { kind: "page", page: "editor" };
  return { kind: "noop" };
}

export type IPadDrawerResizeOutcome = {
  /**
   * Whether the open drawer has to survive the resize: the pager must keep
   * parking it at the drawer's own offset instead of resting on the current
   * page's (closed-drawer) offset.
   */
  keepDrawerOpen: boolean;
  /** Whether the resize has to report a drawer close back to the root. */
  reportClose: boolean;
};

/**
 * What a width/mode change does to an open drawer.
 *
 * The drawer only exists in medium, so it survives exactly a medium -> medium
 * resize: the root width changes, but the drawer is already parked at its own
 * offset and must not be snapped onto the closed page offset while the drawer
 * flag keeps saying it is open. Any move out of medium ends the drawer - the
 * flag is cleared and the close reported, so the root is never left believing a
 * drawer that cannot exist is still open. A drawer that is not open has nothing
 * to keep and nothing to report, and no resize can conjure one open.
 */
export function resolveIPadDrawerResize(
  previousMode: IPadPaneMode | undefined,
  nextMode: IPadPaneMode,
  drawerOpen: boolean
): IPadDrawerResizeOutcome {
  if (!drawerOpen) return { keepDrawerOpen: false, reportClose: false };
  const wasDrawer =
    previousMode !== undefined && ipadDrawerEnabled(previousMode);
  return wasDrawer && ipadDrawerEnabled(nextMode)
    ? { keepDrawerOpen: true, reportClose: false }
    : { keepDrawerOpen: false, reportClose: true };
}

/** Which end the medium drawer snaps to when a pan ends. */
export type IPadDrawerSnapTarget = "open" | "closed";

/**
 * Which end the medium-mode drawer snaps to when a pan ends.
 *
 * The drawer's offset is 0 while it is open and its own width while it is
 * closed, and the finger moves that offset the *opposite* way: a rightward
 * flick (`velocityX > 0`) pulls the drawer open, i.e. decreases the offset, so
 * the projected resting offset is `offset - velocityX / 40`. The nearer end
 * wins, and a projection of exactly half (the legacy strict `<` boundary) counts
 * as closed.
 *
 * Pure and dependency-free: the `"worklet"` directive lets the pager's gesture
 * `onEnd` call this on the UI thread without importing react-native.
 */
export function resolveIPadDrawerSnap(
  offset: number,
  velocityX: number,
  maxOffset: number
): IPadDrawerSnapTarget {
  "worklet";
  return offset - velocityX / 40 < maxOffset / 2 ? "open" : "closed";
}

export type IPadSideMenuItemShape = {
  id: string;
  title: string;
  focusedId?: string;
};

/**
 * The iPad sidebar's copy of a shared side-menu row.
 *
 * The row for the note list keeps its id - the stored order, hidden state and
 * note count are all keyed by it - but is labelled with the existing localized
 * All Notes string and follows the All Notes collection's focused route id, so
 * the row is highlighted while that collection is the one in the list column.
 * Every other row is returned untouched (the same reference), so nothing else
 * about the shared list changes.
 */
export function resolveIPadSideMenuItem<T extends IPadSideMenuItemShape>(
  item: T,
  allNotesLabel: string
): T & IPadSideMenuItemShape {
  if (item.id !== IPAD_ALL_NOTES_MENU_ITEM_ID) return item;
  return {
    ...item,
    title: allNotesLabel,
    focusedId: IPAD_ALL_NOTES_ROUTE_ID
  };
}
