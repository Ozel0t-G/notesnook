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

/**
 * VeyraN Connect server test configuration.
 *
 * Mirrors the focused Core Connect config's pure aliases so the runtime tests
 * can drive the *real* `ConnectAdapter` over the existing synthetic encrypted
 * SQLite fixtures. The aliases resolve to real workspace sources (no mocks);
 * `@notesnook/intl` is the same language-bundle shim the Core config uses, and
 * `sodium-native` resolves to Core's installed Node peer.
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = `${here}../..`;
const core = `${root}/packages/core`;

export default defineConfig({
  resolve: {
    alias: {
      "@notesnook/logger": `${root}/packages/logger/src/index.ts`,
      "@notesnook/crypto": `${root}/packages/crypto/src/index.ts`,
      "@notesnook/sodium": `${root}/packages/sodium/src/node.ts`,
      "@notesnook/intl": `${core}/__tests__/connect/intl-shim.ts`,
      "sodium-native": `${core}/node_modules/sodium-native/index.js`
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: [`${core}/__tests__/setup/global.setup.ts`],
    setupFiles: [`${core}/__tests__/setup/test.setup.ts`],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
