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
import { CONTENT_LIMITS, toTiptapHtml } from "../../src/connect/content.js";
import { connectErrorCode } from "./helpers.js";

/**
 * Regression suite for the real converter/sanitizer.
 *
 * The non-browser environment (React Native / Node tests) uses `linkedom`,
 * whose `DOMParser` is a whole-document parser: parsing a fragment such as
 * `<p>hi</p>` produced an empty `<body>` and DOMPurify therefore returned an
 * empty string, silently collapsing every conversion to `<p></p>`. The fix
 * parses fragments with `innerHTML` semantics before sanitizing; these tests
 * fail if that regresses.
 */
describe("VeyraN Connect sanitizer (fragment parsing)", () => {
  it("keeps paragraph text and inline formatting from markdown", () => {
    const html = toTiptapHtml("markdown", "# H\n\n- a\n- b\n\n**bold**");
    expect(html).toContain("<h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toBe("<p></p>");
  });

  it("keeps multi-paragraph plaintext and unicode", () => {
    const html = toTiptapHtml("plaintext", "first line\nsecond line 你好 😀");
    expect(html.match(/<p>/g)?.length).toBe(2);
    expect(html).toContain("first line");
    expect(html).toContain("second line 你好 😀");
  });

  it("keeps nn:// note links through the sanitizer", () => {
    const html = toTiptapHtml(
      "tiptap",
      '<p><a href="nn://note/abc">link</a></p>'
    );
    expect(html).toContain('href="nn://note/abc"');
  });

  it("keeps https links and lists inside a full document", () => {
    const html = toTiptapHtml(
      "tiptap",
      '<ul><li><a href="https://notesnook.com">site</a></li></ul>'
    );
    expect(html).toContain('href="https://notesnook.com"');
    expect(html).toContain("<li>");
  });

  it("strips scripts/handlers/unsafe urls but keeps the safe text", () => {
    const html = toTiptapHtml(
      "tiptap",
      '<p onclick="x()">keep<script>bad()</script><a href="javascript:alert(1)">x</a></p>'
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("keep");
  });

  it("escapes plaintext instead of interpreting it as HTML", () => {
    const html = toTiptapHtml("plaintext", "<b>not bold</b>\nsecond line");
    expect(html).not.toContain("<b>not bold</b>");
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
  });

  it("rejects content that would be silently emptied by sanitization", () => {
    // Non-empty input must never be persisted as an empty document.
    let caught: unknown;
    try {
      toTiptapHtml("tiptap", "<script>alert(1)</script>");
    } catch (error) {
      caught = error;
    }
    expect(connectErrorCode(caught)).toBe("UNSUPPORTED_CONTENT");
  });

  it("returns a valid empty document for empty/blank input", () => {
    expect(toTiptapHtml("markdown", "")).toBe("<p></p>");
    for (const blank of ["", "   \n  "]) {
      const html = toTiptapHtml("plaintext", blank);
      expect(html).toMatch(/^<p>.*<\/p>$/);
      // Only paragraph/line-break markup, no text content.
      expect(html.replace(/<\/?p>|<br\s*\/?>/g, "").trim()).toBe("");
    }
  });

  it("bounds accepted content size", () => {
    let caught: unknown;
    try {
      toTiptapHtml("plaintext", "x".repeat(CONTENT_LIMITS.maxContentChars + 1));
    } catch (error) {
      caught = error;
    }
    expect(connectErrorCode(caught)).toBe("CONTENT_TOO_LARGE");
  });
});
