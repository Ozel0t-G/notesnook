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
 * Mac Catalyst editor chrome metrics.
 *
 * Mac has no editor header of its own: the window's native NSToolbar carries
 * the editor actions (share, note info, ⋮) and the editor pane starts at the
 * window's top edge (y 0). The formatting toolbar has become a floating glass
 * capsule centered at the bottom of the pane (see `tiptap.tsx`), the way
 * Pages and Notes float their format bar over the page.
 *
 * Nothing here is read on iPhone or iPad: they keep the 50 pt header (plus the
 * safe-area inset) and the keyboard toolbar at the bottom of the pane.
 */

/**
 * Height of the editor header on Mac. There is no editor header on Mac (the
 * actions live in the native window toolbar), so the note content starts at
 * the very top of the pane. Kept at 0 so comments and offsets that referenced
 * the (removed) web header stay valid.
 */
export const MAC_EDITOR_HEADER_HEIGHT = 0;

/** Size of a format-capsule tool button's icon. */
export const MAC_TOOLBAR_ICON_SIZE = 17;

/**
 * Small spacing unit of the Mac editor toolbar theme. It drives the padding
 * inside the toolbar's popovers (`space.small`). The capsule's own metrics
 * (21 pt radius, 14 pt side padding, 18 pt button gap) live next to the
 * toolbar's sx in `packages/editor/src/toolbar/toolbar.tsx`, which cannot
 * import this mobile-only module.
 */
export const MAC_TOOLBAR_GAP = 4;

/** Height of the floating format capsule including its 1 px border. */
export const MAC_TOOLBAR_CAPSULE_HEIGHT = 42;

/** Distance between the format capsule and the bottom edge of the pane. */
export const MAC_TOOLBAR_CAPSULE_BOTTOM = 20;

/**
 * Bottom padding of the note scroller on Mac, so the floating format capsule
 * never covers the last lines of the note.
 */
export const MAC_TOOLBAR_CAPSULE_CLEARANCE = 90;

/**
 * Maximum width of the note's text column on Mac: 46rem (≈736 pt at the
 * default 16 px root font size), centered in the editor pane the way macOS
 * Notes does it. iPhone, iPad and Android keep the full-width column.
 *
 * The last-edited date line, the title, the note body and the
 * word-count/add-tag row above the title all use this same width so their left
 * edges line up.
 */
export const MAC_TEXT_COLUMN_MAX_WIDTH = "46rem";

/**
 * Horizontal padding inside the Mac text column. The desktop editor's 16 px
 * read too narrow once the column is centered and capped, so Mac gets 24 px.
 */
export const MAC_TEXT_COLUMN_PADDING = 24;

/** Title font size on Mac. Other platforms keep the hard-coded 25 px. */
export const MAC_TITLE_FONT_SIZE = 22;

/**
 * Title line height on Mac, paired with `MAC_TITLE_FONT_SIZE` so the hidden
 * measuring div and the title textarea wrap identically.
 */
export const MAC_TITLE_LINE_HEIGHT = 28;
