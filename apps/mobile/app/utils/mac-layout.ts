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
 * Mac Catalyst window metrics.
 *
 * The Mac window has no sidebar rail and no swipe pager: the Library/list
 * column owns the left edge of the window (x = 0) and the editor gets exactly
 * what the list column leaves. Both values are derived from the window width
 * the root view reports, so they follow every resize.
 *
 * Nothing here is read on iPhone or iPad; those keep the iPad panes in
 * `navigation/fluid-panels-view.tsx`.
 */

/**
 * Height of the Mac window's unified title bar row.
 *
 * Mac Catalyst hides the window title and drops the toolbar, so React owns the
 * whole content area and its first row of pixels is the window's top edge. The
 * traffic lights keep floating there (x 8-70, y 8-24 in window points), so the
 * app draws a title bar row of its own: 52 pt tall, with the section control in
 * it at MAC_TITLEBAR_CONTROL_LEFT.
 *
 * On the list + editor split the row is painted over the list column only
 * (macListWidth wide, see navigation-stack.tsx) and the editor pane starts at
 * the window's top edge, painting its own 52 pt half of the same band
 * (`MAC_EDITOR_HEADER_HEIGHT` in packages/editor-mobile/src/utils/mac.ts). On
 * every other screen the row is a sibling of the navigator with an explicit
 * height - no padding in between - so nothing in the panes (or an ancestor's
 * insets) can shift it.
 */
export const MAC_TITLEBAR_HEIGHT = 52;

/**
 * Where the section control starts inside the title bar row: right of the
 * traffic lights, which occupy x 12-72 in window points.
 */
export const MAC_TITLEBAR_CONTROL_LEFT = 88;

/** Gap between the section control and the column's right edge. */
export const MAC_TITLEBAR_CONTROL_RIGHT = 12;

/** Height of the section control (and of its segments). */
export const MAC_TITLEBAR_CONTROL_HEIGHT = 24;

/** Label and symbol size inside the section control. */
export const MAC_TITLEBAR_CONTROL_FONT_SIZE = 12;

/**
 * Horizontal inset of the Mac source lists (Library and the note list). The
 * rows own the full width of the list column otherwise, which puts their icons
 * hard against the window edge and the rounded selection highlight flush with
 * the column's sides. 10 pt of margin around the column's content keeps both
 * inside, with the rows' own 8 pt of inner padding on top of it.
 */
export const MAC_SOURCE_LIST_INSET = 10;

/** Width of the Library/list column: iPad's tablet-mode proportion. */
export const macListWidth = (windowWidth: number) => windowWidth * 0.3;

/**
 * Width of the Mac section control: the list column minus the traffic-light
 * gutter and the trailing gap. Centered vertically in the 52 pt title bar, so
 * its own center lands on y 26.
 */
export const macSectionControlWidth = (windowWidth: number) =>
  Math.max(
    0,
    macListWidth(windowWidth) -
      MAC_TITLEBAR_CONTROL_LEFT -
      MAC_TITLEBAR_CONTROL_RIGHT
  );

/**
 * Everything the list column leaves goes to the editor. Deriving it from the
 * window (instead of a fraction of it) is what keeps the editor's right edge -
 * the "Add tag" button and the header menu - inside the window.
 */
export const macEditorWidth = (windowWidth: number) =>
  windowWidth - macListWidth(windowWidth);
