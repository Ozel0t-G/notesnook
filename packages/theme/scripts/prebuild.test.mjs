import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const themeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repoRoot = path.resolve(themeRoot, "../..");

test("clean checkout includes both legacy default themes and builds offline", () => {
  for (const themeId of ["default-light", "default-dark"]) {
    const asset = `packages/theme/src/theme-engine/themes/${themeId}.json`;
    assert.doesNotThrow(() =>
      execFileSync("git", ["ls-files", "--error-unmatch", "--", asset], {
        cwd: repoRoot,
        stdio: "pipe"
      })
    );
  }

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      'globalThis.fetch = () => { throw new Error("unexpected theme network request"); }; import("./scripts/prebuild.mjs")'
    ],
    { cwd: themeRoot, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
});
