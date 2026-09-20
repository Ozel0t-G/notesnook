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

import {
  BACKGROUND_PRESETS,
  defaultMetadata,
  getPaperSpacing,
  HandwritingMetadata,
  legacyMetadata,
  METADATA_VERSION,
  normalizeColor,
  parseMetadata,
  serializeMetadata,
  SPACING_POINTS
} from "./metadata";

const full: HandwritingMetadata = {
  version: 1,
  background: { type: "color", color: "#000000" },
  paper: { type: "grid", spacing: "large", spacingPt: 36 },
  canvas: { width: 1366 }
};

describe("serialize / deserialize", () => {
  test("round trip keeps every field", () => {
    const parsed = parseMetadata(serializeMetadata(full));
    expect(parsed.source).toBe("file");
    expect(parsed.issues).toEqual([]);
    expect(parsed.metadata).toEqual(full);
  });

  test("the documented example parses", () => {
    const parsed = parseMetadata(
      JSON.stringify({
        version: 1,
        background: { type: "color", color: "#FFFFFF" },
        paper: { type: "lined", spacing: "medium" }
      })
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.metadata.paper).toEqual({ type: "lined", spacing: "medium" });
    expect(parsed.metadata.background.color).toBe("#FFFFFF");
  });

  test("serialization is deterministic (same bytes => same attachment hash)", () => {
    const a = serializeMetadata(full);
    const b = serializeMetadata(parseMetadata(a).metadata);
    expect(a).toBe(b);
    // key order does not depend on the order of the input object
    const shuffled = {
      canvas: full.canvas,
      paper: { spacingPt: 36, spacing: "large", type: "grid" },
      background: { color: "#000000", type: "color" },
      version: 1
    } as unknown as HandwritingMetadata;
    expect(serializeMetadata(shuffled)).toBe(a);
  });

  test("undefined optional values are not written", () => {
    const json = JSON.parse(serializeMetadata(legacyMetadata()));
    expect(json).toEqual({
      version: 1,
      background: { type: "color", color: "#FFFFFF" },
      paper: { type: "blank", spacing: "medium" }
    });
  });

  test("optional template overrides survive", () => {
    const m: HandwritingMetadata = {
      ...full,
      paper: { ...full.paper, color: "#112233", opacity: 0.4 }
    };
    expect(parseMetadata(serializeMetadata(m)).metadata).toEqual(m);
  });
});

describe("missing metadata (drawings from Build 1/2)", () => {
  test.each([undefined, null, ""])(
    "%p falls back to white + blank",
    (input) => {
      const parsed = parseMetadata(input as any);
      expect(parsed.source).toBe("default");
      expect(parsed.issues).toEqual([]);
      expect(parsed.metadata).toEqual(legacyMetadata());
      expect(parsed.metadata.background.color).toBe("#FFFFFF");
      expect(parsed.metadata.paper.type).toBe("blank");
    }
  );
});

describe("invalid metadata", () => {
  test.each([
    ["not json", "{oops"],
    ["array", "[]"],
    ["number", "42"],
    ["null", "null"],
    ["no version", JSON.stringify({ background: { color: "#000000" } })],
    ["string version", JSON.stringify({ version: "1" })],
    ["zero version", JSON.stringify({ version: 0 })],
    ["fractional version", JSON.stringify({ version: 1.5 })]
  ])("%s -> legacy defaults, never throws", (_name, input) => {
    const parsed = parseMetadata(input);
    expect(parsed.source).toBe("default");
    expect(parsed.metadata).toEqual(legacyMetadata());
  });

  test("single broken fields are repaired, the rest is kept", () => {
    const parsed = parseMetadata(
      JSON.stringify({
        version: 1,
        background: { type: "color", color: "red" },
        paper: { type: "hexagons", spacing: "huge", spacingPt: -3 },
        canvas: { width: "wide" }
      })
    );
    expect(parsed.source).toBe("file");
    expect(parsed.issues.length).toBeGreaterThan(0);
    expect(parsed.metadata.background.color).toBe("#FFFFFF");
    expect(parsed.metadata.paper).toEqual({ type: "blank", spacing: "medium" });
    expect(parsed.metadata.canvas).toBeUndefined();
  });

  test("valid fields next to invalid ones are kept", () => {
    const parsed = parseMetadata({
      version: 1,
      background: { type: "color", color: "#101010" },
      paper: { type: "dotted", spacing: "nope" }
    });
    expect(parsed.metadata.background.color).toBe("#101010");
    expect(parsed.metadata.paper.type).toBe("dotted");
    expect(parsed.metadata.paper.spacing).toBe("medium");
  });

  test.each([NaN, Infinity, 0, 7, 129, 1e9])(
    "unusable spacingPt %p is dropped",
    (spacingPt) => {
      const parsed = parseMetadata({
        version: 1,
        background: { type: "color", color: "#FFFFFF" },
        paper: { type: "lined", spacing: "small", spacingPt }
      });
      expect(parsed.metadata.paper.spacingPt).toBeUndefined();
      expect(getPaperSpacing(parsed.metadata.paper)).toBe(
        SPACING_POINTS.lined.small
      );
    }
  );
});

describe("version handling", () => {
  test("current version is written", () => {
    expect(METADATA_VERSION).toBe(1);
    expect(JSON.parse(serializeMetadata(full)).version).toBe(1);
  });

  test("a newer version is read best-effort and flagged", () => {
    const parsed = parseMetadata({
      version: 7,
      background: { type: "color", color: "#2C2C2E" },
      paper: { type: "lined", spacing: "small" },
      somethingNew: { a: 1 }
    });
    expect(parsed.source).toBe("file");
    expect(parsed.issues).toEqual(["newer version 7"]);
    expect(parsed.metadata.background.color).toBe("#2C2C2E");
    expect(parsed.metadata.paper.type).toBe("lined");
    // saving again writes the version this build understands
    expect(parsed.metadata.version).toBe(1);
  });
});

describe("background", () => {
  test("white (default in light mode)", () => {
    expect(defaultMetadata("light").background.color).toBe("#FFFFFF");
  });

  test("dark (default in dark mode) is a dark gray preset", () => {
    const color = defaultMetadata("dark").background.color;
    expect(color).toBe(BACKGROUND_PRESETS.darkGray);
    expect(color).toBe("#2C2C2E");
  });

  test("defaults for new drawings start on blank paper", () => {
    expect(defaultMetadata("dark").paper.type).toBe("blank");
    expect(defaultMetadata("light").paper.type).toBe("blank");
  });

  test("custom colors are normalized (#RGB, lower case)", () => {
    expect(normalizeColor("#abc")).toBe("#AABBCC");
    expect(normalizeColor("#ff8800")).toBe("#FF8800");
    for (const bad of ["ff8800", "#ff88", "#gg0000", "rgb(0,0,0)", 5, null])
      expect(normalizeColor(bad)).toBeUndefined();
    const parsed = parseMetadata({
      version: 1,
      background: { type: "color", color: "#f80" },
      paper: { type: "blank", spacing: "medium" }
    });
    expect(parsed.metadata.background.color).toBe("#FF8800");
  });

  test("all presets are valid colors", () => {
    for (const color of Object.values(BACKGROUND_PRESETS))
      expect(normalizeColor(color)).toBe(color);
  });
});

describe("paper and spacing", () => {
  test.each(["blank", "lined", "grid", "dotted"] as const)(
    "paper type %s survives a round trip",
    (type) => {
      const m: HandwritingMetadata = {
        ...full,
        paper: { type, spacing: "small" }
      };
      expect(parseMetadata(serializeMetadata(m)).metadata.paper.type).toBe(
        type
      );
    }
  );

  test("blank paper has no spacing", () => {
    expect(getPaperSpacing({ type: "blank", spacing: "large" })).toBe(0);
  });

  test.each(["lined", "grid", "dotted"] as const)(
    "%s: small < medium < large",
    (type) => {
      const [s, m, l] = (["small", "medium", "large"] as const).map((spacing) =>
        getPaperSpacing({ type, spacing })
      );
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(m);
      expect(m).toBeLessThan(l);
    }
  );

  test("preset table (shared with the native module)", () => {
    expect(SPACING_POINTS).toEqual({
      lined: { small: 24, medium: 32, large: 44 },
      grid: { small: 16, medium: 24, large: 36 },
      dotted: { small: 16, medium: 24, large: 36 }
    });
  });

  test("an exact spacing wins over the preset", () => {
    expect(
      getPaperSpacing({ type: "lined", spacing: "small", spacingPt: 30 })
    ).toBe(30);
  });
});
