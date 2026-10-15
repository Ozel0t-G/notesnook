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

import { useContext, useEffect, PropsWithChildren } from "react";
import {
  PositionOptions,
  PopupPresenterProps,
  PopupPresenter
} from "@notesnook/ui";
import {
  getPopupContainer,
  getPopupRoot,
  getToolbarElement
} from "../../toolbar/utils/dom.js";
import {
  getPopupAncestry,
  ToolbarPopupVisibilityContext,
  useIsMobile,
  usePopupId,
  useToolbarStore
} from "../../toolbar/stores/toolbar-store.js";
import React from "react";
import {
  ResponsivePresenter,
  ResponsivePresenterProps
} from "../responsive/index.js";

export type PopupWrapperProps = UsePopupHandlerOptions & {
  autoCloseOnUnmount?: boolean;
  position: PositionOptions;
} & Partial<Omit<PopupPresenterProps, "onClose" | "isOpen">>;
export function PopupWrapper(props: PropsWithChildren<PopupWrapperProps>) {
  const {
    id: _id,
    position,
    children,
    autoCloseOnUnmount,
    ...presenterProps
  } = props;
  const { closePopup, isPopupOpen, id } = usePopupHandler(props);
  const isMobile = useIsMobile();
  // Unconditional: every `PopupWrapper` must honour its enclosing `Toolbar`'s
  // quiet-presentation flag, not just the ones rendered while it is already
  // false - the context default (`true`) keeps every popup that never opts in
  // (e.g. `showPopup`'s root, which renders outside any `Toolbar`) unaffected.
  const popupsVisible = useContext(ToolbarPopupVisibilityContext);

  useEffect(() => {
    if (!autoCloseOnUnmount) return;
    return () => {
      closePopup(id);
    };
  }, [autoCloseOnUnmount, id, closePopup]);

  return (
    <PopupPresenter
      key={id}
      onClose={() => closePopup(id)}
      position={position}
      blocking
      focusOnRender
      className={isMobile ? "editor-mobile-toolbar-popup" : undefined}
      isMobile={isMobile}
      container={getPopupContainer()}
      {...presenterProps}
      isOpen={isPopupOpen && popupsVisible}
    >
      {children}
    </PopupPresenter>
  );
}

type UsePopupHandlerOptions = {
  id: string;
  group: string;
  onClosed?: () => void;
};
export function usePopupHandler(options: UsePopupHandlerOptions) {
  const { onClosed, group } = options;
  const id = usePopupId(options.id);
  const openedPopups = useToolbarStore((store) => store.openedPopups);
  const closePopup = useToolbarStore((store) => store.closePopup);
  const closePopupGroup = useToolbarStore((store) => store.closePopupGroup);

  const isPopupOpen = typeof openedPopups[id] === "object";
  const isPopupDefined = typeof openedPopups[id] !== "undefined";

  useEffect(() => {
    // we don't want to close the popup just when it is about to open.
    if (!isPopupOpen && isPopupDefined) onClosed?.();
  }, [isPopupOpen, isPopupDefined, onClosed]);

  useEffect(() => {
    // if another popup in the same group is open, close it - but never the
    // popup this one is nested in, nor any of its ancestors. A child and its
    // ancestors can share a store group (the mobile toolbar forces every popup
    // into "mobile"), and closing one of them would unmount this popup
    // together with everything rendered inside it. The parent is read from the
    // record `usePopupManager` opened, because the presenter options do not
    // carry it.
    if (isPopupOpen) {
      closePopupGroup(
        group,
        getPopupAncestry(useToolbarStore.getState().openedPopups, id)
      );
    }
  }, [onClosed, isPopupOpen, closePopupGroup, id, group]);

  return { isPopupOpen, closePopup, id };
}

type OwnedPopup = { token: number; dismiss: () => void; dispose: () => void };
const ownedPopups = new WeakMap<HTMLElement, OwnedPopup[]>();
let nextPopupToken = 1;

/** Ephemeral UI identity only; never treat the shared body as a note owner. */
export function getPopupDismissToken(owner: HTMLElement): number | undefined {
  if (owner === document.body || !owner.isConnected) return undefined;
  const entries = ownedPopups.get(owner);
  return entries?.[entries.length - 1]?.token;
}

/** Close exactly the requested top popup; a replacement has a different token. */
export function dismissPopupForOwner(
  owner: HTMLElement,
  token: number
): boolean {
  if (getPopupDismissToken(owner) !== token) return false;
  const entries = ownedPopups.get(owner);
  const entry = entries?.[entries.length - 1];
  if (!entry) return false;
  entry.dismiss();
  return true;
}

type ShowPopupOptions = {
  /** Return false to consume dismissal (e.g. close a nested palette first). */
  beforeDismiss?: () => boolean;
  /** An enduring parent host owns popups opened above it; transient menus do not. */
  closeDescendantsOnHide?: boolean;
  popup: (closePopup: () => void) => React.ReactNode;
} & Partial<ResponsivePresenterProps>;
export function showPopup(options: ShowPopupOptions) {
  const {
    popup,
    beforeDismiss,
    closeDescendantsOnHide = false,
    ...props
  } = options;

  const owner = props.container || getPopupContainer();
  const root = getPopupRoot(owner);
  let closed = false;
  const entry: OwnedPopup = {
    token: nextPopupToken++,
    dismiss: () => {
      if (closed || beforeDismiss?.() === false) return;
      entry.dispose();
    },
    dispose: () => {
      if (closed) return;
      hide();
      props.onClose?.();
    }
  };
  function hide() {
    if (closed) return;
    closed = true;
    const entries = ownedPopups.get(owner);
    const index = entries?.indexOf(entry) ?? -1;
    if (entries && index >= 0 && closeDescendantsOnHide) {
      // Later entries were opened over this owner's popup. Removing the parent
      // must also remove those independent React roots (e.g. its link dialog).
      const descendants = entries.splice(index).slice(1).reverse();
      for (const child of descendants) child.dispose();
    } else if (entries && index >= 0) entries.splice(index, 1);
    if (!entries?.length) ownedPopups.delete(owner);
    root.unmount();
  }

  root.render(
    <ResponsivePresenter
      isOpen
      position={{
        target: getToolbarElement(),
        isTargetAbsolute: true,
        location: "below",
        align: "end",
        yOffset: 10
      }}
      blocking
      focusOnRender
      container={owner}
      {...props}
      onClose={entry.dismiss}
    >
      {popup(hide)}
    </ResponsivePresenter>
  );

  if (owner !== document.body && !closed) {
    const entries = ownedPopups.get(owner) || [];
    entries.push(entry);
    ownedPopups.set(owner, entries);
  }
  return hide;
}
