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
 * The display-only, readable rendering of the exact saved-note snapshot.
 *
 * The saved note is stored by Core as Tiptap HTML. The assistant must **never**
 * render that markup (no WebView, no HTML execution, no raw tag display): the
 * preview is converted to bounded plain text with the same `html-to-text`
 * engine Core already uses for `Tiptap.toTXT()` (an existing dependency — no
 * new package, no browser, no script/style/iframe execution).
 *
 * This is presentation only. The exact reviewed `content` string stays
 * untouched in the controller state and is what the model receives as data —
 * this module only decides what a human reads on screen.
 */

import { convert } from "html-to-text";

/**
 * The display bound of the readable preview. It is deliberately large enough to
 * cover a normal note and exists only so a pathologically large document cannot
 * force an unbounded text layout. Core's own snapshot bound (`truncated` on the
 * preview) is the *data* bound and is never changed here.
 */
export const ASSISTANT_PREVIEW_MAX_CHARS = 20_000;

/** The single-character marker appended when the display text was clipped. */
export const ASSISTANT_PREVIEW_ELLIPSIS = "…";

export type ReadablePreview = {
  /** The bounded, readable plain text (never markup). */
  text: string;
  /** True when `text` was clipped at {@link ASSISTANT_PREVIEW_MAX_CHARS}. */
  clipped: boolean;
};

/**
 * The active/embedded elements that never contribute readable text. `skip`
 * drops the element *and its children*, so a `<script>` body, a stylesheet, a
 * nested document or vector markup can never leak into the preview — not even
 * as inert text.
 */
const CONVERT_OPTIONS = {
  wordwrap: false,
  preserveNewlines: true,
  selectors: [
    // Heading text is shown with its original casing (a preview must read like
    // the note; `html-to-text` uppercases headings by default).
    { selector: "h1", options: { uppercase: false } },
    { selector: "h2", options: { uppercase: false } },
    { selector: "h3", options: { uppercase: false } },
    { selector: "h4", options: { uppercase: false } },
    { selector: "h5", options: { uppercase: false } },
    { selector: "h6", options: { uppercase: false } },
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "head", format: "skip" },
    { selector: "title", format: "skip" },
    { selector: "noscript", format: "skip" },
    { selector: "template", format: "skip" },
    { selector: "iframe", format: "skip" },
    { selector: "object", format: "skip" },
    { selector: "embed", format: "skip" },
    { selector: "svg", format: "skip" },
    { selector: "canvas", format: "skip" },
    { selector: "meta", format: "skip" },
    { selector: "link", format: "skip" }
  ]
};

/**
 * Convert one Tiptap HTML snapshot into bounded, readable plain text.
 *
 *  - entities (`&amp;`, `&#8364;`, `&#x1F600;`) are decoded and unicode is
 *    preserved verbatim;
 *  - block elements become paragraphs and lists become bulleted lines;
 *  - a link keeps its visible text (and its target as inert `[url]` text — it is
 *    never followed or executed);
 *  - `script`/`style`/`iframe`/`svg` and friends contribute nothing at all;
 *  - the result is bounded, and clipping is reported truthfully via `clipped`.
 *
 * It is total: a malformed/empty/non-string input yields a bounded empty result
 * rather than throwing, so the preview can never crash the panel.
 */
export function toReadablePreviewText(
  content: unknown,
  maxChars: number = ASSISTANT_PREVIEW_MAX_CHARS
): ReadablePreview {
  const bound =
    typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : ASSISTANT_PREVIEW_MAX_CHARS;
  if (typeof content !== "string" || content.length === 0) {
    return { text: "", clipped: false };
  }

  let raw: string;
  try {
    raw = convert(content, CONVERT_OPTIONS);
  } catch {
    // A conversion failure must never surface markup or throw: show nothing.
    return { text: "", clipped: false };
  }

  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length <= bound) return { text, clipped: false };
  return {
    text: text.slice(0, bound) + ASSISTANT_PREVIEW_ELLIPSIS,
    clipped: true
  };
}
