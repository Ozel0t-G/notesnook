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

import "@tiptap/extension-text-style";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { colord } from "colord";
import { config } from "../../utils/config.js";
import { tiptapKeys } from "@notesnook/common";
import {
  editorHighlight,
  editorHighlightForeground
} from "./editor-highlight-tokens.js";

export interface HighlightOptions {
  types: string[];
  HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    highlight: {
      /**
       * Set a highlight mark
       */
      setHighlight: (backgroundColor: string) => ReturnType;
      /**
       * Toggle a highlight mark
       */
      toggleHighlight: (backgroundColor: string) => ReturnType;
      /**
       * Unset a highlight mark
       */
      unsetHighlight: () => ReturnType;
    };
  }
}

export const Highlight = Extension.create<HighlightOptions>({
  name: "highlight",

  addOptions() {
    return {
      types: ["textStyle"],
      HTMLAttributes: {}
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          backgroundColor: {
            default: null,
            parseHTML: (element) =>
              element.style.backgroundColor?.replace(/['"]+/g, ""),
            renderHTML: (attributes) => {
              if (!attributes.backgroundColor) {
                return {};
              }

              return {
                style: `background-color: ${attributes.backgroundColor}`
              };
            }
          }
        }
      }
    ];
  },

  addCommands() {
    return {
      setHighlight:
        (backgroundColor) =>
        ({ commands }) => {
          return commands.setMark("textStyle", { backgroundColor });
        },
      toggleHighlight:
        (backgroundColor) =>
        ({ commands }) => {
          return commands.toggleMark("textStyle", { backgroundColor });
        },
      unsetHighlight:
        () =>
        ({ chain }) => {
          return chain()
            .setMark("textStyle", { backgroundColor: null })
            .removeEmptyTextStyle()
            .run();
        }
    };
  },

  addKeyboardShortcuts() {
    return {
      [tiptapKeys.toggleHighlight.keys]: () =>
        this.editor.commands.toggleHighlight(getCurrentHighlightColor())
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: highlightContrastPluginKey,
        state: {
          init(_, { doc }) {
            return buildHighlightContrastDecorations(doc);
          },
          apply(tr, previous) {
            if (!tr.docChanged) return previous;
            return buildHighlightContrastDecorations(tr.doc);
          }
        },
        props: {
          decorations(state) {
            return highlightContrastPluginKey.getState(state);
          }
        }
      })
    ];
  }
});

export const highlightContrastPluginKey = new PluginKey<DecorationSet>(
  "highlightContrastMarker"
);

const WARM_HIGHLIGHT_HEX = editorHighlight.toLowerCase();
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_FUNCTION = /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i;

/**
 * Only an ordinary opaque #RGB/#RRGGBB hex or rgb() literal that resolves to
 * the exact warm marker color counts; rgba()/8-digit hex/named colors/any
 * other color (near-misses included) are rejected.
 */
function isWarmHighlightBackground(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!HEX_COLOR.test(trimmed) && !RGB_FUNCTION.test(trimmed)) return false;
  const parsed = colord(trimmed);
  if (!parsed.isValid() || parsed.alpha() !== 1) return false;
  return parsed.toHex().toLowerCase() === WARM_HIGHLIGHT_HEX;
}

function buildHighlightContrastDecorations(
  doc: ProsemirrorNode
): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "textStyle");
    if (!mark || mark.attrs.color) return;
    if (!isWarmHighlightBackground(mark.attrs.backgroundColor)) return;
    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        style: `color: ${editorHighlightForeground}`
      })
    );
  });
  return DecorationSet.create(doc, decorations);
}

function getCurrentHighlightColor() {
  return config.get<"string">("highlight") || "yellow";
}
