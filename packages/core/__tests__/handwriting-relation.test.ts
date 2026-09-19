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

import { expect, test } from "vitest";
import { databaseTest, loginFakeUser } from "./utils";

const PNG_1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_2 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEEAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// stand-in for PKDrawing bytes (any opaque base64 payload)
const PKD = Buffer.from("fake-pkdrawing-bytes").toString("base64");

async function idOf(db: any, hash: string) {
  const [a] = await db.attachments.all
    .fields(["attachments.id"])
    .where((eb: any) => eb("hash", "in", [hash]))
    .items();
  return a.id as string;
}

test("attachment->attachment relation keeps a hidden PKDrawing linked", () =>
  databaseTest().then(async (db) => {
    await loginFakeUser(db);
    const uuid = "11111111-2222-3333-4444-555555555555";

    const pngHash = await db.attachments.save(
      PNG_1,
      "image/png",
      `handwriting-${uuid}.png`
    );
    const pkdHash = await db.attachments.save(
      PKD,
      "application/octet-stream",
      `handwriting-${uuid}.pkdrawing`
    );
    if (!pngHash || !pkdHash) throw new Error("save failed");
    const pngId = await idOf(db, pngHash);
    const pkdId = await idOf(db, pkdHash);

    // note content only references the PNG (visible image node)
    const noteId = await db.notes.add({
      title: "hw",
      content: {
        type: "tiptap",
        data: `<p>a</p><img data-hash="${pngHash}" data-filename="handwriting-${uuid}.png" data-mime="image/png"/>`
      }
    });

    // hidden binding
    await db.relations.add(
      { id: pngId, type: "attachment" },
      { id: pkdId, type: "attachment" }
    );

    // (a) lookup: image hash -> PNG attachment -> PKDrawing
    const found = await db.relations
      .from({ id: pngId, type: "attachment" }, "attachment")
      .resolve();
    expect(found.map((a: any) => a.hash)).toEqual([pkdHash]);

    // (b) not orphaned; note is NOT linked to the PKDrawing
    const orphanedHashes = (await db.attachments.orphaned.items()).map(
      (a: any) => a.hash
    );
    expect(orphanedHashes).not.toContain(pkdHash);
    const noteAttachments = (
      await db.attachments.ofNote(noteId, "all").items()
    ).map((a: any) => a.hash);
    expect(noteAttachments).toContain(pngHash);
    expect(noteAttachments).not.toContain(pkdHash);

    // (c) note content save (processLinkedAttachments) must not drop it
    await db.notes.add({
      id: noteId,
      content: {
        type: "tiptap",
        data: `<p>edited text</p><img data-hash="${pngHash}" data-filename="handwriting-${uuid}.png" data-mime="image/png"/>`
      }
    });
    expect(
      (
        await db.relations
          .from({ id: pngId, type: "attachment" }, "attachment")
          .resolve()
      ).length
    ).toBe(1);

    // (d) removeOrphaned must keep both
    await db.attachments.removeOrphaned();
    expect(await db.attachments.exists(pkdHash)).toBe(true);
    expect(await db.attachments.exists(pngHash)).toBe(true);

    // (e) replacing the image (edit): new PNG+PKD pair, old PNG removed from content
    const png2 = await db.attachments.save(
      PNG_2,
      "image/png",
      `handwriting-${uuid}.png`
    );
    const pkd2 = await db.attachments.save(
      Buffer.from("fake-pkdrawing-bytes-v2").toString("base64"),
      "application/octet-stream",
      `handwriting-${uuid}.pkdrawing`
    );
    if (!png2 || !pkd2) throw new Error("save2 failed");
    await db.relations.add(
      { id: await idOf(db, png2), type: "attachment" },
      { id: await idOf(db, pkd2), type: "attachment" }
    );
    await db.notes.add({
      id: noteId,
      content: {
        type: "tiptap",
        data: `<p>edited text</p><img data-hash="${png2}" data-filename="handwriting-${uuid}.png" data-mime="image/png"/>`
      }
    });
    await db.attachments.removeOrphaned();
    // new pair intact
    expect(await db.attachments.exists(pkd2)).toBe(true);
    expect(await db.attachments.exists(png2)).toBe(true);
    // old PNG orphaned+removed; old PKDrawing survives this pass (documented leak)
    expect(await db.attachments.exists(pngHash)).toBe(false);
    // the old PKDrawing is still related to the old PNG during the first pass
    expect(await db.attachments.exists(pkdHash)).toBe(true);
    // ...and becomes orphaned (and is collected) once the old PNG is gone
    await db.attachments.removeOrphaned();
    expect(await db.attachments.exists(pkdHash)).toBe(false);
    expect(await db.attachments.exists(pkd2)).toBe(true);
  }));
