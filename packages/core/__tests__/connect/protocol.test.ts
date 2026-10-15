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

import { describe, it, expect } from "vitest";
import {
  CONNECT_ERROR_CODES,
  CONNECT_ERROR_MESSAGES
} from "../../src/connect/errors.js";
import type { ConnectErrorCode } from "../../src/connect/errors.js";
import {
  CONNECT_OPERATION_NAMES,
  connectWireResponseSchema,
  errorEnvelope,
  errorEnvelopeSchema,
  operationRequestSchemas,
  operationResponseSchemas,
  requestSchemaFor,
  responseSchemaFor,
  TRANSPORT_ERROR_CODES,
  TRANSPORT_ERROR_MESSAGES,
  transportErrorEnvelope,
  transportErrorEnvelopeSchema,
  transportWireResponseSchema,
  wireResponseSchemaFor
} from "../../src/connect/protocol.js";

const getNoteResult = {
  operation: "get_note",
  noteId: "n1",
  title: "T",
  url: "nn://note/n1",
  content: "<p>x</p>",
  format: "tiptap",
  revision: "r1",
  truncated: false,
  sync: "unknown"
};

const searchNotesResult = {
  operation: "search_notes",
  results: [
    { noteId: "n1", title: "T", url: "nn://note/n1", revision: "r1" }
  ],
  truncated: false,
  sync: "unknown"
};

const taskSummary = {
  taskId: "t1",
  title: "T",
  link: "veyran://task/t1",
  listId: "l1",
  completed: false,
  flagged: false,
  priority: "none",
  revision: "r1"
};

describe("VeyraN Connect protocol (pure wire contract)", () => {
  it("exposes exactly one canonical operation list and per-operation schemas", () => {
    expect([...CONNECT_OPERATION_NAMES]).toHaveLength(12);
    expect(Object.keys(operationRequestSchemas).sort()).toEqual(
      [...CONNECT_OPERATION_NAMES].sort()
    );
    expect(Object.keys(operationResponseSchemas).sort()).toEqual(
      [...CONNECT_OPERATION_NAMES].sort()
    );
    for (const operation of CONNECT_OPERATION_NAMES) {
      expect(requestSchemaFor(operation)).toBeTruthy();
      expect(responseSchemaFor(operation)).toBeTruthy();
    }
  });

  it("keeps per-operation request schemas strict", () => {
    const schema = operationRequestSchemas.get_note;
    expect(
      schema.safeParse({ operation: "get_note", noteId: "n1" }).success
    ).toBe(true);
    // Unknown keys are rejected (strict).
    expect(
      schema.safeParse({ operation: "get_note", noteId: "n1", extra: 1 })
        .success
    ).toBe(false);
  });

  it("rejects a response whose operation does not match the schema", () => {
    expect(
      responseSchemaFor("get_note").safeParse(getNoteResult).success
    ).toBe(true);
    // A search result must not validate as a get_note response.
    expect(
      responseSchemaFor("get_note").safeParse(searchNotesResult).success
    ).toBe(false);
  });

  it("accepts a correlated success and rejects an uncorrelated one", () => {
    const schema = wireResponseSchemaFor("get_note");
    expect(schema.safeParse({ ok: true, result: getNoteResult }).success).toBe(
      true
    );
    // Correlated rejection: valid search result, wrong operation.
    expect(
      schema.safeParse({ ok: true, result: searchNotesResult }).success
    ).toBe(false);
    // Extra top-level keys are rejected (strict envelope).
    expect(
      schema.safeParse({ ok: true, result: getNoteResult, extra: true }).success
    ).toBe(false);
  });

  it("accepts a correlated error envelope and rejects foreign messages", () => {
    const schema = wireResponseSchemaFor("get_note");
    const envelope = errorEnvelope("NOTE_NOT_FOUND");
    expect(schema.safeParse({ ok: false, error: envelope }).success).toBe(true);
    expect(envelope.message).toBe(CONNECT_ERROR_MESSAGES.NOTE_NOT_FOUND);
    // A raw/foreign transport string must not pass.
    expect(
      schema.safeParse({
        ok: false,
        error: { code: "NOTE_NOT_FOUND", message: "ENOENT: raw transport text" }
      }).success
    ).toBe(false);
    // An unknown code must not pass.
    expect(
      schema.safeParse({ ok: false, error: { code: "NOPE", message: "x" } })
        .success
    ).toBe(false);
  });

  it("keeps the static error catalog total and self-consistent", () => {
    expect(CONNECT_ERROR_CODES.length).toBeGreaterThan(0);
    for (const code of CONNECT_ERROR_CODES) {
      expect(typeof CONNECT_ERROR_MESSAGES[code]).toBe("string");
      expect(CONNECT_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
      expect(errorEnvelope(code)).toEqual({
        code,
        message: CONNECT_ERROR_MESSAGES[code]
      });
    }
    // Every catalog code validates for its own static message...
    for (const code of CONNECT_ERROR_CODES)
      expect(errorEnvelopeSchema.safeParse(errorEnvelope(code)).success).toBe(
        true
      );
    // ...and a mismatched message is rejected.
    const known = CONNECT_ERROR_CODES.find(
      (code) => code !== "DENIED"
    ) as ConnectErrorCode;
    expect(
      errorEnvelopeSchema.safeParse({
        code: known,
        message: CONNECT_ERROR_MESSAGES.DENIED
      }).success
    ).toBe(false);
  });

  it("validates the generic wire contract for any supported operation", () => {
    expect(
      connectWireResponseSchema.safeParse({ ok: true, result: getNoteResult })
        .success
    ).toBe(true);
    expect(
      connectWireResponseSchema.safeParse({
        ok: false,
        error: errorEnvelope("INVALID_INPUT")
      }).success
    ).toBe(true);
  });

  it("distinguishes app/broker unavailability via static transport codes", () => {
    expect([...TRANSPORT_ERROR_CODES].sort()).toEqual([
      "APP_UNAVAILABLE",
      "BROKER_UNAVAILABLE",
      "TRANSPORT_UNAVAILABLE"
    ]);
    for (const code of TRANSPORT_ERROR_CODES) {
      expect(transportErrorEnvelope(code)).toEqual({
        code,
        message: TRANSPORT_ERROR_MESSAGES[code]
      });
      expect(
        transportErrorEnvelopeSchema.safeParse(transportErrorEnvelope(code))
          .success
      ).toBe(true);
    }
    // An in-band Connect error and a static transport error both validate...
    expect(
      transportWireResponseSchema.safeParse({
        ok: false,
        error: errorEnvelope("NOT_AUTHORIZED")
      }).success
    ).toBe(true);
    expect(
      transportWireResponseSchema.safeParse({
        ok: false,
        error: transportErrorEnvelope("APP_UNAVAILABLE")
      }).success
    ).toBe(true);
    expect(
      transportWireResponseSchema.safeParse({
        ok: false,
        error: transportErrorEnvelope("BROKER_UNAVAILABLE")
      }).success
    ).toBe(true);
    // ...but a foreign transport error is rejected.
    expect(
      transportWireResponseSchema.safeParse({
        ok: false,
        error: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" }
      }).success
    ).toBe(false);
  });

  it("exposes the full task summary contract including real schedule fields", () => {
    const result = {
      operation: "list_tasks",
      tasks: [
        taskSummary,
        {
          ...taskSummary,
          reminderDate: "2026-01-02",
          reminderTime: "09:30",
          reminderAt: 1_700_000_000_000,
          scheduleVersion: 2,
          recurrenceRule: "FREQ=DAILY",
          flagged: true,
          urgent: true
        }
      ],
      total: 2,
      truncated: false,
      sync: "unknown"
    };
    expect(responseSchemaFor("list_tasks").safeParse(result).success).toBe(true);
    // A task link must be the veyran:// route.
    expect(
      responseSchemaFor("list_tasks").safeParse({
        ...result,
        tasks: [{ ...taskSummary, link: "https://example.com" }],
        total: 1
      }).success
    ).toBe(false);
  });
});
