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

import type { Attachment } from "@notesnook/core";
import { describe, expect, it } from "vitest";
import {
  getFirstRasterImageThumbnail,
  isRasterImageAttachment,
  isRasterImageMimeType
} from "../note-thumbnail.js";

function attachment(overrides: Partial<Attachment>): Attachment {
  return {
    id: "attachment-id",
    hash: "attachment-hash",
    mimeType: "image/jpeg",
    ...overrides
  } as Attachment;
}

describe("note thumbnail attachment selection", () => {
  it("accepts only raster image mime types", () => {
    expect(isRasterImageMimeType("image/png")).toBe(true);
    expect(isRasterImageMimeType("image/jpeg")).toBe(true);
    expect(isRasterImageMimeType("IMAGE/WEBP")).toBe(true);
    expect(isRasterImageMimeType(" image/gif ")).toBe(true);

    expect(isRasterImageMimeType("image/svg+xml")).toBe(false);
    expect(isRasterImageMimeType("application/vnd.notesnook.web-clip")).toBe(
      false
    );
    expect(isRasterImageMimeType("application/pdf")).toBe(false);
    expect(isRasterImageMimeType("")).toBe(false);
    expect(isRasterImageMimeType(undefined)).toBe(false);
  });

  it("rejects failed attachments and non-images", () => {
    expect(isRasterImageAttachment(attachment({}))).toBe(true);
    expect(
      isRasterImageAttachment(attachment({ failed: "upload failed" }))
    ).toBe(false);
    expect(
      isRasterImageAttachment(attachment({ mimeType: "application/pdf" }))
    ).toBe(false);
    expect(
      isRasterImageAttachment(attachment({ mimeType: "image/svg+xml" }))
    ).toBe(false);
    expect(isRasterImageAttachment(undefined)).toBe(false);
  });

  it("never turns an attachment hash into a path outside the thumbnail cache", () => {
    expect(
      isRasterImageAttachment(attachment({ hash: "../../other-file" }))
    ).toBe(false);
    expect(
      isRasterImageAttachment(attachment({ hash: "folder\\other-file" }))
    ).toBe(false);
  });

  it("picks the first raster image in the resolved order", () => {
    const thumbnail = getFirstRasterImageThumbnail([
      attachment({ id: "pdf", hash: "pdf-hash", mimeType: "application/pdf" }),
      attachment({
        id: "svg",
        hash: "svg-hash",
        mimeType: "image/svg+xml"
      }),
      attachment({
        id: "failed",
        hash: "failed-hash",
        mimeType: "image/png",
        failed: "boom"
      }),
      attachment({ id: "photo", hash: "photo-hash", mimeType: "image/jpeg" }),
      attachment({ id: "later", hash: "later-hash", mimeType: "image/png" })
    ]);

    expect(thumbnail).toEqual({
      id: "photo",
      hash: "photo-hash",
      mimeType: "image/jpeg"
    });
  });

  it("returns undefined when the note has no raster image", () => {
    expect(
      getFirstRasterImageThumbnail([
        attachment({ mimeType: "application/octet-stream" }),
        attachment({ failed: "boom" })
      ])
    ).toBeUndefined();
    expect(getFirstRasterImageThumbnail([])).toBeUndefined();
  });

  it("tolerates gaps in the resolved attachment list", () => {
    expect(
      getFirstRasterImageThumbnail([
        undefined,
        attachment({ id: "only", hash: "only-hash", mimeType: "image/png" })
      ])
    ).toEqual({ id: "only", hash: "only-hash", mimeType: "image/png" });
  });
});
