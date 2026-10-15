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
 * Runtime load-safety suite. Runs under
 * `__tests__/connect/vitest.load-safety.config.ts` in a process with **no DOM
 * and no database** (no `setupFiles`), so the assertions below are meaningful:
 * the shared connect suite always installs `linkedom`, which would mask them.
 */
import { describe, it, expect, afterAll, vi } from "vitest";

const globalScope = globalThis as unknown as Record<string, unknown>;

function uninstallDOM(): void {
  delete globalScope.DOMParser;
}

function installThrowingDOMParserGetter(): void {
  Object.defineProperty(globalThis, "DOMParser", {
    configurable: true,
    get() {
      throw new Error(
        "DOMParser must not be touched while importing pure Connect modules"
      );
    }
  });
}

afterAll(() => {
  uninstallDOM();
});

describe("VeyraN Connect runtime load safety", () => {
  it("imports the pure protocol/schema with no DOM and performs zero DOM touch", async () => {
    uninstallDOM();
    expect("DOMParser" in globalThis).toBe(false);
    // A getter that throws makes any eager DOM access during import fail loudly.
    installThrowingDOMParserGetter();
    vi.resetModules();

    const protocol = await import("../../src/connect/protocol.js");
    const limits = await import("../../src/connect/limits.js");
    const errors = await import("../../src/connect/errors.js");

    expect(protocol.CONNECT_OPERATION_NAMES).toHaveLength(12);
    expect(limits.CONTENT_LIMITS.maxContentChars).toBe(100_000);
    expect(errors.CONNECT_ERROR_CODES.length).toBeGreaterThan(0);
    // Pure modules must not pull the adapter/DB.
    expect("ConnectAdapter" in protocol).toBe(false);
    uninstallDOM();
  });

  it("imports content without DOM and fails closed instead of throwing a raw TypeError", async () => {
    uninstallDOM();
    expect("DOMParser" in globalThis).toBe(false);
    vi.resetModules();

    // Importing must not throw even though no DOM exists yet.
    const content = await import("../../src/connect/content.js");
    const limits = await import("../../src/connect/limits.js");
    // The limits are the *same* binding, re-exported (no drifting copy).
    expect(content.CONTENT_LIMITS).toBe(limits.CONTENT_LIMITS);

    let code: string | undefined;
    try {
      content.toTiptapHtml("markdown", "# hi");
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("UNSUPPORTED_CONTENT");
  });

  it("converts markdown/unicode/lists/links and sanitizes scripts after installing the real mobile worker DOM", async () => {
    vi.resetModules();
    // The actual mobile DOM implementation, not a jsdom/linkedom replacement.
    const worker = await import("../../../../apps/mobile/worker.js");
    globalScope.DOMParser = worker.DOMParser;

    const content = await import("../../src/connect/content.js");
    const html = content.toTiptapHtml(
      "markdown",
      [
        "# Heading",
        "",
        "- a",
        "- b",
        "",
        "**bold** ünïcode",
        "",
        "[link](https://example.com)",
        "",
        '<script>bad()</script><p onclick="x()">event</p>'
      ].join("\n")
    );

    expect(html).toContain("<h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("ünïcode");
    expect(html).toContain('href="https://example.com"');
    // Sanitization still applies with the worker DOM.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");

    // Tiptap passthrough keeps the app's own nn:// note links.
    expect(
      content.toTiptapHtml("tiptap", '<p><a href="nn://note/abc">l</a></p>')
    ).toContain("nn://note/abc");
  });
});
