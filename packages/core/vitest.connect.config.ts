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

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * VeyraN Connect focused test configuration.
 *
 * This file exists *only* for isolated checkouts (worker/bridge sandboxes)
 * where the sibling workspace packages (`@notesnook/logger`,
 * `@notesnook/crypto`, `@notesnook/sodium`, `@notesnook/intl`) are not built
 * and the native `sodium-native` peer is not available. It must not be used as
 * the package-wide configuration: `vitest.config.ts` stays free of any
 * environment-specific alias.
 *
 * Every alias below resolves to *real* source (no mocks):
 *   - logger/crypto/sodium resolve to their workspace sources; the intl shim
 *     is a stand-in for the lingui message bundle, which core imports but
 *     never uses in these tests;
 *   - `sodium-native` (a peer of `@notesnook/sodium`, installed as a dev
 *     dependency of core for the Node test backend) is aliased because the
 *     importing file lives outside `packages/core`.
 *
 * Run with: npx vitest run --config vitest.connect.config.ts
 */
const dir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@notesnook/logger": `${dir}../logger/src/index.ts`,
      "@notesnook/crypto": `${dir}../crypto/src/index.ts`,
      "@notesnook/sodium": `${dir}../sodium/src/node.ts`,
      "@notesnook/intl": `${dir}__tests__/connect/intl-shim.ts`,
      // `packages/sodium/src/node.ts` lives outside `packages/core`, so node
      // resolution from there would not find this peer dependency.
      "sodium-native": `${dir}node_modules/sodium-native/index.js`
    }
  },
  test: {
    globalSetup: ["./__tests__/setup/global.setup.ts"],
    setupFiles: ["./__tests__/setup/test.setup.ts"],
    include: [
      "__tests__/connect/**/*.test.{js,ts}",
      ...(process.env.CONNECT_INCLUDE_BASELINE
        ? ["__tests__/**/*.test.{js,ts}", "src/**/*.test.{js,ts}"]
        : [])
    ]
  }
});
