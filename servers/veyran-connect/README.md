# @notesnook/veyran-connect

Loopback HTTPS broker + stdio MCP server for the VeyraN Connect surface. One
pure Core contract, two roles, three separate identities.

See `../../docs/veyran-connect/MCP.md` for the full protocol, TLS and native
contract, and `INSTALL.md` for the Root install/lockfile/build sequence.

## Pieces

- `src/broker.ts` — the bounded RAM-only request queue and the app/MCP state
  machines (instances, nonces, immutable per-session binding, TTL cleanup).
- `src/https.ts` — the loopback HTTPS edge (POST-only, exact `Host`, no
  `Origin`/hop-by-hop/compression, immediate-overflow body reads).
- `src/tls.ts` / `src/certs.ts` — the pinned chain and the dedicated root/leaf
  generation + Node-side validation.
- `src/client.ts` — the MCP-side pinned HTTPS client (`hello` handshake,
  per-instance nonces).
- `src/tools.ts` — the twelve tools derived mechanically from the Core contract,
  with correlated output validation and honest uncertainty.
- `src/cli.ts` — the operator CLI (`setup`, `export-connection`, `mcp-config`,
  `broker`, `status`).
- `src/server.ts` / `src/mcp.ts` — the side-effect-free stdio entry point.

## Commands

```sh
npm install && npm run build
npm run typecheck
npm test

node dist/cli.mjs setup
node dist/cli.mjs broker                       # foreground, singleton
node dist/cli.mjs export-connection --out <path>
```

## Security properties (enforced, not aspirational)

- HTTPS on `127.0.0.1` only, with a private root CA and an exact leaf DER pin;
  the pinned handshake precedes any credential byte.
- Two separate 256-bit credentials (app vs MCP); no credential is ever logged,
  echoed or passed through argv/env.
- `0700` profile directory, `0600` files, `lstat`+`O_NOFOLLOW`+`fstat` reads,
  atomic `O_EXCL`+`fsync`+`rename` writes.
- Any `Origin` refused; exact `Host`; no compression; bounded body/response;
  immediate overflow close.
- Per-instance monotonic nonces; a restart handshakes afresh. Session changes
  purge the old account's queued work. Cancel before claim removes; after claim
  is uncertain (retry with the same `operationId`).
- All error text is a static catalog; `sync` is always `unknown`.

## Rollback

Stop the broker, remove the MCP server from the client config, and optionally
delete `~/.veyran-connect`. Nothing clears or takes over a foreign service.
