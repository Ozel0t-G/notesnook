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
 * Standalone bundle build.
 *
 * Both outputs are fully bundled (the MCP SDK included) so the produced
 * `dist/server.mjs` runs without any repository dependency and without a
 * runtime `npx`. The Core Connect contract is pulled from the *pure relative
 * sources* (`../../packages/core/src/connect/*.ts`) — esbuild resolves the
 * `.js` specifiers to `.ts` — so the bundle never contains the Core database,
 * SQL, native modules, DOM or showdown content pipeline.
 *
 * The build is deliberately offline-safe: it reads the two package-local
 * node_modules trees only.
 */
import esbuild from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(dir, "dist");

/** Fail loudly if a forbidden module ever reaches the graph. */
const forbidden = [
  "better-sqlite3",
  "better-sqlite3-multiple-ciphers",
  "@streetwriters/kysely",
  "dompurify",
  "linkedom",
  "jsdom",
  "showdown",
  "@streetwriters/showdown",
  "@notesnook/core"
];

const guardPlugin = {
  name: "core-purity-guard",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      for (const name of forbidden) {
        if (args.path === name || args.path.startsWith(`${name}/`))
          throw new Error(
            `forbidden module "${args.path}" reached the MCP bundle (from ${args.importer})`
          );
      }
      // The Core package *index* must never be imported: only the pure
      // relative connect sources are allowed.
      if (args.path === "@notesnook/core")
        throw new Error("the Core package index would load the database; import the pure connect sources instead");
      return undefined;
    });
  }
};

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  // The runtime minimum is Node >= 22.10.0 (see package.json `engines`): TLS
  // validation reads `X509Certificate.validFromDate`/`validToDate` (added in
  // 22.10.0). No Node 20 support is claimed.
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  plugins: [guardPlugin],
  legalComments: "external"
};

await esbuild.build({
  ...common,
  entryPoints: [path.join(dir, "src/server.ts")],
  outfile: path.join(outdir, "server.mjs")
});

await esbuild.build({
  ...common,
  entryPoints: [path.join(dir, "src/cli.ts")],
  outfile: path.join(outdir, "cli.mjs"),
  banner: { js: "#!/usr/bin/env node" }
});

// The portable plugin bundle is the *same* standalone artifact: building the
// server also refreshes `plugin/veyran-connect/dist/server.mjs`, so a single
// `npm run build` makes both the harness and the plugin integration tests
// exercisable (they must never skip for a missing dist in CI).
const pluginDist = path.resolve(dir, "../../plugin/veyran-connect/dist");
await fs.mkdir(pluginDist, { recursive: true });
await esbuild.build({
  ...common,
  entryPoints: [path.join(dir, "src/server.ts")],
  outfile: path.join(pluginDist, "server.mjs"),
  sourcemap: false
});
