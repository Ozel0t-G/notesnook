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
 * Mac Catalyst Escape ownership: a tiny ephemeral in-memory registry of the
 * currently-presented sheets/dialogs, so the root Escape handler closes the
 * single actually-topmost one (by real presentation order) instead of
 * broadcasting hide to everything. Nothing here persists or crosses a
 * process boundary.
 */

export type MacModalKind = "dialog" | "sheet";

interface MacModalEntry {
  readonly kind: MacModalKind;
  seq: number;
  active: boolean;
  closing: boolean;
  isClosable: () => boolean;
  close: () => void;
}

export interface MacModalController {
  present: () => void;
  dismissed: () => void;
  markClosing: () => void;
  isActive: () => boolean;
  unregister: () => void;
}

export interface MacSheetRef {
  show: (...args: unknown[]) => unknown;
  hide: (...args: unknown[]) => unknown;
  setModalVisible: (visible: boolean, ...args: unknown[]) => unknown;
  [method: string]: unknown;
}

let nextId = 1;
let nextSeq = 1;
const entries = new Map<number, MacModalEntry>();

export function registerMacModal(
  kind: MacModalKind,
  isClosable: () => boolean,
  close: () => void
): MacModalController {
  const id = nextId++;
  const entry: MacModalEntry = {
    kind,
    seq: 0,
    active: false,
    closing: false,
    isClosable,
    close
  };
  entries.set(id, entry);
  return {
    present: () => {
      // Idempotent only while active and NOT closing: a presented entry's
      // own prop/flag updates (closability, loading, etc.) must never bump
      // it ahead of whatever was actually presented after it.
      //
      // An entry can end up active AND closing when a prior Escape (or the
      // facade's own hide()/setModalVisible(false)) asked native to close it,
      // but the vendor's real onClose callback never actually ran (dropped,
      // interrupted, superseded by another presentation, ...). That entry is
      // then stuck forever consuming Escape without ever closing. A second
      // present() call while still active-and-closing is treated as proof
      // it is genuinely back on screen, so this clears closing and bumps
      // order exactly like a fresh presentation, instead of returning early.
      // The strength of that proof differs by caller: the sheet facade only
      // reaches present() from the real vendor onOpen callback, so there it
      // is a native-confirmed re-presentation. Dialog instead calls
      // controller.present() directly from its visibility/appLocked/
      // dialogInfo effect, i.e. a re-presentation *intent* rather than a
      // native confirmation that the modal is actually back on screen. That
      // is benign today only because no current caller wires a native
      // onShow/onOpen signal through Dialog's controller; if one ever does,
      // this fallback must be revisited for Dialog specifically.
      if (entry.active && !entry.closing) return;
      entry.active = true;
      entry.closing = false;
      entry.seq = nextSeq++;
    },
    dismissed: () => {
      entry.active = false;
      entry.closing = false;
    },
    markClosing: () => {
      entry.closing = true;
    },
    isActive: () => entry.active,
    unregister: () => {
      entries.delete(id);
    }
  };
}

/**
 * The single topmost active entry across dialogs and sheets, by actual
 * presentation order: whichever was presented (or re-presented) most
 * recently wins, regardless of kind. Neither a dialog (a native Modal) nor a
 * sheet (an ActionSheet) is assumed to sit above the other by default - only
 * the real order they were shown in decides.
 */
function topmostActive(): MacModalEntry | undefined {
  let top: MacModalEntry | undefined;
  for (const entry of entries.values()) {
    if (!entry.active) continue;
    if (!top || entry.seq > top.seq) top = entry;
  }
  return top;
}

/** A late Web reply must not act beneath a newly presented native modal. */
export function hasActiveMacModal(): boolean {
  return !!topmostActive();
}

export function consumeMacEscape(): boolean {
  const top = topmostActive();
  if (!top) return false;
  if (top.closing) return true;
  if (!top.isClosable()) return true;
  top.closing = true;
  top.close();
  return true;
}

/**
 * Wraps the real ActionSheet ref so hide()/setModalVisible(false) called
 * through this facade (including the registry's own close callback) mark
 * the entry closing without a redundant close, while every other method,
 * including Symbol-keyed ones, is forwarded unchanged, bound to the current
 * real ref. Presentation itself is never armed here: show()/setModalVisible
 * (true) only forward the call, because native can still refuse to actually
 * open afterwards (locked, interrupted animation, ...); the entry is armed
 * from the real onOpen callback once presentation has actually happened, so
 * a request native ends up refusing never owns Escape as a "ghost". Every
 * path also guards against a null/stale target ref so a forgotten reference
 * to this facade can never create an entry after the owning component has
 * unmounted.
 */
export function createMacSheetFacade(
  targetRef: { current: MacSheetRef | null },
  controller: MacModalController
): MacSheetRef {
  return new Proxy({} as MacSheetRef, {
    get(_target, prop: string | symbol) {
      if (prop === "show") {
        return (...args: unknown[]) => {
          if (!targetRef.current) return undefined;
          return targetRef.current.show(...args);
        };
      }
      if (prop === "setModalVisible") {
        return (visible: boolean, ...args: unknown[]) => {
          if (!targetRef.current) return undefined;
          if (!visible && controller.isActive()) {
            controller.markClosing();
          }
          return targetRef.current.setModalVisible(visible, ...args);
        };
      }
      if (prop === "hide") {
        return (...args: unknown[]) => {
          if (!targetRef.current) return undefined;
          if (controller.isActive()) controller.markClosing();
          return targetRef.current.hide(...args);
        };
      }
      if (typeof prop === "symbol") {
        const value = targetRef.current?.[prop as unknown as string];
        return typeof value === "function"
          ? value.bind(targetRef.current)
          : value;
      }
      const value = targetRef.current?.[prop];
      return typeof value === "function"
        ? value.bind(targetRef.current)
        : value;
    }
  });
}

export function __resetMacModalStackForTests(): void {
  entries.clear();
  nextId = 1;
  nextSeq = 1;
}
