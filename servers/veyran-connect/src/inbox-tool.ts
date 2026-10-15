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
 * `capture_note` — the one MCP tool that is **not** a Core operation.
 *
 * It is deliberately different from `create_note`:
 *
 *  - `create_note` writes into the local VeyraN database through the broker and
 *    the app, and honestly reports `persisted: "local_saved"` plus a note id.
 *  - `capture_note` posts bounded text to the user's own Notesnook **Inbox**
 *    endpoint, which encrypts it with the account's Inbox PGP key and queues it
 *    for the next device sync. The documented response carries **no** note id,
 *    so this tool can only ever report that the relay *accepted and queued* the
 *    item — never that a note exists, was created locally, was imported on a
 *    device, or is synced, and never a link.
 *
 * Repeat safety is local and honest. The documented API has no idempotency
 * header and returns no item id, so the tool keeps a bounded local receipt per
 * stable `operationId` (with the canonical payload hash):
 *
 *  1. before anything is sent, a provisional `uncertain` receipt is written —
 *     so a crash between "sent" and "answered" can never produce a silent
 *     resend on retry;
 *  2. a documented `200 {"success":true}` promotes it to `accepted`;
 *  3. a documented refusal (400/401/403/429) removes it — the relay did not
 *     queue the item, so a corrected retry is legitimate;
 *  4. anything else (timeout, dropped socket after the body was written, 5xx,
 *     unparseable 200, truncated body) leaves it `uncertain`: the answer says
 *     the outcome is unknown and must not be resent, because there is no
 *     supported inbox status query to consult;
 *  5. an exact repeat of an `accepted` operation returns the same receipt with
 *     **no second HTTP request**; a reused `operationId` with different content
 *     is a conflict and is refused without a request.
 */
import { z } from "zod";
import { INBOX_LIMITS } from "./limits.js";
import {
  OPERATION_ID_PATTERN,
  buildCaptureRequest,
  captureNoteInputSchema
} from "./inbox-format.js";
import {
  InboxProfileError,
  InboxReceiptStore,
  KeyedLock,
  inboxRecipientBinding,
  loadInboxApiKey,
  toInboxProfileError,
  withInboxReceiptFileLock,
  type InboxReceiptState
} from "./inbox-profile.js";
import {
  httpsInboxSender,
  type InboxOutcome,
  type InboxSender
} from "./inbox-transport.js";
import { operatorPaths } from "./paths.js";
import type { ToolErrorCode } from "./errors.js";
import { reportDiagnostic } from "./logging.js";
import {
  errorResult,
  type ToolAnnotations,
  type ToolCallResult,
  type ToolHandler,
  type ToolRegistrar
} from "./tools.js";

export const CAPTURE_NOTE_TOOL_NAME = "capture_note";

/**
 * Truthful annotations: it writes into the user's own account (not read-only),
 * it only ever adds (not destructive), an exact repeat reuses the local receipt
 * instead of a second request (idempotent), and it talks to an external service
 * (open world).
 */
export const CAPTURE_NOTE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

export const captureNoteTitle = "Capture note to Notesnook Inbox";

export const captureNoteDescription =
  "Send one bounded text capture (title + plain text or Markdown) to the user's own Notesnook Inbox endpoint through their configured Inbox API key. Use only when the user explicitly asks to capture/send/forward something to Notesnook. This is not create_note: the documented Inbox response is only {\"success\":true} (encrypted and queued by the relay) — it returns no note id, no link and no device import, so report inbox_accepted/queued only and never claim a note was created, imported, or synced. Reuse the same operationId only for the identical title/content/format; an exact repeat returns the stored receipt without a second request, and a changed payload under the same id is refused as a conflict. On INBOX_UNCERTAIN the outcome is unknown — do not resend automatically.";

export const captureNoteInput: z.ZodObject = captureNoteInputSchema;

/**
 * Strict, bounded output. Every "did this become a note?" field is a literal
 * `false`/`null`: the Inbox API cannot report one, so the tool cannot claim
 * one. `replayedFromReceipt` distinguishes a fresh acceptance from a repeat
 * that reused the local receipt and sent nothing.
 */
export const captureNoteOutputSchema = z.strictObject({
  operationId: z
    .string()
    .min(1)
    .max(INBOX_LIMITS.maxOperationIdChars)
    .regex(OPERATION_ID_PATTERN),
  status: z.literal("inbox_accepted"),
  serverQueued: z.literal(true),
  importedToDevice: z.literal(false),
  noteId: z.null(),
  sync: z.literal("unknown"),
  replayedFromReceipt: z.boolean()
});

export type CaptureNoteOutput = z.infer<typeof captureNoteOutputSchema>;

const ACCEPTED_SUMMARY =
  "Inbox accepted the capture: the relay reported it encrypted and queued. No note id was returned; nothing is confirmed created on this device, imported, or synced.";
const REPLAYED_SUMMARY =
  "Inbox accepted this capture earlier; the stored local receipt was returned without sending a second request. No note id exists; nothing is confirmed created on this device, imported, or synced.";

function acceptedResult(
  operationId: string,
  replayedFromReceipt: boolean
): ToolCallResult {
  const structured: CaptureNoteOutput = captureNoteOutputSchema.parse({
    operationId,
    status: "inbox_accepted",
    serverQueued: true,
    importedToDevice: false,
    noteId: null,
    sync: "unknown",
    replayedFromReceipt
  });
  return {
    content: [
      {
        type: "text",
        text: replayedFromReceipt ? REPLAYED_SUMMARY : ACCEPTED_SUMMARY
      }
    ],
    structuredContent: structured
  };
}

function inboxErrorResult(code: ToolErrorCode): ToolCallResult {
  return errorResult(code);
}

function profileErrorCode(error: unknown): ToolErrorCode {
  if (error instanceof InboxProfileError) return error.code;
  return toInboxProfileError(error).code;
}

export interface CaptureNoteOptions {
  profileDir?: string;
  /** Test seam: the real sender is the fixed-endpoint HTTPS POST. */
  sender?: InboxSender;
  /** Test seam: replaces `Date.now()` for receipt timestamps. */
  now?: () => number;
}

/**
 * Build the handler. It never calls the broker and never touches the app: the
 * capture path is independent of whether the VeyraN app is running, and it
 * fails closed with `INBOX_NOT_CONFIGURED` when the operator has not stored an
 * Inbox API key.
 */
export function createCaptureNoteHandler(
  options: CaptureNoteOptions = {}
): ToolHandler {
  const paths = operatorPaths(options.profileDir);
  const sender = options.sender ?? httpsInboxSender;
  const now = options.now ?? (() => Date.now());
  const locks = new KeyedLock();

  return async (args, extra): Promise<ToolCallResult> => {
    const signal = extra?.mcpReq?.signal;
    if (signal?.aborted) return inboxErrorResult("CANCELLED");

    const parsed = captureNoteInputSchema.safeParse(args);
    if (!parsed.success) return inboxErrorResult("INVALID_ARGUMENTS");
    const input = parsed.data;

    const request = buildCaptureRequest(input);
    if (!request.ok) return inboxErrorResult(request.code);

    let apiKey: string;
    try {
      apiKey = await loadInboxApiKey(paths.inboxKey);
    } catch (error) {
      return inboxErrorResult(profileErrorCode(error));
    }
    const recipientBinding = inboxRecipientBinding(apiKey);

    return locks.run(input.operationId, async (): Promise<ToolCallResult> => {
      try {
        return await withInboxReceiptFileLock(paths.inboxLock, async () => {
          const receipts = new InboxReceiptStore(paths.inboxReceipts);

      let existing;
      try {
        existing = await receipts.get(input.operationId);
      } catch (error) {
        return inboxErrorResult(profileErrorCode(error));
      }

      if (existing) {
        // A local acceptance receipt belongs to the exact configured recipient
        // credential. Never reuse another account's accepted state after a
        // key rotation or account switch.
        if (existing.recipientBinding !== recipientBinding)
          return inboxErrorResult("IDEMPOTENCY_CONFLICT");
        // A different payload under the same stable id is a different
        // operation: refuse it instead of silently sending a second capture.
        if (existing.payloadHash !== request.payloadHash)
          return inboxErrorResult("IDEMPOTENCY_CONFLICT");
        return existing.state === "accepted"
          ? acceptedResult(input.operationId, true)
          : inboxErrorResult("INBOX_UNCERTAIN");
      }

      // Cancellation is only honest *before* the provisional receipt exists:
      // after this point the request is on its way and must complete (bounded by
      // the transport timeout) so a real outcome is recorded rather than lost.
      if (signal?.aborted) return inboxErrorResult("CANCELLED");

      // Write-ahead receipt: if the process dies between here and the outcome,
      // the retry sees `uncertain` and refuses to resend.
      const provisional = {
        operationId: input.operationId,
        payloadHash: request.payloadHash,
        recipientBinding,
        state: "uncertain" as InboxReceiptState,
        at: now()
      };
      try {
        await receipts.put(provisional);
      } catch {
        return inboxErrorResult("LOCAL_STORE_UNAVAILABLE");
      }

      reportDiagnostic("INBOX_CAPTURE_TRANSMITTED");
      // The real sender resolves (never rejects), but an injected sender or a
      // future bug must not escape as a raw error: an unexpected throw after
      // the write-ahead receipt is exactly "may have been sent", so it is
      // reported as unknown and never retried.
      const outcome = await sender
        .send({ apiKey, body: request.body })
        .catch((): InboxOutcome => ({ kind: "unconfirmed" }));

      if (outcome.kind === "accepted") {
        // Promote the receipt. If this write fails, the provisional `uncertain`
        // stays: the *proven* acceptance is still reported truthfully, and a
        // later retry errs on the safe side (unknown, no resend).
        await receipts
          .put({ ...provisional, state: "accepted", at: now() })
          .catch(() => undefined);
        return acceptedResult(input.operationId, false);
      }

      if (outcome.kind === "refused") {
        // The documented refusal statuses mean the item was not queued, so the
        // receipt is removed and a corrected retry may send again.
        await receipts.remove(input.operationId).catch(() => undefined);
        return inboxErrorResult(outcome.code);
      }

      if (outcome.kind === "not_sent") {
        await receipts.remove(input.operationId).catch(() => undefined);
        return inboxErrorResult("INBOX_UNAVAILABLE");
      }

      reportDiagnostic("INBOX_CAPTURE_UNCERTAIN");
          return inboxErrorResult("INBOX_UNCERTAIN");
        });
      } catch (error) {
        return inboxErrorResult(profileErrorCode(error));
      }
    });
  };
}

export function registerCaptureNote(
  registrar: ToolRegistrar,
  options: CaptureNoteOptions = {}
): void {
  registrar.registerTool(
    CAPTURE_NOTE_TOOL_NAME,
    {
      title: captureNoteTitle,
      description: captureNoteDescription,
      inputSchema: captureNoteInput,
      outputSchema: captureNoteOutputSchema,
      annotations: CAPTURE_NOTE_ANNOTATIONS
    },
    createCaptureNoteHandler(options)
  );
}
