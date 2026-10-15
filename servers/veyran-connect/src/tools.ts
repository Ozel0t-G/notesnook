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
 * The twelve Core MCP tools — one per accepted Core operation.
 *
 * The stdio server registers one additional, *non-Core* tool, `capture_note`
 * (the official Notesnook Inbox API), from `inbox-tool.ts`: it talks directly
 * to the fixed public endpoint with the operator's separately stored Inbox key
 * and never touches the broker, the app or the Core contract.
 *
 * The visible input schema of each tool is *derived mechanically* from the
 * single Core contract: `operationRequestSchemas[op].omit({ operation: true })`.
 * The literal `operation` field is **never** visible to the model; it is added
 * internally before validation, so the model cannot desynchronise the tool from
 * the operation it targets, and the tool cannot drift from Core.
 *
 * Everything a handler returns is validated twice: the correlated wire envelope
 * (`wireResponseSchemaFor(op)` → `result.operation` must match) and the
 * operation response schema. A tool error is the static, bounded envelope;
 * because the SDK skips `outputSchema` validation for `isError: true`, the
 * envelope is validated here separately (`isToolErrorEnvelope`), so a raw error
 * string can never leave the process. No result is ever reported as "saved" or
 * "synced" unless the Core response itself says `local_saved` / `unknown`.
 *
 * A write whose fate is unknown — the await transport failed, or the broker
 * reported an already-claimed request — is reported as `IDEMPOTENCY_UNCERTAIN`
 * (retry with the same operationId), never as an unavailable transport and
 * never as saved. Reads, which cannot persist anything, stay distinguishable.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  CONNECT_OPERATION_NAMES,
  operationRequestSchemas,
  operationResponseSchemas,
  requestSchemaFor,
  responseSchemaFor,
  wireResponseSchemaFor,
  type ConnectOperation
} from "./contract.js";
import {
  isToolErrorEnvelope,
  toolErrorEnvelope,
  TOOL_ERROR_MESSAGES,
  type ToolErrorCode
} from "./errors.js";
import type { BrokerErrorCode } from "./errors.js";
import { attachBroker, type AttachResult } from "./attach.js";
import { isPreTransmitAbort, type BrokerClient } from "./client.js";
import {
  registerCaptureNote,
  type CaptureNoteOptions
} from "./inbox-tool.js";

/**
 * The exact result type the SDK's `registerTool` callback must return
 * (`CallToolResult | InputRequiredResult` in the pinned server SDK).
 *
 * Deriving it from the real registrar — rather than hand-declaring a look-alike
 * interface — keeps every handler provably assignable to the official
 * `registerTool` callback type and preserves the compiler checks (no `unknown`
 * cast is placed around the registrar). A hand interface is *not* structurally
 * assignable to the SDK's result type: interfaces do not receive the implicit
 * index signature the SDK's result carries, so a sound, alias-derived type is
 * used instead.
 */
type RegisterToolCallback = NonNullable<
  Parameters<McpServer["registerTool"]>[2]
>;
export type ToolCallResult = Awaited<ReturnType<RegisterToolCallback>>;

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: ConnectOperation;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  annotations: ToolAnnotations;
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const ADDITIVE_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const REPLACE: ToolAnnotations = {
  readOnlyHint: false,
  // Replaces/overwrites fields on an existing record: truthfully destructive.
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
};

/** Operations that can persist a change on the device. */
const WRITE_OPERATIONS: ReadonlySet<ConnectOperation> = new Set([
  "create_note",
  "append_to_note",
  "update_note",
  "create_task",
  "update_task",
  "complete_task"
]);

const DESCRIPTIONS: Record<ConnectOperation, { title: string; description: string }> = {
  status: {
    title: "VeyraN status",
    description:
      "Report the local VeyraN Connect state: signed-in account, ready/locked, actually granted capabilities and journal pressure. Use before other calls to learn what is permitted. Reports sync as unknown; it never claims server sync."
  },
  list_notebooks: {
    title: "List notebooks",
    description:
      "List notebooks the active grants expose (id + title, bounded, truncated flag). Use to resolve a notebook id before create_note."
  },
  search_notes: {
    title: "Search notes",
    description:
      "Search granted notes by text and return bounded note summaries (id, title, nn:// link, revision). Use get_note to read a body; use the returned revision for later mutations."
  },
  get_note: {
    title: "Get note",
    description:
      "Read one granted note as a TipTap document with its id, nn:// link, revision and truncation flag. Read the revision first; a write requires that exact expectedRevision."
  },
  create_note: {
    title: "Create note",
    description:
      "Create one note in the local database and return its id, revision, nn:// link and persisted=local_saved (sync always unknown). A create request already authorises creation; pass a stable operationId you keep for an identical retry. A create needs no expectedRevision."
  },
  append_to_note: {
    title: "Append to note",
    description:
      "Append content to one granted note, requiring the current expectedRevision. Adds content without replacing existing text; persisted=local_saved, sync unknown."
  },
  update_note: {
    title: "Update note",
    description:
      "Replace fields (title/content/format/pinned/favorite) on one granted note at its expectedRevision. This overwrites existing values, so it is marked destructive; persisted=local_saved, sync unknown."
  },
  create_task: {
    title: "Create task",
    description:
      "Create one task (title plus optional floating due/reminder dates, priority, recurrence, flagged/urgent) and return its id, link and persisted state. Dates are floating device-local calendar values; there is no timezone parameter. A create needs no expectedRevision."
  },
  list_task_lists: {
    title: "List task lists",
    description:
      "List task lists the grants expose (id + name, bounded, truncated flag). Use to resolve a listId before create_task or list_tasks."
  },
  list_tasks: {
    title: "List tasks",
    description:
      "List tasks for a granted list (or all granted lists), including flagged/urgent, priority, recurrence and the stored floating schedule fields. Reports total and truncated; sync unknown."
  },
  update_task: {
    title: "Update task",
    description:
      "Replace task fields at the current expectedRevision; overwrites existing values, so it is marked destructive. persisted=local_saved, sync unknown."
  },
  complete_task: {
    title: "Complete task",
    description:
      "Mark one granted task completed at its expectedRevision, returning the new revision, completed flag and link. A recurring task's follow-up occurrence is created by the app's maintenance path."
  }
};

/**
 * Visible tool args: the Core request schema minus the internal `operation`.
 *
 * The per-operation schemas are kept in an `as const` record, so indexing
 * yields a union of concrete `ZodObject`s; the cast makes the (identical)
 * `omit` signature unambiguous to the type checker.
 */
export function toolInputSchema(operation: ConnectOperation): z.ZodObject {
  const schema = operationRequestSchemas[operation] as unknown as z.ZodObject;
  return schema.omit({ operation: true });
}

function toolOutputSchema(operation: ConnectOperation): z.ZodObject {
  return operationResponseSchemas[operation] as unknown as z.ZodObject;
}

export function toolDefinitions(): ToolDefinition[] {
  return CONNECT_OPERATION_NAMES.map((operation) => {
    const annotations =
      operation === "update_note" || operation === "update_task"
        ? REPLACE
        : WRITE_OPERATIONS.has(operation)
          ? ADDITIVE_WRITE
          : READ_ONLY;
    return {
      name: operation,
      title: DESCRIPTIONS[operation].title,
      description: DESCRIPTIONS[operation].description,
      inputSchema: toolInputSchema(operation),
      outputSchema: toolOutputSchema(operation),
      annotations
    };
  });
}

function isToolErrorCode(code: string): code is ToolErrorCode {
  return Object.prototype.hasOwnProperty.call(TOOL_ERROR_MESSAGES, code);
}

/** Map a broker-local code onto the bounded tool error surface. */
function mapBrokerCode(code: BrokerErrorCode): ToolErrorCode {
  switch (code) {
    case "BROKER_UNAVAILABLE":
      return "BROKER_UNAVAILABLE";
    case "APP_UNAVAILABLE":
      return "APP_UNAVAILABLE";
    case "UNCERTAIN":
      return "IDEMPOTENCY_UNCERTAIN";
    default:
      return "TRANSPORT_UNAVAILABLE";
  }
}

/**
 * Static, bounded, content-free summary text. Only numbers, booleans and closed
 * enum literals are interpolated; never a title, body, id or url.
 */
export function summaryText(
  operation: ConnectOperation,
  result: Record<string, unknown>
): string {
  const truncated = result.truncated === true;
  const sync = "sync unknown";
  switch (operation) {
    case "status": {
      const status = result.status === "ready" ? "ready" : "locked";
      return `VeyraN status: ${status}; ${sync}.`;
    }
    case "list_notebooks": {
      const count = Array.isArray(result.notebooks) ? result.notebooks.length : 0;
      return `Returned ${count} notebook(s); truncated=${truncated}; ${sync}.`;
    }
    case "list_task_lists": {
      const count = Array.isArray(result.lists) ? result.lists.length : 0;
      return `Returned ${count} task list(s); truncated=${truncated}; ${sync}.`;
    }
    case "search_notes": {
      const count = Array.isArray(result.results) ? result.results.length : 0;
      return `Returned ${count} result(s); truncated=${truncated}; ${sync}.`;
    }
    case "get_note":
      return `Read one note; truncated=${truncated}; ${sync}.`;
    case "list_tasks": {
      const count = Array.isArray(result.tasks) ? result.tasks.length : 0;
      const total = typeof result.total === "number" ? result.total : 0;
      return `Returned ${count} of ${total} task(s); truncated=${truncated}; ${sync}.`;
    }
    default:
      return `Record persisted=${
        result.persisted === "local_saved" ? "local_saved" : "unknown"
      }; ${sync}.`;
  }
}

function okResult(
  operation: ConnectOperation,
  result: Record<string, unknown>
): ToolCallResult {
  return {
    content: [{ type: "text", text: summaryText(operation, result) }],
    structuredContent: result
  };
}

/**
 * The static, self-validated error envelope (exported for the non-Core
 * `capture_note` tool, which builds the same bounded error surface).
 */
export function errorResult(code: ToolErrorCode): ToolCallResult {
  const envelope = toolErrorEnvelope(code);
  // Self-validate: `isError: true` results are not validated by the SDK.
  if (!isToolErrorEnvelope(envelope)) return errorResultInternal();
  return {
    content: [{ type: "text", text: envelope.message }],
    structuredContent: envelope,
    isError: true
  };
}

function errorResultInternal(): ToolCallResult {
  // A last-resort, statically valid envelope (the catalogue is trusted input,
  // so this is unreachable in practice).
  return {
    content: [{ type: "text", text: TOOL_ERROR_MESSAGES.TRANSPORT_UNAVAILABLE }],
    structuredContent: {
      status: "error",
      code: "TRANSPORT_UNAVAILABLE",
      message: TOOL_ERROR_MESSAGES.TRANSPORT_UNAVAILABLE
    },
    isError: true
  };
}

/** Outcome of a write whose fate is unknown: never claimed-removed, never saved. */
function uncertainOrUnavailable(operation: ConnectOperation): ToolErrorCode {
  return WRITE_OPERATIONS.has(operation)
    ? "IDEMPOTENCY_UNCERTAIN"
    : "TRANSPORT_UNAVAILABLE";
}

async function cancelAndReport(
  client: Pick<BrokerClient, "cancel">,
  ticketId: string,
  operation: ConnectOperation
): Promise<ToolCallResult> {
  try {
    const cancelled = await client.cancel(ticketId);
    if (cancelled.ok) {
      const result = cancelled.result as
        | { removed?: boolean; uncertain?: boolean }
        | undefined;
      if (result?.uncertain) return errorResult("IDEMPOTENCY_UNCERTAIN");
      if (result?.removed) return errorResult("CANCELLED");
    }
  } catch {
    // Fall through to the honest uncertain outcome.
  }
  return errorResult(uncertainOrUnavailable(operation));
}

export interface ToolExtra {
  mcpReq?: { signal?: AbortSignal };
}

export type ToolHandler = (
  args: Record<string, unknown>,
  extra: ToolExtra
) => Promise<ToolCallResult>;

export interface ToolConfig {
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  annotations: ToolAnnotations;
}

/**
 * The exact `registerTool` surface of the SDK's `McpServer`. Deriving the type
 * from the SDK (rather than hand-declaring a structural interface) means the
 * compiler checks each `{ title, description, inputSchema, outputSchema,
 * annotations }` config and each handler against the *official* SDK types; a
 * shape the SDK would reject fails the build instead of silently registering a
 * broken tool. `mcp.ts` passes the real `McpServer` (assignable by
 * construction) with no cast.
 */
export type ToolRegistrar = Pick<McpServer, "registerTool">;

export interface ToolsOptions {
  profileDir?: string;
  attach?: () => Promise<AttachResult>;
  /** Test seam for the one non-Core tool (`capture_note`). */
  inboxSender?: CaptureNoteOptions["sender"];
}

/**
 * Collapse concurrent and repeated attach attempts into a single caller
 * instance. The stdio server is *one* MCP caller: it performs exactly one
 * `hello` handshake and reuses that instance (and its nonce sequence) for every
 * tool call, instead of handshaking per call. A failed attach is not cached, so
 * a later call retries once the broker is reachable. An instance the broker no
 * longer knows (restart/eviction) is recovered by `BrokerClient` itself.
 */
export function memoizeAttach(
  attach: () => Promise<AttachResult>
): () => Promise<AttachResult> {
  let cached: Promise<AttachResult> | undefined;
  return () => {
    if (cached) return cached;
    cached = attach().then(
      (value) => {
        if (!value.ok) cached = undefined;
        return value;
      },
      (error: unknown) => {
        cached = undefined;
        throw error;
      }
    );
    return cached;
  };
}

export function createToolHandler(
  operation: ConnectOperation,
  attach: () => Promise<AttachResult>
): ToolHandler {
  return async (args, extra): Promise<ToolCallResult> => {
    const signal = extra?.mcpReq?.signal;
    if (signal?.aborted) return errorResult("CANCELLED");

    const candidate =
      args && typeof args === "object"
        ? { ...args, operation }
        : { operation };
    const parsed = requestSchemaFor(operation).safeParse(candidate);
    if (!parsed.success) return errorResult("INVALID_ARGUMENTS");

    const attachOutcome = await attach().then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const })
    );
    if (!attachOutcome.ok) return errorResult("BROKER_UNAVAILABLE");
    const attached: AttachResult = attachOutcome.value;
    if (!attached.ok) return errorResult(attached.code);
    const client = attached.client;

    // The attach await is a suspension point: re-check the signal before any
    // work is enqueued so an already-cancelled call never submits. The client
    // itself re-checks the signal after its `hello` handshake await and
    // immediately before the request bytes are written.
    if (signal?.aborted) return errorResult("CANCELLED");

    const submitted = await client.submit(parsed.data, signal).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    if (!submitted.ok) {
      // A rejection that provably happened *before* the request was written
      // (abort during the handshake) means nothing was enqueued: honest
      // cancellation, not an uncertain write.
      if (isPreTransmitAbort(submitted.error)) return errorResult("CANCELLED");
      return errorResult(uncertainOrUnavailable(operation));
    }
    if (!submitted.value.ok)
      return errorResult(mapBrokerCode(submitted.value.error.code));
    const ticketId = (submitted.value.result as { ticketId?: unknown } | undefined)
      ?.ticketId;
    if (typeof ticketId !== "string")
      return errorResult(uncertainOrUnavailable(operation));

    const awaitOutcome = await client.awaitResponse(ticketId, signal).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const })
    );
    if (!awaitOutcome.ok) {
      if (signal?.aborted) return cancelAndReport(client, ticketId, operation);
      return errorResult(uncertainOrUnavailable(operation));
    }
    const awaited = awaitOutcome.value;
    if (!awaited.ok) {
      switch (awaited.error.code) {
        case "APP_UNAVAILABLE":
          return errorResult("APP_UNAVAILABLE");
        case "BROKER_UNAVAILABLE":
          return errorResult("BROKER_UNAVAILABLE");
        case "UNCERTAIN":
          return errorResult("IDEMPOTENCY_UNCERTAIN");
        default:
          return errorResult("TRANSPORT_UNAVAILABLE");
      }
    }

    // Operation-correlated check *before* any output is produced.
    const inner = (awaited.result as { response?: unknown } | undefined)?.response;
    const wire = wireResponseSchemaFor(operation).safeParse(inner);
    if (!wire.success) return errorResult("UNCORRELATED_RESULT");
    if (!wire.data.ok) {
      const code = wire.data.error.code;
      return errorResult(isToolErrorCode(code) ? code : "UNCORRELATED_RESULT");
    }
    const checked = responseSchemaFor(operation).safeParse(wire.data.result);
    if (!checked.success) return errorResult("UNCORRELATED_RESULT");
    return okResult(operation, checked.data as unknown as Record<string, unknown>);
  };
}

export function registerVeyranTools(
  registrar: ToolRegistrar,
  options: ToolsOptions = {}
): void {
  const attach = memoizeAttach(
    options.attach ?? (() => attachBroker(options.profileDir))
  );
  for (const definition of toolDefinitions()) {
    registrar.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        annotations: definition.annotations
      },
      createToolHandler(definition.name, attach)
    );
  }
  // One non-Core tool: the official Notesnook Inbox capture path (fixed
  // endpoint, operator-stored key, local receipts). It deliberately bypasses
  // the broker/app, so it is registered separately from the derived tools and
  // never appears in `toolDefinitions()`/the Core contract.
  registerCaptureNote(registrar, {
    profileDir: options.profileDir,
    sender: options.inboxSender
  });
}
