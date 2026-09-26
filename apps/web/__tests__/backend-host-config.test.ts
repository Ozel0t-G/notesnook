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

import { test, describe, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Source-level guard against silent Notesnook fallback.
 *
 * The web client previously repeated the production host list as literal
 * fallbacks in its own bootstrap, which meant a backend change in
 * @notesnook/core did not reach the web app. These assertions fail if that
 * duplication is reintroduced, which is the only way a normal (non-override)
 * web session could reach upstream infrastructure again.
 *
 * See artifacts/veyran-backend-audit.md sections 1.3 and 3.
 */

const UPSTREAM_HOSTS = [
  "api.notesnook.com",
  "auth.streetwriters.co",
  "events.streetwriters.co",
  "monogr.ph"
];

function source(relativePath: string) {
  const text = readFileSync(resolve(__dirname, "..", relativePath), "utf-8");
  // Drop the GPL header, which legitimately cites notesnook.com.
  return text.replace(/^\/\*[\s\S]*?\*\//, "");
}

describe("web backend host configuration", () => {
  test("db bootstrap does not hardcode upstream hosts", () => {
    const db = source("src/common/db.ts");
    for (const host of UPSTREAM_HOSTS) {
      expect(db, `src/common/db.ts must not hardcode ${host}`).not.toContain(
        host
      );
    }
  });

  test("db bootstrap takes its defaults from core", () => {
    const db = source("src/common/db.ts");
    for (const key of ["API_HOST", "AUTH_HOST", "SSE_HOST", "MONOGRAPH_HOST"]) {
      expect(db, `${key} default must come from core`).toContain(
        `getHostUrl("${key}", hosts.${key})`
      );
    }
  });

  test("the user override is still applied last", () => {
    // The advanced/self-host override must keep winning over build-time env and
    // compiled defaults, otherwise development against a local server breaks.
    const db = source("src/common/db.ts");
    expect(db).toContain(
      'Config.get<Partial<Record<string, string>>>(\n    "serverUrls"'
    );
    const spreadAt = db.indexOf("...serverUrls");
    const lastDefaultAt = db.lastIndexOf("getHostUrl(");
    expect(spreadAt).toBeGreaterThan(-1);
    expect(spreadAt).toBeGreaterThan(lastDefaultAt);
  });

  test("only explicitly saved urls are offered as affinity evidence", () => {
    // Passing the build's defaults here would let a default masquerade as the
    // user's own saved configuration when attributing a legacy profile.
    const db = source("src/common/db.ts");
    expect(db).toContain("persistedOverrides: serverUrls");
  });

  test("the connectivity probe does not hardcode a backend", () => {
    const worker = source("src/utils/network-check.worker.ts");
    for (const host of UPSTREAM_HOSTS) {
      expect(worker, `probe must not reach ${host}`).not.toContain(host);
    }
    expect(worker).toContain("healthUrl");
  });

  test("the connectivity probe targets the configured sync host", () => {
    const wrapper = source("src/utils/network-check.ts");
    expect(wrapper).toContain("hosts.API_HOST");
  });
});
