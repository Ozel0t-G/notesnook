import { describe, expect, it } from "vitest";
import { isExternalUrlAllowed } from "./external-url";

describe("external URL schemes", () => {
  it("keeps web, email, and existing app links", () => {
    for (const url of [
      "https://veyran.northcore.space/",
      "http://example.com/",
      "mailto:qa@example.com",
      "nn://note/123",
      "veyran://tasks"
    ]) {
      expect(isExternalUrlAllowed(url)).toBe(true);
    }
  });

  it("blocks local files, script URLs, and unknown OS handlers", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hello",
      "custom-handler://run",
      "not a URL"
    ]) {
      expect(isExternalUrlAllowed(url)).toBe(false);
    }
  });
});
