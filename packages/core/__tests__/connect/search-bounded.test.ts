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

import { describe, it, expect, afterEach } from "vitest";
import { createHarness, ConnectHarness } from "./fixtures.js";

let harness: ConnectHarness | undefined;
afterEach(async () => {
  if (harness) {
    harness.adapter.close();
    await harness.close();
    harness = undefined;
  }
});

type SearchResult = {
  results: { noteId: string; title: string }[];
  truncated: boolean;
};

async function search(
  ctx: ConnectHarness,
  query: string,
  limit?: number
): Promise<SearchResult> {
  return (await ctx.adapter.execute({
    operation: "search_notes",
    query,
    ...(limit === undefined ? {} : { limit })
  })) as SearchResult;
}

/** Add a note and (by default) bind it to the granted notebook. */
async function addNote(
  ctx: ConnectHarness,
  title: string,
  body: string,
  notebook = true
): Promise<string> {
  const id = await ctx.db.notes.add({
    title,
    content: { type: "tiptap", data: `<p>${body}</p>` }
  });
  if (notebook) await ctx.db.notes.addToNotebook(ctx.notebookId, id);
  return id;
}

/**
 * The Connect `search_notes` candidate path is a real, bounded SQL query
 * (`Lookup.boundedNoteIds`) against a real database — no fake lookup and no
 * materialized `IN (...)` id list. These tests exercise that path end to end:
 * eligibility (scope / live notebook / current body / privacy) is applied
 * *before* matching, ranking and the `LIMIT`, so hidden matches can neither
 * consume a visible slot nor make a complete response look truncated.
 */
describe("VeyraN Connect bounded search candidates", () => {
  it("does not let hidden matches consume the visible limit or flip truncated", async () => {
    harness = await createHarness();
    const ctx = harness;
    const token = "sqlneedletoken";

    const visible: string[] = [];
    for (const suffix of ["one", "two", "three"])
      visible.push(await addNote(ctx, `Visible ${suffix}`, `${token} ${suffix}`));

    // Every hidden class the SQL eligibility must exclude *before* the LIMIT.
    const localOnly = await addNote(ctx, "Hidden local", `${token} local`);
    await ctx.db.notes.localOnly(true, localOnly);

    const vaulted = await addNote(ctx, "Hidden vault", `${token} vault`);
    await ctx.db
      .sql()
      .updateTable("content")
      .set({ locked: true, data: JSON.stringify({ cipher: "x", iv: "y" }) })
      .where("noteId", "=", vaulted)
      .execute();

    const trashed = await addNote(ctx, "Hidden trash", `${token} trash`);
    await ctx.db.notes.moveToTrash(trashed);

    // Not related to the granted notebook and not a direct grant.
    const outOfScope = await ctx.db.notes.add({
      title: "Hidden out of scope",
      content: { type: "tiptap", data: `<p>${token} out</p>` }
    });

    const missingBody = await addNote(ctx, "Hidden missing body", `${token} x`);
    await ctx.db
      .sql()
      .deleteFrom("content")
      .where("noteId", "=", missingBody)
      .execute();

    // A *stale* historical body row (same noteId, different content id) must
    // never produce a hit: only the note's current `contentId` is joined.
    const stale = await addNote(ctx, "Hidden stale history", "plain body");
    const staleNote = await ctx.db.notes.note(stale);
    expect(staleNote?.contentId).toBeTruthy();
    await ctx.db.content.add({
      id: "stalecontent00000000001",
      noteId: stale,
      type: "tiptap",
      data: `<p>${token} stale</p>`
    } as never);

    const hiddenIds = [
      localOnly,
      vaulted,
      trashed,
      outOfScope,
      missingBody,
      stale
    ];

    const limited = await search(ctx, token, 3);
    expect(new Set(limited.results.map((r) => r.noteId))).toEqual(
      new Set(visible)
    );
    // The hidden matches must not have been counted as overflow.
    expect(limited.truncated).toBe(false);
    for (const hidden of hiddenIds)
      expect(limited.results.some((r) => r.noteId === hidden)).toBe(false);

    const cut = await search(ctx, token, 2);
    expect(cut.results).toHaveLength(2);
    expect(cut.truncated).toBe(true);
    for (const hit of cut.results) expect(visible).toContain(hit.noteId);
  });

  it("bounds the grant arrays as json parameters and cuts to the candidate limit", async () => {
    harness = await createHarness();
    const ctx = harness;
    const token = "bulkneedletoken";

    const created: string[] = [];
    for (let index = 0; index < 8; index++)
      created.push(await addNote(ctx, `Bulk ${index}`, `${token} ${index}`));

    // The granted arrays are two *JSON parameters* expanded with `json_each`
    // inside the query, so a 1000-entry grant set (the adapter's own bound) is
    // a constant number of SQL parameters — it must not raise a parameter-count
    // error and must still honor the LIMIT.
    const real = created.slice(0, 3);
    const padded = [
      ...real,
      ...Array.from({ length: 997 }, (_, index) =>
        `fake${String(index).padStart(16, "0")}`
      )
    ];
    expect(padded).toHaveLength(1000);

    const bounded = await ctx.db.lookup.boundedNoteIds(token, {
      noteIds: padded,
      notebookIds: [],
      limit: 2
    });
    expect(bounded).toHaveLength(2);
    for (const id of bounded) expect(real).toContain(id);

    // The adapter asks for `limit + 1` candidates so an overflow is detectable
    // and never returns more than the requested visible limit.
    const result = await search(ctx, token, 2);
    expect(result.results).toHaveLength(2);
    expect(result.truncated).toBe(true);
    for (const hit of result.results) expect(created).toContain(hit.noteId);

    const all = await search(ctx, token, 50);
    expect(all.results).toHaveLength(8);
    expect(all.truncated).toBe(false);
  });

  it("keeps eligible FTS rank order in the sub-3-character branch and ignores hidden FTS hits", async () => {
    harness = await createHarness();
    const ctx = harness;

    // "ab" is a sub-3-character token (regex-filtered); "rankneedle" is the FTS
    // token. The eligible FTS hit set must be intersected with the regex, and
    // its rank order preserved — not re-ranked into plain id order.
    const first = await addNote(ctx, "Rank one", "ab rankneedle one");
    const second = await addNote(ctx, "Rank two", "ab rankneedle two");
    // FTS-eligible but does not contain the short token: filtered out.
    const noShort = await addNote(ctx, "Rank three", "rankneedle only");
    // Hidden (local-only) FTS match must not influence the branch at all.
    const hidden = await addNote(ctx, "Rank hidden", "ab rankneedle hidden");
    await ctx.db.notes.localOnly(true, hidden);

    const query = "ab rankneedle";
    const one = await search(ctx, query);
    const two = await search(ctx, query);
    const ids = one.results.map((r) => r.noteId);
    expect(new Set(ids)).toEqual(new Set([first, second]));
    expect(ids).not.toContain(noShort);
    expect(ids).not.toContain(hidden);
    // Deterministic rank + id ordering across identical requests.
    expect(two.results.map((r) => r.noteId)).toEqual(ids);
    expect(one.truncated).toBe(false);

    // Fallback: when no *eligible* FTS hit exists the regex is applied over the
    // eligible set itself (again ordered by id, deterministically).
    const short = await addNote(ctx, "Short only", "qx short token");
    const hiddenShort = await addNote(ctx, "Short hidden", "qx short hidden");
    await ctx.db.notes.localOnly(true, hiddenShort);
    const shortResult = await search(ctx, "qx");
    expect(shortResult.results.map((r) => r.noteId)).toEqual([short]);
  });

  it("serves a directly granted archived note but not an archived notebook member", async () => {
    harness = await createHarness();
    const ctx = harness;
    const token = "archneedletoken";

    const direct = await addNote(ctx, "Archived direct", `${token} direct`, false);
    await ctx.db.notes.archive(true, direct);
    const member = await addNote(ctx, "Archived member", `${token} member`);
    // The notebook member must actually be archived for the exclusion below to
    // mean anything: archive it and assert the *stored* flag before searching.
    await ctx.db.notes.archive(true, member);
    expect((await ctx.db.notes.note(member))?.archived).toBe(true);

    // Grant the archived note *directly* (the fixture grants only `noteId`).
    await ctx.adapter.setGrants({
      accountId: ctx.accountId,
      canCreate: true,
      canRead: true,
      canChange: true,
      canTask: true,
      notebookIDs: [ctx.notebookId],
      noteIDs: [direct],
      listIDs: [ctx.listId]
    });

    const result = await search(ctx, token);
    const ids = result.results.map((r) => r.noteId);
    // A direct note grant serves the note regardless of its archived flag;
    // notebook membership excludes archived notes.
    expect(ids).toContain(direct);
    expect(ids).not.toContain(member);
    // Deterministic, repeatable ordering.
    const again = await search(ctx, token);
    expect(again.results.map((r) => r.noteId)).toEqual(ids);
  });

  it("never serves a body the note no longer points at", async () => {
    harness = await createHarness();
    const ctx = harness;
    const token = "currentbodytoken";

    const note = await addNote(ctx, "Current body", "the real body");
    const noteRow = await ctx.db.notes.note(note);
    // A stale row for the same note carrying the token, while the *current*
    // body does not.
    await ctx.db.content.add({
      id: "stalecurrent0000000001",
      noteId: note,
      type: "tiptap",
      data: `<p>${token} stale</p>`
    } as never);

    const staleResult = await search(ctx, token);
    expect(staleResult.results.some((r) => r.noteId === note)).toBe(false);

    // Replace the *current* body (through the pipeline) so it carries the
    // token: now the note is a hit, from the current row only.
    await ctx.db.notes.add({
      id: note,
      contentId: noteRow?.contentId,
      content: { type: "tiptap", data: `<p>${token} current</p>` }
    });
    const currentResult = await search(ctx, token);
    expect(currentResult.results.map((r) => r.noteId)).toEqual([note]);
    expect(currentResult.results[0].title).toBe("Current body");
  });
});
