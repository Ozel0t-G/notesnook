# veyran-connect (plugin bundle)

A portable, self-contained agent plugin that exposes the VeyraN note/task tools
over a local stdio MCP server. All twelve Core tools talk to the loopback HTTPS
broker on `127.0.0.1:<persisted port>` through a pinned TLS chain; the server
never opens the database and never spawns the broker.

One extra, non-Core tool is registered: `capture_note`. It is the **only**
outbound path and the only tool that reaches the public network. It posts one
bounded title + plain-text/Markdown capture to the fixed official endpoint
`https://inbox.notesnook.com/` using a **separate** Inbox API key that the
operator stores locally with `veyran-connect inbox-key` (hidden TTY prompt,
never in argv, never in the environment). It is registered, and behaves, as
distinct from `create_note`: the documented response is only
`{"success":true}` — the relay encrypted and queued the item — so it reports
`inbox_accepted`/queued with `importedToDevice: false`, `noteId: null` and
`sync: "unknown"`, and never claims a note id, a link, a local creation or an
import. It needs neither the broker nor the app to be running. See
`docs/veyran-connect/MCP.md` §7.1 for enablement, the cleartext exposure to the
TLS-terminating relay, server acceptance vs device import, the bounded text
limits and the retry semantics (local receipts keyed by `operationId`; an
`INBOX_UNCERTAIN` outcome is never resent automatically).

```
plugin.json      agent-plugins 1.0.0 plugin manifest
mcp.json         stdio MCP server declaration (command: node, ${PLUGIN_ROOT})
skills/veyran/   the VeyraN skill (name: veyran)
dist/server.mjs  the bundled standalone server (git-ignored; produced by build)
LICENSE          GPL-3.0-or-later (matches the repository license)
```

## Build

`dist/server.mjs` is not committed (the repository ignores `dist`). Produce it
from an installed workspace:

```sh
cd servers/veyran-connect && npm install && npm run build
cd ../../plugin/veyran-connect && npm run build     # node ./scripts/bundle.mjs
```

`npm run build` bundles `servers/veyran-connect/src/server.ts` (the MCP SDK
included) into `dist/server.mjs`, enforced by the same purity guard as the
server package; it invokes no package manager and needs no runtime dependencies.
The result runs standalone, outside the repository.

## Install (Codex local plugin marketplace)

This repository ships a local Codex plugin marketplace at
`plugin/.agents/plugins/marketplace.json` (marketplace id `veyran-local`) whose
single entry `veyran-connect` points at this directory with a **relative** source
path (`./veyran-connect`, resolved from the marketplace root, i.e. `plugin/`).
Because a local source references the directory **in place**, build the bundle
first (see above) — the installed plugin runs `dist/server.mjs` from here rather
than copying it.

From the repository root:

```sh
# 1. build the stdio bundle first (installed plugin runs dist/server.mjs in place)
cd servers/veyran-connect && npm install && npm run build
cd ../../plugin/veyran-connect && npm run build
cd ../..                                    # back to the repository root

# 2. register the local marketplace, then add the plugin
codex plugin marketplace add ./plugin
codex plugin add veyran-connect@veyran-local
```

`codex plugin marketplace add` and `codex plugin add` are the commands supported
by the Codex build this was verified against; run the two commands from the
repository root so `./plugin` resolves. Restart Codex if it does not pick the
plugin up in the current session.

The plugin installs **without authentication**: `policy.authentication` is
`ON_USE` because broker/app pairing and the optional Inbox key happen only when a
tool is actually used, never at install time.

Adding this plugin does **not** replace an existing direct MCP server entry named
`veyran`: the plugin adds the separate stdio server id `veyran-connect`, and a
pre-existing `veyran` server (if any) is left untouched. Likewise the skill name
is `veyran` while the plugin id is `veyran-connect` — separate identifiers.

## Configure

The server reads only its own `0600` `mcp.config.json` (MCP credential, public
root CA and leaf pin — never the app credential). The operator CLI creates it:

```sh
node servers/veyran-connect/dist/cli.mjs setup
node servers/veyran-connect/dist/cli.mjs broker   # foreground; keep running
```

### Inbox capture (optional, separate key)

`capture_note` needs one extra, optional step: enable the Inbox API in your
Notesnook account (`Settings > Account > Inbox API`), create an Inbox API key
there, and store it once in the operator profile with a hidden TTY prompt:

```sh
node servers/veyran-connect/dist/cli.mjs inbox-key             # hidden prompt
node servers/veyran-connect/dist/cli.mjs inbox-key --replace   # rotate it
```

The key is written `0600` into the existing `0700` profile as
`inbox.key.json`; it is **not** a broker credential and is never copied into
`mcp.config.json`. Until it exists, `capture_note` fails closed with
`INBOX_NOT_CONFIGURED`. Revoking the key in the Notesnook app invalidates it
everywhere, including any copy on disk.

The stdio server id declared in `mcp.json` is `veyran-connect`. If your global
MCP configuration already defines a direct server named `veyran`, this bundle
adds a separate entry and leaves that one untouched.

Pass `--profile <dir>` in `mcp.json`'s `args` if you use a non-default profile
location (the default is `~/.veyran-connect`). Until the broker is running, the
Core tools honestly report `BROKER_UNAVAILABLE`; nothing is auto-spawned.
`capture_note` does not use the broker at all: its only prerequisite is the
stored Inbox key.

## Rollback

1. Stop the agent/MCP client and any running `dist/server.mjs` (`Ctrl-C`).
2. Stop the foreground broker (`Ctrl-C` in the terminal running
   `veyran-connect broker`).
3. **Remove the plugin registration and the marketplace entry.** If your Codex
   build provides removal subcommands, remove the plugin first and then the
   marketplace:

   ```sh
   codex plugin remove veyran-connect@veyran-local
   codex plugin marketplace remove ./plugin
   ```

   Only `marketplace add` and `plugin add` were verified against the Codex build
   here; if your build has no `remove` forms, delete the `veyran-connect` entry
   (and the `veyran-local` marketplace) through Codex's own plugin
   configuration, or remove or keep the checked-in
   `plugin/.agents/plugins/marketplace.json` entry itself.
4. Remove this plugin directory if you no longer want the checked-out bundle.
5. Optionally remove your operator profile (`~/.veyran-connect` or the
   `--profile` directory), which also deletes the local `inbox.key.json` copy
   and the capture receipts. Deleting the file is **not** a revocation: revoke
   the Inbox API key in the Notesnook app
   (`Settings > Account > Inbox API > API Keys`) to make every copy useless.

Rollback removes **only** this plugin and the operator profile you created.
It never clears, reconfigures or deletes any other (foreign) service or config.
Any data written through the tools stays in the user's own VeyraN database;
notes captured through `capture_note` stay in the user's Notesnook account
(delete them there, as with any other note).
