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
  findDrawingSource,
  findMetadataSource,
  getHandwritingFilename,
  isHandwritingImage,
  isHandwritingSupported,
  isValidHandwritingId,
  parseHandwritingFilename
} from "./utils";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("handwriting filenames", () => {
  test("UUID pairing: png and pkdrawing share the same id", () => {
    const png = getHandwritingFilename(ID, "png");
    const drawing = getHandwritingFilename(ID, "drawing");
    expect(png).toBe(`handwriting-${ID}.png`);
    expect(drawing).toBe(`handwriting-${ID}.pkdrawing`);
    expect(parseHandwritingFilename(png)?.id).toBe(
      parseHandwritingFilename(drawing)?.id
    );
  });

  test("id is normalised to lowercase", () => {
    expect(getHandwritingFilename(ID.toUpperCase(), "png")).toBe(
      `handwriting-${ID}.png`
    );
    expect(
      parseHandwritingFilename(`HANDWRITING-${ID.toUpperCase()}.PNG`)
    ).toEqual({ id: ID, kind: "png" });
  });

  test("filename detection", () => {
    expect(isHandwritingImage(`handwriting-${ID}.png`)).toBe(true);
    // the source file is not an image
    expect(isHandwritingImage(`handwriting-${ID}.pkdrawing`)).toBe(false);
    for (const name of [
      "photo.png",
      "handwriting.png",
      `handwriting-${ID}.jpg`,
      `handwriting-${ID}.png.exe`,
      `my-handwriting-${ID}.png`,
      `handwriting-not-a-uuid.png`,
      "",
      undefined,
      null
    ]) {
      expect(isHandwritingImage(name as any)).toBe(false);
      expect(parseHandwritingFilename(name as any)).toBeUndefined();
    }
  });

  test("rejects invalid ids", () => {
    expect(isValidHandwritingId("nope")).toBe(false);
    expect(isValidHandwritingId(undefined)).toBe(false);
    expect(() => getHandwritingFilename("../../etc/passwd", "png")).toThrow();
  });
});

describe("platform guard", () => {
  test("only iPad is supported", () => {
    expect(isHandwritingSupported({ OS: "ios", isPad: true })).toBe(true);
    expect(isHandwritingSupported({ OS: "ios", isPad: false })).toBe(false);
    expect(isHandwritingSupported({ OS: "ios" })).toBe(false);
    expect(isHandwritingSupported({ OS: "android", isPad: true })).toBe(false);
    expect(isHandwritingSupported({ OS: "web", isPad: true })).toBe(false);
  });
});

describe("findDrawingSource", () => {
  const png = `handwriting-${ID}.png`;
  const drawing = (id: string, hash: string) => ({
    id,
    hash,
    filename: `handwriting-${ID}.pkdrawing`
  });

  test("prefers the related (relation-bound) drawing", () => {
    const related = drawing("a", "h1");
    const other = drawing("b", "h2");
    expect(findDrawingSource(png, [related], [other])).toBe(related);
  });

  test("falls back to same-filename lookup when the relation is missing", () => {
    const other = drawing("b", "h2");
    expect(findDrawingSource(png, [], [other])).toBe(other);
  });

  test("missing source returns undefined (edit disabled, note not failed)", () => {
    expect(findDrawingSource(png, [], [])).toBeUndefined();
  });

  test("ignores drawings that belong to another uuid", () => {
    const foreign = {
      id: "x",
      hash: "hx",
      filename: "handwriting-11111111-1111-4111-8111-111111111111.pkdrawing"
    };
    expect(findDrawingSource(png, [foreign], [foreign])).toBeUndefined();
  });

  test("non-handwriting image has no source", () => {
    expect(
      findDrawingSource("photo.png", [drawing("a", "h")], [drawing("a", "h")])
    ).toBeUndefined();
  });
});

describe("handwriting metadata files", () => {
  const png = `handwriting-${ID}.png`;
  const att = (filename: string, id: string, dateCreated?: number) => ({
    id,
    hash: `h-${id}`,
    filename,
    dateCreated
  });

  test("filename pairing includes the .json file", () => {
    expect(getHandwritingFilename(ID, "metadata")).toBe(
      `handwriting-${ID}.json`
    );
    expect(parseHandwritingFilename(`handwriting-${ID}.json`)).toEqual({
      id: ID,
      kind: "metadata"
    });
    expect(isHandwritingImage(`handwriting-${ID}.json`)).toBe(false);
  });

  test("metadata is found through the relation first", () => {
    const meta = att(`handwriting-${ID}.json`, "m1");
    const drawing = att(`handwriting-${ID}.pkdrawing`, "d1");
    expect(findMetadataSource(png, [drawing, meta], [])).toBe(meta);
    // the drawing lookup is unaffected by the additional relation
    expect(findDrawingSource(png, [drawing, meta], [])).toBe(drawing);
  });

  test("falls back to the newest same-name file when the relation is missing", () => {
    const old = att(`handwriting-${ID}.json`, "m1", 100);
    const fresh = att(`handwriting-${ID}.json`, "m2", 200);
    expect(findMetadataSource(png, [], [old, fresh])).toBe(fresh);
    expect(findMetadataSource(png, [], [fresh, old])).toBe(fresh);
  });

  test("no metadata (Build 1 drawing) -> undefined", () => {
    const drawing = att(`handwriting-${ID}.pkdrawing`, "d1");
    expect(findMetadataSource(png, [drawing], [drawing])).toBeUndefined();
  });

  test("never returns another drawing's metadata or a non-PNG lookup", () => {
    const other = att(
      "handwriting-11111111-2222-3333-4444-555555555555.json",
      "x"
    );
    expect(findMetadataSource(png, [other], [other])).toBeUndefined();
    expect(
      findMetadataSource(`handwriting-${ID}.json`, [other], [other])
    ).toBeUndefined();
    expect(findMetadataSource("photo.png", [other], [other])).toBeUndefined();
  });
});
