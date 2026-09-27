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
 * Dependency-free structural + WCAG contrast validator for the VeyraN themes.
 *
 * The repo's normal toolchain (tsc/jest/eslint) needs an installed monorepo.
 * This script runs on a bare Node so the palettes can always be checked:
 *
 *   node packages/theme/scripts/validate-veyran.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src", "theme-engine");

// Mirrors validator.ts -- kept in sync manually because this script must not
// depend on a build of the package.
const VARIANTS = [
  "primary",
  "secondary",
  "disabled",
  "selected",
  "error",
  "success"
];
const COLORS = [
  "accent",
  "paragraph",
  "background",
  "border",
  "heading",
  "icon",
  "separator",
  "placeholder",
  "hover",
  "accentForeground",
  "backdrop"
];
const ALPHA_COLORS = [
  "hover",
  "backdrop",
  "background",
  "placeholder",
  "textSelection",
  "shade"
];
const DEPRECATED_COLORS = ["shade", "textSelection"];
const HEX = /^#(?:[0-9a-fA-F]{3}){1,2}$/;
const HEX_ALPHA = /^#(?:(?:[\da-fA-F]{3}){1,2}|(?:[\da-fA-F]{4}){1,2})$/;
const ID = /^[a-z0-9_-]+$/;

/** Parse a #rgb/#rrggbb/#rgba/#rrggbbaa string into {r,g,b,a} 0-255 / 0-1. */
function parseHex(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

/** Accept either a hex string or an already-parsed {r,g,b,a} color. */
function toRGBA(color) {
  return typeof color === "string" ? parseHex(color) : color;
}

/** Composite a possibly-translucent color over an opaque backdrop. */
function over(fg, bg) {
  const f = toRGBA(fg);
  const b = toRGBA(bg);
  return {
    r: Math.round(f.r * f.a + b.r * (1 - f.a)),
    g: Math.round(f.g * f.a + b.g * (1 - f.a)),
    b: Math.round(f.b * f.a + b.b * (1 - f.a)),
    a: 1
  };
}

function relativeLuminance({ r, g, b }) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.1 contrast ratio. Translucent inputs are flattened onto `base`. */
export function contrast(fg, bg, base = bg) {
  const f = relativeLuminance(over(fg, over(bg, base)));
  const b = relativeLuminance(over(bg, base));
  const [hi, lo] = f > b ? [f, b] : [b, f];
  return (hi + 0.05) / (lo + 0.05);
}

function loadTheme(id) {
  return JSON.parse(readFileSync(path.join(SRC, "veyran", `${id}.json`), "utf8"));
}

const failures = [];
const notes = [];
function check(ok, label, detail) {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

function validateStructure(theme, expectScheme) {
  const t = `[${theme.id}] structure`;
  check(ID.test(theme.id || ""), `${t}: id matches ^[a-z0-9_-]+$`, theme.id);
  check(!!theme.name, `${t}: name present`);
  check(typeof theme.version === "number", `${t}: version is a number`);
  check(theme.compatibilityVersion === 1, `${t}: compatibilityVersion === 1`);
  check(!!theme.license, `${t}: license present`);
  check(!!theme.description, `${t}: description present`);
  check(!!theme.authors?.[0]?.name, `${t}: authors[0].name present`);
  check(theme.colorScheme === expectScheme, `${t}: colorScheme === ${expectScheme}`);
  check(typeof theme.codeBlockCSS === "string", `${t}: codeBlockCSS present`);

  // VeyraN has no owned, verified domain or support channel (see
  // docs/veyran-branding.md). The theme metadata below is shown directly in
  // theme pickers/details dialogs, so it must never claim Streetwriters'
  // own notesnook.com/support@streetwriters.co as VeyraN's, and must never
  // invent a homepage/support URL VeyraN doesn't actually have.
  check(
    !theme.homepage,
    `${t}: no homepage claimed (VeyraN has no owned, verified domain yet)`,
    theme.homepage
  );
  for (const author of theme.authors || []) {
    check(
      !/streetwriters/i.test(author.name || ""),
      `${t}: theme author isn't attributed to Streetwriters`,
      author.name
    );
    check(
      !author.email,
      `${t}: no invented support email in theme metadata`,
      author.email
    );
    check(
      !author.url,
      `${t}: no invented support URL in theme metadata`,
      author.url
    );
  }

  // base scope must be 100% specified -- it is the fallback for every scope.
  for (const v of VARIANTS)
    for (const c of COLORS)
      check(
        typeof theme.scopes?.base?.[v]?.[c] === "string",
        `${t}: scopes.base.${v}.${c} is required`
      );

  // every colour value in every scope must match the schema's hex patterns
  for (const [scopeName, scope] of Object.entries(theme.scopes || {}))
    for (const [variantName, variant] of Object.entries(scope || {}))
      for (const [colorName, value] of Object.entries(variant || {})) {
        const key = `scopes.${scopeName}.${variantName}.${colorName}`;
        check(
          COLORS.includes(colorName) || DEPRECATED_COLORS.includes(colorName),
          `${t}: unknown key ${key}`
        );
        const re = ALPHA_COLORS.includes(colorName) ? HEX_ALPHA : HEX;
        check(re.test(value), `${t}: ${key} invalid hex`, value);
      }
}

/**
 * Resolve a colour the way theme-engine/utils.ts buildVariants does, so the
 * contrast assertions below measure what the app actually renders.
 */
function resolve(theme, scope, variant, color) {
  return (
    theme.scopes[scope]?.[variant]?.[color] ??
    theme.scopes.base[variant]?.[color]
  );
}

const AA_TEXT = 4.5;
const AA_LARGE = 3.0;
const NON_TEXT = 3.0;
const SEPARATOR_MIN = 1.2;

function validateContrast(theme) {
  const t = `[${theme.id}] contrast`;
  const scopes = Object.keys(theme.scopes);

  for (const scope of scopes) {
    const bg = resolve(theme, scope, "primary", "background");
    const rootBg = theme.scopes.base.primary.background;

    // Body text and headings must clear AA for normal text.
    for (const [color, min] of [
      ["paragraph", AA_TEXT],
      ["heading", AA_TEXT],
      ["icon", NON_TEXT],
      ["placeholder", AA_LARGE],
      ["accent", NON_TEXT]
    ]) {
      const fg = resolve(theme, scope, "primary", color);
      const ratio = contrast(fg, bg, rootBg);
      notes.push(
        `${theme.id} ${scope}.primary.${color} on background: ${ratio.toFixed(2)}:1 (min ${min})`
      );
      check(
        ratio >= min,
        `${t}: ${scope}.primary.${color} on ${scope}.primary.background`,
        `${ratio.toFixed(2)}:1 < ${min}:1 (${fg} on ${bg})`
      );
    }

    // Text placed on the accent fill (buttons, chips, selected pills).
    const accent = resolve(theme, scope, "primary", "accent");
    const onAccent = resolve(theme, scope, "primary", "accentForeground");
    const accentRatio = contrast(onAccent, accent, rootBg);
    notes.push(
      `${theme.id} ${scope}.primary.accentForeground on accent: ${accentRatio.toFixed(2)}:1 (min ${AA_TEXT})`
    );
    check(
      accentRatio >= AA_TEXT,
      `${t}: ${scope}.primary.accentForeground on accent`,
      `${accentRatio.toFixed(2)}:1 < ${AA_TEXT}:1 (${onAccent} on ${accent})`
    );

    // Secondary surfaces still have to carry readable secondary text.
    const secBg = resolve(theme, scope, "secondary", "background");
    for (const color of ["paragraph", "heading"]) {
      const fg = resolve(theme, scope, "secondary", color);
      const ratio = contrast(fg, secBg, rootBg);
      notes.push(
        `${theme.id} ${scope}.secondary.${color} on secondary background: ${ratio.toFixed(2)}:1 (min ${AA_TEXT})`
      );
      check(
        ratio >= AA_TEXT,
        `${t}: ${scope}.secondary.${color} on ${scope}.secondary.background`,
        `${ratio.toFixed(2)}:1 < ${AA_TEXT}:1 (${fg} on ${secBg})`
      );
    }

    // A selected row must stay readable, and must be distinguishable from
    // the unselected surface it sits next to.
    const selBg = resolve(theme, scope, "selected", "background");
    const selFg = resolve(theme, scope, "selected", "paragraph");
    const selRatio = contrast(selFg, selBg, rootBg);
    notes.push(
      `${theme.id} ${scope}.selected.paragraph on selected background: ${selRatio.toFixed(2)}:1 (min ${AA_TEXT})`
    );
    check(
      selRatio >= AA_TEXT,
      `${t}: ${scope}.selected.paragraph on ${scope}.selected.background`,
      `${selRatio.toFixed(2)}:1 < ${AA_TEXT}:1`
    );
    const selDelta = contrast(selBg, bg, rootBg);
    notes.push(
      `${theme.id} ${scope} selected vs unselected surface: ${selDelta.toFixed(2)}:1 (min ${SEPARATOR_MIN})`
    );
    check(
      selDelta >= SEPARATOR_MIN,
      `${t}: ${scope} selected surface distinguishable from primary surface`,
      `${selDelta.toFixed(2)}:1 < ${SEPARATOR_MIN}:1`
    );

    // Hairlines must be visible without being loud.
    for (const color of ["border", "separator"]) {
      const fg = resolve(theme, scope, "primary", color);
      const ratio = contrast(fg, bg, rootBg);
      notes.push(
        `${theme.id} ${scope}.primary.${color} on background: ${ratio.toFixed(2)}:1 (min ${SEPARATOR_MIN})`
      );
      check(
        ratio >= SEPARATOR_MIN,
        `${t}: ${scope}.primary.${color} visible on ${scope}.primary.background`,
        `${ratio.toFixed(2)}:1 < ${SEPARATOR_MIN}:1`
      );
    }

    // error/success states are status colours: readable on their own surface.
    for (const variant of ["error", "success"]) {
      const vBg = resolve(theme, scope, variant, "background");
      const vFg = resolve(theme, scope, variant, "paragraph");
      const ratio = contrast(vFg, vBg, rootBg);
      notes.push(
        `${theme.id} ${scope}.${variant}.paragraph on ${variant} background: ${ratio.toFixed(2)}:1 (min ${AA_TEXT})`
      );
      check(
        ratio >= AA_TEXT,
        `${t}: ${scope}.${variant}.paragraph on ${scope}.${variant}.background`,
        `${ratio.toFixed(2)}:1 < ${AA_TEXT}:1 (${vFg} on ${vBg})`
      );
    }
  }
}

/** The accent must stay restrained: no neon, no fully saturated fills. */
function validateRestraint(theme) {
  const t = `[${theme.id}] restraint`;
  const accent = parseHex(theme.scopes.base.primary.accent);
  const max = Math.max(accent.r, accent.g, accent.b);
  const min = Math.min(accent.r, accent.g, accent.b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  notes.push(
    `${theme.id} accent HSV saturation: ${saturation.toFixed(3)} (max 0.75)`
  );
  check(
    saturation <= 0.75,
    `${t}: accent saturation is restrained`,
    `${saturation.toFixed(3)} > 0.75`
  );
}

const light = loadTheme("veyran-light");
const dark = loadTheme("veyran-dark");

validateStructure(light, "light");
validateStructure(dark, "dark");
validateContrast(light);
validateContrast(dark);
validateRestraint(light);
validateRestraint(dark);

check(light.id !== dark.id, "[veyran] light and dark ids differ");

if (process.argv.includes("--verbose")) notes.forEach((n) => console.log("  " + n));

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n`);
  failures.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log(
  `\n✓ VeyraN themes pass ${notes.length} contrast/restraint assertions and all structural checks.`
);
