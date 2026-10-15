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

import showdown from "@streetwriters/showdown";
import { getDummyDocument, HTMLParser } from "../utils/html-parser.js";
import dataurl from "../utils/dataurl.js";
import { getDomPurify } from "../utils/dom-purify.js";
import { ConnectError } from "./errors.js";
import { CONTENT_LIMITS } from "./limits.js";
import type { ConnectContentFormat } from "./limits.js";

// Re-exported unchanged so existing importers (`connect/index.ts`, the content
// tests) keep their single identity: `content.CONTENT_LIMITS` is the very same
// object as `limits.CONTENT_LIMITS`, and the format type is the same alias.
export { CONTENT_LIMITS } from "./limits.js";
export type { ConnectContentFormat } from "./limits.js";

/**
 * The Markdown converter is created lazily, at call time, and never at module
 * import: the mobile worker installs `globalThis.DOMParser` lazily
 * (`apps/mobile/globals.js`), so building the converter eagerly at import would
 * either bind a `null` showdown document (the original "late mobile DOM fail")
 * or eagerly load the worker DOM implementation on import. The live DOM is
 * re-read on every Markdown conversion instead.
 */
let markdownConverter: InstanceType<typeof showdown.Converter> | undefined;

function getMarkdownConverter(): InstanceType<typeof showdown.Converter> {
  if (!markdownConverter) {
    markdownConverter = new showdown.Converter();
    markdownConverter.setFlavor("original");
  }
  return markdownConverter;
}

/**
 * Bind showdown's document helper to the *current* platform DOM, failing closed
 * when no `DOMParser` is available (rather than letting showdown throw a raw
 * `TypeError` later). `getDummyDocument` reads `globalThis.DOMParser` at call
 * time and returns `null` when it is absent.
 */
function bindMarkdownDocument(): void {
  const document = getDummyDocument();
  if (!document) throw new ConnectError("UNSUPPORTED_CONTENT");
  (showdown.helper as unknown as { document: unknown }).document = document;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plaintextToHtml(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`)
    .join("");
}

const DOCUMENT_SHELL =
  '<!doctype html><html lang="en"><head><title>Document Fragment</title></head><body></body></html>';

/** Attribute a stored-attachment reference is carried on (see `tiptap.ts`). */
const ATTACHMENT_HASH_ATTR = "data-hash";

/**
 * Reject any input that would cross the *attachment* persistence boundary.
 *
 * VeyraN Connect is a bounded-text API: an image reaches the content pipeline
 * either as a `data:` URI (which `Attachments.save` turns into a new stored
 * attachment) or as a `data-hash` reference to an existing stored attachment
 * (which the relation helper binds). Both writes happen deep inside
 * post-processing, where a revocation that lands while `Attachments.save` is
 * suspended cannot be undone, so the adapter refuses the input up front —
 * before a reservation is allocated and before any conversion/persistence side
 * effect — instead of trying to guard the attachment writer globally. Ordinary
 * text (paragraphs, lists, links, Unicode, plain `<img>` markup without an
 * attachment payload) is unaffected.
 */
function assertNoAttachmentContent(html: string): void {
  let offending = false;
  new HTMLParser({
    ontag: (name, attr) => {
      if (offending) return;
      if (attr[ATTACHMENT_HASH_ATTR]) {
        offending = true;
        return;
      }
      const src = attr["src"];
      if (name.toLowerCase() !== "img" || !src) return;
      try {
        if (dataurl.toObject(src).data) offending = true;
      } catch {
        // Not a parseable data URI: the persistence pipeline would not save it
        // either, so it is not an attachment boundary.
      }
    }
  }).parse(html);
  if (offending) throw new ConnectError("UNSUPPORTED_CONTENT");
}

/**
 * Would re-running the ordinary content pipeline over `html` import a *new*
 * attachment (an `<img>` whose `src` is a `data:` URI)?
 *
 * A plaintext append is combined with the *stored* body, so a legacy note that
 * still carries an inline base64 image would (re)enter `Attachments.save`
 * during post-processing — a persistent effect the bounded Connect guard does
 * not own. `assertNoAttachmentContent` only sees the *new* request input, so
 * this detector is used to refuse such an append *before* a reservation is
 * allocated, leaving the stored body and its existing attachment relations
 * untouched. Stored `data-hash` references are *not* flagged here: they bind to
 * already-stored attachments through the guarded relation helper.
 */
export function containsInlineAttachmentData(html: string): boolean {
  if (typeof html !== "string" || !html) return false;
  let offending = false;
  try {
    new HTMLParser({
      ontag: (name, attr) => {
        if (offending) return;
        const src = attr["src"];
        if (name.toLowerCase() !== "img" || !src) return;
        try {
          if (dataurl.toObject(src).data) offending = true;
        } catch {
          // Not a parseable data URI: the pipeline would not import it either.
        }
      }
    }).parse(html);
  } catch {
    // Unparseable stored markup is treated as unsafe to re-import.
    return true;
  }
  return offending;
}

type ParserDocument = {
  body?: {
    innerHTML: string;
  } | null;
};

/**
 * Parse an HTML fragment with the *fragment* parsing rules of the platform.
 *
 * `DOMParser.parseFromString(html, "text/html")` is a whole-document parser:
 * browsers and jsdom synthesize `<html><head><body>` around a fragment, but
 * lighter non-browser HTML implementations (linkedom, used by the React Native
 * / Node test environment) treat the first tag as the document element and
 * hoist the implicit `head`/`body` around it, which leaves `<body>` empty. The
 * sanitizer then sees nothing and every conversion collapses to `<p></p>`.
 *
 * Setting `innerHTML` on an existing body element always uses fragment parsing
 * rules on every supported platform, so the sanitizer receives exactly the
 * nodes the caller wrote.
 */
function parseFragment(html: string): { innerHTML: string } {
  const DOMParserCtor = (
    globalThis as unknown as {
      DOMParser?: new () => {
        parseFromString(input: string, type: string): ParserDocument;
      };
    }
  ).DOMParser;
  if (typeof DOMParserCtor !== "function")
    throw new ConnectError("UNSUPPORTED_CONTENT");

  let body: { innerHTML: string } | null | undefined;
  try {
    body = new DOMParserCtor().parseFromString(DOCUMENT_SHELL, "text/html")
      .body;
  } catch {
    throw new ConnectError("UNSUPPORTED_CONTENT");
  }
  if (!body || typeof body.innerHTML !== "string")
    throw new ConnectError("UNSUPPORTED_CONTENT");

  body.innerHTML = html;
  // A fragment parser that produced nothing for non-empty input cannot be
  // trusted: fail closed instead of persisting silently emptied content.
  if (!body.innerHTML.trim()) throw new ConnectError("UNSUPPORTED_CONTENT");
  return body;
}

/**
 * Convert bounded Markdown / plaintext into sanitized Tiptap-compatible HTML.
 * `tiptap` input is trusted only after the same sanitizer pass.
 *
 * The output is always HTML (never a `.md`/plain string) and is passed through
 * DOMPurify, so no unsafe markup (scripts, event handlers, `javascript:`
 * URLs, iframes, forms) can reach the persisted content. Empty input yields the
 * canonical empty document; non-empty input that sanitizes to nothing is
 * rejected (`UNSUPPORTED_CONTENT`) rather than quietly discarded.
 */
export function toTiptapHtml(
  format: ConnectContentFormat,
  content: string
): string {
  if (typeof content !== "string")
    throw new ConnectError("UNSUPPORTED_CONTENT");
  if (content.length > CONTENT_LIMITS.maxContentChars)
    throw new ConnectError("CONTENT_TOO_LARGE");

  let html: string;
  try {
    switch (format) {
      case "markdown":
        // Bind the live DOM and build the converter at call time; without a
        // `DOMParser` this fails closed instead of returning broken markup.
        bindMarkdownDocument();
        html = getMarkdownConverter().makeHtml(content) as string;
        break;
      case "plaintext":
        html = plaintextToHtml(content);
        break;
      case "tiptap":
        html = content;
        break;
      default:
        throw new ConnectError("UNSUPPORTED_CONTENT");
    }
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError("UNSUPPORTED_CONTENT");
  }

  if (typeof html !== "string")
    throw new ConnectError("UNSUPPORTED_CONTENT");
  // Nothing to sanitize: store the canonical empty document.
  if (!html.trim()) return "<p></p>";

  // Attachment-bearing input is refused here, before a reservation or any
  // persistence effect (see `assertNoAttachmentContent`).
  assertNoAttachmentContent(html);

  const body = parseFragment(html);

  let sanitized: unknown;
  try {
    sanitized = getDomPurify().sanitize(body as unknown as Node, {
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["style"],
      // DOMPurify's default allowlist plus the app's own `nn://` note links.
      ALLOWED_URI_REGEXP:
        /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|nn):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
    });
  } catch {
    throw new ConnectError("UNSUPPORTED_CONTENT");
  }

  if (typeof sanitized !== "string" || !sanitized.trim())
    throw new ConnectError("UNSUPPORTED_CONTENT");
  return sanitized;
}

export function assertBounded(value: string, max: number): void {
  if (typeof value !== "string" || value.length > max)
    throw new ConnectError("INVALID_INPUT");
}

export interface BoundedText {
  value: string;
  truncated: boolean;
}

/** Bound a returned summary string and report whether it was cut. */
export function boundText(value: unknown, max: number): BoundedText {
  const text = typeof value === "string" ? value : "";
  if (text.length <= max) return { value: text, truncated: false };
  return { value: text.slice(0, max), truncated: true };
}

export interface BoundedItems<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

/** Bound a returned collection, always reporting the untruncated total. */
export function boundItems<T>(items: readonly T[], max: number): BoundedItems<T> {
  if (items.length <= max)
    return { items: [...items], total: items.length, truncated: false };
  return { items: items.slice(0, max), total: items.length, truncated: true };
}

/**
 * Bound a stored note body for a read. Never returns a partial body: a body
 * that exceeds the (generous) limit fails closed instead of silently losing
 * the tail, because callers may write the value straight back.
 */
export function boundContent(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  if (text.length > CONTENT_LIMITS.maxResponseContentChars)
    throw new ConnectError("CONTENT_TOO_LARGE");
  return text;
}
