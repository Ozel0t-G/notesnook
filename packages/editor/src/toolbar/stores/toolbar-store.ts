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

import { create } from "zustand";
import { DownloadOptions } from "../../utils/downloader.js";
import { createContext, useCallback, useContext } from "react";

export type ToolbarLocation = "top" | "bottom";

/**
 * The id of the popup a nested toolbar popup is rendered *inside* (the
 * enclosing "more" group's `popupId`), or `undefined` for a popup rendered
 * directly on the toolbar row.
 *
 * `MoreTools` provides its own `popupId` here for everything it renders, and
 * `Dropdown` consumes it as `usePopupManager`'s `parent`. Without it a nested
 * dropdown shares its parent's store group (the mobile toolbar forces every
 * popup into the `"mobile"` group), so opening the child would
 * `closePopupGroup` its own parent and unmount the very panel the child is
 * rendered in.
 *
 * It lives next to the store - and not in `components/popup-presenter` - so
 * that renderers mocking the presenter (e.g. the toolbar render tests) keep
 * resolving it from the real, never-mocked store module.
 */
export const PopupParentContext = createContext<string | undefined>(undefined);

/** Per-host ephemeral namespace. Parent context already contains a resolved id. */
export const PopupIdScopeContext = createContext("");
export function usePopupId(id: string) {
  return useContext(PopupIdScopeContext) + id;
}

/**
 * Whether the toolbar may *automatically* open the `linkSettings` popup when a
 * link is selected (the bottom/mobile toolbar shows the link's actions this
 * way, without a tap). `true` is the default for every platform and keeps the
 * previous behaviour.
 *
 * The iOS quiet reading presentation passes `false`: the toolbar stays mounted
 * but is hidden in CSS, and its zero-size rect would anchor the popup at the
 * origin - clipped above the status bar. Gating only the automatic popup keeps
 * the tool, its commands and the toolbar lifecycle exactly as they are, so the
 * normal popup returns the moment the user leaves the quiet presentation.
 *
 * A plain React context - deliberately not a zustand store field: it is a
 * per-`Toolbar`-instance rendering decision (supplied by the embedding app) and
 * must neither persist nor leak into other toolbars. It lives next to
 * `PopupParentContext` so renderers that mock the presenter still resolve it
 * from the real, never-mocked store module.
 */
export const LinkSettingsAutoOpenContext = createContext(true);

/**
 * Whether the Mac format bar's existing "Aa" menu (`MacFormat`) should lay its
 * popup out as a single bounded vertical column instead of the toolbar's
 * default horizontal bottom row. Set by the iPhone/iPad "Aa" presentation,
 * which reuses the existing Mac format commands unchanged; `Toolbar` provides
 * `ios && !macCatalyst` here, so the Mac Catalyst capsule's own row layout is
 * never affected even if both flags are set.
 *
 * A plain React context, for the same reason as `LinkSettingsAutoOpenContext`:
 * a per-`Toolbar`-instance rendering decision that must neither persist nor
 * leak into other toolbars.
 */
export const IosFormatContext = createContext(false);

/**
 * Whether the toolbar's own popups (the "more" overflow, "Aa", any nested
 * menu) may be shown. `true` is the default on every platform and keeps the
 * previous behaviour.
 *
 * The iOS quiet reading presentation sets this to `false` instead of
 * unmounting the toolbar: the toolbar stays mounted but is hidden in CSS
 * (`HeaderDone`), while a popup that was already open before that happened is
 * rendered through its own portal, outside the toolbar's own DOM subtree -
 * hiding the toolbar does nothing to it, and it survives on screen, anchored
 * at the toolbar's now-clipped origin above the native app's own chrome.
 *
 * `PopupWrapper` reads this context directly and ANDs it with the store's own
 * `isPopupOpen`, so only the popup's *rendered visibility* is gated: its
 * `openedPopups` record (open, pinned, nested parent/child) is left
 * completely untouched. Leaving the quiet presentation restores every popup
 * that was open and/or pinned exactly as it was, with no re-opening logic of
 * its own and no `closeAllPopups` ever involved.
 *
 * A plain React context, for the same reason as `LinkSettingsAutoOpenContext`
 * and `IosFormatContext`: a per-`Toolbar`-instance rendering decision that
 * must neither persist nor leak into other toolbars, and that a presenter
 * mock resolves from the real, never-mocked store module.
 */
export const ToolbarPopupVisibilityContext = createContext(true);

export type PopupRef = {
  id: string;
  group: string;
  pinned?: boolean;
  parent?: string;
};
interface ToolbarState {
  downloadOptions?: DownloadOptions;
  setDownloadOptions: (options?: DownloadOptions) => void;
  isMobile: boolean;
  openedPopups: Record<string, PopupRef | false | undefined>;
  setIsMobile: (isMobile: boolean) => void;
  /**
   * The embedding app runs in a Mac Catalyst window, where the toolbar is a
   * desktop format bar at the top of the editor instead of the iOS keyboard
   * toolbar: a single non-scrolling row of compact buttons whose trailing
   * groups collapse into the "more" popup. See `Toolbar`.
   */
  macCatalyst: boolean;
  setMacCatalyst: (macCatalyst: boolean) => void;
  toolbarLocation: ToolbarLocation;
  setToolbarLocation: (location: ToolbarLocation) => void;
  isPopupOpen: (popupId: string) => boolean;
  openPopup: (ref: PopupRef) => void;
  closePopup: (popupId: string) => void;
  closePopupGroup: (groupId: string, excluded: string[]) => void;
  closeAllPopups: () => void;
  fontFamily: string;
  setFontFamily: (fontFamily: string) => void;
  fontSize: number;
  setFontSize: (fontSize: number) => void;
}

export const useToolbarStore = create<ToolbarState>((set, get) => ({
  downloadOptions: undefined,
  isMobile: false,
  openedPopups: {},
  setDownloadOptions: (options) => set({ downloadOptions: options }),
  setIsMobile: (isMobile) => set({ isMobile }),
  macCatalyst: false,
  setMacCatalyst: (macCatalyst) => set({ macCatalyst }),
  toolbarLocation: "top",
  setToolbarLocation: (location) => set({ toolbarLocation: location }),
  closePopup: (id) =>
    set((state) => {
      // Closing a popup closes everything nested in it: a descendant is
      // rendered inside its parent, so leaving its record behind would make it
      // re-open on its own the next time the parent is rendered (both the
      // trigger toggle and the presenter's ESC/backdrop close funnel here, and
      // both must leave no leaked descendant behind).
      const openedPopups: Record<string, PopupRef | false | undefined> = {
        ...state.openedPopups,
        [id]: undefined
      };
      toggleChildState(
        openedPopups,
        (ref) => {
          openedPopups[ref.id] = undefined;
        },
        id
      );
      return { openedPopups };
    }),
  isPopupOpen: (id) => !!get().openedPopups[id],
  openPopup: (ref) =>
    set({
      openedPopups: {
        ...get().openedPopups,
        [ref.id]: ref
      }
    }),
  closePopupGroup: (group, excluded) =>
    set((state) => {
      for (const key in state.openedPopups) {
        const ref = state.openedPopups[key];
        if (
          ref &&
          ref.group === group &&
          !excluded.includes(ref.id) &&
          !ref.pinned &&
          !isChildPinned(state.openedPopups, ref.id)
        ) {
          state.openedPopups[key] = undefined;
        }
      }
      return state;
    }),
  closeAllPopups: () =>
    set((state) => {
      for (const key in state.openedPopups) {
        const ref = state.openedPopups[key];
        if (ref && !ref.pinned && !isChildPinned(state.openedPopups, ref.id))
          state.openedPopups[key] = undefined;
      }
      return state;
    }),
  fontFamily: "sans-serif",
  setFontFamily: (fontFamily) => set({ fontFamily }),
  fontSize: 14,
  setFontSize: (fontSize) => set({ fontSize })
}));

export function useToolbarLocation() {
  return useToolbarStore((store) => store.toolbarLocation);
}

export function useIsMobile() {
  return useToolbarStore((store) => store.isMobile);
}

export function useIsMacCatalyst() {
  return useToolbarStore((store) => store.macCatalyst);
}

export function usePopupManager(options: {
  id: string;
  group: string;
  parent?: string;
}) {
  const { parent } = options;
  const id = usePopupId(options.id);
  const openedPopups = useToolbarStore((store) => store.openedPopups);
  const openPopup = useToolbarStore((store) => store.openPopup);
  const closePopup = useToolbarStore((store) => store.closePopup);
  const closePopupGroup = useToolbarStore((store) => store.closePopupGroup);
  const isMobile = useIsMobile();
  const isOpen = typeof openedPopups[id] === "object";
  const isPinned =
    typeof openedPopups[id] === "object" &&
    (!!openedPopups[id]?.pinned || isChildPinned(openedPopups, id));
  const group = isMobile ? "mobile" : options.group;

  const open = useCallback(() => {
    const openedPopups = useToolbarStore.getState().openedPopups;
    // Opening a popup closes the other popups of the same group - but never
    // the popup this one is nested in, nor any of its ancestors: on the mobile
    // toolbar every popup shares the "mobile" group, so dropping an ancestor
    // would unmount the very chain this popup is rendered in.
    closePopupGroup(group, [id, ...getPopupAncestry(openedPopups, parent)]);
    openPopup({
      id,
      group,
      parent,
      pinned: isParentPinned(openedPopups, parent)
    });
  }, [openPopup, closePopupGroup, group, id, parent]);

  const close = useCallback(() => {
    closePopup(id);
    useToolbarStore.setState((state) => {
      toggleChildState(
        state.openedPopups,
        (ref) => {
          state.openedPopups[ref.id] = undefined;
        },
        id
      );
      return state;
    });
  }, [closePopup, id]);

  const toggle = useCallback(() => {
    if (isOpen) close();
    else open();
  }, [isOpen, close, open]);

  const togglePinned = useCallback(() => {
    useToolbarStore.setState((state) => {
      toggleChildState(
        state.openedPopups,
        (ref) => (ref.pinned = !isPinned),
        id
      );
      return state;
    });
    if (isPinned) openPopup({ group, id, parent, pinned: false });
    else openPopup({ group, id, parent, pinned: true });
  }, [isPinned, openPopup, id, group, parent]);

  return { isOpen, open, close, toggle, isPinned, togglePinned };
}

/**
 * `id` followed by every ancestor reachable through the `parent` pointers
 * recorded in `openedPopups` (`[id, parent, grandparent, ...]`). The walk is
 * bounded by the number of open popups and skips already-visited ids, so a
 * malformed or cyclic parent chain can never loop forever.
 *
 * This is the one place the "which popups are above me" question is answered:
 * `open()` and the presenter's group-closing effect both exclude the result so
 * that opening (or re-opening) a nested popup never closes the popup it - or
 * any of its ancestors - is rendered in.
 */
export function getPopupAncestry(
  popups: Record<string, PopupRef | false | undefined>,
  id?: string
): string[] {
  const ancestry: string[] = [];
  const visited = new Set<string>();
  let current = id;
  const bound = Object.keys(popups).length + 1;
  while (current && !visited.has(current) && ancestry.length < bound) {
    visited.add(current);
    ancestry.push(current);
    const ref = popups[current];
    current = ref ? ref.parent : undefined;
  }
  return ancestry;
}

function toggleChildState(
  popups: Record<string, PopupRef | undefined | false>,
  action: (ref: PopupRef) => void,
  parent?: string
) {
  if (!parent) return;
  for (const key in popups) {
    const ref = popups[key];
    if (ref && ref.parent === parent) {
      action(ref);
      toggleChildState(popups, action, ref.id);
    }
  }
}

function isParentPinned(
  popups: Record<string, PopupRef | undefined | false>,
  parent?: string
) {
  if (!parent) return;
  for (const key in popups) {
    const ref = popups[key];
    if (ref && ref.id === parent && ref.pinned) {
      return true;
    }
  }
  return false;
}

function isChildPinned(
  popups: Record<string, PopupRef | undefined | false>,
  id: string
) {
  for (const key in popups) {
    const ref = popups[key];
    if (ref && ref.parent === id && ref.pinned) {
      return true;
    }
  }
  return false;
}
