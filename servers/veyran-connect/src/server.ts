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
 * The stdio MCP entry point (the bundled `dist/server.mjs`).
 *
 * Protocol frames go to stdout *only*; all diagnostics go to a static,
 * bounded stderr reporter that can never contain a token, payload, id, title
 * or a raw provider/parser/SQL error. The stdin transport keeps an aggregate
 * unread buffer of 1 MiB (the SDK's default of 10 MiB is overridden) so an
 * oversized coalesced frame closes the transport instead of buffering without
 * bound. We deliberately do **not** promise a structured tool error when the
 * transport closes on overflow: the connection is already gone.
 *
 * The `serveStdio` handle is used only through its documented `close():
 * Promise<void>` (the pinned SDK's `StdioServerHandle`); no other lifecycle
 * field is invented and no field is read by casting to a hand-written type.
 */
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildMcpServer } from "./mcp.js";
import { SERVER_LIMITS } from "./limits.js";
import { reportDiagnostic } from "./logging.js";

/** `--profile <dir>`/`--profile=<dir>` select the operator profile; no secret. */
export function parseProfileArg(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--profile") return argv[index + 1];
    if (arg.startsWith("--profile=")) return arg.slice("--profile=".length);
  }
  return undefined;
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const profileDir = parseProfileArg(argv);
  reportDiagnostic("SERVER_START");
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: SERVER_LIMITS.maxStdioBufferBytes
  });
  const handle = serveStdio(
    // The factory is side-effect free and era-agnostic: the default legacy
    // handshake and the disposable modern probe build the same stateless
    // server. Nothing is written, paired or spawned here.
    () => buildMcpServer({ profileDir }),
    {
      transport,
      maxSubscriptions: 128,
      onerror: () => {
        // Never forward the raw error: it may carry provider/host details.
        reportDiagnostic("TRANSPORT_ERROR");
      }
    }
  );
  reportDiagnostic("SERVER_READY");

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    reportDiagnostic("SERVER_SHUTDOWN");
    // The documented handle closes the pinned server **and** its transport,
    // ending the stdin/stdout streams and releasing their timers. A foreground
    // Ctrl-C or a closed stdin pipe must actually terminate the process; a
    // stuck close is bounded by a short, unref'd safety timer.
    const done = (): void => process.exit(0);
    const guard = setTimeout(done, 2_000);
    if (typeof guard.unref === "function") guard.unref();
    try {
      void Promise.resolve(handle.close())
        .catch(() => undefined)
        .finally(done);
    } catch {
      done();
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // A closed stdin pipe is the normal end of a stdio session: the SDK ends the
  // server on EOF, and this bounds the process exit.
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
}

main();
