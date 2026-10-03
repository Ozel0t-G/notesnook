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

import type { Note } from "@notesnook/core";
import { db } from "../../common/database";
import { applyTemplateVariables, resetTaskChecks } from "./variables";
import type { TemplateContext } from "./variables";

export const TEMPLATE_TAG = "template";
export const DEFAULT_TEMPLATE_TITLE = "Untitled template";
export const EMPTY_TEMPLATE_CONTENT = "<p></p>";

const LOCKED_TEMPLATE_ERROR = "Vault-locked notes cannot be used as templates.";

export type { TemplateContext };

/**
 * `db.relations.from(tag, "note")` deliberately excludes archived notes, so the
 * template list is queried through SQL (same null/0 boolean encoding as the
 * core `isFalse` helper).
 */
function isFalse(eb: any, column: string) {
  return eb.or([eb(column, "is", null), eb(column, "==", 0)]);
}

export async function getTemplateTagId(create: true): Promise<string>;
export async function getTemplateTagId(
  create?: boolean
): Promise<string | undefined>;
export async function getTemplateTagId(
  create = false
): Promise<string | undefined> {
  const existing = await db.tags.find(TEMPLATE_TAG);
  if (existing) return existing.id;
  if (!create) return undefined;
  return db.tags.add({ title: TEMPLATE_TAG });
}

async function selectTemplateNotes(): Promise<Note[]> {
  const tagId = await getTemplateTagId(false);
  if (!tagId) return [];

  const notes = await db
    .sql()
    .selectFrom("notes")
    .selectAll()
    .where((eb: any) => isFalse(eb, "dateDeleted"))
    .where((eb: any) => isFalse(eb, "deleted"))
    .where("archived", "==", true)
    .where("id", "in", (eb: any) =>
      eb
        .selectFrom("relations")
        .select("toId")
        .where("fromType", "==", "tag")
        .where("fromId", "==", tagId)
        .where("toType", "==", "note")
    )
    .execute();

  return notes as unknown as Note[];
}

function byTitleCaseInsensitive(a: Note, b: Note): number {
  const left = (a.title || "").toLowerCase();
  const right = (b.title || "").toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export async function getTemplates(): Promise<Note[]> {
  const notes = await selectTemplateNotes();
  return notes.sort(byTitleCaseInsensitive);
}

export async function getTemplateIds(): Promise<string[]> {
  const notes = await selectTemplateNotes();
  return notes.map((note) => note.id);
}

export async function getTemplateCount(): Promise<number> {
  return (await getTemplateIds()).length;
}

export async function isTemplate(noteId: string): Promise<boolean> {
  return (await getTemplateIds()).includes(noteId);
}

async function archiveAndLink(noteId: string, tagId: string): Promise<void> {
  await db.notes.archive(true, noteId);
  await db.relations.add(
    { type: "tag", id: tagId },
    { type: "note", id: noteId }
  );
}

export async function createTemplate(): Promise<string> {
  const tagId = await getTemplateTagId(true);
  const id = await db.notes.add({
    title: DEFAULT_TEMPLATE_TITLE,
    content: { type: "tiptap", data: EMPTY_TEMPLATE_CONTENT }
  });
  await archiveAndLink(id, tagId);
  return id;
}

export async function saveNoteAsTemplate(noteId: string): Promise<string> {
  const note = await db.notes.note(noteId);
  if (!note) throw new Error("The note could not be found.");

  const content = note.contentId
    ? await db.content.get(note.contentId)
    : undefined;
  if (content?.locked) throw new Error(LOCKED_TEMPLATE_ERROR);

  const tagId = await getTemplateTagId(true);
  const id = await db.notes.add({
    title: note.title,
    content: {
      type: content?.type ?? "tiptap",
      data:
        content && typeof content.data === "string"
          ? content.data
          : EMPTY_TEMPLATE_CONTENT
    }
  });
  await archiveAndLink(id, tagId);
  return id;
}

export async function addToTemplates(noteId: string): Promise<void> {
  const tagId = await getTemplateTagId(true);
  await archiveAndLink(noteId, tagId);
}

export async function removeFromTemplates(noteId: string): Promise<void> {
  const tagId = await getTemplateTagId(false);
  if (tagId)
    await db.relations.unlink(
      { type: "tag", id: tagId },
      { type: "note", id: noteId }
    );
  // A template is only a normal note because it is archived; unarchive it.
  await db.notes.archive(false, noteId);
}

export async function getTemplateContent(
  noteId: string
): Promise<{ title: string; html: string }> {
  const note = await db.notes.note(noteId);
  if (!note) throw new Error("The template could not be found.");

  const content = note.contentId
    ? await db.content.get(note.contentId)
    : undefined;
  if (content?.locked) throw new Error(LOCKED_TEMPLATE_ERROR);

  return {
    title: note.title,
    html:
      content && typeof content.data === "string"
        ? content.data
        : EMPTY_TEMPLATE_CONTENT
  };
}

export async function prepareTemplateForInsert(
  noteId: string,
  ctx: TemplateContext
): Promise<{ title: string; html: string }> {
  const { title, html } = await getTemplateContent(noteId);
  return {
    title,
    html: resetTaskChecks(applyTemplateVariables(html, ctx))
  };
}

export default {
  TEMPLATE_TAG,
  getTemplateTagId,
  getTemplates,
  getTemplateIds,
  getTemplateCount,
  isTemplate,
  createTemplate,
  saveNoteAsTemplate,
  addToTemplates,
  removeFromTemplates,
  getTemplateContent,
  prepareTemplateForInsert
};
