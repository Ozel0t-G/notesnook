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
  buildUploadDiagnostics,
  expectedEncryptedSize,
  redact
} from "./upload-diagnostics";

const attachment = {
  id: "att-id",
  filename: "handwriting-x.png",
  mimeType: "image/png",
  size: 158670,
  chunkSize: 524288,
  alg: "xcha-stream",
  hashType: "xxh64",
  dateUploaded: null,
  failed: null
};

describe("upload diagnostics", () => {
  it("adds one auth tag per chunk to the plaintext size", () => {
    expect(expectedEncryptedSize(158670, 524288)).toBe(158687);
    expect(expectedEncryptedSize(524289, 524288)).toBe(524289 + 2 * 17);
    expect(expectedEncryptedSize(0, 524288)).toBeUndefined();
  });

  it("reports the response body and whether the local file matches the record", () => {
    const d = buildUploadDiagnostics({
      filename: "99c48e266535ee6c",
      url: "https://api.example/s3?name=99c48e266535ee6c",
      headerNames: ["Authorization", "content-type"],
      responseCode: 400,
      responseBody: "quota exceeded",
      localSize: 158687,
      remoteSize: 0,
      attachment
    });
    expect(d.responseBody).toBe("quota exceeded");
    expect(d.expectedEncryptedSize).toBe(158687);
    expect(d.localSizeMatchesRecord).toBe(true);
    expect(d.attachment?.plaintextSize).toBe(158670);
  });

  it("flags a local file that does not match the record", () => {
    const d = buildUploadDiagnostics({
      filename: "h",
      url: "u",
      headerNames: [],
      localSize: 100,
      remoteSize: 5,
      attachment
    });
    expect(d.localSizeMatchesRecord).toBe(false);
    expect(d.remoteFileSize).toBe(5);
  });

  it("never contains credentials and truncates long bodies", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk";
    const d = buildUploadDiagnostics({
      filename: "h",
      url: "u",
      headerNames: ["Authorization"],
      responseBody: `Bearer ${jwt} ${"x".repeat(2000)}`,
      localSize: 1,
      remoteSize: 0
    });
    const text = JSON.stringify(d);
    expect(text).not.toContain(jwt);
    expect((d.responseBody as string).length).toBeLessThanOrEqual(500);
    expect(redact(`token eyJhbGciOiJIUzI1NiJ9.abc.def`)).toContain("[redacted");
  });

  it("copes with a missing attachment record and missing body", () => {
    const d = buildUploadDiagnostics({
      filename: "h",
      url: "u",
      headerNames: [],
      responseBody: null,
      localSize: 1,
      remoteSize: -1
    });
    expect(d.attachment).toBeUndefined();
    expect(d.localSizeMatchesRecord).toBeUndefined();
    expect(d.responseBody).toBeNull();
  });
});
