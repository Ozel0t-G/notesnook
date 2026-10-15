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

import { getMarkRange } from "@tiptap/core";
import type { Selection } from "@tiptap/pm/state";
import type {
  Attrs,
  MarkType,
  Node as ProsemirrorNode,
  ResolvedPos
} from "prosemirror-model";
import {
  Link as LinkNode,
  LinkAttributes
} from "../../extensions/link/index.js";
import { Editor } from "../../types.js";

export type InsertInternalLinkOptions = {
  /**
   * Existing link attributes handed to the host's picker. Used when editing an
   * already existing internal link so the host can prefill/keep them.
   */
  attributes?: LinkAttributes;
  /**
   * Range the link must be applied to. Defaults to the current selection.
   * When provided, the previously existing selection is restored afterwards.
   */
  range?: { from: number; to: number };
};

type SelectionBookmark = ReturnType<Selection["getBookmark"]>;

/**
 * Commits `bookmark` as the editor selection in its own transaction, keeping
 * the selection *type* the bookmark was created from (a `NodeSelection` stays a
 * `NodeSelection`). `setLink` reads the committed `editor.state.selection`, so
 * this must happen before it runs instead of being queued in the same chain.
 */
function commitSelection(editor: Editor, bookmark: SelectionBookmark): boolean {
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setSelection(bookmark.resolve(tr.doc));
      return true;
    })
    .run();
}

/** An exact link-mark run: `[from, to)` in absolute document positions. */
type LinkRun = { from: number; to: number };

/**
 * The pinned tiptap `getMarkRange` takes an optional mark attributes filter as
 * its third argument (the same one `unsetMark` passes). Typing the reference
 * explicitly keeps this call independent of the published signature while
 * still handing the helper the *full* attributes of the mark the probe points
 * at, so the returned run can never widen across an adjacent mark of the same
 * type whose attributes differ (e.g. the same `href` with another `title`).
 */
const markRangeAt = getMarkRange as (
  $pos: ResolvedPos,
  type: MarkType,
  attributes?: Attrs
) => { from: number; to: number } | undefined;

/** Every attribute the caller asked for must be on the mark, exactly. */
function matchesRequestedAttributes(
  attrs: Attrs,
  requested?: LinkAttributes
): boolean {
  // No link context (`href`) at all: nothing can be narrowed to, never resolve.
  if (!requested?.href) return false;
  for (const key of Object.keys(requested)) {
    const value = (requested as Record<string, unknown>)[key];
    // `undefined` means "not part of the request" (a partial attributes view).
    if (value !== undefined && attrs[key] !== value) return false;
  }
  return true;
}

/** A text child of the resolved textblock and where it starts inside it. */
type TextChild = { node: ProsemirrorNode; offset: number };

/**
 * The text children directly around `$pos.parentOffset`: at an exact child
 * boundary that is *both* the child before and the child after it, inside a
 * text node it is just the node the position points into.
 *
 * Both neighbours are required because the pinned `getMarkRange` resolves the
 * *previous* child at an exact child boundary: a lookup that only ever looked
 * at the child after the probe used to miss a link that merely *starts* there
 * (the right side of a shared boundary — a single-character link) and hid the
 * second of two adjacent links, collapsing an ambiguous boundary to one side.
 */
function adjacentTextChildren($pos: ResolvedPos): TextChild[] {
  const children: TextChild[] = [];
  for (const found of [
    $pos.parent.childBefore($pos.parentOffset),
    $pos.parent.childAfter($pos.parentOffset)
  ]) {
    if (!found.node?.isText) continue;
    if (children.some((child) => child.node === found.node)) continue;
    children.push({ node: found.node, offset: found.offset });
  }
  return children;
}

/** Distinct runs by their `from:to` key (two candidates of one run are one). */
function dedupeRuns(runs: LinkRun[]): LinkRun[] {
  const byKey = new Map<string, LinkRun>();
  for (const run of runs) byKey.set(`${run.from}:${run.to}`, run);
  return [...byKey.values()];
}

/**
 * Every link run with the requested attributes that touches the probe `pos`.
 *
 * Only the text children immediately around the probe are inspected — no
 * whole-block scan, no nearest-match guessing. Each candidate is resolved with
 * the existing `getMarkRange` called from a position that is *inside that
 * actual child*: for a single-character child that is its inclusive end, which
 * `getMarkRange` resolves back to the child itself. The child's own *full*
 * attributes bound the run so it can never widen into an adjacent same-type
 * mark (e.g. the same `href` under another `title`).
 */
function linkRunsAt(
  doc: ProsemirrorNode,
  pos: number,
  linkType: MarkType,
  requested?: LinkAttributes
): LinkRun[] {
  if (pos < 0 || pos > doc.content.size) return [];
  const $pos = doc.resolve(pos);
  // Block nodes (e.g. a selected image) are never linkable inline content.
  if (!$pos.parent.inlineContent) return [];

  const runs: LinkRun[] = [];
  for (const child of adjacentTextChildren($pos)) {
    const mark = child.node.marks.find(
      (candidate) => candidate.type === linkType
    );
    // A neighbouring *other* link (a shared boundary, an adjacent mark of the
    // same type with different attributes) is never a hit.
    if (!mark || !matchesRequestedAttributes(mark.attrs, requested)) continue;

    const childStart = $pos.start() + child.offset;
    const probe = childStart + 1;
    const range = markRangeAt(doc.resolve(probe), linkType, mark.attrs);
    if (!range || range.from < 0 || range.to > doc.content.size) continue;
    // The resolved run must actually cover the child it was probed from; a
    // neighbour's run never does, and must not be attributed to this candidate.
    if (range.from > childStart || range.to < childStart + child.node.nodeSize)
      continue;
    // Keep only a run that actually touches the probe position.
    if (range.from > pos || range.to < pos) continue;
    runs.push({ from: range.from, to: range.to });
  }
  return runs;
}

/** The exactly-one link run touching `pos`, or `undefined` when ambiguous. */
function singleLinkRunAt(
  doc: ProsemirrorNode,
  pos: number,
  linkType: MarkType,
  requested?: LinkAttributes
): LinkRun | undefined {
  const runs = dedupeRuns(linkRunsAt(doc, pos, linkType, requested));
  return runs.length === 1 ? runs[0] : undefined;
}

/**
 * Whether the character at absolute position `pos` is a plain ASCII space with
 * *no* link mark. The child holding that character is picked by its offsets
 * (both neighbours are consulted, so the choice does not depend on the exact
 * boundary direction of `childBefore`/`childAfter`): `insertLink` leaves one
 * unmarked plain space behind, so a marked space is not a generated spacer and
 * must never be bridged across.
 */
function plainAsciiSpaceAt(
  doc: ProsemirrorNode,
  pos: number,
  linkType: MarkType
): boolean {
  if (pos < 0 || pos >= doc.content.size) return false;
  const $pos = doc.resolve(pos);
  if (!$pos.parent.inlineContent) return false;
  const { parentOffset } = $pos;
  if (parentOffset >= $pos.parent.content.size) return false;
  if ($pos.parent.textBetween(parentOffset, parentOffset + 1) !== " ")
    return false;
  for (const child of adjacentTextChildren($pos)) {
    if (
      child.offset <= parentOffset &&
      parentOffset < child.offset + child.node.nodeSize
    )
      return !child.node.marks.some((mark) => mark.type === linkType);
  }
  return false;
}

/**
 * A link directly separated from `pos` by exactly one *unlinked* plain ASCII
 * space character: `insertLink` leaves exactly one plain space behind after a
 * creation (`<a>caption</a> `), so this is the only generated spacer that may
 * bridge a derived fallback range to the link it belongs to. Zero, two or more
 * spaces, any other whitespace character, a *linked* space, another link in the
 * way or any larger gap never resolve.
 */
function spacerLinkedRun(
  doc: ProsemirrorNode,
  pos: number,
  linkType: MarkType,
  requested?: LinkAttributes
): LinkRun | undefined {
  // `<a>caption</a> |` — the spacer right before the position, the link right
  // before the spacer.
  if (plainAsciiSpaceAt(doc, pos - 1, linkType)) {
    const run = singleLinkRunAt(doc, pos - 2, linkType, requested);
    if (run && run.to === pos - 1) return run;
  }
  // `| <a>caption</a>` — the spacer right after the position, the link right
  // after the spacer.
  if (plainAsciiSpaceAt(doc, pos, linkType)) {
    const run = singleLinkRunAt(doc, pos + 1, linkType, requested);
    if (run && run.from === pos + 1) return run;
  }
  return undefined;
}

/**
 * Resolves the range of the link the user is actually acting on.
 *
 * `EditLink` (without a hover popup `selectedNode`) and `showLinkPopup` derive
 * their range from `selectionToOffset(editor.state)`. At the "normal ending
 * caret" the link extension leaves behind after a creation — the caret rests on
 * the plain spacer next to the freshly inserted link — that derived range is
 * *not* the link range, while the link mark is still active at its inclusive
 * end boundary. Applying the link to that derived range would edit the spacer
 * (or the paragraph start) instead of the linked text.
 *
 * Resolution is deliberately local and never guesses:
 *
 * - only the explicitly supplied range decides: a link that contains, starts at
 *   or ends at one of its boundaries is the target. The live caret is *not*
 *   part of that candidate set — an unrelated caret resting on another link
 *   with the same `href`, or in another textblock, must never turn a valid
 *   explicitly hovered range into a fake ambiguity (or into a resolution);
 * - both neighbours of a boundary are inspected, so a link that merely *starts*
 *   at it (a single-character link, the right side of a shared boundary) is a
 *   candidate too, and two adjacent links stay two candidates;
 * - two distinct links on the same boundary are ambiguous and rejected;
 * - only when the range carries no link at all may at most *one* immediately
 *   adjacent *unlinked* generated plain ASCII spacer bridge to a link that has
 *   positive document evidence;
 * - a run in another textblock, or a run behind any larger gap, is never used.
 *
 * `attributes.href` (the link the host picker was pre-filled with) narrows
 * every candidate to that exact link; with a partial attributes view only the
 * provided attributes are compared. Without link context (`href`) or without
 * the link mark type nothing is resolved at all.
 *
 * Returns `undefined` when nothing can be resolved; callers must then refuse
 * (editing) or keep their original range (creation).
 */
export function resolveActiveInternalLinkRange(
  editor: Editor,
  range: { from: number; to: number },
  attributes?: LinkAttributes
): { from: number; to: number } | undefined {
  const linkType = editor.schema?.marks?.[LinkNode.name];
  if (!linkType || !attributes?.href) return undefined;

  const { doc } = editor.state;

  /**
   * The link runs touching a range boundary: the runs around the boundary
   * itself, plus a run that *ends* exactly there (its last character is the
   * boundary, e.g. a link ending at the end of its textblock). Two distinct
   * runs at one boundary stay two runs — that boundary is ambiguous then and is
   * never snapped to one side.
   */
  const runsAt = (pos: number): LinkRun[] => [
    ...linkRunsAt(doc, pos, linkType, attributes),
    ...linkRunsAt(doc, pos - 1, linkType, attributes).filter(
      (run) => run.to === pos
    )
  ];

  // Only the range the caller is acting on decides.
  const found = dedupeRuns([...runsAt(range.from), ...runsAt(range.to)]);
  if (found.length === 1) return found[0];
  // Two different links touch the range: ambiguous, do not guess.
  if (found.length > 1) return undefined;

  // The range carries no link: it may be the single generated plain ASCII
  // spacer next to the link it belongs to.
  for (const pos of [range.from, range.to]) {
    const bridged = spacerLinkedRun(doc, pos, linkType, attributes);
    if (bridged) return bridged;
  }

  return undefined;
}

/**
 * Runs the host provided internal link picker
 * (`editor.storage.createInternalLink`) and applies its result as a link on the
 * editor selection.
 *
 * Every internal-link entry point (the Insert "+" menu, the `addInternalLink`
 * toolbar tool and `editLink`) goes through this single command so they all
 * share the exact same safety guarantees:
 *
 * - no-op when the editor is missing, readonly (`!isEditable`) or destroyed;
 * - no-op when the host app did not provide a picker;
 * - no mutation when the picker is canceled or resolves to nothing;
 * - never writes to a document that changed while the picker was open, the
 *   captured positions would be stale and would corrupt the note;
 * - the selected text is preserved as the link title when there is one, and the
 *   href format is whatever the host produced (`nn://...`).
 *
 * The captured selection is bookmarked and resolved again *after* the document
 * identity guard, so the selection type survives the asynchronous picker: the
 * default path (a creation from the live selection) must not turn a
 * `NodeSelection` (e.g. a selected image) into a clamped `TextSelection`.
 * Editing an explicit `range` (hovered link editing) stays a text selection,
 * and restores the previous selection afterwards — also when the link command
 * refuses, so a refused edit cannot leave the selection stuck on the range.
 *
 * An explicit `range` is first resolved against the link actually present in the
 * document (see {@link resolveActiveInternalLinkRange}): a selection derived
 * fallback range that lands on the plain spacer next to a freshly created link
 * is replaced by the link's own range, so the linked caption is edited instead
 * of the spacer. Resolving to a real link also switches the apply step to an
 * attribute-only mark command bounded to that exact range, so a caption split
 * across bold/italic/color text nodes keeps all of its inline marks (and its
 * neighbours) and only the link attributes change. A range without a real link
 * behind it and the default (creation) path keep the existing `setLink` path.
 *
 * When the caller is *editing an existing link* (`options.attributes.href` is
 * the link the host picker was pre-filled with), a range that does not resolve
 * to that link is refused before the picker opens: falling back to `setLink`
 * there would silently rewrite the spacer (or the paragraph start) the derived
 * range points at, or flatten the caption's inline marks. The document and the
 * selection are left untouched.
 */
export async function insertInternalLink(
  editor: Editor | undefined,
  options: InsertInternalLinkOptions = {}
): Promise<LinkAttributes | undefined> {
  if (!editor || editor.isDestroyed || !editor.isEditable) return;

  const storage = editor.storage;
  if (typeof storage.createInternalLink !== "function") return;

  const doc = editor.state.doc;
  const previousSelection = editor.state.selection;
  const requestedRange = options.range;
  const requested = requestedRange ?? previousSelection;

  if (
    requested.from < 0 ||
    requested.to > doc.content.size ||
    requested.from > requested.to
  )
    return;

  // An explicit range is a hover range (a real link) or a selection derived
  // fallback, which at the creation ending caret points at the plain spacer next
  // to the link. Resolve it to the link the user is acting on before any
  // position is captured; a range that cannot be resolved is used as-is for a
  // creation, but refuses an edit of an existing link.
  const resolvedRange = requestedRange
    ? resolveActiveInternalLinkRange(
        editor,
        requestedRange,
        options.attributes
      )
    : undefined;

  // `options.attributes.href` is an existing internal link handed to the host
  // picker: this call edits that link, so the range must have resolved to it.
  // A miss (or an ambiguous boundary) must not fall through to the text
  // rewriting `setLink` path — refuse without asking the host and without
  // touching the document or the selection.
  if (requestedRange && options.attributes?.href && !resolvedRange) return;

  const range = resolvedRange ?? requestedRange ?? previousSelection;
  const { from, to } = range;

  const selectedText = doc.textBetween(from, to);

  // Bookmark the live selection so it can be resolved again after the await.
  // Resolving (rather than re-creating a text range) preserves the selection
  // type of the creation path.
  const previousBookmark = previousSelection.getBookmark();

  let link: LinkAttributes | undefined;
  try {
    link = await storage.createInternalLink(options.attributes);
  } catch {
    // A failed host picker (a rejected promise or a synchronous throw from the
    // picker itself) is treated like a cancel: no document or selection change.
    return;
  }

  // The user canceled the picker: nothing must change.
  if (!link) return;
  // Ignore a malformed picker result instead of mutating the document with it.
  // The href format is host owned (`nn://`, `veyran://`, ...), so only the
  // presence of a usable href is checked here.
  if (typeof link.href !== "string" || link.href.length === 0) return;

  // The picker is asynchronous: bail out if the editor is no longer usable or
  // the document changed while it was open.
  if (editor.isDestroyed || !editor.isEditable) return;
  if (editor.state.doc !== doc) return;

  const attributes: LinkAttributes = {
    ...link,
    title: selectedText || link.title
  };

  let applied: boolean;

  if (resolvedRange) {
    // Attribute-only edit of a link that already exists in the document: apply
    // the new attributes with the existing tiptap mark command, bounded to the
    // exact link range. `setLink` (`insertLink` in the link extension) rewrites
    // the caption text via `removeMark` + `insertText`, which flattens a caption
    // split across bold/italic/color text nodes; the mark command only swaps the
    // link mark's attributes and leaves every other inline mark and neighbour
    // untouched.
    applied = editor
      .chain()
      .focus()
      .setTextSelection({ from, to })
      .setMark(LinkNode.name, attributes)
      .run();
  } else {
    // Creation (or an explicit range without a real link behind it): unchanged
    // `setLink` path. The command decides what to do from the *committed* editor
    // selection, not from the queued selection command. Committing the captured
    // selection in its own step first — exactly like the pre-existing `EditLink`
    // toolbar flow does — keeps it from reading the stale, live selection
    // (editing a hovered link, or a caret that drifted while the picker was
    // open) and mangling neighbouring text.
    const selectionApplied = options.range
      ? // Explicit hovered ranges are always applied as a text selection.
        editor.chain().focus().setTextSelection({ from, to }).run()
      : commitSelection(editor, previousBookmark);
    if (!selectionApplied) return;

    applied = editor.commands.setLink(attributes);
  }

  // Keep the caret where the user left it (hovered/explicit range editing), with
  // the selection type it had. This also runs when the link command refused: a
  // refused link must not leave the user's selection stuck on the hovered/derived
  // range. Creation keeps `setLink`'s normal ending caret. A *throwing* command
  // is a programming error, is not caught and still rejects.
  if (options.range) commitSelection(editor, previousBookmark);

  return applied ? link : undefined;
}
