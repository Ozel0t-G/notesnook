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
 * Real SDK stdio handshake against the **built** `dist/server.mjs` (default
 * legacy initialize) and the complete route through the actual bundled
 * process:
 *
 *   official SDK stdio client → dist/server.mjs (stdio)
 *     → pinned HTTPS broker → app TLS client → real Core adapter
 *
 * Requires `npm run build` first; a missing bundle **fails** the suite (it never
 * skips). This proves stdout is protocol-only, exactly the twelve tools are
 * advertised with no visible `operation` field, an honest `BROKER_UNAVAILABLE`
 * is returned with no broker, and a real note create round-trips through the
 * whole stack.
 *
 * The default client below is constructed with **no options**: the pinned SDK's
 * default `versionNegotiation` is `legacy`, so these cases prove the legacy
 * path only. The explicit `mode: "auto"` case is added separately.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ensureSecureDir } from "../src/secure-files.js";
import { saveMcpConfig } from "../src/config.js";
import { createHarness, type ConnectHarness } from "../../../packages/core/__tests__/connect/fixtures.js";
import {
  AppConnection,
  makeProfile,
  startAppLoop,
  startBroker,
  type StartedBroker
} from "./harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "../dist/server.mjs");
const built = existsSync(serverPath);

const dirs: string[] = [];
const brokers: StartedBroker[] = [];
const loops: { stop: () => void }[] = [];
const fixtures: ConnectHarness[] = [];
const clients: Client[] = [];

async function tempProfile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyran-connect-stdio-"));
  dirs.push(dir);
  const profile = path.join(dir, "profile");
  await ensureSecureDir(profile);
  return profile;
}

async function connect(profile: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--profile", profile],
    cwd: path.dirname(serverPath)
  });
  const client = new Client({ name: "veyran-connect-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(transport);
  return client;
}

afterAll(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const loop of loops.splice(0)) loop.stop();
  for (const broker of brokers.splice(0)) await broker.stop();
  for (const fixture of fixtures.splice(0)) await fixture.close().catch(() => undefined);
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("built stdio server (real SDK client)", () => {
  // This is a critical integration test: it must FAIL (not silently skip) when
  // the bundle is absent, so a broken build can never look green.
  beforeAll(() => {
    if (!built)
      throw new Error(
        `dist/server.mjs is missing (${serverPath}); run "npm run build" before the tests.`
      );
  });

  it("advertises exactly the twelve Core tools plus capture_note, with no visible operation field", async () => {
    const profile = await tempProfile();
    const material = await makeProfile();
    await saveMcpConfig(path.join(profile, "mcp.config.json"), {
      v: 1,
      brokerId: material.credentials.app.id,
      port: 47829,
      client: material.credentials.mcp,
      tls: { rootPem: material.tls.rootPem, leafPin: material.tls.leafPin }
    });
    const client = await connect(profile);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "append_to_note",
        "capture_note",
        "complete_task",
        "create_note",
        "create_task",
        "get_note",
        "list_notebooks",
        "list_task_lists",
        "list_tasks",
        "search_notes",
        "status",
        "update_note",
        "update_task"
      ].sort()
    );
    for (const tool of tools) {
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      );
      expect(properties).not.toContain("operation");
      // Every Core tool is closed-world; `capture_note` is the one exception:
      // it talks to the fixed public Inbox endpoint, and says so.
      if (tool.name === "capture_note") {
        expect(tool.annotations?.openWorldHint).toBe(true);
        expect(tool.annotations?.readOnlyHint).toBe(false);
        expect(tool.annotations?.destructiveHint).toBe(false);
      } else {
        expect(tool.annotations?.openWorldHint).toBe(false);
      }
    }
    const write = tools.find((tool) => tool.name === "update_note");
    expect(write?.annotations?.readOnlyHint).toBe(false);
    expect(write?.annotations?.destructiveHint).toBe(true);
  });

  it("negotiates the SDK's explicit auto mode and lists the same thirteen tools", async () => {
    const profile = await tempProfile();
    const material = await makeProfile();
    await saveMcpConfig(path.join(profile, "mcp.config.json"), {
      v: 1,
      brokerId: material.credentials.app.id,
      port: 47829,
      client: material.credentials.mcp,
      tls: { rootPem: material.tls.rootPem, leafPin: material.tls.leafPin }
    });
    // The SDK's *default* negotiation is legacy; `mode: "auto"` is an explicit
    // opt-in that probes the modern path with a disposable sibling server. The
    // probe must stay bounded (`maxRetries: 0`) and side-effect free.
    const before = (await fs.readdir(profile)).sort();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, "--profile", profile],
      cwd: path.dirname(serverPath)
    });
    const client = new Client(
      { name: "veyran-connect-auto-test", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: "auto",
          probe: { timeoutMs: 2_000, maxRetries: 0 }
        }
      }
    );
    clients.push(client);
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "append_to_note",
        "capture_note",
        "complete_task",
        "create_note",
        "create_task",
        "get_note",
        "list_notebooks",
        "list_task_lists",
        "list_tasks",
        "search_notes",
        "status",
        "update_note",
        "update_task"
      ].sort()
    );
    // The modern probe must not touch the profile...
    expect((await fs.readdir(profile)).sort()).toEqual(before);
    // ...and must not start a broker: with no broker listening the tool
    // honestly reports BROKER_UNAVAILABLE.
    const status = await client.callTool({ name: "status", arguments: {} });
    expect(status.isError).toBe(true);
    expect(
      (status.structuredContent as { code?: string } | undefined)?.code
    ).toBe("BROKER_UNAVAILABLE");
  });

  it("exits on stdin EOF without waiting for the unref'd exit guard", async () => {
    const profile = await tempProfile();
    const material = await makeProfile();
    await saveMcpConfig(path.join(profile, "mcp.config.json"), {
      v: 1,
      brokerId: material.credentials.app.id,
      port: 47829,
      client: material.credentials.mcp,
      tls: { rootPem: material.tls.rootPem, leafPin: material.tls.leafPin }
    });
    const child = spawn(process.execPath, [serverPath, "--profile", profile], {
      cwd: path.dirname(serverPath),
      stdio: ["pipe", "pipe", "pipe"]
    });
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr)
      throw new Error("stdio child did not expose its pipes");
    // Drain both pipes so the child can never block writing; only stdin is
    // relevant to the EOF signal.
    stdout.resume();
    stderr.resume();
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code))
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.end();
    // The 2s exit guard is a *last resort*; a normal EOF must terminate the
    // process well before it. Racing at 1900ms proves termination is driven by
    // the closed stdin pipe (the shown lifecycle `close()`), not the guard.
    const settled = await Promise.race([
      exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_900))
    ]);
    if (settled === "timeout") child.kill("SIGKILL");
    expect(settled).not.toBe("timeout");
    expect(settled).toBe(0);
  });

  it("reports an honest BROKER_UNAVAILABLE with no fabricated success", async () => {
    const profile = await tempProfile();
    const material = await makeProfile();
    await saveMcpConfig(path.join(profile, "mcp.config.json"), {
      v: 1,
      brokerId: material.credentials.app.id,
      port: 47829,
      client: material.credentials.mcp,
      tls: { rootPem: material.tls.rootPem, leafPin: material.tls.leafPin }
    });
    const client = await connect(profile);
    const result = await client.callTool({ name: "status", arguments: {} });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { code?: string } | undefined;
    expect(structured?.code).toBe("BROKER_UNAVAILABLE");
  });

  it("keeps secrets and context out of stdout/stderr diagnostics", async () => {
    const profile = await tempProfile();
    const material = await makeProfile();
    await saveMcpConfig(path.join(profile, "mcp.config.json"), {
      v: 1,
      brokerId: material.credentials.app.id,
      port: 47830,
      client: material.credentials.mcp,
      tls: { rootPem: material.tls.rootPem, leafPin: material.tls.leafPin }
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, "--profile", profile],
      cwd: path.dirname(serverPath),
      stderr: "pipe"
    });
    const stderrChunks: string[] = [];
    const errStream = (transport as unknown as { stderr?: NodeJS.ReadableStream }).stderr;
    errStream?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
    const client = new Client({ name: "veyran-connect-log-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);
    await client.callTool({ name: "status", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const diagnostics = stderrChunks.join("");
    expect(diagnostics).not.toContain(material.credentials.mcp.secret);
    expect(diagnostics).not.toContain(material.credentials.mcp.id);
    expect(diagnostics).not.toContain("Bearer");
    expect(diagnostics).not.toContain(material.tls.leafPin);
  });

  it("round-trips a real note create through the whole bundled stack", async () => {
    const harness = await createHarness();
    fixtures.push(harness);
    const material = await makeProfile();
    const started = await startBroker(material);
    brokers.push(started);
    const app = new AppConnection({
      port: started.port,
      credential: material.credentials.app,
      rootPem: material.tls.rootPem,
      leafPin: material.tls.leafPin
    });
    await app.session(harness.accountId, 1);
    loops.push(startAppLoop(app, "app-cli", (request) => harness.adapter.execute(request)));

    const profile = await tempProfile();
    await saveMcpConfig(path.join(profile, "mcp.config.json"), {
      v: 1,
      brokerId: started.broker.brokerId,
      port: started.port,
      client: material.credentials.mcp,
      tls: { rootPem: material.tls.rootPem, leafPin: material.tls.leafPin }
    });
    const client = await connect(profile);

    const created = await client.callTool({
      name: "create_note",
      arguments: {
        operationId: "op-stdio-create-1",
        notebookId: harness.notebookId,
        title: "Stdio note",
        content: "hello from stdio",
        format: "plaintext"
      }
    });
    expect(created.isError).toBeFalsy();
    const body = created.structuredContent as { noteId?: string; persisted?: string };
    expect(body.persisted).toBe("local_saved");
    expect(typeof body.noteId).toBe("string");

    const listed = await client.callTool({
      name: "list_notebooks",
      arguments: {}
    });
    expect(listed.isError).toBeFalsy();
  });
});
