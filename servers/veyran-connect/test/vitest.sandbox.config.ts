/*
TEMPORARY sandbox-only wrapper (deleted before handoff).

The canonical `vitest.config.ts` makes Vite search for a PostCSS config upward
from the package directory; in this isolated sandbox the search walks into
`/Users/ozel0t/.ai-workers/bridge/package.json`, which is outside the writable
checkout and therefore unreadable (EPERM), aborting the run. Pinning an inline
(empty) PostCSS config skips that search. Everything else is the real config.
*/
import { defineConfig, mergeConfig } from "vitest/config";
// eslint-disable-next-line import/no-unresolved
import base from "../vitest.config.js";

export default mergeConfig(
  base,
  defineConfig({ css: { postcss: { plugins: [] } } })
);
