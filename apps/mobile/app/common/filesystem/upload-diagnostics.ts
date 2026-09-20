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

// Auth overhead libsodium adds per encrypted chunk (same value as ABYTES in ./utils).
const CHUNK_OVERHEAD = 17;
const MAX_BODY_LENGTH = 500;

export type UploadDiagnosticsInput = {
  filename: string;
  url: string;
  headerNames: string[];
  responseCode?: number;
  responseBody?: string | null;
  error?: string;
  localSize: number;
  remoteSize: number;
  attachment?: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    chunkSize: number;
    alg: string;
    hashType: string;
    dateUploaded?: number | null;
    failed?: string | null;
  };
};

/** Removes anything that looks like a credential from text taken from a response. */
export function redact(text: string) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+/g, "[redacted-jwt]");
}

/** Size of the encrypted file for a plaintext of `size` bytes. */
export function expectedEncryptedSize(size: number, chunkSize: number) {
  if (!size || !chunkSize) return undefined;
  return size + Math.ceil(size / chunkSize) * CHUNK_OVERHEAD;
}

/**
 * Everything needed to tell whether a failed single-part upload is caused by
 * the attachment record, the local file, the object already on the server or
 * the server's answer. Contains no Authorization value.
 */
export function buildUploadDiagnostics(input: UploadDiagnosticsInput) {
  const { attachment } = input;
  const expected = attachment
    ? expectedEncryptedSize(attachment.size, attachment.chunkSize)
    : undefined;
  const body =
    typeof input.responseBody === "string"
      ? redact(input.responseBody).slice(0, MAX_BODY_LENGTH)
      : input.responseBody;

  return {
    hash: input.filename,
    url: input.url,
    requestHeaders: input.headerNames,
    responseCode: input.responseCode,
    responseBody: body,
    error: input.error,
    localEncryptedSize: input.localSize,
    remoteFileSize: input.remoteSize,
    expectedEncryptedSize: expected,
    // false: the local file does not match the attachment record
    localSizeMatchesRecord:
      expected === undefined ? undefined : expected === input.localSize,
    attachment: attachment && {
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      plaintextSize: attachment.size,
      chunkSize: attachment.chunkSize,
      alg: attachment.alg,
      hashType: attachment.hashType,
      dateUploaded: attachment.dateUploaded,
      previousFailure: attachment.failed
    }
  };
}
