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
 * Handwriting metadata: everything about a drawing that PKDrawing does not
 * store (page background, paper template, page width). It is saved as
 *
 *   handwriting-<UUID>.json   application/json   (hidden, PNG -> JSON relation)
 *
 * The page background (optional) and the paper template are NOT part of the
 * PKDrawing strokes. They are rendered underneath the strokes (background
 * colour -> paper -> strokes) both in the editor and in the exported PNG. A
 * NEW drawing has a transparent background (`{ "type": "none" }`), so its PNG
 * has an alpha channel and looks like typed text in the note.
 *
 * Reading is lenient (a broken file never blocks editing), writing is strict
 * and deterministic (same input => same bytes => same attachment hash).
 *
 * The native module (HandwritingMetadata.swift) implements the same schema and
 * the same spacing presets. Keep both in sync.
 *
 * Do not import React Native here so this stays unit-testable.
 */

export const METADATA_VERSION = 1;

export type PaperType = "blank" | "lined" | "grid" | "dotted";
export type PaperSpacing = "small" | "medium" | "large";

export const PAPER_TYPES: readonly PaperType[] = [
  "blank",
  "lined",
  "grid",
  "dotted"
];
export const PAPER_SPACINGS: readonly PaperSpacing[] = [
  "small",
  "medium",
  "large"
];

/** Spacing presets in points (the canvas coordinate space, PNG = 2x). */
export const SPACING_POINTS: Record<
  Exclude<PaperType, "blank">,
  Record<PaperSpacing, number>
> = {
  lined: { small: 24, medium: 32, large: 44 },
  grid: { small: 16, medium: 24, large: 36 },
  dotted: { small: 16, medium: 24, large: 36 }
};

/**
 * Historical background colours. The background is no longer selectable (new
 * drawings are transparent), but OLD drawings keep the exact colour they were
 * created with, so these values are still read and rendered unchanged.
 */
export const BACKGROUND_PRESETS = {
  white: "#FFFFFF",
  paper: "#FBF3DD",
  lightGray: "#E9E9EC",
  darkGray: "#2C2C2E",
  black: "#000000"
} as const;

export type HandwritingMetadata = {
  version: number;
  /**
   * `{ type: "none" }` = transparent page (new drawings). `{ type: "color" }`
   * = an opaque page from an old drawing; kept working without migration.
   */
  background: { type: "none" } | { type: "color"; color: string };
  paper: {
    type: PaperType;
    spacing: PaperSpacing;
    /** Exact spacing in points; wins over the preset when present. */
    spacingPt?: number;
    /** Optional overrides. Derived from the background when absent. */
    color?: string;
    opacity?: number;
  };
  canvas?: {
    /** Page width in points. The PNG is `width * 2` pixels wide. */
    width: number;
  };
};

export type ParsedMetadata = {
  metadata: HandwritingMetadata;
  /** "file": read from a metadata file, "default": there was nothing usable. */
  source: "file" | "default";
  /** Problems that were repaired with defaults. Empty for a clean file. */
  issues: string[];
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const MIN_SPACING = 8;
const MAX_SPACING = 128;
const MIN_WIDTH = 64;
const MAX_WIDTH = 8192;

/**
 * Drawings created before metadata existed (Build 1/2) were rendered on
 * white without any paper. They open with exactly that.
 */
export function legacyMetadata(): HandwritingMetadata {
  return {
    version: METADATA_VERSION,
    background: { type: "color", color: BACKGROUND_PRESETS.white },
    paper: { type: "blank", spacing: "medium" }
  };
}

/**
 * Metadata for a NEW drawing: transparent background, blank paper, medium
 * spacing. The exported PNG therefore has an alpha channel, so it looks like
 * typed text on any note background.
 */
export function defaultMetadata(): HandwritingMetadata {
  return {
    version: METADATA_VERSION,
    background: { type: "none" },
    paper: { type: "blank", spacing: "medium" }
  };
}

export function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== "string" || !HEX.test(value)) return;
  let hex = value.slice(1).toUpperCase();
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  return `#${hex}`;
}

function finiteInRange(value: unknown, min: number, max: number) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the content of a metadata file. Never throws.
 *
 * - missing / empty / not JSON / not an object / no valid version
 *     -> legacy defaults (white, blank)
 * - newer version than supported -> known fields are read on a best-effort
 *     basis (the next save writes the current version)
 * - single invalid fields are replaced by their defaults
 */
export function parseMetadata(
  input: string | object | null | undefined
): ParsedMetadata {
  const fallback = (issue?: string): ParsedMetadata => ({
    metadata: legacyMetadata(),
    source: "default",
    issues: issue ? [issue] : []
  });

  if (input === undefined || input === null || input === "") return fallback();

  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      return fallback("not valid JSON");
    }
  }
  if (!isObject(raw)) return fallback("not an object");

  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
    return fallback("missing or invalid version");

  const issues: string[] = [];
  if (version > METADATA_VERSION) issues.push(`newer version ${version}`);
  const base = legacyMetadata();

  const bg = isObject(raw.background) ? raw.background : undefined;
  let background: HandwritingMetadata["background"];
  if (bg?.type === "none") {
    // transparent page (new drawings)
    background = { type: "none" };
  } else {
    let color = normalizeColor(bg?.color);
    if (!color) {
      if (bg !== undefined) issues.push("invalid background");
      color = BACKGROUND_PRESETS.white;
    }
    background = { type: "color", color };
  }

  const p = isObject(raw.paper) ? raw.paper : undefined;
  let type = base.paper.type;
  if (PAPER_TYPES.includes(p?.type as PaperType)) type = p!.type as PaperType;
  else if (p !== undefined) issues.push("invalid paper type");
  let spacing = base.paper.spacing;
  if (PAPER_SPACINGS.includes(p?.spacing as PaperSpacing))
    spacing = p!.spacing as PaperSpacing;
  else if (p !== undefined) issues.push("invalid paper spacing");

  const paper: HandwritingMetadata["paper"] = { type, spacing };
  const spacingPt = finiteInRange(p?.spacingPt, MIN_SPACING, MAX_SPACING);
  if (spacingPt !== undefined) paper.spacingPt = spacingPt;
  else if (p?.spacingPt !== undefined) issues.push("invalid spacingPt");
  const lineColor = normalizeColor(p?.color);
  if (lineColor) paper.color = lineColor;
  else if (p?.color !== undefined) issues.push("invalid paper color");
  const opacity = finiteInRange(p?.opacity, 0, 1);
  if (opacity !== undefined) paper.opacity = opacity;
  else if (p?.opacity !== undefined) issues.push("invalid paper opacity");

  const metadata: HandwritingMetadata = {
    version: METADATA_VERSION,
    background,
    paper
  };
  const c = isObject(raw.canvas) ? raw.canvas : undefined;
  const width = finiteInRange(c?.width, MIN_WIDTH, MAX_WIDTH);
  if (width !== undefined) metadata.canvas = { width };
  else if (c?.width !== undefined) issues.push("invalid canvas width");

  return { metadata, source: "file", issues };
}

/** Effective line/grid/dot distance in points, 0 for blank paper. */
export function getPaperSpacing(paper: HandwritingMetadata["paper"]): number {
  if (paper.type === "blank") return 0;
  return paper.spacingPt ?? SPACING_POINTS[paper.type][paper.spacing];
}

/**
 * Deterministic JSON (fixed key order, no undefined values). Identical
 * metadata always produces identical bytes and therefore the same attachment
 * hash, so unchanged metadata is de-duplicated by the attachment layer.
 */
export function serializeMetadata(metadata: HandwritingMetadata): string {
  const { background, paper, canvas } = metadata;
  const out: Record<string, unknown> = {
    version: METADATA_VERSION,
    background:
      background.type === "none"
        ? { type: "none" }
        : { type: "color", color: background.color },
    paper: {
      type: paper.type,
      spacing: paper.spacing,
      ...(paper.spacingPt !== undefined ? { spacingPt: paper.spacingPt } : {}),
      ...(paper.color !== undefined ? { color: paper.color } : {}),
      ...(paper.opacity !== undefined ? { opacity: paper.opacity } : {})
    }
  };
  if (canvas) out.canvas = { width: canvas.width };
  return JSON.stringify(out);
}
