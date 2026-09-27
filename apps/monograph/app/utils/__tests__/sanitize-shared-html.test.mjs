import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeSharedHtml } from "../sanitize-shared-html.ts";

test("removes scripts, event handlers, and dangerous links", () => {
  const html = sanitizeSharedHtml(
    '<p onclick="evil()">Safe <a href="javascript:evil()">link</a></p>' +
      '<img src="x" onerror="evil()"><script>evil()</script>'
  );
  assert.match(html, /Safe/);
  assert.match(html, /link/);
  assert.doesNotMatch(html, /onclick|onerror|javascript:|<script|evil\(\)/i);
});

test("removes active SVG, MathML, iframe srcdoc, and forms", () => {
  const html = sanitizeSharedHtml(
    '<svg onload="evil()"><script>evil()</script></svg>' +
      '<math><annotation-xml encoding="text/html"><img src=x onerror=evil()></annotation-xml></math>' +
      '<iframe srcdoc="<script>evil()</script>" src="https://example.com"></iframe>' +
      '<form action="https://example.com"><input name="secret"></form><p>Retained</p>' +
      '<xmp><img src=x onerror=evil()></xmp><plaintext>evil()</plaintext>'
  );
  assert.match(html, /Retained/);
  assert.doesNotMatch(html, /<svg|<math|annotation-xml|<iframe|srcdoc|<form|<input|evil\(\)/i);
});

test("keeps ordinary note formatting and safe links", () => {
  const html = sanitizeSharedHtml(
    '<h2>Heading</h2><p class="callout" style="color:#123456;text-align:center">' +
      '<strong>Bold</strong> <em>italic</em> ' +
      '<a href="https://example.com/path" target="_blank" rel="opener">link</a></p>' +
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">Done</li></ul>' +
      '<table><tbody><tr><td colspan="2">Cell</td></tr></tbody></table>'
  );
  for (const expected of ["<h2>Heading</h2>", "<strong>Bold</strong>", "<em>italic</em>", "https://example.com/path", "data-checked=", "<table>", "Cell", "color:#123456"]) {
    assert.ok(html.includes(expected), `${expected} missing from ${html}`);
  }
  assert.match(html, /rel="noopener noreferrer"/);
});

test("keeps safe images but strips active and insecure sources", () => {
  const html = sanitizeSharedHtml(
    '<img src="https://example.com/image.png" data-hash="abc" alt="Photo">' +
      '<img src="data:image/png;base64,AA==">' +
      '<img src="data:image/svg+xml;base64,AA==">' +
      '<img src="http://example.com/insecure.png">' +
      '<img src="//example.com/protocol-relative.png">'
  );
  assert.match(html, /src="https:\/\/example.com\/image.png"/);
  assert.match(html, /data:image\/png;base64,AA==/);
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(html, /image\/svg\+xml|insecure\.png|protocol-relative\.png/);
});

test("rejects CSS URLs, malformed nesting, and non-string payloads", () => {
  const html = sanitizeSharedHtml(
    '<div style="background-image:url(https://evil.example/t);color:#112233"><p>Text' +
      '<svg><p onmouseover="evil()">nested</p></svg></div>'
  );
  assert.match(html, /Text/);
  assert.doesNotMatch(html, /background-image|evil\.example|onmouseover|evil\(\)|<svg/i);
  assert.equal(sanitizeSharedHtml({ data: "<script>evil()</script>" }), "<p></p>");
});
