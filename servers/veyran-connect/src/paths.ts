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
 * Location of the dedicated operator profile.
 *
 * The operator profile is *only* ever the dedicated `<home>/.veyran-connect`
 * directory (or an explicit `--profile <dir>` argument). Nothing here reads or
 * writes the user's Keychain, app container or any foreign service config.
 *
 * File ownership (binding architecture):
 *  - `broker.credentials.json` — broker-owned, holds **both** the app and the
 *    MCP client 256-bit credentials; never leaves the operator profile.
 *  - `broker.config.json` — broker-owned, static persisted `brokerId` + port.
 *  - `mcp.config.json` — caller-owned (stdio server) **MCP credential only**;
 *    never contains the app credential.
 *  - `connection.export.json` — explicit, user-picked export of the app-side
 *    connection (app credential) that the sandboxed app imports into its own
 *    container/Keychain. It is written only on an explicit operator command.
 *  - `inbox.key.json` — the operator's **separate** Notesnook Inbox API key
 *    (written only by the explicit `inbox-key` CLI command, with a hidden TTY
 *    prompt). It is never the broker/app credential and is never shared with
 *    them; deleting it removes only the Inbox capture path.
 *  - `inbox.receipts.json` — bounded local write receipts for `capture_note`
 *    (stable `operationId` + canonical payload hash + local state, never a
 *    remote claim and never any part of the captured text).
 */
import os from "node:os";
import path from "node:path";

export interface OperatorPaths {
  dir: string;
  credentials: string;
  config: string;
  mcpConfig: string;
  connection: string;
  /** The separate Notesnook Inbox API key (never a broker credential). */
  inboxKey: string;
  /** Bounded local write receipts for `capture_note`. */
  inboxReceipts: string;
  /** Cross-process exclusive marker for inbox receipt/send transactions. */
  inboxLock: string;
}

export const PROFILE_DIR_NAME = ".veyran-connect";

export function defaultProfileDir(): string {
  return path.join(os.homedir(), PROFILE_DIR_NAME);
}

export function operatorPaths(profileDir?: string): OperatorPaths {
  const dir = path.resolve(profileDir ?? defaultProfileDir());
  return {
    dir,
    credentials: path.join(dir, "broker.credentials.json"),
    config: path.join(dir, "broker.config.json"),
    mcpConfig: path.join(dir, "mcp.config.json"),
    connection: path.join(dir, "connection.export.json"),
    inboxKey: path.join(dir, "inbox.key.json"),
    inboxReceipts: path.join(dir, "inbox.receipts.json"),
    inboxLock: path.join(dir, "inbox.capture.lock")
  };
}
