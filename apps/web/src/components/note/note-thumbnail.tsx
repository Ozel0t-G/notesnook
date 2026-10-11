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

import type { NoteThumbnail as NoteThumbnailInfo } from "@notesnook/common";
import { isRasterImageMimeType, isSafeAttachmentHash } from "@notesnook/common";
import { EVENTS } from "@notesnook/core";
import { useEffect, useRef, useState } from "react";
import { db } from "../../common/db";
import { decryptFile } from "../../interfaces/fs";

const THUMBNAIL_SIZE = 52;
const THUMBNAIL_PIXELS = THUMBNAIL_SIZE * 3;

async function isBlocked(noteId: string, locked?: boolean) {
  if (db.vault.unlocked) return false;
  if (locked) return true;
  try {
    return await db.vaults.itemExists({ id: noteId, type: "note" });
  } catch {
    return true;
  }
}

async function toThumbnail(blob: Blob): Promise<Blob | undefined> {
  const image = await createImageBitmap(blob);
  try {
    const scale = Math.min(
      1,
      THUMBNAIL_PIXELS / Math.max(image.width, image.height)
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | undefined>((resolve) =>
      canvas.toBlob((result) => resolve(result || undefined), "image/png")
    );
  } finally {
    image.close();
  }
}

/** A small, memory-only preview for a visible macOS desktop note row. */
export function NoteThumbnail({
  noteId,
  thumbnail,
  locked
}: {
  noteId: string;
  thumbnail: NoteThumbnailInfo;
  locked?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const objectUrl = useRef<string>();
  const [url, setUrl] = useState<string>();
  const [visible, setVisible] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(!!entry?.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const hide = () => {
      generation.current++;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = undefined;
      setUrl(undefined);
    };
    const show = () => setRevision((value) => value + 1);
    const onVaultLock = () => {
      hide();
      // Notes outside the vault may rebuild their previews after the purge.
      show();
    };
    const onVisibilityChange = () => {
      if (document.hidden) hide();
      else show();
    };
    const subscriptions = [
      db.eventManager.subscribe(EVENTS.vaultLocked, onVaultLock),
      db.eventManager.subscribe(EVENTS.vaultAutoLocked, onVaultLock),
      db.eventManager.subscribe(EVENTS.userLoggedOut, hide),
      db.eventManager.subscribe(EVENTS.vaultUnlocked, show)
    ];
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      generation.current++;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = undefined;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      subscriptions.forEach((subscription) => subscription.unsubscribe());
    };
  }, []);

  useEffect(() => {
    if (!visible || document.hidden || !isSafeAttachmentHash(thumbnail.hash))
      return;
    let cancelled = false;
    const currentGeneration = generation.current;
    const obsolete = () =>
      cancelled || currentGeneration !== generation.current;

    (async () => {
      try {
        if (await isBlocked(noteId, locked)) return;
        const attachment = await db.attachments.attachment(thumbnail.hash);
        if (
          !attachment ||
          attachment.failed ||
          !isRasterImageMimeType(attachment.mimeType) ||
          obsolete()
        )
          return;
        if (!(await db.fs().exists(attachment.hash))) {
          const downloaded = await db
            .fs()
            .downloadFile(
              `note-thumbnail:${noteId}`,
              attachment.hash,
              attachment.chunkSize
            );
          if (!downloaded) return;
        }
        if (obsolete() || (await isBlocked(noteId, locked))) return;
        const key = await db.attachments.decryptKey(attachment.key);
        if (!key || obsolete() || (await isBlocked(noteId, locked))) return;
        const plaintext = await decryptFile(attachment.hash, {
          key,
          iv: attachment.iv,
          name: attachment.filename,
          type: attachment.mimeType,
          isUploaded: !!attachment.dateUploaded
        });
        if (!plaintext || obsolete() || (await isBlocked(noteId, locked)))
          return;
        const small = await toThumbnail(plaintext);
        if (!small || obsolete() || (await isBlocked(noteId, locked))) return;
        const nextUrl = URL.createObjectURL(small);
        if (obsolete() || (await isBlocked(noteId, locked))) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = nextUrl;
        setUrl(nextUrl);
      } catch {
        // Offline or unsupported image formats simply have no preview.
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = undefined;
      setUrl(undefined);
    };
  }, [visible, noteId, thumbnail.hash, locked, revision]);

  return (
    <div
      ref={element}
      data-test-id="note-thumbnail"
      style={{
        position: "absolute",
        right: 12,
        top: "50%",
        transform: "translateY(-50%)",
        width: THUMBNAIL_SIZE,
        height: THUMBNAIL_SIZE,
        borderRadius: 6,
        overflow: "hidden",
        background: "var(--background-secondary)"
      }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}
    </div>
  );
}
