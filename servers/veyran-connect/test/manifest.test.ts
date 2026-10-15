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
 * Structural validation of the portable plugin bundle against the
 * agent-plugins 1.0.0 rules (from the published schemas).
 *
 * The full JSON-Schema validation against the official schema files is a Root
 * step (`docs/veyran-connect/MCP.md` §"Official schema validation"): the schema
 * URLs are not fetched from the network in this authoring round. These checks
 * assert exactly the constraints the official schemas impose: required
 * `$schema` + `name`, `version` optional, no legacy top-level keys, `stdio`
 * only with `type/command/args/env/cwd`, a `node` (never absolute/placeholder)
 * command, and matching versions.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "../../../plugin/veyran-connect");
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("plugin bundle manifests", () => {
  const pluginExists = existsSync(path.join(pluginRoot, "plugin.json"));

  it.skipIf(!pluginExists)("plugin.json matches the 1.0.0 plugin schema rules", () => {
    const plugin = readJson(path.join(pluginRoot, "plugin.json"));
    expect(plugin.$schema).toBe(PLUGIN_SCHEMA);
    expect(plugin.name).toBe("veyran-connect");
    expect(typeof plugin.version).toBe("string");
    // No historical top-level keys in the plugin manifest.
    expect(plugin.skills).toBeUndefined();
    expect(plugin.mcpServers).toBeUndefined();
  });

  it.skipIf(!pluginExists)("mcp.json declares a stdio server with `node`", () => {
    const mcp = readJson(path.join(pluginRoot, "mcp.json"));
    expect(mcp.$schema).toBe(MCP_SCHEMA);
    const servers = mcp.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers)).toEqual(["veyran-connect"]);
    const veyranConnect = servers["veyran-connect"];
    expect(veyranConnect.type).toBe("stdio");
    expect(veyranConnect.command).toBe("node");
    expect(String(veyranConnect.command)).not.toMatch(/^[/~]/);
    expect(veyranConnect.args).toEqual(["${PLUGIN_ROOT}/dist/server.mjs"]);
    expect(veyranConnect.cwd).toBe("${PLUGIN_ROOT}");
    for (const key of Object.keys(veyranConnect))
      expect(["type", "command", "args", "env", "cwd"]).toContain(key);
  });

  it.skipIf(!pluginExists)("keeps schema versions consistent", () => {
    const plugin = readJson(path.join(pluginRoot, "plugin.json"));
    const mcp = readJson(path.join(pluginRoot, "mcp.json"));
    expect(String(plugin.$schema)).toContain("/1.0.0/");
    expect(String(mcp.$schema)).toContain("/1.0.0/");
  });

  it.skipIf(!pluginExists)("ships a valid, discriminating SKILL.md", () => {
    const skill = readFileSync(
      path.join(pluginRoot, "skills/veyran/SKILL.md"),
      "utf8"
    );
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(frontmatter).toBeTruthy();
    const yaml = frontmatter?.[1] ?? "";
    expect(yaml).toMatch(/^name:\s*veyran\s*$/m);
    expect(yaml).toMatch(/^description:\s*\S+/m);
    expect(skill).toMatch(/never instructions/i);
    expect(skill).toMatch(/\bdelete\b/);
    expect(skill).toMatch(/`sync: "unknown"`|sync unknown/);
  });
});

/**
 * The Codex local-plugin marketplace manifest. `plugin/` is the marketplace
 * root (it contains `.agents/`), and the `local` source path is resolved
 * *relative to that root*, so the entry must resolve to the real
 * `plugin/veyran-connect` bundle directory.
 */
describe("local marketplace manifest", () => {
  const pluginExists = existsSync(path.join(pluginRoot, "plugin.json"));
  // `plugin/` contains `.agents/`, so it is the marketplace root.
  const marketplaceRoot = path.resolve(pluginRoot, "..");
  const marketplaceFile = path.join(
    marketplaceRoot,
    ".agents",
    "plugins",
    "marketplace.json"
  );

  it.skipIf(!pluginExists)(
    "declares one local veyran-connect plugin with a relative, in-root source",
    () => {
      // Read unconditionally (never skip on the file's own existence):
      // a missing manifest must fail, not silently pass.
      const marketplace = readJson(marketplaceFile);

      // Exact top-level shape — the installed Codex schema is only
      // {name, interface, plugins}; no invented fields.
      expect(Object.keys(marketplace).sort()).toEqual([
        "interface",
        "name",
        "plugins"
      ]);
      expect(marketplace.name).toBe("veyran-local");

      const iface = marketplace.interface as Record<string, unknown>;
      expect(Object.keys(iface)).toEqual(["displayName"]);
      expect(typeof iface.displayName).toBe("string");
      expect(String(iface.displayName).trim().length).toBeGreaterThan(0);

      const plugins = marketplace.plugins as Record<string, unknown>[];
      expect(Array.isArray(plugins)).toBe(true);
      expect(plugins).toHaveLength(1);

      const entry = plugins[0];
      expect(Object.keys(entry).sort()).toEqual([
        "category",
        "name",
        "policy",
        "source"
      ]);
      expect(entry.name).toBe("veyran-connect");

      // The marketplace plugin id must match the bundle's plugin.json name.
      const plugin = readJson(path.join(pluginRoot, "plugin.json"));
      expect(entry.name).toBe(plugin.name);

      const source = entry.source as Record<string, unknown>;
      expect(Object.keys(source).sort()).toEqual(["path", "source"]);
      expect(source.source).toBe("local");
      expect(source.path).toBe("./veyran-connect");

      // The path must be relative, must not escape the marketplace root and
      // must not carry an absolute/placeholder prefix.
      const sourcePath = String(source.path);
      expect(path.isAbsolute(sourcePath)).toBe(false);
      expect(sourcePath).not.toMatch(/^[/~]/);
      expect(sourcePath).not.toMatch(/(^|\/)\.\.(\/|$)/);
      expect(sourcePath).not.toMatch(/\$\{/);

      // Canonical resolution: resolved from the marketplace root, the source
      // must be exactly the real bundle directory (and it must be a bundle).
      expect(path.resolve(marketplaceRoot, sourcePath)).toBe(pluginRoot);
      for (const rel of ["plugin.json", "mcp.json", "skills/veyran/SKILL.md"])
        expect(existsSync(path.join(pluginRoot, rel))).toBe(true);

      const policy = entry.policy as Record<string, unknown>;
      expect(Object.keys(policy).sort()).toEqual([
        "authentication",
        "installation"
      ]);
      // No auth on install; broker/app pairing + optional Inbox key are ON_USE.
      expect(policy.installation).toBe("AVAILABLE");
      expect(policy.authentication).toBe("ON_USE");

      expect(typeof entry.category).toBe("string");
      expect(String(entry.category).trim().length).toBeGreaterThan(0);

      // No credential-like key can appear anywhere in the manifest.
      expect(JSON.stringify(marketplace)).not.toMatch(
        /"?(secret|token|password|credential|api[_-]?key|pin)"?\s*:/i
      );
    }
  );
});
