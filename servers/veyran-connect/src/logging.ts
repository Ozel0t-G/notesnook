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
 * Static, bounded diagnostics.
 *
 * The stdio MCP server must keep stdout for JSON-RPC only, and *nothing*
 * (stdout or stderr) may ever carry a credential, token, note/task payload,
 * title, id or a raw parser/SQL/provider error. Diagnostics are therefore a
 * fixed code→text catalog with an allow-listed set of numeric/boolean counters;
 * no free-form string can enter a log line.
 */

const DIAGNOSTICS = {
  SERVER_START: "stdio MCP server starting (protocol on stdout only).",
  SERVER_READY: "stdio MCP server ready.",
  SERVER_SHUTDOWN: "stdio MCP server shutting down.",
  TRANSPORT_ERROR: "stdio transport reported a protocol-level error.",
  TRANSPORT_INPUT_OVERFLOW:
    "stdio input exceeded the bounded buffer; transport closed.",
  BROKER_ATTACH_FAILED: "broker health probe failed; reporting unavailable.",
  BROKER_ATTACHED: "broker health probe succeeded.",
  CLI_START: "broker CLI starting.",
  CLI_STOP: "broker CLI stopping.",
  BROKER_LISTENING: "broker listening on its persisted loopback port.",
  BROKER_BIND_FAILED: "broker could not bind its persisted port; failing closed.",
  CONFIG_INVALID: "a persisted Connect file failed validation.",
  CONFIG_INSECURE: "a persisted Connect file failed its permission checks.",
  CONFIG_CREATED: "operator profile files created.",
  CONFIG_PRESERVED: "existing operator profile files preserved.",
  CONNECTION_EXPORTED: "app connection file written atomically.",
  CONNECTION_EXPORT_REFUSED: "app connection export refused; path not explicit.",
  PAIRING_DISPLAYED: "pairing instructions displayed on the foreground TTY.",
  PAIRING_REFUSED: "pairing requires an explicit foreground TTY.",
  INBOX_KEY_WRITTEN: "inbox API key file written atomically (0600).",
  INBOX_KEY_REFUSED:
    "inbox key setup refused; a hidden foreground TTY prompt is required.",
  INBOX_KEY_PRESERVED:
    "an existing inbox API key file was preserved; pass --replace to set a new key.",
  INBOX_CAPTURE_UNCERTAIN: "an inbox capture has an unknown outcome.",
  INBOX_CAPTURE_TRANSMITTED: "an inbox capture request was transmitted."
} as const;

export type DiagnosticCode = keyof typeof DIAGNOSTICS;

/**
 * The first line is always a fixed string; the optional suffix accepts only
 * allow-listed numeric/boolean counters (never a string, never an object).
 */
export function diagnosticLine(
  code: DiagnosticCode,
  counts?: Record<string, number | boolean>
): string {
  let line = `veyran-connect: ${DIAGNOSTICS[code]}`;
  if (counts) {
    const parts: string[] = [];
    for (const key of Object.keys(counts).sort()) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) continue;
      const value = counts[key];
      if (typeof value !== "number" && typeof value !== "boolean") continue;
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      parts.push(`${key}=${value}`);
    }
    if (parts.length) line += ` (${parts.join(" ")})`;
  }
  return line;
}

/** Write a static diagnostic to stderr. Never touches stdout. */
export function reportDiagnostic(
  code: DiagnosticCode,
  counts?: Record<string, number | boolean>
): void {
  try {
    process.stderr.write(`${diagnosticLine(code, counts)}\n`);
  } catch {
    // Diagnostics must never throw into the request path.
  }
}
