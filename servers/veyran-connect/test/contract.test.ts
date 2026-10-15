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

import { describe, expect, it } from "vitest";
import {
  CONNECT_OPERATION_NAMES,
  operationRequestSchemas,
  operationResponseSchemas,
  wireResponseSchemaFor
} from "../src/contract.js";
import {
  toolDefinitions,
  toolInputSchema,
  summaryText
} from "../src/tools.js";
import {
  toolErrorEnvelope,
  isToolErrorEnvelope,
  brokerErrorEnvelope,
  BROKER_ERROR_MESSAGES
} from "../src/errors.js";
import { toolErrorEnvelopeSchema } from "../src/errors.js";

describe("single-contract tool schemas", () => {
  it("exposes exactly the twelve Core operations, once each", () => {
    const names = toolDefinitions().map((tool) => tool.name);
    expect(names).toEqual([...CONNECT_OPERATION_NAMES]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("never exposes the internal `operation` field or a timezone parameter", () => {
    for (const definition of toolDefinitions()) {
      const shape = (toolInputSchema(definition.name) as unknown as {
        shape: Record<string, unknown>;
      }).shape;
      expect(Object.keys(shape)).not.toContain("operation");
      for (const key of Object.keys(shape))
        expect(key.toLowerCase()).not.toMatch(/timezone|tz|utc|offset/);
    }
  });

  it("rejects unknown/extra args and a foreign operation field", () => {
    const schema = toolInputSchema("get_note");
    expect(schema.safeParse({ noteId: "a" }).success).toBe(true);
    expect(schema.safeParse({ noteId: "a", operation: "get_note" }).success).toBe(
      false
    );
    expect(schema.safeParse({ noteId: "a", extra: 1 }).success).toBe(false);
  });

  it("keeps the visible args a strict subset of the Core request schema", () => {
    for (const operation of CONNECT_OPERATION_NAMES) {
      const core = operationRequestSchemas[operation];
      const visible = toolInputSchema(operation) as unknown as {
        shape: Record<string, unknown>;
      };
      const coreShape = core as unknown as { shape: Record<string, unknown> };
      for (const key of Object.keys(visible.shape)) {
        expect(Object.keys(coreShape.shape)).toContain(key);
      }
      expect(Object.keys(visible.shape).length).toBe(
        Object.keys(coreShape.shape).length - 1
      );
    }
  });
});

describe("response correlation", () => {
  it("rejects a result for a different operation", () => {
    const createNote = {
      operation: "create_note",
      operationId: "op-1",
      noteId: "note-1",
      revision: "r",
      url: "nn://note/note-1",
      persisted: "local_saved",
      sync: "unknown"
    };
    expect(
      wireResponseSchemaFor("get_note").safeParse({ ok: true, result: createNote })
        .success
    ).toBe(false);
    expect(
      wireResponseSchemaFor("create_note").safeParse({
        ok: true,
        result: createNote
      }).success
    ).toBe(true);
  });

  it("accepts only catalog messages in an error envelope", () => {
    const envelope = toolErrorEnvelope("NOT_AUTHORIZED");
    expect(isToolErrorEnvelope(envelope)).toBe(true);
    expect(
      toolErrorEnvelopeSchema.safeParse({
        status: "error",
        code: "NOT_AUTHORIZED",
        message: "raw provider text leaked here"
      }).success
    ).toBe(false);
    expect(
      toolErrorEnvelopeSchema.safeParse({
        status: "error",
        code: "NOT_A_REAL_CODE",
        message: "x"
      }).success
    ).toBe(false);
  });

  it("keeps the broker error catalog static", () => {
    const envelope = brokerErrorEnvelope("QUEUE_FULL");
    expect(envelope.message).toBe(BROKER_ERROR_MESSAGES.QUEUE_FULL);
  });
});

describe("annotations", () => {
  it("marks reads read-only and writes not read-only, all closed-world", () => {
    const reads = new Set(["status", "list_notebooks", "search_notes", "get_note", "list_task_lists", "list_tasks"]);
    for (const definition of toolDefinitions()) {
      expect(definition.annotations.openWorldHint).toBe(false);
      expect(definition.annotations.idempotentHint).toBe(true);
      expect(definition.annotations.readOnlyHint).toBe(reads.has(definition.name));
      expect(definition.annotations.destructiveHint).toBe(
        definition.name === "update_note" || definition.name === "update_task"
      );
    }
  });
});

describe("bounded summaries", () => {
  it("never interpolates ids, titles or urls", () => {
    const text = summaryText("get_note", {
      operation: "get_note",
      noteId: "secret-note-id",
      title: "secret title",
      url: "nn://note/secret-note-id",
      content: "secret body",
      format: "tiptap",
      revision: "rev",
      truncated: false,
      sync: "unknown"
    });
    expect(text).not.toContain("secret");
    expect(text).not.toContain("nn://");
  });

  it("reports write persistence exactly as the response does", () => {
    expect(
      summaryText("create_note", {
        operation: "create_note",
        persisted: "local_saved",
        sync: "unknown"
      })
    ).toContain("local_saved");
  });
});
