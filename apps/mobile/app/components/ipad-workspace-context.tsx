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

import React from "react";
import type { IPadPaneMode } from "../utils/ipad-layout";

/**
 * The width-derived iPad workspace, published to the panes that have to react
 * to it without reading (or writing) the shared device mode.
 *
 * The provider is `navigation/fluid-panels-view.tsx`, i.e. the root that owns
 * the panes, and it publishes this only on an iPad: on every other client the
 * context is absent, so its consumers keep their existing behaviour exactly.
 *
 * The split between this and `utils/ipad-layout.ts` is deliberate: the state is
 * React-only here (who is mounted and who reads which mode), while every width,
 * boundary and pager position is computed by the pure helper, which nothing in
 * React can change.
 */
export type IPadWorkspaceState = {
  /** The pane mode the root's actual width lays out in. */
  paneMode: IPadPaneMode;
  /**
   * Whether the source sidebar is *actually visible right now* - not whether the
   * workspace has a sidebar at all.
   *
   * The sidebar node stays mounted through every width (narrow, drawer closed,
   * fullscreen included) so the side menu keeps its tab, scroll and scenes; when
   * it is not visible it is a zero-width or off-canvas pane that takes no
   * touches and is hidden from VoiceOver instead of being unmounted. So
   * "available" is not a question this flag answers: it is true in wide (the
   * persistent column, outside fullscreen) and in medium only while the drawer
   * is actually open, and false in narrow, in medium with the drawer closed and
   * in fullscreen.
   *
   * A consumer therefore reads it as "the source list is on screen", e.g. to
   * know that the Library's own login/sync affordance is the only reachable one
   * where the sidebar is not.
   */
  sidebarVisible: boolean;
};

const IPadWorkspaceContext = React.createContext<IPadWorkspaceState | undefined>(
  undefined
);

export function IPadWorkspaceProvider({
  value,
  children
}: {
  value?: IPadWorkspaceState;
  children: React.ReactNode;
}) {
  return (
    <IPadWorkspaceContext.Provider value={value}>
      {children}
    </IPadWorkspaceContext.Provider>
  );
}

/**
 * The iPad workspace this pane is laid out in, or undefined on every other
 * client (iPhone, Android, Mac Catalyst, and tests without a provider).
 */
export function useIPadWorkspace(): IPadWorkspaceState | undefined {
  return React.useContext(IPadWorkspaceContext);
}
