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
 * Bundle the standalone MCP server into this plugin's `dist/server.mjs`.
 *
 * esbuild is resolved from the sibling server package's `node_modules` via
 * `createRequire`, so no package manager is invoked at build time and none is
 * needed at run time. The output is the same fully-bundled, dependency-free
 * artifact the server package produces — enforced by the same purity guard, so
 * no DOM/database/SQL/content-pipeline module (or the Core package index) can
 * reach the plugin bundle.
 */
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const serverRoot = path.resolve(pluginRoot, "../../servers/veyran-connect");
const require = createRequire(path.join(serverRoot, "package.json"));
const esbuild = require("esbuild");

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
            `forbidden module "${args.path}" reached the plugin bundle (from ${args.importer})`
          );
      }
      if (args.path === "@notesnook/core")
        throw new Error(
          "the Core package index would load the database; import the pure connect sources instead"
        );
      return undefined;
    });
  }
};

const dist = path.join(pluginRoot, "dist");
await fs.mkdir(dist, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(serverRoot, "src/server.ts")],
  outfile: path.join(dist, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  // Runtime minimum Node >= 22.10.0 (see package.json `engines`); no Node 20
  // support is claimed.
  target: "node22",
  sourcemap: false,
  logLevel: "info",
  legalComments: "external",
  plugins: [guardPlugin]
});

process.stdout.write(`bundled: ${path.join(dist, "server.mjs")}\n`);
