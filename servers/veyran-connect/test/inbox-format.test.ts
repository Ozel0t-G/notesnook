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
 * Pure `capture_note` input shaping: the strict input schema, the byte bounds,
 * the canonical payload hash and — most importantly — the converter, which must
 * make it *impossible* for a hostile capture to produce anything but escaped
 * text plus a small, fixed set of tags this project writes itself.
 */
import { describe, expect, it } from "vitest";
import {
  INBOX_SOURCE,
  buildCaptureRequest,
  buildInboxHtml,
  buildInboxPayload,
  captureNoteInputSchema,
  capturePayloadHash,
  escapeHtml,
  markdownToHtml,
  plaintextToHtml
} from "../src/inbox-format.js";
import { INBOX_LIMITS } from "../src/limits.js";

/** Every tag the converter is allowed to emit (never from the input). */
const GENERATED_TAGS =
  /<(\/?)(?:p|br|h[1-6]|ul|ol|li|blockquote|pre|code|strong|em|s|a)\b[^>]*>/g;

/**
 * Strip only generated tags; what remains must contain no `<`/`>` at all,
 * proving no markup from the input survived escaping.
 */
function textOnly(html: string): string {
  return html.replace(GENERATED_TAGS, "");
}

function htmlOf(
  content: string,
  format: "markdown" | "plaintext" = "markdown"
): string {
  const result = buildInboxHtml(format, content);
  if (!result.ok) throw new Error(`conversion failed: ${result.code}`);
  return result.html;
}

const input = (value: Partial<Record<string, unknown>> = {}) =>
  captureNoteInputSchema.parse({
    operationId: "op-1",
    title: "Title",
    content: "body",
    ...value
  });

describe("capture_note input schema", () => {
  it("accepts the documented minimal and full shapes only", () => {
    expect(
      captureNoteInputSchema.safeParse({ operationId: "op-1", title: "T" }).success
    ).toBe(true);
    expect(
      captureNoteInputSchema.safeParse({
        operationId: "op-1",
        title: "T",
        content: "hello",
        format: "plaintext"
      }).success
    ).toBe(true);
  });

  it("rejects unknown, secret-bearing and redirecting arguments", () => {
    // No key, endpoint, header, proxy or redirect can arrive from the model.
    for (const extra of [
      { apiKey: "x".repeat(32) },
      { key: "x".repeat(32) },
      { url: "https://evil.example/" },
      { endpoint: "https://evil.example/" },
      { headers: { authorization: "x" } },
      { proxy: "http://127.0.0.1:8080" },
      { followRedirects: true },
      { type: "note" },
      { source: "zapier" },
      { version: 1 },
      { operation: "capture_note" },
      { pinned: true }
    ])
      expect(
        captureNoteInputSchema.safeParse({
          operationId: "op-1",
          title: "T",
          ...extra
        }).success
      ).toBe(false);
  });

  it("rejects a bad operation id, a control-character or blank title and html format", () => {
    expect(
      captureNoteInputSchema.safeParse({ operationId: "-bad", title: "T" }).success
    ).toBe(false);
    expect(
      captureNoteInputSchema.safeParse({ operationId: "a".repeat(129), title: "T" })
        .success
    ).toBe(false);
    expect(
      captureNoteInputSchema.safeParse({ operationId: "op-1", title: "a\u0007b" })
        .success
    ).toBe(false);
    expect(
      captureNoteInputSchema.safeParse({ operationId: "op-1", title: "   " }).success
    ).toBe(false);
    expect(
      captureNoteInputSchema.safeParse({ operationId: "op-1", title: "a\nb" }).success
    ).toBe(false);
    expect(
      captureNoteInputSchema.safeParse({
        operationId: "op-1",
        title: "T",
        format: "html"
      }).success
    ).toBe(false);
  });
});

describe("escaping", () => {
  it("escapes every markup-significant character", () => {
    expect(escapeHtml(`<a href="x" onerror='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;"
    );
  });

  it("never lets input markup survive into the document", () => {
    const hostile = [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "<iframe src=\"https://e.com\"></iframe>",
      "<style>body{}</style>",
      "<div onclick=alert(1)>text</div>",
      "<svg/onload=alert(1)>",
      "<!-- comment -->",
      "<?php echo 1 ?>"
    ].join("\n\n");
    const html = htmlOf(hostile);
    // No character of the input can open a tag or an attribute: stripping only
    // the tags this project writes leaves no `<`/`>` at all.
    expect(textOnly(html)).not.toMatch(/[<>]/);
    // Consequently every hostile tag survives only as escaped *text*.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;div onclick=alert(1)&gt;text&lt;/div&gt;");
  });
});

describe("links", () => {
  it("keeps http/https links and drops every other address", () => {
    const html = htmlOf(
      [
        "[secure](https://example.com/a?b=1&c=2)",
        "[plain](http://example.com/x)",
        "[js](javascript:alert(1))",
        "[data](data:text/html;base64,PHNjcmlwdD4=)",
        "[file](file:///etc/passwd)",
        "[relative](/local/path)",
        "[proto-relative](//evil.example/x)"
      ].join("\n\n")
    );
    expect(html).toContain(
      '<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer nofollow">secure</a>'
    );
    expect(html).toContain(
      '<a href="http://example.com/x" rel="noopener noreferrer nofollow">plain</a>'
    );
    // Exactly two links, and every emitted address is an exact http/https URL:
    // no `javascript:`, `data:`, `file:`, relative or protocol-relative address
    // ever becomes an `href`.
    expect([...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1])).toEqual([
      "https://example.com/a?b=1&amp;c=2",
      "http://example.com/x"
    ]);
    for (const label of ["js", "data", "file", "relative", "proto-relative"])
      expect(html).toContain(label);
  });

  it("cannot be tricked into an attribute break", () => {
    const html = htmlOf(
      [
        '[a](https://e.com/x"onmouseover="alert)',
        "[b](https://e.com/x'onmouseover='alert)",
        "[c](https://e.com/x<script>)",
        "[d](https://e.com/<script>)",
        "[e](https://e.com/x >y)"
      ].join("\n\n")
    );
    expect(textOnly(html)).not.toMatch(/[<>]/);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    for (const href of hrefs) expect(href).toMatch(/^https?:\/\//);
    expect(html).not.toMatch(/\son(?:error|mouseover|load|click)=/i);
  });

  it("escapes the label and never links from inside code spans", () => {
    const html = htmlOf(
      "[<b>label</b>](https://example.com) and `<a href=\"https://example.com\">x</a>`"
    );
    expect(html).toContain("<a href=\"https://example.com\"");
    expect(html).toContain("&lt;b&gt;label&lt;/b&gt;");
    expect(html.match(/<a /g)?.length).toBe(1);
    expect(html).toContain("<code>&lt;a href=&quot;https://example.com&quot;&gt;x&lt;/a&gt;</code>");
  });
});

describe("block structure", () => {
  it("keeps headings, paragraphs, lists, quotes and code blocks", () => {
    const html = htmlOf(
      [
        "# Heading one",
        "",
        "Intro paragraph",
        "second line",
        "",
        "- first",
        "- second",
        "  - nested flattens",
        "",
        "1. one",
        "2. two",
        "",
        "> quoted",
        "> more",
        "",
        "```",
        "const x = 1 < 2;",
        "```",
        "",
        "### Deep heading"
      ].join("\n")
    );
    expect(html).toContain("<h1>Heading one</h1>");
    expect(html).toContain("<p>Intro paragraph<br>second line</p>");
    expect(html).toContain("<ul><li>first</li><li>second</li><li>nested flattens</li></ul>");
    expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(html).toContain("<blockquote><p>quoted<br>more</p></blockquote>");
    expect(html).toContain("<pre><code>const x = 1 &lt; 2;</code></pre>");
    expect(html).toContain("<h3>Deep heading</h3>");
    expect(textOnly(html)).not.toMatch(/[<>]/);
  });

  it("does not mistake a long hash run or a dash line for structure", () => {
    const html = htmlOf("####### too deep\n\n---\n\n2 * 3 * 4");
    expect(html).not.toContain("<h7>");
    expect(html).toContain("####### too deep");
    expect(html).toContain("---");
    expect(html).toContain("2 * 3 * 4");
  });

  it("applies emphasis and code spans on running text only", () => {
    const html = htmlOf(
      "**bold** and __also bold__ and *it* and _it_ and ~~gone~~ and `a**b**c`"
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<strong>also bold</strong>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain("<s>gone</s>");
    // Emphasis inside a code span stays literal.
    expect(html).toContain("<code>a**b**c</code>");
    expect(html).not.toContain("<code>a<strong>");
  });

  it("keeps plain text layouts as written", () => {
    const html = htmlOf("Line one\nLine two\n\nSecond block", "plaintext");
    expect(html).toBe("<p>Line one<br>Line two</p><p>Second block</p>");
    // Plaintext performs no Markdown parsing at all.
    const literal = htmlOf("# not a heading\n\n- not a list", "plaintext");
    expect(literal).toBe("<p># not a heading</p><p>- not a list</p>");
  });
});

describe("bounded conversion", () => {
  it("normalizes CRLF/CR and a BOM without rewriting anything else", () => {
    expect(htmlOf("﻿a\r\nb\rc")).toBe("<p>a<br>b<br>c</p>");
  });

  it("refuses control characters and oversized input or output", () => {
    expect(buildInboxHtml("markdown", "bad\u0000null").ok).toBe(false);
    expect(buildInboxHtml("markdown", "bad\u000bb\u000cv\u001f")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_CONTENT"
    });
    const big = "a".repeat(INBOX_LIMITS.maxContentBytes + 1);
    expect(buildInboxHtml("markdown", big)).toMatchObject({
      ok: false,
      code: "CONTENT_TOO_LARGE"
    });
    // Escaping can expand: 1 MiB of `<` becomes ~4 MiB of HTML and is refused
    // by the derived-document bound rather than truncated.
    const expanding = "<".repeat(INBOX_LIMITS.maxContentBytes);
    expect(buildInboxHtml("markdown", expanding)).toMatchObject({
      ok: false,
      code: "CONTENT_TOO_LARGE"
    });
  });

  it("accepts a capture right at the 1 MiB text bound", () => {
    const body = "x".repeat(INBOX_LIMITS.maxContentBytes);
    const result = buildCaptureRequest(input({ content: body }));
    expect(result.ok).toBe(true);
  });
});

describe("payload + canonical hash", () => {
  it("builds exactly the documented request body", () => {
    const parsed = input({ title: "T", content: "# H", format: "markdown" });
    const { body, payloadHash } = buildCaptureRequest(parsed) as {
      body: string;
      payloadHash: string;
    };
    expect(JSON.parse(body)).toEqual({
      title: "T",
      type: "note",
      source: INBOX_SOURCE,
      version: 1,
      content: { type: "html", data: "<h1>H</h1>" }
    });
    expect(body.indexOf('"content"')).toBeGreaterThan(body.indexOf('"version"'));
    expect(payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omits content for an empty capture and never emits a note id", () => {
    const payload = buildInboxPayload(input({ title: "T", content: "" }), "");
    expect(Object.keys(payload)).toEqual(["title", "type", "source", "version"]);
    expect(JSON.stringify(payload)).not.toMatch(/noteId|nn:\/\//);
  });

  it("is stable for identical input and changes with title, content or format", () => {
    const base = input({ operationId: "op-1", title: "T", content: "body" });
    expect(capturePayloadHash(base)).toBe(capturePayloadHash({ ...base }));
    expect(capturePayloadHash(base)).not.toBe(
      capturePayloadHash({ ...base, title: "T2" })
    );
    expect(capturePayloadHash(base)).not.toBe(
      capturePayloadHash({ ...base, content: "other" })
    );
    expect(capturePayloadHash(base)).not.toBe(
      capturePayloadHash({ ...base, format: "plaintext" })
    );
    // The operation id is *not* part of the payload hash, so the same content
    // under a new id is a genuinely new capture.
    expect(capturePayloadHash(base)).toBe(
      capturePayloadHash({ ...base, operationId: "op-2" })
    );
    // An absent body and an empty body are the same capture.
    expect(capturePayloadHash(input({ content: undefined }))).toBe(
      capturePayloadHash(input({ content: "" }))
    );
  });
});

describe("converter is deterministic and bounded in shape", () => {
  it("emits only balanced, generated tags for arbitrary hostile input", () => {
    // `markdownToHtml`/`plaintextToHtml` consume *escaped* lines: escaping is
    // the only path into them, and the output carries no input markup.
    const html = markdownToHtml(
      escapeHtml("<b>x\n</p>\n[a](https://e.com)\n**y**").split("\n")
    );
    expect(textOnly(html)).not.toMatch(/[<>]/);
    expect(html).toContain("<p>");
    const plain = plaintextToHtml(escapeHtml("<b>x\n&y").split("\n"));
    expect(textOnly(plain)).not.toMatch(/[<>]/);
    // The escaped blockquote marker is a marker; a literal `&gt;` is not.
    const quoted = markdownToHtml(escapeHtml("> quoted").split("\n"));
    expect(quoted).toBe("<blockquote><p>quoted</p></blockquote>");
    const literal = markdownToHtml(escapeHtml("&gt; not a quote").split("\n"));
    expect(literal).toBe("<p>&amp;gt; not a quote</p>");
  });
});
