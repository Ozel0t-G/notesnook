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
 * The window's own chrome - title, toolbar (Library/Tasks/Search and New Note,
 * see ios/Notesnook/MacMenu/VeyraNMacToolbar.{h,m}) and traffic lights - is
 * native and lives above the window's content area, so React starts at the top
 * of that content and reserves no row of its own for it. The height of the
 * chrome is what `macToolbarInset` returns, and the list column and the editor
 * pane pad themselves with it.
 *
 * Nothing here is read on iPhone or iPad; those keep the iPad panes in
 * `navigation/fluid-panels-view.tsx`.
 */

/**
 * Height of the Mac window's unified toolbar, in points.
 *
 * Only a fallback: with the toolbar installed UIKit reports its height in the
 * window's top safe-area inset, which is what `macToolbarInset` prefers. Some
 * macCatalyst/AppKit versions report 0 there - the inset is recalculated only
 * once the toolbar has been laid out - and on those the panes fall back to the
 * 52 pt a unified toolbar measures on macOS.
 */
export const MAC_TOOLBAR_HEIGHT = 52;

/**
 * The top inset the Mac panes - the list column and the editor pane - start
 * below: the window's top safe-area inset (react-native-safe-area-context
 * `insets.top`, which carries the native toolbar's height on Catalyst), or
 * MAC_TOOLBAR_HEIGHT when UIKit reports 0.
 *
 * Keep the 52 pt in sync with `MAC_EDITOR_HEADER_HEIGHT` in
 * packages/editor-mobile/src/utils/mac.ts, the height of the editor's own web
 * header, which starts right under this inset on Mac.
 */
export const macToolbarInset = (insetTop: number) =>
  insetTop > 0 ? insetTop : MAC_TOOLBAR_HEIGHT;

/**
 * Metrics of MacSectionControl, the React-drawn section control that used to
 * live in a 52 pt title bar row of its own: where the control started (right of
 * the traffic lights, which occupy x 12-72 in window points), the gap to the
 * column's right edge, and the control's height/label size. The native toolbar
 * replaced that row, so nothing mounts the component in the running app.
 */
export const MAC_TITLEBAR_CONTROL_LEFT = 88;
export const MAC_TITLEBAR_CONTROL_RIGHT = 12;
export const MAC_TITLEBAR_CONTROL_HEIGHT = 24;
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
 * gutter and the trailing gap. Unused in the running app along with the control
 * itself (see components/mac-section-control.tsx).
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
