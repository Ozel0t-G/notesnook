import sanitizeHtml from "sanitize-html";

// Public shares contain author-controlled HTML, including after a password or
// URL-key unlock. Keep this policy at the viewer boundary so the server-rendered
// fallback and the read-only editor receive exactly the same safe fragment.
const allowedTags = [
  "p", "br", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "del", "mark", "sub", "sup",
  "blockquote", "pre", "code", "ul", "ol", "li", "hr", "a", "img",
  "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr",
  "th", "td"
];

// Active embeds (iframe, audio, video) are deliberately omitted from public
// shares. They remain intact in the owner's encrypted note; the viewer does
// not execute or load them until a separately reviewed embed policy exists.

const editorDataAttributes = [
  "data-type", "data-checked", "data-hash", "data-filename", "data-mime",
  "data-size", "data-align", "data-aspect-ratio", "data-color"
];

const safeColor = [
  /^#[0-9a-f]{3,8}$/i,
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i
];

function safeImageSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  if (/^\/(?!\/)[^\s\\]*$/.test(source)) return source;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(source))
    return source;
  try {
    const url = new URL(source);
    if (url.protocol === "https:") return source;
  } catch {
    // A malformed or relative external URL must not reach the document.
  }
  return undefined;
}

export function sanitizeSharedHtml(value: unknown): string {
  if (typeof value !== "string") return "<p></p>";

  return sanitizeHtml(value, {
    allowedTags,
    allowedAttributes: {
      "*": ["class", "dir", "lang", "title", "style", ...editorDataAttributes],
      a: ["href", "target", "rel", "title"],
      img: ["src", "alt", "title", "width", "height", "referrerpolicy", ...editorDataAttributes],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"]
    },
    allowedStyles: {
      "*": {
        color: safeColor,
        "background-color": safeColor,
        "text-align": [/^(?:left|right|center|justify)$/i]
      }
    },
    allowedSchemes: ["https", "http", "mailto"],
    allowedSchemesByTag: { img: ["https", "data"] },
    allowProtocolRelative: false,
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "svg", "math", "iframe", "object", "embed", "form", "xmp", "plaintext"],
    transformTags: {
      a: (_tag, attributes) => ({
        tagName: "a",
        attribs: { ...attributes, rel: "noopener noreferrer" }
      }),
      img: (_tag, attributes) => {
        const source = safeImageSource(attributes.src);
        const { src: _discardedSource, ...otherAttributes } = attributes;
        return {
          tagName: "img",
          attribs: {
            ...otherAttributes,
            ...(source ? { src: source } : {}),
            referrerpolicy: "no-referrer"
          }
        };
      }
    }
  });
}
