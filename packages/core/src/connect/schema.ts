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

import { z } from "zod";
// Pure limits module: importing the schema must never load the content
// pipeline (showdown/DOM/dompurify) or the database.
import { CONTENT_LIMITS } from "./limits.js";

const identifier = z.string().min(1).max(CONTENT_LIMITS.maxIdChars);
const operationId = z.string().min(1).max(CONTENT_LIMITS.maxIdChars);
const title = z.string().max(CONTENT_LIMITS.maxTitleChars);
const content = z.string().max(CONTENT_LIMITS.maxContentChars);
const revision = z.string().min(1).max(200);
const format = z.enum(["markdown", "plaintext", "tiptap"]);
const priority = z.enum(["none", "low", "medium", "high"]);
const calendarDate = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
const calendarTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const notePatch = {
  title: title.optional(),
  content: content.optional(),
  format: format.optional(),
  pinned: z.boolean().optional(),
  favorite: z.boolean().optional()
};

const taskPatch = {
  title: title.optional(),
  description: z.string().max(10_000).optional(),
  listId: identifier.optional(),
  dueDate: calendarDate.optional(),
  dueTime: calendarTime.optional(),
  reminderDate: calendarDate.optional(),
  reminderTime: calendarTime.optional(),
  reminderAt: z.number().int().finite().optional(),
  priority: priority.optional(),
  recurrenceRule: z.string().max(500).optional(),
  flagged: z.boolean().optional(),
  urgent: z.boolean().optional()
};

// ------------------------------------------------------------------ requests

export const statusRequest = z.strictObject({
  operation: z.literal("status")
});

export const listNotebooksRequest = z.strictObject({
  operation: z.literal("list_notebooks")
});

export const searchNotesRequest = z.strictObject({
  operation: z.literal("search_notes"),
  query: z.string().min(1).max(CONTENT_LIMITS.maxQueryChars),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CONTENT_LIMITS.maxSearchResults)
    .optional()
});

export const getNoteRequest = z.strictObject({
  operation: z.literal("get_note"),
  noteId: identifier
});

export const createNoteRequest = z.strictObject({
  operation: z.literal("create_note"),
  operationId,
  notebookId: identifier.optional(),
  title: title.optional(),
  content,
  format: format.optional()
});

export const appendToNoteRequest = z.strictObject({
  operation: z.literal("append_to_note"),
  operationId,
  noteId: identifier,
  content,
  format: format.optional(),
  expectedRevision: revision
});

export const updateNoteRequest = z.strictObject({
  operation: z.literal("update_note"),
  operationId,
  noteId: identifier,
  expectedRevision: revision,
  patch: z.strictObject(notePatch)
});

export const createTaskRequest = z.strictObject({
  operation: z.literal("create_task"),
  operationId,
  title,
  listId: identifier.optional(),
  description: taskPatch.description,
  dueDate: taskPatch.dueDate,
  dueTime: taskPatch.dueTime,
  reminderDate: taskPatch.reminderDate,
  reminderTime: taskPatch.reminderTime,
  reminderAt: taskPatch.reminderAt,
  priority: taskPatch.priority,
  recurrenceRule: taskPatch.recurrenceRule,
  flagged: taskPatch.flagged,
  urgent: taskPatch.urgent
});

export const listTaskListsRequest = z.strictObject({
  operation: z.literal("list_task_lists")
});

export const listTasksRequest = z.strictObject({
  operation: z.literal("list_tasks"),
  listId: identifier.optional(),
  includeCompleted: z.boolean().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CONTENT_LIMITS.maxResponseItems)
    .optional()
});

export const updateTaskRequest = z.strictObject({
  operation: z.literal("update_task"),
  operationId,
  taskId: identifier,
  expectedRevision: revision,
  patch: z.strictObject(taskPatch)
});

export const completeTaskRequest = z.strictObject({
  operation: z.literal("complete_task"),
  operationId,
  taskId: identifier,
  expectedRevision: revision
});

export const requestSchema = z.discriminatedUnion("operation", [
  statusRequest,
  listNotebooksRequest,
  searchNotesRequest,
  getNoteRequest,
  createNoteRequest,
  appendToNoteRequest,
  updateNoteRequest,
  createTaskRequest,
  listTaskListsRequest,
  listTasksRequest,
  updateTaskRequest,
  completeTaskRequest
]);

export type ConnectRequest = z.infer<typeof requestSchema>;

// ----------------------------------------------------------------- responses

const syncUnknown = z.literal("unknown");
const persistedLocal = z.literal("local_saved");
/**
 * Every bounded read reports whether it hit its bound (so a shorter list is
 * never mistaken for "there is nothing else").
 */
const truncated = z.boolean();
const total = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const summaryTitle = z.string().max(CONTENT_LIMITS.maxResponseTitleChars);
/** Route-safe note/task link; the id is preserved verbatim, never re-encoded. */
const noteUrl = z.string().regex(/^nn:\/\/note\/.+/);
const taskLink = z.string().regex(/^veyran:\/\/task\/.+/);

const noteSummary = z.strictObject({
  noteId: identifier,
  title: summaryTitle,
  url: noteUrl,
  revision: z.string()
});

/**
 * A task listing entry. `flagged`/`urgent` and the floating calendar schedule
 * (`reminderDate`/`reminderTime`/`reminderAt`/`scheduleVersion`) are the real
 * stored fields; there is no invented timezone argument.
 */
const taskSummary = z.strictObject({
  taskId: identifier,
  title: summaryTitle,
  link: taskLink,
  listId: identifier,
  completed: z.boolean(),
  dueDate: z.string().optional(),
  dueTime: z.string().optional(),
  reminderDate: z.string().optional(),
  reminderTime: z.string().optional(),
  reminderAt: z.number().int().finite().optional(),
  scheduleVersion: z.number().int().optional(),
  recurrenceRule: z.string().max(500).optional(),
  flagged: z.boolean(),
  urgent: z.boolean().optional(),
  priority,
  revision: z.string()
});

const noteWriteFields = {
  operationId: identifier,
  noteId: identifier,
  revision: z.string(),
  url: z.string(),
  persisted: persistedLocal,
  sync: syncUnknown
};

const taskWriteFields = {
  operationId: identifier,
  taskId: identifier,
  revision: z.string(),
  completed: z.boolean(),
  link: z.string(),
  persisted: persistedLocal,
  sync: syncUnknown
};

export const statusResponse = z.strictObject({
  operation: z.literal("status"),
  version: z.literal(1),
  account: z.literal("signed_in"),
  status: z.enum(["ready", "locked"]),
  /** False whenever the adapter is locked (truthful, content-free blocked state). */
  available: z.boolean(),
  grantsGeneration: z.number().int().min(0),
  /** Granted capabilities (from the immutable grants snapshot). */
  capabilities: z.strictObject({
    read: z.boolean(),
    create: z.boolean(),
    change: z.boolean(),
    task: z.boolean()
  }),
  /** Non-sensitive journal pressure. */
  journal: z.strictObject({
    capacity: z.number().int().min(0),
    count: z.number().int().min(0)
  }),
  sync: syncUnknown
});

export const listNotebooksResponse = z.strictObject({
  operation: z.literal("list_notebooks"),
  notebooks: z
    .array(z.strictObject({ id: identifier, title: summaryTitle }))
    .max(CONTENT_LIMITS.maxResponseItems),
  truncated,
  sync: syncUnknown
});

export const searchNotesResponse = z.strictObject({
  operation: z.literal("search_notes"),
  results: z.array(noteSummary).max(CONTENT_LIMITS.maxResponseItems),
  truncated,
  sync: syncUnknown
});

export const getNoteResponse = z.strictObject({
  operation: z.literal("get_note"),
  noteId: identifier,
  title: summaryTitle,
  url: noteUrl,
  content: z.string().max(CONTENT_LIMITS.maxResponseContentChars),
  format: z.literal("tiptap"),
  revision: z.string(),
  truncated,
  sync: syncUnknown
});

export const createNoteResponse = z.strictObject({
  operation: z.literal("create_note"),
  ...noteWriteFields
});

export const appendToNoteResponse = z.strictObject({
  operation: z.literal("append_to_note"),
  ...noteWriteFields
});

export const updateNoteResponse = z.strictObject({
  operation: z.literal("update_note"),
  ...noteWriteFields
});

export const listTaskListsResponse = z.strictObject({
  operation: z.literal("list_task_lists"),
  lists: z
    .array(z.strictObject({ id: identifier, name: summaryTitle }))
    .max(CONTENT_LIMITS.maxResponseItems),
  truncated,
  sync: syncUnknown
});

export const listTasksResponse = z.strictObject({
  operation: z.literal("list_tasks"),
  tasks: z.array(taskSummary).max(CONTENT_LIMITS.maxResponseItems),
  total,
  truncated,
  sync: syncUnknown
});

export const createTaskResponse = z.strictObject({
  operation: z.literal("create_task"),
  ...taskWriteFields
});

export const updateTaskResponse = z.strictObject({
  operation: z.literal("update_task"),
  ...taskWriteFields
});

export const completeTaskResponse = z.strictObject({
  operation: z.literal("complete_task"),
  ...taskWriteFields
});

export const responseSchema = z.union([
  statusResponse,
  listNotebooksResponse,
  searchNotesResponse,
  getNoteResponse,
  createNoteResponse,
  appendToNoteResponse,
  updateNoteResponse,
  listTaskListsResponse,
  listTasksResponse,
  createTaskResponse,
  updateTaskResponse,
  completeTaskResponse
]);

export type ConnectResponse = z.infer<typeof responseSchema>;
