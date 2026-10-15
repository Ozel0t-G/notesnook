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
 * Bounded, pure input shaping for `capture_note` (the official Notesnook Inbox
 * API). This module contains **no transport and no filesystem access**: it
 * takes the model's bounded title + plain text/Markdown, produces the exact
 * `{ title, type, source, version, content }` JSON the documented endpoint
 * expects, and derives the stable canonical payload hash used for local repeat
 * safety.
 *
 * Safety model of the converter:
 *  - the *only* HTML that can leave this module is HTML this module wrote: the
 *    input is escaped first (`& < > " '`), so no element, attribute, script or
 *    event handler from the input can survive — there is no "sanitize after
 *    build" step that could miss a construct;
 *  - links are emitted only when the address matches an exact `http`/`https`
 *    address (a strict RFC-3986-ish character allow-list, matched on the
 *    *escaped* text, so no `javascript:`, `data:`, `file:` or attribute-breaking
 *    address can be produced), and are always emitted with
 *    `rel="noopener noreferrer nofollow"`;
 *  - every emitted tag is a non-void element written by us in matching pairs, so
 *    the Inbox server's "unbalanced tag becomes one code block" rule can never
 *    be triggered by our output;
 *  - all sizes are bounded *before* the socket is opened: the raw capture text
 *    (UTF-8 bytes), the derived HTML (UTF-8 bytes) and the serialized JSON body.
 *
 * The endpoint itself never returns a note id (only `{"success":true}`), so
 * nothing in this module — or anywhere downstream — carries a note id, a link
 * or an import/sync claim.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { INBOX_LIMITS } from "./limits.js";

/** The fixed, honest `source` identifier sent with every capture. */
export const INBOX_SOURCE = "veyran-connect";
/** The only schema version the documented Inbox API accepts. */
export const INBOX_PAYLOAD_VERSION = 1 as const;

/** Stable operation-id shape (mirrors the Core operation-id bound). */
export const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const CAPTURE_FORMATS = ["plaintext", "markdown"] as const;
export type CaptureFormat = (typeof CAPTURE_FORMATS)[number];

/** Control characters that may never enter a capture (placeholders are safe). */
const FORBIDDEN_CONTROL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const TITLE_CONTROL = /[\u0000-\u001F\u007F]/;

/**
 * Visible `capture_note` arguments. Structural bounds live here (shape, id
 * pattern, title length/characters); the authoritative *byte* bounds of the
 * capture text are enforced by `buildInboxHtml`, so an oversized body is a
 * bounded `CONTENT_TOO_LARGE` refusal rather than a schema error.
 */
export const captureNoteInputSchema = z.strictObject({
  operationId: z
    .string()
    .min(1)
    .max(INBOX_LIMITS.maxOperationIdChars)
    .regex(OPERATION_ID_PATTERN),
  title: z
    .string()
    .min(1)
    .max(INBOX_LIMITS.maxTitleChars)
    .refine((value) => !TITLE_CONTROL.test(value), {
      message: "the title must not contain control characters"
    })
    .refine((value) => /\S/.test(value), {
      message: "the title must contain at least one non-whitespace character"
    }),
  content: z.string().optional(),
  format: z.enum(CAPTURE_FORMATS).optional()
});

export type CaptureNoteInput = z.infer<typeof captureNoteInputSchema>;

export function captureFormat(input: CaptureNoteInput): CaptureFormat {
  return input.format ?? "markdown";
}

/**
 * The canonical, deterministic shape hashed for repeat safety: the bounded
 * *input* (version, format, title, content), never a timestamp, a derived
 * document or anything from the environment. An exact repeat of the same call
 * therefore always maps to the same hash, while a changed title, format or body
 * maps to a different one.
 */
export function canonicalCapture(input: CaptureNoteInput): string {
  return JSON.stringify({
    v: INBOX_PAYLOAD_VERSION,
    format: captureFormat(input),
    title: input.title,
    content: input.content ?? ""
  });
}

export function capturePayloadHash(input: CaptureNoteInput): string {
  return createHash("sha256").update(canonicalCapture(input), "utf8").digest("hex");
}

/** The exact documented request body (content omitted when empty). */
export interface InboxNotePayload {
  title: string;
  type: "note";
  source: string;
  version: 1;
  content?: { type: "html"; data: string };
}

export function buildInboxPayload(
  input: CaptureNoteInput,
  html: string
): InboxNotePayload {
  const payload: InboxNotePayload = {
    title: input.title,
    type: "note",
    source: INBOX_SOURCE,
    version: INBOX_PAYLOAD_VERSION
  };
  if (html.length > 0) payload.content = { type: "html", data: html };
  return payload;
}

export type CaptureBoundsIssue = "INVALID_INPUT" | "CONTENT_TOO_LARGE";

export type CaptureBounds =
  | { ok: true; titleBytes: number; contentBytes: number }
  | { ok: false; code: CaptureBoundsIssue };

/**
 * Byte-exact bounds on the raw capture. `title`/`content` were already shape-
 * checked by `captureNoteInputSchema`; this is the authoritative byte bound.
 */
export function checkCaptureBounds(input: CaptureNoteInput): CaptureBounds {
  const titleBytes = Buffer.byteLength(input.title, "utf8");
  if (titleBytes > INBOX_LIMITS.maxTitleBytes)
    return { ok: false, code: "CONTENT_TOO_LARGE" };
  const contentBytes = Buffer.byteLength(input.content ?? "", "utf8");
  if (contentBytes > INBOX_LIMITS.maxContentBytes)
    return { ok: false, code: "CONTENT_TOO_LARGE" };
  return { ok: true, titleBytes, contentBytes };
}

// ------------------------------------------------------------------- escaping

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

/** Escape every character that could start markup, an attribute or an entity. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/**
 * An exact `http`/`https` address built from a strict character allow-list.
 * Matched against *escaped* text, so an address can never contain a raw quote,
 * angle bracket or control character; the escaped forms of those characters are
 * refused as well, so a link address never contains markup-significant text.
 */
const SAFE_URL = /^https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+$/i;
const ESCAPED_MARKUP_IN_URL = /&(?:lt|gt|quot|#39);/;

// ------------------------------------------------------------ inline markdown

const STASH = "\u0000";

/**
 * Inline Markdown on already-escaped text: `code`, `[label](http(s) url)`,
 * `**bold**`/`__bold__`, `*italic*`/`_italic_`, `~~strike~~`.
 *
 * Code spans and links are resolved first and replaced by placeholders that no
 * later rule can match, so emphasis can never rewrite a URL or a code span.
 */
export function inlineMarkdown(escaped: string): string {
  const stashed: string[] = [];
  const stash = (html: string): string => {
    stashed.push(html);
    return `${STASH}${stashed.length - 1}${STASH}`;
  };

  let text = escaped.replace(/`([^`\n]+)`/g, (_match, code: string) =>
    stash(`<code>${code}</code>`)
  );
  text = text.replace(
    /\[([^\]\n]*)\]\(([^()\s<>]*)\)/g,
    (match, label: string, url: string) => {
      // Only an exact http/https address becomes a link; anything else (a
      // relative path, `javascript:`, `data:`, a malformed address, an address
      // that needed escaping) is left as the literal, escaped text.
      if (!SAFE_URL.test(url) || ESCAPED_MARKUP_IN_URL.test(url)) return match;
      return stash(
        `<a href="${url}" rel="noopener noreferrer nofollow">${label}</a>`
      );
    }
  );
  // Emphasis requires non-whitespace edges (so `2 * 3 * 4` stays literal) and
  // never spans a line break.
  const inner = "(\\S(?:[^*\\n]*\\S)?)";
  text = text
    .replace(new RegExp(`\\*\\*${inner}\\*\\*`, "g"), "<strong>$1</strong>")
    .replace(/__(\S(?:[^_\n]*\S)?)__/g, "<strong>$1</strong>")
    .replace(new RegExp(`(^|[^*])\\*${inner}\\*`, "g"), "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(\S(?:[^_\n]*\S)?)_/g, "$1<em>$2</em>")
    .replace(/~~(\S(?:[^~\n]*\S)?)~~/g, "<s>$1</s>");

  return text.replace(
    new RegExp(`${STASH}(\\d+)${STASH}`, "g"),
    (_match, index: string) => stashed[Number(index)] ?? ""
  );
}

// ------------------------------------------------------------- block markdown

const HEADING = /^(#{1,6})\s+(.+)$/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
/**
 * Block quote. Lines arrive *escaped*, so the marker is the escaped `&gt;`
 * (a literal `&gt;` in the capture becomes `&amp;gt;` and is not a marker).
 */
const QUOTE = /^&gt;\s?(.*)$/;
const FENCE = /^```/;

/** True when a line starts a block that must not join the current paragraph. */
function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) || BULLET.test(line) || QUOTE.test(line) || FENCE.test(line)
  );
}

/**
 * Block Markdown: ATX headings, flat (or flattened nested) ordered/unordered
 * lists, blockquotes and fenced code blocks; blank lines separate paragraphs and
 * a single newline inside a paragraph becomes `<br>` (so plain-text layouts —
 * addresses, lists of lines — survive as written). Every line's text is escaped
 * before any markup is produced, and inline Markdown is applied only to running
 * text (never inside code spans/blocks).
 */
export function markdownToHtml(escapedLines: readonly string[]): string {
  const out: string[] = [];
  let index = 0;
  while (index < escapedLines.length) {
    const line = escapedLines[index];
    if (line.trim() === "") {
      index++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = inlineMarkdown(heading[2].trim());
      out.push(`<h${level}>${text}</h${level}>`);
      index++;
      continue;
    }

    if (FENCE.test(line.trim())) {
      const body: string[] = [];
      index++;
      while (index < escapedLines.length && !FENCE.test(escapedLines[index].trim())) {
        body.push(escapedLines[index]);
        index++;
      }
      // Consume the closing fence when present (an unterminated fence simply
      // ends at the end of the capture: no markup can escape it).
      if (index < escapedLines.length) index++;
      out.push(`<pre><code>${body.join("\n")}</code></pre>`);
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]);
      const items: string[] = [];
      let current = bullet[3];
      index++;
      while (index < escapedLines.length) {
        const next = BULLET.exec(escapedLines[index]);
        if (next) {
          if (/\d/.test(next[2]) !== ordered) break;
          items.push(current);
          current = next[3];
          index++;
          continue;
        }
        if (escapedLines[index].trim() === "" || startsBlock(escapedLines[index]))
          break;
        current += ` ${escapedLines[index].trim()}`;
        index++;
      }
      items.push(current);
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag}>${items
          .map((item) => `<li>${inlineMarkdown(item.trim())}</li>`)
          .join("")}</${tag}>`
      );
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const parts: string[] = [];
      while (index < escapedLines.length) {
        const next = QUOTE.exec(escapedLines[index]);
        if (!next) break;
        parts.push(next[1].trim());
        index++;
      }
      out.push(
        `<blockquote><p>${parts
          .map((part) => inlineMarkdown(part))
          .join("<br>")}</p></blockquote>`
      );
      continue;
    }

    const paragraph = [line];
    index++;
    while (
      index < escapedLines.length &&
      escapedLines[index].trim() !== "" &&
      !startsBlock(escapedLines[index])
    ) {
      paragraph.push(escapedLines[index]);
      index++;
    }
    out.push(
      `<p>${paragraph
        .map((part) => inlineMarkdown(part.trim()))
        .join("<br>")}</p>`
    );
  }
  return out.join("");
}

/** Plain text: escaped, blank-line separated paragraphs, newlines as `<br>`. */
export function plaintextToHtml(escapedLines: readonly string[]): string {
  const out: string[] = [];
  let block: string[] = [];
  const flush = (): void => {
    if (block.length === 0) return;
    out.push(`<p>${block.map((line) => escapeHtml(line).trimEnd()).join("<br>")}</p>`);
    block = [];
  };
  for (const line of escapedLines) {
    if (line.trim() === "") flush();
    else block.push(line);
  }
  flush();
  return out.join("");
}

// ------------------------------------------------------------------ conversion

export type HtmlBuildResult =
  | { ok: true; html: string }
  | { ok: false; code: "UNSUPPORTED_CONTENT" | "CONTENT_TOO_LARGE" };

/** Normalize line endings and drop a leading BOM; never any other rewrite. */
export function normalizeCaptureText(value: string): string {
  return value.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/**
 * Convert the bounded capture text into the exact HTML sent to the Inbox API.
 * Nothing is sent if this fails: an oversized input, an oversized derived
 * document or a control character is a bounded refusal, never a truncation.
 */
export function buildInboxHtml(
  format: CaptureFormat,
  content: string
): HtmlBuildResult {
  const normalized = normalizeCaptureText(content);
  if (FORBIDDEN_CONTROL.test(normalized))
    return { ok: false, code: "UNSUPPORTED_CONTENT" };
  if (Buffer.byteLength(normalized, "utf8") > INBOX_LIMITS.maxContentBytes)
    return { ok: false, code: "CONTENT_TOO_LARGE" };
  const escaped = escapeHtml(normalized);
  const lines = escaped.split("\n");
  const html =
    format === "plaintext" ? plaintextToHtml(lines) : markdownToHtml(lines);
  if (Buffer.byteLength(html, "utf8") > INBOX_LIMITS.maxHtmlBytes)
    return { ok: false, code: "CONTENT_TOO_LARGE" };
  return { ok: true, html };
}

export type CaptureBodyResult =
  | { ok: true; body: string; html: string; payloadHash: string }
  | { ok: false; code: "INVALID_INPUT" | "CONTENT_TOO_LARGE" | "UNSUPPORTED_CONTENT" };

/**
 * The single bounded construction step: bounds → HTML → payload → serialized
 * body. Returns the exact bytes that may be sent, or a bounded refusal.
 */
export function buildCaptureRequest(input: CaptureNoteInput): CaptureBodyResult {
  const bounds = checkCaptureBounds(input);
  if (!bounds.ok) return { ok: false, code: bounds.code };
  const html = buildInboxHtml(captureFormat(input), input.content ?? "");
  if (!html.ok) return { ok: false, code: html.code };
  const payload = buildInboxPayload(input, html.html);
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > INBOX_LIMITS.maxRequestBytes)
    return { ok: false, code: "CONTENT_TOO_LARGE" };
  return {
    ok: true,
    body,
    html: html.html,
    payloadHash: capturePayloadHash(input)
  };
}
