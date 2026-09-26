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

import { strings } from "@notesnook/intl";
import { db } from "../../common/database";
import { DDS } from "../../services/device-detection";
import { eSendEvent } from "../../services/event-manager";
import Navigation from "../../services/navigation";
import { useMenuStore } from "../../stores/use-menu-store";
import { useRelationStore } from "../../stores/use-relation-store";
import { useTagStore } from "../../stores/use-tag-store";
import { eOnLoadNote, eOnNotebookUpdated } from "../../utils/events";
import { openLinkInBrowser } from "../../utils/functions";
import { fluidTabsRef } from "../../utils/global-refs";
import { editorState } from "../editor/tiptap/utils";

export const PLACEHOLDER_DATA = {
  title: strings.yourNotes(),
  paragraph: strings.notesEmpty(),
  button: strings.addFirstNote(),
  action: openEditor,
  loading: strings.loadingNotes()
};

export function toCamelCase(title: string) {
  if (!title) return "";
  return title.slice(0, 1).toUpperCase() + title.slice(1);
}

export function openMonographsWebpage() {
  try {
    openLinkInBrowser(
      "https://notesnook.com/help/publish-notes-with-monographs"
    );
  } catch (e) {
    console.error(e);
  }
}

export function openEditor() {
  if (!DDS.isTab) {
    eSendEvent(eOnLoadNote, { newNote: true });
    editorState().currentlyEditing = true;
    editorState().movedAway = false;
    fluidTabsRef.current?.goToPage("editor");
  } else {
    eSendEvent(eOnLoadNote, { newNote: true });
  }
}

type FirstSaveData = {
  type: string;
  id: string;
  notebook?: string;
};

// A deferred first-save callback must not outlive a newer screen context.
let firstSaveRegistration = 0;

export const setOnFirstSave = (
  data: {
    type: string;
    id: string;
    notebook?: string;
  } | null
) => {
  const registration = ++firstSaveRegistration;
  if (!data) {
    editorState().onNoteCreated = null;
    return;
  }
  setTimeout(() => {
    if (registration !== firstSaveRegistration) return;
    editorState().onNoteCreated = (noteId) => onNoteCreated(noteId, data);
  }, 0);
};

/**
 * A Library or global compose action explicitly creates a note without a
 * notebook, even when the user configured a default notebook. The editor's
 * usual default tag still applies.
 */
export function setOnFirstSaveUnassigned() {
  const registration = ++firstSaveRegistration;
  // Match the deferred first-save registration used by Notebook creation, so
  // this assignment survives the transition back into the editor pane.
  setTimeout(() => {
    if (registration !== firstSaveRegistration) return;
    editorState().onNoteCreated = (noteId) => {
      const defaultTag = db.settings.getDefaultTag();
      if (defaultTag) {
        void onNoteCreated(noteId, { type: "tag", id: defaultTag });
      }
    };
  }, 0);
}

export async function onNoteCreated(noteId: string, data: FirstSaveData) {
  if (!data) return;
  switch (data.type) {
    case "notebook": {
      await db.relations?.add(
        { type: "notebook", id: data.id },
        { type: "note", id: noteId }
      );
      editorState().onNoteCreated = null;
      useRelationStore.getState().update();
      eSendEvent(eOnNotebookUpdated, data.id);
      break;
    }
    case "tag": {
      const note = await db.notes.note(noteId);
      const tag = await db.tags.tag(data.id);

      if (tag && note) {
        await db.relations.add(tag, note);
      }

      editorState().onNoteCreated = null;
      useTagStore.getState().refresh();
      useRelationStore.getState().update();
      break;
    }
    case "color": {
      const note = await db.notes.note(noteId);
      const color = await db.colors.color(data.id);
      if (note && color) {
        await db.relations.add(color, note);
      }
      editorState().onNoteCreated = null;
      useMenuStore.getState().setColorNotes();
      useRelationStore.getState().update();
      break;
    }
    default: {
      break;
    }
  }
  Navigation.queueRoutesForUpdate();
}
