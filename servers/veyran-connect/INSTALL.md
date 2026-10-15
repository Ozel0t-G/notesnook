# Local VeyraN Connect setup

The MCP server is a local stdio process. Note/task operations reach the paired
VeyraN app through an authenticated loopback-only TLS broker; the MCP process
never opens the app database or encrypted server data. `capture_note` is the
separate, optional Notesnook Inbox path described in `docs/veyran-connect/MCP.md`.

## Requirements and build

Use Node.js 22.10 or newer and the checked-in package lockfile. From the
repository root:

```sh
cd servers/veyran-connect
npm ci
npm run typecheck
npm run typecheck:test
npm test
npm run build
cd ../../plugin/veyran-connect
npm run build
```

The server and plugin builds are self-contained. The plugin bundle is written to
`plugin/veyran-connect/dist/server.mjs`; build artifacts are ignored by Git.
No runtime package manager or `npx` invocation is needed.

## Pair the local app and Codex

The local operator profile defaults to `~/.veyran-connect` and is created with
restrictive permissions. In a terminal, build the server first, then:

```sh
node servers/veyran-connect/dist/cli.mjs setup
node servers/veyran-connect/dist/cli.mjs broker
```

Keep the broker running in that terminal. Export a pairing file only when you
are ready to import it in VeyraN Settings → VeyraN Connect; the export contains
credentials, so keep it private and remove it after import. The app must be
unlocked and the matching account active for reads and writes. Capabilities in
`status` reflect grants the user actually enabled.

The current Codex CLI supports the repository-local marketplace format:

```sh
codex plugin marketplace add ./plugin
codex plugin add veyran-connect@veyran-local
```

The marketplace and plugin have already been added on this development machine.
Restart Codex if the current window has not loaded the new tools. If pairing is
not imported or the client is unavailable, MCP reports that state; it does not
pretend that data was saved.

## Optional Inbox capture

`capture_note` uses the official Notesnook Inbox API and a separate user-created
Inbox API key. Enable Inbox API in the app, then run
`node servers/veyran-connect/dist/cli.mjs inbox-key` from an interactive
terminal. The key is entered through a hidden prompt and stored in the private
operator profile. Never paste it into a chat, tool argument, shell command or
environment variable. No real Inbox request is made by tests.

Captures have local idempotency receipts, bounded to the newest 256 operations.
If two MCP processes race, an atomic profile lock serializes them. A crash can
leave `~/.veyran-connect/inbox.capture.lock`; the server fails closed with
`INBOX_BUSY`. To recover, first stop every MCP/plugin process that uses this
profile, verify none remain, then remove that exact stale lock file manually.
Do not delete it while a process may own it. The receipt journal is local and
finite; after an old receipt is evicted, it cannot guarantee deduplication for
that old operation ID.

An accepted Inbox response means only that the remote Inbox accepted/queued the
encrypted item. It is not a locally imported note and has no note ID or opening
link. The client imports through its existing sync/decryption path. The TLS
terminating endpoint necessarily handles the request text before encryption;
this integration does not claim end-to-end encryption from the MCP process to
the user's device.

## Stop and remove

Stop the foreground broker and Codex/plugin MCP process with Ctrl-C. Remove the
plugin using Codex's plugin-management UI/CLI if desired. Revoke an Inbox key in
the VeyraN/Notesnook account settings before removing its local copy. Removing
the local profile also removes pairing credentials and receipts, so only do so
when you intend to disconnect this local installation. No public service is
required for local Codex use.
