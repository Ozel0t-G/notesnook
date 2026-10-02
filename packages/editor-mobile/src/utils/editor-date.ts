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
 * The note's last-edited date, as delivered by the app.
 *
 * The RN side already sends it to the WebView through the existing
 * `setStatus` editor command (`commands.setStatus` in
 * `apps/mobile/app/screens/editor/tiptap/commands.ts`) every time a note is
 * loaded or saved: `getFormattedDate(note.dateEdited, "date-time")`. That
 * command used to be dropped on the floor in the WebView, so this tiny store
 * captures it per tab and lets a component (the Mac date line above the note
 * title) subscribe to it without a new native event.
 */
type Listener = (date: string) => void;

const dates: Record<string, string> = {};
const listeners: Record<string, Set<Listener>> = {};

export const editorDate = {
  /** Records the formatted date (or "" to clear it) for a tab. */
  set(tabId: string, date: string) {
    if (dates[tabId] === date) return;
    dates[tabId] = date;
    listeners[tabId]?.forEach((listener) => listener(date));
  },

  /** The last value recorded for a tab, so a late subscriber is not empty. */
  get(tabId: string) {
    return dates[tabId] || "";
  },

  /** Subscribes to changes for a tab; returns the unsubscribe function. */
  subscribe(tabId: string, listener: Listener) {
    if (!listeners[tabId]) listeners[tabId] = new Set();
    listeners[tabId].add(listener);
    return () => {
      listeners[tabId]?.delete(listener);
    };
  }
};
