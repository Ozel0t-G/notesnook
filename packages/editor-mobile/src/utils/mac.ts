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
 * On Mac the editor pane starts at the window's top edge (y 0) and the list
 * column draws the window's title bar row, so the editor's own header has to
 * be exactly as tall as that row for both to look like one title bar. The
 * formatting toolbar then sits at the top of the pane, directly under the
 * header, the way Pages and Notes put their format bar.
 *
 * Nothing here is read on iPhone or iPad: they keep the 50 pt header (plus the
 * safe-area inset) and the keyboard toolbar at the bottom of the pane.
 */

/**
 * Height of the editor header on Mac. Keep in sync with
 * `MAC_TITLEBAR_HEIGHT` in `apps/mobile/app/utils/mac-layout.ts`, which sizes
 * the list column's half of the same band.
 */
export const MAC_EDITOR_HEADER_HEIGHT = 52;

/** Height of a toolbar button (and of the row's buttons). */
export const MAC_TOOLBAR_BUTTON_SIZE = 28;

/** Size of a toolbar button's icon. */
export const MAC_TOOLBAR_ICON_SIZE = 16;

/** Gap between two buttons, and between two toolbar groups. */
export const MAC_TOOLBAR_GAP = 4;

/**
 * Height of the toolbar row itself: a 28 pt button plus 4 pt of padding above
 * and below.
 */
export const MAC_TOOLBAR_HEIGHT = MAC_TOOLBAR_BUTTON_SIZE + MAC_TOOLBAR_GAP * 2;
