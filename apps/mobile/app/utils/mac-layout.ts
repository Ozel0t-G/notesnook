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
 * The Mac window lays out like macOS Notes: a persistent source list (sidebar)
 * on the left, the note list in the middle and the editor taking exactly what
 * is left. All three values are derived from the window width the root view
 * reports, so they follow every resize, and the widths always add up to the
 * window width so the editor's right edge stays inside the window.
 *
 * The window's own chrome - title, toolbar (Library/Tasks/Search and New Note,
 * see ios/Notesnook/MacMenu/VeyraNMacToolbar.{h,m}) and traffic lights - is
 * native and lives above the window's content area, so React starts at the top
 * of that content and reserves no row of its own for it. The height of the
 * chrome is what `macToolbarInset` returns, and every pane pads itself with it.
 *
 * Nothing here is read on iPhone or iPad; those keep the iPad panes in
 * `navigation/fluid-panels-view.tsx`.
 */

import { NativeModules } from "react-native";

/** Window-width-driven width, clamped to the given bounds. */
const clampWidth = (width: number, min: number, max: number) =>
  width < min ? min : width > max ? max : width;

/**
 * Height of the Mac window's unified toolbar, in points.
 *
 * Only a fallback for the short window at startup before UIKit has laid the
 * toolbar out: `macToolbarInset` prefers the native measurement (the
 * `toolbarHeight` constant the VeyraNMacMenu bridge publishes, or the window's
 * top safe-area inset) and only uses this constant while neither is known yet.
 * The old 52 pt "keep in sync with the editor header" note is obsolete:
 * `MAC_EDITOR_HEADER_HEIGHT` in packages/editor-mobile/src/utils/mac.ts is 0
 * now (the editor has no header on Mac), so the editor starts at the very top
 * of the pane and does not depend on this value.
 */
export const MAC_TOOLBAR_HEIGHT = 52;

/**
 * The last real (non-zero) toolbar inset seen. The window's safe-area inset
 * settles only after the toolbar has been laid out, so a caller that runs
 * during the first frames sees 0 and would otherwise fall back to
 * MAC_TOOLBAR_HEIGHT, then jump to the real inset once UIKit reports it (the
 * ~20 pt list jump in R20). Caching the first real value makes the inset
 * stable from then on.
 */
let cachedToolbarInset = 0;

/**
 * The native toolbar height, if the bridge has measured it. 0 means "not
 * measurable yet" (see +[VeyraNMacToolbar toolbarHeight]).
 */
function measuredToolbarHeight() {
  const height = NativeModules?.VeyraNMacMenu?.toolbarHeight;
  return typeof height === "number" && height > 0 ? height : 0;
}

/**
 * The top inset the Mac panes - the list column and the editor pane - start
 * below. Prefers the native measurement (the `toolbarHeight` constant, then
 * the fallback safe-area inset `insetTop`) and caches the first non-zero value
 * so it cannot flip back and forth between the fallback and the real height as
 * the window lays out (R20). MAC_TOOLBAR_HEIGHT is returned only while no real
 * measurement exists yet.
 */
export const macToolbarInset = (insetTop: number) => {
  if (cachedToolbarInset === 0) {
    const value = measuredToolbarHeight() || (insetTop > 0 ? insetTop : 0);
    if (value > 0) cachedToolbarInset = value;
  }
  return cachedToolbarInset > 0 ? cachedToolbarInset : MAC_TOOLBAR_HEIGHT;
};

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

/**
 * Below this window width the Mac sidebar collapses on its own (R10): at the
 * 900 pt minimum the three panes would leave the editor only ~440 pt, so the
 * source list gives way instead and the editor keeps >= ~560 pt.
 */
export const MAC_SIDEBAR_AUTO_COLLAPSE_WIDTH = 1000;

/** True when the window is narrow enough that the sidebar collapses by itself. */
export const macSidebarAutoCollapsed = (
  windowWidth: number,
  threshold = MAC_SIDEBAR_AUTO_COLLAPSE_WIDTH
) => windowWidth < threshold;

/**
 * A manual View > Toggle Sidebar choice, remembered together with which side of
 * the breakpoint (`narrow`) the window was on when it was made. It only holds
 * while the window stays on that side: crossing the breakpoint hands control
 * back to the automatic rule.
 */
export type MacSidebarOverride = { narrow: boolean; visible: boolean };

/** Whether the sidebar is shown: the manual choice if still valid, else automatic. */
export const macSidebarEffectiveVisible = (
  windowWidth: number,
  override?: MacSidebarOverride,
  threshold = MAC_SIDEBAR_AUTO_COLLAPSE_WIDTH
) => {
  const narrow = macSidebarAutoCollapsed(windowWidth, threshold);
  return override && override.narrow === narrow ? override.visible : !narrow;
};

/**
 * Width of the Mac source list (sidebar): 220 pt at a typical window width,
 * clamped to 200-260 pt so it neither disappears in a narrow window nor eats
 * the note list in a wide one.
 *
 * The Mac window cannot be narrower than 900 pt (SceneDelegate's
 * `sizeRestrictions.minimumSize`), and at 900 pt the two clamps bottom out at
 * 200 + 260, so the editor always keeps at least 440 pt.
 *
 * `visible` is View > Toggle Sidebar's flag: a hidden sidebar is 0 pt wide and
 * the space goes to the note list and the editor (see `macEditorWidth`), so the
 * source list is gone from the layout rather than collapsed to a sliver.
 */
export const macSidebarWidth = (windowWidth: number, visible = true) =>
  visible ? clampWidth(windowWidth * 0.2, 200, 260) : 0;

/**
 * Width of the note list column (the middle one): 300 pt at a typical window
 * width, clamped to 260-360 pt. Named `macListWidth` because the note list is
 * the "list" pane of `FluidPanels`.
 */
export const macListWidth = (windowWidth: number) =>
  clampWidth(windowWidth * 0.25, 260, 360);

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
 * Everything the sidebar and the note list leave goes to the editor. Deriving
 * it from the window (instead of a fraction of it) is what keeps the editor's
 * right edge - the "Add tag" button and the header menu - inside the window:
 * `macSidebarWidth + macListWidth + macEditorWidth` is exactly the window
 * width, so the editor pane fills the rest of the window after every resize
 * (including when the sidebar is hidden, where the whole sidebar width is what
 * the editor grows by).
 */
export const macEditorWidth = (windowWidth: number, sidebarVisible = true) =>
  windowWidth -
  macSidebarWidth(windowWidth, sidebarVisible) -
  macListWidth(windowWidth);

/**
 * Liquid Glass sidebar metrics (Part 1 of the Mac glass design).
 *
 * The sidebar is no longer an opaque, full-height column: it is a floating
 * glass panel inset from the window's top, left and bottom edges, with the
 * source list and the account card living inside it. The window has no right
 * edge here (the note list is the sidebar's neighbour), so the panel stays
 * flush with the list column on that side.
 *
 * The panel is translucent, so it needs an opaque backdrop: the Mac window and
 * the React root both carry the app's window colour (SceneDelegate.m,
 * navigation/fluid-panels-view.tsx) and the sidebar pane stays transparent, so
 * the glass - and the `MAC_SIDEBAR_PANEL_INSET` strip around it - sits on that
 * colour instead of a blank, light backdrop.
 */
/** Inset of the floating glass sidebar panel from the window's edges. */
export const MAC_SIDEBAR_PANEL_INSET = 9;
/** Corner radius of the floating glass sidebar panel. */
export const MAC_SIDEBAR_PANEL_RADIUS = 19;
/** Height of one Mac source-list row (the glass-era, roomier row). */
export const MAC_SIDEBAR_ROW_HEIGHT = 30;
/** Corner radius of a source-list row's selection/hover highlight. */
export const MAC_SIDEBAR_ROW_RADIUS = 9;

/** The account card the sidebar pins to its bottom: a glass card of its own. */
export const MAC_ACCOUNT_CARD_HEIGHT = 46;
export const MAC_ACCOUNT_CARD_RADIUS = 14;
/** Margin of the account card inside the sidebar panel. */
export const MAC_ACCOUNT_CARD_MARGIN = 10;

/** A row-selection fill, applied with `opacity` on a layer of its own. */
export type MacSidebarSelection = { color: string; opacity: number };

/**
 * Strength of the sidebar's selection highlight. Unlike the accent fill still
 * used by the note list (see `macSelectionFill` in mac-system-state.ts), the
 * source list uses a subtle neutral wash: white over a dark glass panel, black
 * over a light one.
 */
export const MAC_SIDEBAR_SELECTION_OPACITY = {
  light: 0.08,
  dark: 0.14
} as const;

/** The sidebar's subtle rounded selection highlight for the given appearance. */
export function macSidebarSelectionFill(isDark: boolean): MacSidebarSelection {
  return {
    color: isDark ? "#FFFFFF" : "#000000",
    opacity: isDark
      ? MAC_SIDEBAR_SELECTION_OPACITY.dark
      : MAC_SIDEBAR_SELECTION_OPACITY.light
  };
}
