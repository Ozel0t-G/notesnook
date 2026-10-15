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

/**
 * Runtime load-safety configuration.
 *
 * Deliberately has **no `setupFiles`**: the shared `vitest.connect.config.ts`
 * setup always installs a `linkedom` `DOMParser`, which would hide the exact
 * failure this suite exists to catch (a DOM-less / DB-less process that must
 * still be able to import the pure Connect modules). The test installs the
 * *real* `apps/mobile/worker.js` DOM implementation itself.
 *
 * Run with: npx vitest run --config __tests__/connect/vitest.load-safety.config.ts
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/connect/load-safety.spec.ts"]
  }
});
