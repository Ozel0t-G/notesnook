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
 * The in-memory MCP server factory.
 *
 * Building a server has **zero side effects**: it registers the twelve tools
 * and returns. It never reads/writes the operator profile, never pairs, never
 * probes or starts the broker. The broker is attached lazily on the first tool
 * call and then **reused** — one stdio process is one MCP caller instance with
 * one `hello` handshake and one nonce sequence — so the SDK's disposable
 * modern-probe sibling and the default legacy handshake are both side-effect
 * free. The real `McpServer` is passed to `registerVeyranTools` directly (no
 * cast), so the SDK's own `registerTool` types are what the compiler checks.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { registerVeyranTools, type ToolsOptions } from "./tools.js";

export const SERVER_NAME = "veyran-connect";
export const SERVER_VERSION = "1.0.0";

export interface BuildServerOptions {
  profileDir?: string;
  /** Test seam: replace the lazy attach with a fixed result. */
  attach?: ToolsOptions["attach"];
  /** Test seam: replace the Inbox HTTPS sender with a fake. */
  inboxSender?: ToolsOptions["inboxSender"];
}

export function buildMcpServer(options: BuildServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerVeyranTools(server, {
    profileDir: options.profileDir,
    attach: options.attach,
    inboxSender: options.inboxSender
  });
  return server;
}
