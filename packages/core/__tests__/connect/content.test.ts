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

describe("VeyraN Connect content conversion", () => {
  it("converts markdown to sanitized Tiptap HTML", () => {
    const html = toTiptapHtml("markdown", "# H\n\n- a\n- b\n\n**bold**");
    expect(html).toContain("<h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("escapes plaintext instead of interpreting it as HTML", () => {
    const html = toTiptapHtml("plaintext", "<b>not bold</b>\nsecond line");
    expect(html).not.toContain("<b>not bold</b>");
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
    expect(html.match(/<p>/g)?.length).toBe(2);
  });

  it("strips scripts, event handlers and unsafe URLs", () => {
    const html = toTiptapHtml(
      "tiptap",
      '<p onclick="x()"><script>bad()</script><a href="javascript:alert(1)">x</a></p>'
    );
    expect(html).not.toContain("script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
  });

  it("keeps nn:// internal note links", () => {
    const html = toTiptapHtml(
      "tiptap",
      '<p><a href="nn://note/abc">link</a></p>'
    );
    expect(html).toContain("nn://note/abc");
  });

  it("bounds content size", () => {
    const tooLarge = "x".repeat(CONTENT_LIMITS.maxContentChars + 1);
    let caught: unknown;
    try {
      toTiptapHtml("plaintext", tooLarge);
    } catch (error) {
      caught = error;
    }
    expect(connectErrorCode(caught)).toBe("CONTENT_TOO_LARGE");
  });

  it("produces a valid empty document for empty input", () => {
    expect(toTiptapHtml("markdown", "")).toBe("<p></p>");
  });
});
