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

import Sodium from "@ammarahmed/react-native-sodium";
import ImageResizer from "@bam.tech/react-native-image-resizer";
import { isSafeAttachmentHash } from "@notesnook/common";
import type { NoteThumbnail } from "@notesnook/common";
import { EVENTS } from "@notesnook/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Platform } from "react-native";
import RNFetchBlob from "react-native-blob-util";
import { db } from "../common/database";
import { createCacheDir } from "../common/filesystem/io";
import { cacheDir } from "../common/filesystem/utils";
import { getAppGroupIdForNative } from "../utils/constants";
import {
  getThumbnailCacheDir,
  getThumbnailCachePath,
  getThumbnailFileUri,
  getThumbnailResizeTarget,
  isRasterImageMimeType,
  isThumbnailVaultBlocked
} from "../utils/note-thumbnail";
import { useAppState } from "./use-app-state";

/**
 * How many plaintext thumbnails may be decrypted/resized at the same time.
 * Note lists mount several rows at once; a small bound keeps decryption and the
 * image resizer from spiking memory/CPU. Further requests queue and are served
 * in order.
 */
const MAX_CONCURRENT_DECODES = 2;
const MAX_CACHED_THUMBNAILS = 64;

let activeDecodes = 0;
const decodeWaiters: (() => void)[] = [];
const cachedThumbnails = new Map<string, string>();

async function withDecodeSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeDecodes >= MAX_CONCURRENT_DECODES) {
    await new Promise<void>((resolve) => decodeWaiters.push(resolve));
  }
  activeDecodes++;
  try {
    return await operation();
  } finally {
    activeDecodes = Math.max(0, activeDecodes - 1);
    decodeWaiters.shift()?.();
  }
}

/**
 * Bumped whenever the plaintext thumbnail cache is purged. A load captures the
 * epoch when it starts and refuses to hand back a thumbnail (deleting it) if a
 * purge happened in the meantime: this closes the race where a decrypt finishes
 * *after* a vault lock/background event.
 */
let cacheEpoch = 0;

/** In-flight loads de-duplicated by attachment hash. */
const inFlight = new Map<string, Promise<string | undefined>>();

let purgePromise: Promise<void> | undefined;

/**
 * Delete every plaintext note thumbnail. Only the dedicated thumbnail directory
 * (and this hook's own `thumb_` temp files) is touched: the encrypted attachment
 * ciphertext in the cache root is never removed.
 */
export function purgeNoteThumbnailCache(): Promise<void> {
  cacheEpoch++;
  cachedThumbnails.clear();
  if (!purgePromise) {
    purgePromise = (async () => {
      const dir = getThumbnailCacheDir(cacheDir);
      try {
        const entries = await RNFetchBlob.fs.ls(dir).catch(() => []);
        await Promise.all(
          entries.map((entry) =>
            RNFetchBlob.fs.unlink(`${dir}/${entry}`).catch(() => {})
          )
        );
        await RNFetchBlob.fs.unlink(dir).catch(() => {});
      } catch {
        /* empty */
      }

      // Sodium writes decrypted files to the shared cache before they can be
      // moved into our directory. Sweep leftovers from a previous crash too.
      try {
        const cacheEntries = await RNFetchBlob.fs.ls(cacheDir).catch(() => []);
        await Promise.all(
          cacheEntries
            .filter(
              (entry) => entry.startsWith("thumb_") || entry.endsWith("_dcache")
            )
            .map((entry) =>
              RNFetchBlob.fs.unlink(`${cacheDir}/${entry}`).catch(() => {})
            )
        );
      } catch {
        /* empty */
      }
    })().finally(() => {
      purgePromise = undefined;
    });
  }
  return purgePromise;
}

function stripFileScheme(path: string) {
  return path.startsWith("file://") ? path.slice("file://".length) : path;
}

function decryptedPath(uri: string): string {
  const path = stripFileScheme(uri);
  return path.startsWith("/") ? path : `${cacheDir}/${path}`;
}

async function ensureThumbnailDirectory(): Promise<string> {
  await createCacheDir();
  const directory = getThumbnailCacheDir(cacheDir);
  if (!(await RNFetchBlob.fs.exists(directory))) {
    await RNFetchBlob.fs.mkdir(directory);
  }
  return directory;
}

async function isVaultLockedForNote(
  noteId: string,
  resolvedLocked?: boolean
): Promise<boolean> {
  if (db.vault.unlocked) return false;
  if (resolvedLocked) return true;
  try {
    const inVault = await db.vaults.itemExists({ id: noteId, type: "note" });
    return inVault && !db.vault.unlocked;
  } catch {
    // A failed membership lookup cannot authorize decrypting a note.
    return true;
  }
}

async function rememberThumbnail(hash: string, path: string) {
  cachedThumbnails.delete(hash);
  cachedThumbnails.set(hash, path);
  while (cachedThumbnails.size > MAX_CACHED_THUMBNAILS) {
    const oldest = cachedThumbnails.keys().next().value;
    if (!oldest) break;
    const oldPath = cachedThumbnails.get(oldest);
    cachedThumbnails.delete(oldest);
    if (oldPath) await RNFetchBlob.fs.unlink(oldPath).catch(() => {});
  }
}

async function getImageSize(
  uri: string
): Promise<{ width?: number; height?: number }> {
  return new Promise((resolve) => {
    Image.getSize(
      getThumbnailFileUri(uri),
      (width, height) => resolve({ width, height }),
      () => resolve({})
    );
  });
}

async function getCachedThumbnail(hash: string): Promise<string | undefined> {
  const path = getThumbnailCachePath(cacheDir, hash);
  if (await RNFetchBlob.fs.exists(path)) {
    // Older attempts passed a file path where the native resizer expects a
    // directory. That path must not be mistaken for a finished image.
    if (await RNFetchBlob.fs.isDir(path)) {
      await RNFetchBlob.fs.unlink(path).catch(() => {});
      return undefined;
    }
    await rememberThumbnail(hash, path);
    return getThumbnailFileUri(path);
  }
  return undefined;
}

async function deletePlaintextThumbnail(hash: string) {
  cachedThumbnails.delete(hash);
  await RNFetchBlob.fs
    .unlink(getThumbnailCachePath(cacheDir, hash))
    .catch(() => {});
}

/**
 * Make sure the *encrypted* ciphertext for an attachment is on disk. The
 * download is issued through the core file-storage queue, which de-duplicates
 * concurrent requests and skips files that already exist. `db.fs().exists`
 * additionally validates the on-disk size against the attachment metadata, so a
 * truncated download is treated as missing.
 */
async function ensureCiphertext(
  noteId: string,
  hash: string,
  chunkSize: number
): Promise<boolean> {
  try {
    if (await db.fs().exists(hash)) return true;
    await db.fs().downloadFile(`note-thumbnail:${noteId}`, hash, chunkSize);
    return await db.fs().exists(hash);
  } catch {
    return false;
  }
}

/**
 * Decrypt an attachment to a file in the app cache and return its URI.
 *
 * The plaintext never goes through a base64 string: sodium streams the
 * ciphertext straight to a small file on disk, so a full-size image is never
 * held in JS memory.
 */
async function decryptAttachmentToFile(
  attachment: Awaited<ReturnType<typeof db.attachments.attachment>>
): Promise<string | undefined> {
  if (!attachment) return undefined;
  const key = await db.attachments.decryptKey(attachment.key);
  if (!key) return undefined;

  const cipher = {
    iv: attachment.iv,
    salt: attachment.salt,
    length: attachment.size,
    alg: attachment.alg,
    hash: attachment.hash,
    hashType: attachment.hashType,
    mime: attachment.mimeType,
    fileName: undefined,
    uri: undefined,
    chunkSize: attachment.chunkSize,
    // Undefined on Mac Catalyst, where sodium falls back to the app's own
    // cache directory instead of an App Group container it cannot open.
    appGroupId: getAppGroupIdForNative()
  };
  const uri = await Sodium.decryptFile(key, cipher, "cache");
  if (typeof uri !== "string" || !uri.length) return undefined;

  const source = decryptedPath(uri);
  const directory = await ensureThumbnailDirectory();
  const target = `${directory}/plain_${attachment.hash}`;
  await RNFetchBlob.fs.mv(source, target);
  return target;
}

/** Best-effort removal of the full-size plaintext decrypted for a thumbnail. */
async function deleteDecryptedAttachment(hash: string, uri?: string) {
  if (uri) {
    await RNFetchBlob.fs.unlink(decryptedPath(uri)).catch(() => {});
  }
  // Sodium's cache output is hash_dcache. Never unlink the bare hash: that is
  // the encrypted attachment on some installations.
  await RNFetchBlob.fs.unlink(`${cacheDir}/${hash}_dcache`).catch(() => {});
}

/**
 * Download (if needed), stream-decrypt, downscale and cache the first raster
 * image of a note. Returns the `file://` URI of the small plaintext thumbnail,
 * or undefined when it cannot (or must not) be produced.
 *
 * The caller is responsible for the vault gates; this function re-checks them
 * after every async step through `locked` so a lock racing the pipeline can
 * never publish a plaintext thumbnail.
 */
async function createThumbnail(
  noteId: string,
  hash: string,
  epoch: number,
  locked?: boolean
): Promise<string | undefined> {
  const attachment = await db.attachments.attachment(hash);
  if (!attachment || attachment.failed || !isSafeAttachmentHash(hash))
    return undefined;
  if (!isRasterImageMimeType(attachment.mimeType)) return undefined;

  // 1. Ciphertext must be on disk; otherwise download it (online, bounded by
  //    the core queue).
  if (!(await ensureCiphertext(noteId, hash, attachment.chunkSize))) {
    return undefined;
  }
  if (epoch !== cacheEpoch || (await isVaultLockedForNote(noteId, locked))) {
    return undefined;
  }

  // 2. Stream-decrypt straight to a file (no full-image base64).
  let decryptedUri: string | undefined;
  try {
    decryptedUri = await decryptAttachmentToFile(attachment);
    if (!decryptedUri) return undefined;
    if (epoch !== cacheEpoch || (await isVaultLockedForNote(noteId, locked))) {
      return undefined;
    }

    // 3. Downscale to the small plaintext thumbnail. `onlyScaleDown` means a
    //    smaller source is never upscaled and re-encoded.
    const { width, height } = await getImageSize(decryptedUri);
    const target = getThumbnailResizeTarget(width, height);

    const cached = await getCachedThumbnail(hash);
    if (cached) return cached;

    const thumbnailDir = await ensureThumbnailDirectory();
    const outPath = getThumbnailCachePath(cacheDir, hash);
    // The iOS resizer interprets outputPath as a directory below Documents.
    // Traverse to Library/.cache so plaintext remains in the app's excluded
    // cache directory on iPhone, iPad and Mac Catalyst.
    const resizerDirectory =
      Platform.OS === "ios"
        ? `${RNFetchBlob.fs.dirs.DocumentDir}/../Library/.cache/note-thumbnails`
        : thumbnailDir;

    const resized = await ImageResizer.createResizedImage(
      getThumbnailFileUri(decryptedUri),
      target.width,
      target.height,
      "PNG",
      80,
      0,
      resizerDirectory,
      false,
      {
        mode: "contain",
        onlyScaleDown: true
      }
    );
    if (!resized?.uri) return undefined;
    const generatedPath = decryptedPath(resized.uri);
    if (epoch !== cacheEpoch || (await isVaultLockedForNote(noteId, locked))) {
      await RNFetchBlob.fs.unlink(generatedPath).catch(() => {});
      return undefined;
    }
    try {
      await RNFetchBlob.fs.mv(generatedPath, outPath);
    } catch {
      await RNFetchBlob.fs.unlink(generatedPath).catch(() => {});
      return undefined;
    }
    // The vault can lock while the move is in progress. Check once more after
    // the file reaches its stable path so the purge cannot leave it behind.
    if (epoch !== cacheEpoch || (await isVaultLockedForNote(noteId, locked))) {
      await deletePlaintextThumbnail(hash);
      return undefined;
    }
    await rememberThumbnail(hash, outPath);
    if (epoch !== cacheEpoch || (await isVaultLockedForNote(noteId, locked))) {
      await deletePlaintextThumbnail(hash);
      return undefined;
    }
    return getThumbnailFileUri(outPath);
  } catch {
    return undefined;
  } finally {
    // The full-size plaintext must never outlive the operation.
    await deleteDecryptedAttachment(hash, decryptedUri);
  }
}

async function loadThumbnail(
  noteId: string,
  hash: string,
  locked?: boolean
): Promise<string | undefined> {
  const existing = inFlight.get(hash);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const epoch = cacheEpoch;
      if (purgePromise) await purgePromise;
      if (epoch !== cacheEpoch) return undefined;

      // Fast path: a previously produced plaintext thumbnail.
      const cached = await getCachedThumbnail(hash);
      if (cached) {
        // Re-check the vault *after* the async filesystem call and after a
        // possible purge; a locked vault note must never show a cached image.
        if (epoch !== cacheEpoch) return undefined;
        if (isThumbnailVaultBlocked(locked, db.vault.unlocked))
          return undefined;
        if (await isVaultLockedForNote(noteId, locked)) return undefined;
        return cached;
      }

      return withDecodeSlot(async () => {
        if (epoch !== cacheEpoch) return undefined;
        const uri = await createThumbnail(noteId, hash, epoch, locked);
        if (!uri) return undefined;

        // Fresh vault check after download/decrypt/resize. If the vault locked
        // (or the cache was purged) while we were working, throw the plaintext
        // away instead of rendering it.
        if (epoch !== cacheEpoch) {
          await deletePlaintextThumbnail(hash);
          return undefined;
        }
        if (isThumbnailVaultBlocked(locked, db.vault.unlocked)) {
          await deletePlaintextThumbnail(hash);
          return undefined;
        }
        if (await isVaultLockedForNote(noteId, locked)) {
          await deletePlaintextThumbnail(hash);
          return undefined;
        }
        return uri;
      });
    } catch {
      return undefined;
    }
  })();

  inFlight.set(hash, promise);
  try {
    return await promise;
  } finally {
    if (inFlight.get(hash) === promise) inFlight.delete(hash);
  }
}

export type UseNoteThumbnailOptions = {
  noteId?: string;
  thumbnail?: NoteThumbnail;
  locked?: boolean;
  /** When false the thumbnail is never loaded (e.g. trash rows). */
  enabled?: boolean;
};

/**
 * Resolves the small plaintext thumbnail URI for a single note-list row.
 *
 * Only mounted (visible) rows run this hook, so only visible rows ever
 * download/decrypt. The returned URI is dropped whenever the vault locks, the
 * app leaves the foreground, or the user logs out, and the plaintext cache is
 * purged at the same time.
 */
export function useNoteThumbnail({
  noteId,
  thumbnail,
  locked,
  enabled = true
}: UseNoteThumbnailOptions): string | undefined {
  const [uri, setUri] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);
  const appState = useAppState();
  const previousAppState = useRef(appState);
  const thumbnailHash = thumbnail?.hash;
  const thumbnailMimeType = thumbnail?.mimeType;

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  // Hide + purge when the vault locks (manually or by timer) or on logout.
  useEffect(() => {
    const onVaultLocked = () => {
      setUri(undefined);
      void purgeNoteThumbnailCache().then(reload);
    };
    const onVaultUnlocked = () => reload();
    const subscriptions = [
      db.eventManager.subscribe(EVENTS.vaultLocked, onVaultLocked),
      db.eventManager.subscribe(EVENTS.vaultAutoLocked, onVaultLocked),
      db.eventManager.subscribe(EVENTS.userLoggedOut, onVaultLocked),
      db.eventManager.subscribe(EVENTS.vaultUnlocked, onVaultUnlocked)
    ];
    return () => {
      for (const subscription of subscriptions) subscription.unsubscribe();
    };
  }, [reload]);

  // Backgrounding the app is a lock-equivalent moment for plaintext on disk.
  // Only a *transition* out of the foreground purges, so a row that mounts
  // while the app is already inactive does not thrash the cache.
  useEffect(() => {
    const previous = previousAppState.current;
    previousAppState.current = appState;
    if (previous === "active" && appState !== "active") {
      setUri(undefined);
      void purgeNoteThumbnailCache().then(reload);
    }
  }, [appState, reload]);

  useEffect(() => {
    if (
      !enabled ||
      !noteId ||
      !thumbnailHash ||
      !isSafeAttachmentHash(thumbnailHash) ||
      !isRasterImageMimeType(thumbnailMimeType)
    ) {
      setUri(undefined);
      return;
    }

    // Never (re)build a plaintext thumbnail while the app is not in the
    // foreground: backgrounding purges the cache and must not race it back.
    if (appState !== "active") {
      setUri(undefined);
      return;
    }

    // Resolved vault-membership gate *before* any download or decryption. The
    // vault must be unlocked for the image to be produced at all.
    if (isThumbnailVaultBlocked(locked, db.vault.unlocked)) {
      setUri(undefined);
      return;
    }

    let cancelled = false;
    setUri(undefined);

    (async () => {
      const result = await loadThumbnail(noteId, thumbnailHash, locked);
      if (cancelled) return;
      // Final gate before publishing to the UI.
      if (isThumbnailVaultBlocked(locked, db.vault.unlocked)) return;
      if (await isVaultLockedForNote(noteId, locked)) return;
      if (cancelled) return;
      setUri(result);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    noteId,
    thumbnailHash,
    thumbnailMimeType,
    locked,
    reloadKey,
    appState
  ]);

  return enabled ? uri : undefined;
}
