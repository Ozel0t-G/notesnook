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

// The display-only readable rendering of a saved-note snapshot.
//
// The saved note is Tiptap HTML; the assistant must never render markup. These
// tests drive the shared `html-to-text` conversion directly (no React Native, no
// WebView, no network) and assert that the result is readable, unicode-correct,
// bounded and free of any active content.

import {
  ASSISTANT_PREVIEW_MAX_CHARS,
  toReadablePreviewText
} from "./preview-text";

describe("VeyraN Assistant — readable preview text", () => {
  it("decodes entities and preserves unicode verbatim", () => {
    const { text } = toReadablePreviewText(
      "<p>Grüße &amp; Hallo &#8364; &#x1F600; — 日本語</p>"
    );
    expect(text).toBe("Grüße & Hallo € 😀 — 日本語");
  });

  it("renders block elements as readable paragraphs without any markup", () => {
    const { text } = toReadablePreviewText(
      "<h1>Titel</h1><p>Erster Absatz</p><p>Zweiter Absatz</p>"
    );
    expect(text).toContain("Titel");
    expect(text).toContain("Erster Absatz");
    expect(text).toContain("Zweiter Absatz");
    // Ordered as in the note, paragraph-separated.
    expect(text.indexOf("Erster Absatz")).toBeLessThan(
      text.indexOf("Zweiter Absatz")
    );
    // Never raw markup.
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("</h1>");
  });

  it("renders lists as bulleted readable lines", () => {
    const { text } = toReadablePreviewText(
      "<ul><li>Eins</li><li>Zwei</li></ul>"
    );
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Eins");
    expect(lines[1]).toContain("Zwei");
    expect(lines[0].trimStart().startsWith("*")).toBe(true);
  });

  it("keeps a link's text (and its inert target) without executing it", () => {
    const { text } = toReadablePreviewText(
      '<p>Siehe <a href="https://example.com/x">den Link</a>.</p>'
    );
    expect(text).toContain("den Link");
    // The href is shown as inert text only: there is no html element/URL render.
    expect(text).toContain("https://example.com/x");
    expect(text).not.toContain("<a ");
  });

  it("never renders active content (script/style/iframe/svg bodies)", () => {
    const { text } = toReadablePreviewText(
      "<p>sichtbar</p>" +
        '<script>alert("pwned")</script>' +
        "<style>.x{color:red}</style>" +
        '<iframe src="https://evil.example"></iframe>' +
        "<svg><script>svgPwn()</script></svg>" +
        "<noscript>noscript-body</noscript>"
    );
    expect(text).toBe("sichtbar");
    expect(text).not.toContain("pwned");
    expect(text).not.toContain("svgPwn");
    expect(text).not.toContain("noscript-body");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("color:red");
  });

  it("bounds the display text and reports clipping truthfully", () => {
    const { text, clipped } = toReadablePreviewText(
      "<p>" + "a".repeat(500) + "</p>",
      50
    );
    expect(clipped).toBe(true);
    expect(text.length).toBe(51);
    expect(text.endsWith("…")).toBe(true);

    const small = toReadablePreviewText("<p>kurz</p>", 50);
    expect(small.clipped).toBe(false);
    expect(small.text).toBe("kurz");
  });

  it("is total: empty, non-string and malformed input stay bounded and silent", () => {
    expect(toReadablePreviewText("")).toEqual({ text: "", clipped: false });
    expect(toReadablePreviewText(undefined)).toEqual({
      text: "",
      clipped: false
    });
    expect(toReadablePreviewText(12345)).toEqual({ text: "", clipped: false });
    // Unbalanced markup is tolerated rather than thrown on.
    const malformed = toReadablePreviewText("<p>offen <b>fett");
    expect(malformed.text).toContain("offen");
    expect(malformed.text).toContain("fett");
  });

  it("uses a large but finite default display bound", () => {
    expect(ASSISTANT_PREVIEW_MAX_CHARS).toBe(20_000);
    const { clipped } = toReadablePreviewText("<p>kurz</p>");
    expect(clipped).toBe(false);
  });
});
