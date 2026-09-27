# VeyraN Backend / Auth Migration Audit

**Branch:** `agent/claude-backend-auth` · **Worktree:** `agents/claude-backend-auth`
**Date opened:** 2026-09-26
**Status:** Audit complete; implementation revised after review rounds 2 and 3; live E2E unverified (§10); open items: host singleton (§11.6), NODE_ENV=test hosts (§11.7), adoption UI (§12.7). NOT integration-complete.

> **Evidence convention used throughout this document**
>
> - **VERIFIED** — read directly in this worktree's source, or observed in a live read-only probe recorded here.
> - **INFERRED** — deduced from client code about a _server-side_ contract we have not observed.
> - **ASSUMED** — stated by intent/planning only; no code or live evidence yet.
>
> Nothing in this file may be promoted from INFERRED/ASSUMED to VERIFIED without a citation
> (`file:line`) or a recorded probe result.

---

## 1. Client host-configuration chain (VERIFIED)

The client resolves backend hosts through a single mutable module-level object, overridden in
layers. Understanding this chain is a precondition for any safe retarget.

### 1.1 Layer 0 — compiled-in defaults

`packages/core/src/utils/constants.ts:34-56` exports a mutable `hosts` object. Production values
are selected by `isProduction()` (`packages/core/src/utils/constants.ts:28-32`), which is true when
`NODE_ENV` is `production` **or `test`**:

| Host key             | Production default (today)               | Dev default             |
| -------------------- | ---------------------------------------- | ----------------------- |
| `API_HOST`           | `https://api.notesnook.com`              | `http://localhost:5264` |
| `AUTH_HOST`          | `https://auth.streetwriters.co`          | `http://localhost:8264` |
| `SSE_HOST`           | `https://events.streetwriters.co`        | `http://localhost:7264` |
| `SUBSCRIPTIONS_HOST` | `https://subscriptions.streetwriters.co` | `http://localhost:9264` |
| `ISSUES_HOST`        | `https://issues.streetwriters.co`        | `http://localhost:2624` |
| `MONOGRAPH_HOST`     | `https://monogr.ph`                      | `http://localhost:6264` |
| `NOTESNOOK_HOST`     | `https://notesnook.com`                  | `http://localhost:8787` |

Note there is **no `FILES_HOST`** in this list — see §1.5.

### 1.2 Layer 1 — `db.host()` runtime mutation

`packages/core/src/api/index.ts:489-497` — `host()` assigns each key onto the same module-level
`Hosts` object, using `||` so a falsy/absent value leaves the existing default in place. This is a
**global mutation**, not per-instance state; there is exactly one host table per process.

### 1.3 Layer 2 — web build-time env override

`apps/web/src/common/db.ts:31-34`:

```ts
function getHostUrl(hostUrl: keyof typeof hosts, defaultUrl: string) {
  if (IS_TESTING) return defaultUrl;
  const envValue = import.meta.env[`NN_${hostUrl}`];
  return envValue || defaultUrl;
}
```

- `apps/web/vite.config.ts:49` sets `envPrefix: "NN_"`, so `NN_API_HOST`, `NN_AUTH_HOST`, … are
  build-time substitutions.
- `IS_TESTING` is defined at `apps/web/vite.config.ts:84` as `process.env.TEST === "true"`, and
  pins tests to the hardcoded defaults regardless of env.
- **No `.env` file exists in `apps/web/`** (VERIFIED — directory listing), so today these env vars
  are unset and the hardcoded defaults win.

**Consequence for this migration:** `apps/web/src/common/db.ts:48-57` re-hardcodes the Notesnook
production hosts as `getHostUrl` fallbacks, _duplicating_ the defaults in `constants.ts`. Changing
`constants.ts` alone would **not** change web behaviour. Both sites must change together.

### 1.4 Layer 3 — user-settable `serverUrls` override (the "advanced" override)

- Web: `apps/web/src/common/db.ts:58` spreads `Config.get("serverUrls", {})` **last**, so it wins
  over both env and defaults. Stored via `apps/web/src/stores/setting-store.ts:286-295`
  (`setServerUrls`) into `Config` (persistent client-side settings).
- Overridable surface is deliberately narrow — `apps/web/src/stores/setting-store.ts:33-39`:
  ```ts
  export const HostIds = [
    "API_HOST",
    "AUTH_HOST",
    "SSE_HOST",
    "MONOGRAPH_HOST"
  ] as const;
  ```
- Mobile has a parallel definition at `apps/mobile/app/stores/use-setting-store.ts:31-37` and UI at
  `apps/mobile/app/screens/settings/server-config.tsx`.
- Web UI: `apps/web/src/dialogs/settings/components/servers-configuration.tsx`.

This is the existing mechanism the brief calls the "safe advanced development override". It
cannot be influenced by remote data — confirmed in §4.6 and §6.1.

### 1.5 File storage has no client-configured host (VERIFIED)

`packages/core/src/database/fs.ts` builds every file operation against `API_HOST`, not a separate
files host:

- `fs.ts:126`, `fs.ts:190`, `fs.ts:242`, `fs.ts:321` — `${hosts.API_HOST}/s3?name=${filename}`
- `fs.ts:335` — `${hosts.API_HOST}/s3/bulk-delete`

`/s3` is a presign endpoint; the actual blob transfer goes to whatever URL the server returns.
`files.veyran.northcore.space` is therefore a _server-side_ storage concern and needs **no client
host constant at all** — the client only needs `API_HOST` correct. Originally inferred from client
code, now **CONFIRMED** by the live probe: see §2.6.

### 1.6 Server compatibility gate (VERIFIED, enforcement point TBD)

`packages/core/src/utils/constants.ts:22-26`:

```ts
const COMPATIBLE_SERVER_VERSION = 1;
export function isServerCompatible(version: number) {
  return COMPATIBLE_SERVER_VERSION === version;
}
```

A VeyraN sync server must report version `1` exactly. The deployed server reports `1` — see §2.4.

### 1.7 Health probe contract (VERIFIED)

`packages/core/src/api/healthcheck.ts` — `GET ${host}/health`, and the client requires the response
body to trim to the exact string `"Healthy"`. Only `AUTH_HOST` is health-checked
(`HealthCheck.auth()`). Any VeyraN auth host must reproduce this exact response.

### 1.8 Host display names (VERIFIED — branding overlap)

`packages/core/src/utils/constants.ts:60-72` maps hostnames to human labels, including the literal
`"Notesnook Sync Server"`. Retargeting hosts changes this map's keys; the label strings are a
minor branding overlap noted in §8.6.

---

## 2. Live server contract verification (VERIFIED — read-only probe, 2026-09-26)

Probe constraints honoured: GET/HEAD/OPTIONS only; no credentials; no account creation; no real
user data; well under three dozen requests total. POST-only endpoints were therefore **not**
exercised — see §10.

### 2.1 Infrastructure shape

All six candidate hosts resolve to a **single IP, `57.131.192.204`**, with **one wildcard
certificate** (CN `veyran.northcore.space`, SAN `*.veyran.northcore.space` +
`veyran.northcore.space`, Let's Encrypt, issued 2026-09-25, expires 2026-12-24). This is one
reverse proxy fronting several backend containers — not six independent servers.

### 2.2 Per-host verdicts

| Host                            | Service identified                    | Verdict                                              | Decisive evidence                                                                                                 |
| ------------------------------- | ------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `veyran.northcore.space`        | Static SPA (VeyraN web client), nginx | VERIFIED                                             | `<title>VeyraN</title>`, `og:site_name: VeyraN`                                                                   |
| `auth.veyran.northcore.space`   | IdentityServer4, Kestrel              | **VERIFIED-serves-protocol**                         | `/.well-known/openid-configuration` full IS4 discovery doc; `/health` → `Healthy`                                 |
| `api.veyran.northcore.space`    | Notesnook sync server, Kestrel        | **VERIFIED-serves-protocol**                         | `/version` → `{"version":1,"id":"notesnook-sync","instance":"veyran"}`; `/health` → `Healthy`                     |
| `events.veyran.northcore.space` | SSE server, Kestrel                   | **VERIFIED-serves-protocol**                         | `/version` → `{"version":1,"id":"sse","instance":"veyran"}`; `/sse` → `401` (route exists)                        |
| `files.veyran.northcore.space`  | MinIO object store                    | VERIFIED — **infrastructure, not a client contract** | `/minio/health/live` → `200`, `server: MinIO`; `/attachments` → `403 AccessDenied` S3 XML with `x-amz-request-id` |
| `share.veyran.northcore.space`  | Monograph viewer SPA                  | VERIFIED                                             | `<title>Monograph</title>`, `monograph-view` bundle                                                               |

### 2.3 Auth server matches the client's exact OAuth2 contract (VERIFIED)

The IS4 discovery document advertises `scopes_supported`:

```
openid, notesnook.sync, IdentityServerApi, auth:grant_types:mfa,
auth:grant_types:mfa_password, offline_access
```

This is an **exact match** to the `SCOPES` array the client declares at
`packages/core/src/api/token-manager.ts:38-44`, and `grant_types_supported` includes the Notesnook
custom grants `email`, `mfa`, `mfa_password` used at `user-manager.ts:130,149,183`. The deployment
is a genuine Notesnook-compatible identity server, not a lookalike.

**Anomaly (VERIFIED, needs server-side attention):** the discovery document reports
`"issuer": "http://identity:8264"` — an internal Docker hostname over plain HTTP, not the public
`https://auth.veyran.northcore.space`. The same class of anomaly was observed upstream, so this may
be a stock deployment quirk rather than VeyraN-specific. **This is a server-side configuration
issue, not a client one, and it is out of scope for this branch.** It matters because any client or
library that performs strict OIDC issuer validation would reject these tokens. The current client
does _not_ appear to validate the issuer (it treats the token endpoint as a plain HTTP API), which
is why login is expected to work regardless — but this should be fixed server-side before any
standards-compliant client is added. Filed as an open issue in §10.

### 2.4 Sync server version gate satisfied (VERIFIED)

`api.veyran.northcore.space/version` reports `"version":1`, and
`packages/core/src/utils/constants.ts:22-26` requires `COMPATIBLE_SERVER_VERSION === 1`. The gate
passes.

### 2.5 Client-expected routes vs live routes

Every route the client depends on that could be safely probed exists. A `401` here is _positive_
evidence (route present, auth-gated); a `404` would indicate a gap. **No route the client depends on
returned 404.**

| Client call                                                                                       | Host | Live result                                | Gap                                                   |
| ------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------ | ----------------------------------------------------- |
| `POST /connect/token`                                                                             | AUTH | present in discovery `token_endpoint`      | none                                                  |
| `POST /connect/revocation`                                                                        | AUTH | present in discovery `revocation_endpoint` | none                                                  |
| `POST /account/token`, `/account/logout`, `/account/verify`, `/account/recover`, `PATCH /account` | AUTH | **not probed (mutating)**                  | UNKNOWN — see §10                                     |
| `GET /account/sessions`                                                                           | AUTH | not probed                                 | UNKNOWN                                               |
| `GET /users`                                                                                      | API  | `401`                                      | none                                                  |
| `POST /users` (signup), `/users/delete`, `/users/reset`, `PATCH /users/password/reset`            | API  | **not probed (mutating)**                  | UNKNOWN — see §10                                     |
| `GET /s3?name=`                                                                                   | API  | `401`                                      | none — confirms file traffic is proxied via API, §1.5 |
| `/hubs/sync/v2` + `/negotiate`                                                                    | API  | `401`                                      | none (SignalR route present)                          |
| `GET /sse`                                                                                        | SSE  | `401`                                      | none                                                  |
| `GET /monographs?deviceId=`                                                                       | API  | `401`                                      | none                                                  |
| `GET /announcements/active`                                                                       | API  | `200 []`                                   | none                                                  |
| `GET /health`                                                                                     | AUTH | `200 "Healthy"`                            | exact match to `healthcheck.ts`                       |

**Correction to an earlier assumption:** the events path is `/sse`
(`packages/core/src/api/index.ts:416`), **not** `/hubs/sse`. `/hubs/sse` returns `404` and is not a
real route.

### 2.6 §1.5 inference now CONFIRMED

`files.veyran.northcore.space` is the MinIO store that `api.veyran.northcore.space/s3` proxies to.
The client never addresses a files host directly. **No `FILES_HOST` client constant is needed, and
none should be added.**

### 2.7 No VeyraN backend wiring exists in the repo today (VERIFIED)

`grep -rln "veyran.northcore.space\|northcore"` across the worktree returns **zero matches** in
code, env files, or config. There is no `docker-compose*`, `infra/`, or `deploy/` directory. The
in-repo VeyraN docs (`docs/veyran-branding.md`, `resources/branding/veyran/README.md`) cover
branding, trademark, and icons only — they say nothing about a backend.

**Therefore:** today, a shipped VeyraN build still talks to Streetwriters production infrastructure
by default, and `*.veyran.northcore.space` is reachable only if a user manually types URLs into the
advanced server-configuration UI. This is precisely the gap this branch must close.

---

## 3. Production Notesnook / Streetwriters network dependency inventory (VERIFIED)

Classification scheme:

- **CORE-SELFHOST** — must move to VeyraN for independent operation (auth, sync, events, files, sharing)
- **ANCILLARY-REMOTE** — Notesnook infra but not core (subscriptions, pricing, issues, themes, updates)
- **STATIC-LINK** — URL opened in a browser; no data transmitted
- **NATIVE/BUILD** — bundle ids, ATS, deep links, CSP allowlists, updater feeds

### 3.1 Hosts with **no** VeyraN counterpart (VERIFIED by §2 probe)

The probe found VeyraN services for auth, api/sync, events, files, and share. It found **no**
VeyraN equivalent for:

| Host constant        | Current production target        | Class            | Disposition                                  |
| -------------------- | -------------------------------- | ---------------- | -------------------------------------------- |
| `SUBSCRIPTIONS_HOST` | `subscriptions.streetwriters.co` | ANCILLARY-REMOTE | Owned by brand/entitlement branch — see §8.1 |
| `ISSUES_HOST`        | `issues.streetwriters.co`        | ANCILLARY-REMOTE | Bug reporting; no VeyraN target              |
| `NOTESNOOK_HOST`     | `notesnook.com`                  | ANCILLARY-REMOTE | Pricing/checkout web endpoints               |

These must **not** be pointed at VeyraN — no service there answers them. They are also **not**
overridable via `serverUrls` (`HostIds` covers only API/AUTH/SSE/MONOGRAPH, §1.4), so they remain
hardcoded to Notesnook infra regardless of user configuration. This is the documented overlap in
§8.1.

### 3.2 🔴 Silent-fallback risks — hardcoded hosts that ignore all host configuration

These bypass the `hosts` object entirely, so neither a default change nor a `serverUrls` override
redirects them. Ranked by whether they fire during **normal** operation.

| #   | Location                                                             | Literal                                                                      | Fires during                                                        | Class            | Status           |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------- | ---------------- |
| 1   | `apps/web/src/utils/network-check.worker.ts:26`                      | `fetch("https://api.notesnook.com/health")`                                  | every sync / reconnect (`apps/web/src/stores/app-store.ts:142,355`) | CORE-SELFHOST    | **FIXED** — §9.4 |
| 2   | `apps/web/src/common/themes-router.ts:24`                            | `https://themes-api.notesnook.com`                                           | theme browsing                                                      | ANCILLARY-REMOTE | Open — §8.3      |
| 3   | `apps/mobile/app/screens/settings/theme-selector.tsx:69`             | `https://themes-api.notesnook.com`                                           | theme browsing                                                      | ANCILLARY-REMOTE | Open — §8.3      |
| 4   | `apps/desktop/src/main.ts:264-266`                                   | `setSpellCheckerDictionaryDownloadURL("http://dictionaries.notesnook.com/")` | spellcheck dictionary download                                      | ANCILLARY-REMOTE | Open — §8.3      |
| 5   | `apps/monograph/app/components/monographpost/report-modal.tsx:26,65` | `POST https://notesnook.com/api/v1/reports/submit`                           | abuse reporting on a published note                                 | ANCILLARY-REMOTE | Open — §8.4      |
| 6   | `apps/monograph/app/entry.server.tsx:93`                             | CSP `connect-src 'self' https://notesnook.com/api/v1/reports/submit`         | —                                                                   | NATIVE/BUILD     | Open — §8.4      |
| 7   | `apps/web/src/utils/changelog.ts:24`                                 | `https://api.github.com/repos/streetwriters/notesnook/releases/tags/...`     | changelog view                                                      | ANCILLARY-REMOTE | Open — §8.3      |
| 8   | `apps/mobile/app/utils/github-version.ts:56`                         | `https://api.github.com/repos/streetwriters/notesnook/releases`              | update check                                                        | ANCILLARY-REMOTE | Open — §8.3      |

Item 1 was the only silent fallback on the **auth / sync / files / events / share** path that the
brief scopes to this branch, and it is fixed. Items 2-8 are ancillary or live in
branding/theme/monograph files the brief asks me not to touch unless essential; they are documented
as overlap rather than changed.

### 3.3 Dependencies that correctly honour host configuration (no action)

`packages/core/src/api/debug.ts:33` (`ISSUES_HOST/create/notesnook`), `subscriptions.ts`,
`pricing.ts`, `offers.ts`, `circle.ts` all route through the `hosts` object. They still reach
Notesnook infra by default because their hosts have no VeyraN counterpart (§3.1), but they are
redirectable and are not _silent_ fallbacks.

### 3.4 CSP (VERIFIED)

- `apps/web` ships **no** CSP: `apps/web/public/_headers` sets `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'` but no
  `Content-Security-Policy`; `apps/web/src/index.html` has no CSP meta tag.
- `apps/desktop` sets no CSP headers (no `onHeadersReceived` anywhere in `apps/desktop/src`).
- `apps/monograph/app/entry.server.tsx:79-103` is the only real CSP, with **no wildcard**:
  `connect-src 'self' https://notesnook.com/api/v1/reports/submit`.

**Therefore the host change in this branch required no CSP edit.** Only the monograph
report-abuse endpoint (§8.4) would.

### 3.5 Deep links / associated domains (REPORT ONLY — brief forbids changing these)

- `apps/web/public/apple-app-site-association` — `"appID": "53CWBG3QUC.org.streetwriters.notesnook"`
- `apps/mobile/apple-app-site-association` — `"appID": "com.streetwriters.notesnook"`; **this file is
  malformed JSON as committed** (`"applinks:{`), and its appID disagrees with the web copy.
- `apps/mobile/android/app/src/main/AndroidManifest.xml:155` — `android:host="app.notesnook.com"`
  (no `android:autoVerify`).
- `apps/mobile/ios/Notesnook/Info.plist:52-57` — schemes `ShareMedia`, `nn`, `veyran`.
- `apps/mobile/ios/Notesnook/Notesnook.entitlements` — **no** `associated-domains` entitlement, so
  iOS universal links are inert in this build regardless of the AASA files. App Group and keychain
  group are already `group.com.ozel0t.note.notesnookpencil`.

All of the above are bundle-ID / entitlement / branding territory. **Untouched by this branch**;
handed to the branding owner (§8.5).

### 3.6 Updaters and telemetry (VERIFIED)

- **Desktop auto-update is already deliberately disabled** for this fork —
  `apps/desktop/src/utils/autoupdater.ts:20-23` carries the comment that configuring the upstream
  Notesnook endpoint "could replace this fork with an upstream build". No feed URL is configured. No
  action needed, and this is the correct posture.
- Mobile has no native updater, only the GitHub releases poll (§3.2 item 8).
- **No telemetry, analytics, or crash-reporting SDK exists anywhere in the codebase** — searched for
  Sentry, Crashlytics, PostHog, Mixpanel, Amplitude, and generic `analytics`; only false-positive
  substring matches. Issue reporting via `ISSUES_HOST` is the sole diagnostic egress.

---

## 4. Auth / session architecture (VERIFIED)

### 4.1 Protocol

OAuth2 / IdentityServer4, `client_id: "notesnook"` throughout. Endpoint constants:
`token-manager.ts:45-50` and `user-manager.ts:37-48`.

Login is a **three-leg custom-grant ladder**, not a standard password grant:

1. `authenticateEmail` (`user-manager.ts:123-136`) — `POST AUTH_HOST/connect/token`,
   `grant_type: "email"` → returns a token scoped `auth:grant_types:mfa`.
2. `authenticateMultiFactorCode` (`user-manager.ts:138-158`) — `grant_type: "mfa"` → token scoped
   `auth:grant_types:mfa_password`.
3. `authenticatePassword` (`user-manager.ts:160-236`) — `grant_type: "mfa_password"`, sending the
   **hashed** password, requesting scope `notesnook.sync offline_access IdentityServerApi`.

Each leg asserts the incoming token's scope (`user-manager.ts:142,169`), so the ladder cannot be
short-circuited.

### 4.2 Password handling

The password is never sent in cleartext. `this.db.storage().hash(password, email)`
(`user-manager.ts:88,174`) hashes it with the **email as salt** client-side. There is a legacy
fallback path: on `"Password is incorrect."` the client re-hashes with
`hash(password, email, { usesFallback: true })` and retries (`user-manager.ts:190-208`). A VeyraN
auth server must preserve this error string for the fallback to work for migrated legacy accounts.

### 4.3 Key derivation depends on a **server-supplied salt** — the crux of this migration

`user-manager.ts:99-101` (signup) and `user-manager.ts:221-231` (login):

```ts
await this.db.storage().deriveCryptoKey({ password, salt: user.salt });
```

`user.salt` comes from `fetchUser()` → `GET ${API_HOST}/users` (`user-manager.ts:345-347`). The
local master key — and therefore the decryptability of all local content — is a function of
`(password, salt_from_whichever_server_API_HOST_points_at)`.

**Consequence:** pointing `API_HOST` at a different backend changes the salt, which changes the
derived master key. Local data encrypted under the old key becomes undecryptable. The master key
also wraps `dataEncryptionKey`, `attachmentsKey`, and `monographPasswordsKey`
(`user-manager.ts:104-117`), so the blast radius is total.

This is why the migration cannot be a one-line default swap.

### 4.4 Session persistence

Token (`{access_token, refresh_token, expires_in, scope, t}`) is stored in KV under the key
`"token"` (`token-manager.ts:163-167`). Refresh fires when `Date.now() >= t + expires_in*1000`
(`token-manager.ts:82-86`), is mutex-guarded with a 10s timeout (`token-manager.ts:52-56`), and
requires the `offline_access` scope plus a refresh token (`token-manager.ts:88-94`). The token
survives app restart because it lives in the KV store, **not** in memory. Nothing in the stored
token records which backend issued it — see §5.

### 4.5 Sync / SSE / file auth

- Sync: SignalR hub `${API_HOST}/hubs/sync/v2` (`api/sync/index.ts:491`).
- Events: `EventSource ${SSE_HOST}/sse` (`api/index.ts:416`).
- Files: presign via `${API_HOST}/s3` (`database/fs.ts:126,190,242,321,335`); the blob transfer then
  goes to the URL the server returns (MinIO — §2.6).

All three ride the same access token, so all three fail together when the token is foreign to the
configured backend.

### 4.6 Does the client trust server data to set hosts? (VERIFIED — NO)

`db.host()` (`api/index.ts:489-497`) is called only from client bootstrap
(`apps/web/src/common/db.ts:47`) with values from compile-time env and local `Config`. No HTTP
response body is ever fed into it. Searching the worktree for writes to `serverUrls` finds only
`setServerUrls` (`apps/web/src/stores/setting-store.ts:286`), invoked from the settings UI.
**Confirmed: remote data cannot redirect hosts today.** Any override I add must preserve this
property.

---

## 5. Profile & local-data safety

Hard constraints restated from the brief:

1. Existing local data and profiles must survive.
2. A legacy Notesnook-cloud profile must not silently upload to VeyraN.
3. A legacy profile must not be overwritten by VeyraN data.
4. Either preserve per-profile backend affinity, or explicitly block/re-login **while preserving
   local read access**.

### 5.1 🔴 CRITICAL — changing default hosts alone destroys legacy local data (CONFIRMED in code)

This is the decisive finding of the audit. It is a fully traced, unconditional code path that needs
**no user action** beyond installing an update whose default hosts changed.

| Step | Code                    | What happens                                                                                                                                                                                                                |
| ---- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | —                       | Legacy profile has a Notesnook-issued `token` in KV and notes in SQLite.                                                                                                                                                    |
| 2    | —                       | App updates; production default hosts now point at VeyraN.                                                                                                                                                                  |
| 3    | —                       | Any authenticated call to `api.veyran.northcore.space` presents the foreign token → `401`.                                                                                                                                  |
| 4    | `utils/http.ts:178-179` | **Any** `401` from **any** host publishes `EVENTS.userUnauthorized` with the URL.                                                                                                                                           |
| 5    | `user-manager.ts:58`    | Guard is `if (url.includes("/connect/token") \|\| !(await HealthCheck.auth())) return;`. The URL is `/users`, not `/connect/token`, and VeyraN auth **returns `Healthy`** (VERIFIED §2.2) — so the guard does **not** trip. |
| 6    | `user-manager.ts:60`    | `_refreshToken(true)` POSTs the legacy refresh token to VeyraN `/connect/token` → rejected → `invalid_grant`.                                                                                                               |
| 7    | `user-manager.ts:62-69` | → `await this.logout(false, "Your token has been revoked…")`                                                                                                                                                                |
| 8    | `user-manager.ts:275`   | `logout()` → `await this.db.reset()`                                                                                                                                                                                        |
| 9    | `api/index.ts:267-289`  | `reset()` runs `storage().clear()` then **`DELETE FROM sqlite_master; VACUUM`**                                                                                                                                             |

**Consequence: total, irreversible destruction of the local note database, triggered automatically
by a host default change.** Severity: CRITICAL. Status: **CONFIRMED** — every link read in source,
and step 5's non-trip confirmed by the live probe showing VeyraN auth reports `Healthy`.

Note the cruel detail: the healthy-auth guard at step 5 exists to _protect_ users during a
Notesnook outage. A correctly-functioning VeyraN auth server defeats it. A broken VeyraN server
would be safer than a working one.

**This inverts the implementation order.** Backend affinity must land _before_ any default-host
change, or the host change is itself the bug.

### 5.2 🟠 Silent upload of legacy data to VeyraN (CONFIRMED path, narrower trigger)

`sync.send()` collects via `collection.unsynced(chunkSize, isForceSync)`
(`api/sync/collector.ts`, called from `api/sync/index.ts:280`). With `isForceSync: true`, **all**
local items are collected and pushed regardless of their `synced` flag. Login also resets the
checkpoint — `await this.db.setLastSynced(0)` at `user-manager.ts:96` (signup) and
`user-manager.ts:218` (login, when not `sessionExpired`).

So a legacy profile that survives to a force-sync against VeyraN would upload its full local
contents. In practice §5.1 usually fires first and wipes the DB, so this is the _second_ failure
mode, not the first — but it must be blocked independently, because fixing §5.1 without fixing this
would convert a data-loss bug into a data-leak bug.

### 5.3 🟡 `sessionExpired` re-login skips the checkpoint reset

`user-manager.ts:216-219` — when `sessionExpired` is true, `setLastSynced(0)` and
`devices.register()` are skipped, preserving the old checkpoint. Re-logging in against a _different_
backend while carrying a checkpoint from the _old_ backend means the client believes it is already
up to date at a timestamp that is meaningless to the new server. Consequence is ambiguous
(under-fetch or under-send rather than destruction) and is **SUSPECTED**, not confirmed. Worth a
test.

### 5.4 No backend affinity exists anywhere today (CONFIRMED)

Nothing in the stored `token` (`token-manager.ts:28-34`), the `user` object
(`user-manager.ts:280-283`, KV key `"user"`), or `lastSynced` (`api/index.ts:473-478`) records
_which backend_ the session belongs to. `serverUrls` persists the user's _current_ override, not the
_origin_ of existing data. There is no field to distinguish "this profile's data came from Notesnook
cloud" from "this profile's data came from VeyraN".

This absence is the root cause of §5.1 and §5.2.

---

## 6. Override-leak safety (VERIFIED)

### 6.1 Remote data cannot redirect hosts

Ruled out — see §4.6. `db.host()` is fed only by compile-time env and local `Config`/settings; no
HTTP response body reaches it. **This branch preserves that property: no new code path lets server
data influence host selection.**

### 6.2 No new override was added

The brief allows keeping a safe advanced/development override. The pre-existing mechanisms already
satisfy this, so **I added no new override surface** — the smallest safe change is no change here:

| Mechanism                                                             | Scope                  | Settable by remote data? | Production-reachable?                           |
| --------------------------------------------------------------------- | ---------------------- | ------------------------ | ----------------------------------------------- |
| `serverUrls` in Config/settings (§1.4)                                | API/AUTH/SSE/MONOGRAPH | No                       | Yes, by explicit user action in the settings UI |
| `NN_*` vite env (§1.3)                                                | all 7 hosts            | No — compile-time only   | Only if a build sets them                       |
| Commented LAN block, `apps/mobile/app/common/database/index.ts:54-64` | all 7                  | No                       | No — requires editing source and recompiling    |

Because no new flag was introduced, there is nothing new that could leak into production. Had one
been needed, the correct vehicle on web is the vite `define` block
(`apps/web/vite.config.ts:77-90`), whose `false` literals are dead-code-eliminated by esbuild;
mobile has **no** equivalent build-time define mechanism (VERIFIED — no react-native-config, no
babel define plugin), which is a further reason not to add one in this branch.

### 6.3 Normal onboarding requires no custom server URLs

With defaults now VeyraN (§9.1), a new user signs up, verifies, and syncs without opening the
server-configuration screen. VERIFIED for host _resolution_; the end-to-end flow itself is
**unverified** (§10).

---

## 7. Test & verification (EXECUTED)

### 7.1 Environment constraints discovered

- `isProduction()` (`packages/core/src/utils/constants.ts:28-32`) returns **true when
  `NODE_ENV === "test"`**, and vitest sets exactly that. Unit tests therefore observe the **production**
  host values directly — convenient, and what the new core test relies on.
- `IS_TESTING` is a vite `define` only (`apps/web/vite.config.ts:84`) and is **not defined under
  vitest**. A bare unit test that executes `apps/web/src/common/db.ts:32` would throw
  `ReferenceError`. This is why the web test is a source-level invariant test rather than an
  import-and-execute test.
- The repo has **no npm workspaces and no nx/turbo**; sibling packages are `file:` symlinks that are
  **not** auto-built. Tests resolving `dist/` need those built first.

### 7.2 Tests added

| File                                                       | Tests | What it locks down                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/utils/__tests__/backend-hosts.test.ts`  | 10    | Production hosts are VeyraN and https; no core host contains `notesnook.com`/`streetwriters.co`; ancillary hosts deliberately remain upstream; version gate accepts `1`; `normalizeBackendId` ignores cosmetic differences but not ports |
| `packages/core/src/api/__tests__/backend-affinity.test.ts` | 9     | **The §5.1 regression guard**: an untracked legacy profile reads as `mismatch`, not `match`; affinity recording/clearing; cosmetic host differences do not lock a user out                                                               |
| `apps/web/__tests__/backend-host-config.test.ts`           | 5     | Web bootstrap does not reintroduce hardcoded upstream fallbacks; defaults come from core; the `serverUrls` override still applies last; the connectivity probe targets the configured host                                               |

Both core test files follow the fast `src/**/__tests__/` convention, avoiding `databaseTest()` and
therefore the native sqlite dependency.

### 7.3 Results — commands actually run

```
cd packages/core && npx vitest run src/utils/__tests__/backend-hosts.test.ts
  → 10 passed, 419ms
cd packages/core && npx vitest run src/api/__tests__/backend-affinity.test.ts
  → 9 passed, 552ms
cd apps/web && npx vitest run --config vitest.config.ts __tests__/backend-host-config.test.ts
  → 5 passed, 340ms
cd packages/core && npx tsc --noEmit -p tsconfig.json
  → clean
npx eslint <all 12 changed/added files>
  → 0 errors, 3 warnings (pre-existing `no-explicit-any` on untouched lines)
cd packages/core && npx vitest run src/
  → 13 of 15 files passed (185 tests). 2 files fail: see 7.4
cd apps/web && npx vitest run --config vitest.config.ts --dir ./__tests__/
  → 4 of 5 files passed. 1 file fails: see 7.4
```

### 7.4 Pre-existing failures, NOT caused by this change

- `packages/core/src/api/sync/__tests__/collector.test.js` and `merger.test.js` (30 tests) fail in
  `databaseTest()` at `new BetterSQLite3(...)` — the native `better-sqlite3-multiple-ciphers` binding
  is not built in this environment (`clang: error: unsupported option '-maes' for target
arm64-apple-darwin27.2.0`, an Xcode 27 toolchain issue). The failure occurs while loading the
  native binding, before any host or affinity code executes.
- `apps/web/__tests__/customize-toolbar.test.ts` fails with
  `Failed to resolve entry for package "@notesnook/editor"` — an unbuilt sibling package. This branch
  does not touch the editor.

Neither failure is attributable to this work, but **neither was I able to run to green**, so the
database-level sync tests remain unexercised here (§10).

### 7.5 CI cost warning

`ios.preview.build.yml`, `android.preview.build.yml`, and `desktop.preview.yml` all include
`packages/**` in their `paths:` filter. A `packages/core/src/utils/constants.ts` change therefore
triggers **iOS, Android, and desktop preview builds** on PR, not just core/web tests. Also note
`.github/workflows/core.tests.yml` runs `test:e2e` against **real production hosts** using
`USER_EMAIL`/`USER_PASSWORD` secrets — with defaults now pointing at VeyraN, that workflow will
exercise VeyraN, and will fail unless those secrets correspond to a VeyraN account. **Flagged for
Codex/CI owner; not changed here.**

---

## 8. Branding / entitlement / theme overlap

### 8.1 Billing / subscriptions — owned by the brand/entitlement branch

`packages/core/src/api/subscriptions.ts` routes to `SUBSCRIPTIONS_HOST`
(`subscriptions.streetwriters.co`) and `NOTESNOOK_HOST` (`notesnook.com`). Per §3.1 there is no
VeyraN counterpart, and per the brief the brand/entitlement branch owns the old billing API. **This
branch does not modify billing.**

Two points to hand over:

1. **`checkoutUrl` places account details in a URL query string** —
   `packages/core/src/api/subscriptions.ts:213`:
   ```ts
   return `${hosts.NOTESNOOK_HOST}/api/v2/checkout?userId=${user.id}&email=${…}`;
   ```
   User id and email travel in a query string to `notesnook.com`. Query strings are logged by
   proxies, retained in server access logs, and leak via `Referer`. Flagged by the independent
   architecture review and **confirmed here**. Remediation belongs to the billing owner; recording
   it so it is not lost.
2. `SUBSCRIPTIONS_HOST`, `ISSUES_HOST`, and `NOTESNOOK_HOST` are **not** in `HostIds` (§1.4), so
   they cannot be redirected even by an advanced user. If the product requires that _no_ normal
   operation reaches Notesnook infra, these three need a decision from the billing/brand owner —
   not a silent repoint by this branch.

**Scope boundary for this branch:** ensure auth, sync, files, events, and share cannot silently
route to Notesnook. Billing/pricing/issues remain as-is and are documented here as overlap.

### 8.2 Third-party payment hosts (informational)

`apps/web/src/dialogs/buy-dialog/paddle.tsx:41-49` hardcodes Paddle hosts (`buy.paddle.com`,
`checkout-service.paddle.com`, `api.paddle.com`, plus sandbox variants). Paddle infrastructure, not
Notesnook — outside host substitution, but part of the billing surface the billing owner inherits.

### 8.3 Themes, dictionaries, and GitHub version checks — deliberately not changed

`themes-api.notesnook.com` (web `apps/web/src/common/themes-router.ts:24`, mobile
`apps/mobile/app/screens/settings/theme-selector.tsx:69`), `dictionaries.notesnook.com`
(`apps/desktop/src/main.ts:264-266`, note: plain **HTTP**), and the two
`api.github.com/repos/streetwriters/notesnook` release polls (§3.2 items 7-8) are hardcoded and
non-overridable.

I left these alone because: they are ancillary rather than auth/sync/files/events/share; the theme
ones live in theme files the brief asks me not to touch; and each needs a _destination_ that does not
exist yet (there is no VeyraN themes API, dictionary mirror, or release feed). **They need an owner
decision, not a repoint.** The desktop dictionary URL being plain HTTP is worth fixing on its own
merits.

### 8.4 Monograph abuse reporting — needs a VeyraN endpoint before it can move

`apps/monograph/app/components/monographpost/report-modal.tsx:26,65` POSTs the monograph id and a
report category to `https://notesnook.com/api/v1/reports/submit`, and
`apps/monograph/app/entry.server.tsx:93` pins that exact URL in the CSP `connect-src`. Since
`share.veyran.northcore.space` serves this app (§2.2), a VeyraN user reporting abuse currently sends
data to Notesnook.

Moving it requires **both** edits plus a VeyraN endpoint that does not exist. Out of scope here;
recorded as required follow-up.

### 8.5 Bundle IDs, entitlements, deep links

Reported in §3.5, untouched per the brief. Two items the branding owner should know: the mobile AASA
file is **malformed JSON**, and there is **no `associated-domains` entitlement**, so iOS universal
links do not currently function at all.

### 8.6 Host display labels

`packages/core/src/utils/constants.ts:60-72` maps hostnames to labels including the literal
`"Notesnook Sync Server"`. Retargeting hosts changes this map's **keys**; changing the **labels** is
a branding decision. Recommend leaving labels untouched in this branch and flagging to Codex.

Concretely: a VeyraN sync host will now be labelled "Notesnook Sync Server" in the
server-configuration UI. Cosmetic, user-visible, and a one-line fix that belongs to branding.

---

## 9. Implementation

Ordering principle: **affinity protection had to land before the host change**, because §5.1 proves
the host change alone destroys legacy local data. The commits are sequenced accordingly.

### 9.1 Backend affinity (new)

`packages/core/src/api/backend-affinity.ts` (new) records which backend a profile's data belongs to.

- Stored in the existing generic `kv` key/value table via a new key `backendAffinity`
  (`packages/core/src/database/kv.ts`). **No SQL migration and no schema change** — the `kv` table is
  already a generic store, so adding a key is inert for existing databases. Encryption format,
  editor, save path, and lifecycle are all untouched.
- `normalizeBackendId()` compares hostnames only, case-insensitively, ignoring trailing slashes and
  explicit default ports, but **preserving non-default ports** (so `localhost:5264` and
  `localhost:8264` are correctly different backends). A cosmetic difference must never lock a user
  out of their own data.
- **Legacy inference:** a profile with a user but no recorded affinity predates this tracking, so it
  can only have come from Notesnook cloud. `check()` returns `mismatch` for it. This is what makes
  existing installs safe rather than silently mishandled.
- Affinity is recorded on signup (`user-manager.ts`, after `fetchUser`) and on successful login —
  the points at which the data provably belongs to the authenticating backend.

### 9.2 Guard 1 — the destructive auto-logout (fixes §5.1)

`packages/core/src/api/user-manager.ts`, in the `EVENTS.userUnauthorized` subscriber: before
attempting a refresh, check affinity. On `mismatch`, log, publish `EVENTS.userSessionExpired`, and
**return without refreshing or logging out**.

Why `userSessionExpired` is the right signal: it already means "re-login required" and it does **not**
delete data. `apps/web/src/stores/user-store.ts:42-45` routes to `/sessionexpired`; local notes stay
readable. And `authenticatePassword(..., sessionExpired: true)` deliberately skips
`setLastSynced(0)` (`user-manager.ts:216-219`), so the re-login path does not reset the checkpoint
either. This is exactly the brief's "explicitly block/re-login while preserving local access",
implemented with a mechanism the clients already handle.

`logout()` itself is **unchanged** — a user-initiated logout still wipes, which is correct and
expected. Only the _automatic, server-triggered_ invocation is blocked.

### 9.3 Guard 2 — sync gate (fixes §5.2 and overwrite risk)

`packages/core/src/api/sync/index.ts`, in `Sync.start()` after the user check: on `mismatch`, stop
the connection, stop auto-sync, publish `syncAborted`, and throw an error naming both backends. This
blocks **both** directions, so legacy data is neither uploaded to VeyraN nor overwritten by it.

### 9.4 Host defaults → VeyraN, de-duplicated

Defaults were duplicated across **three** sites, which is how they drifted. Now there is one source
of truth:

| File                                       | Change                                                                                                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/utils/constants.ts`     | `API_HOST`, `AUTH_HOST`, `SSE_HOST` → `api/auth/events.veyran.northcore.space`; `MONOGRAPH_HOST` → `share.veyran.northcore.space`. `SUBSCRIPTIONS_HOST`/`ISSUES_HOST`/`NOTESNOOK_HOST` deliberately unchanged (§3.1), with a comment saying why. |
| `apps/web/src/common/db.ts`                | fallbacks now read `hosts.*` from core instead of repeating literals                                                                                                                                                                             |
| `apps/mobile/app/common/database/index.ts` | same; also stops repeating literals                                                                                                                                                                                                              |

No `FILES_HOST` was added — confirmed unnecessary (§2.6).

Also fixed: `apps/web/src/utils/network-check.worker.ts` no longer hardcodes
`api.notesnook.com/health`. The wrapper (`apps/web/src/utils/network-check.ts`) now passes
`${hosts.API_HOST}/health`, resolved on the main thread after `db.host()` overrides apply. This was
the only silent fallback on the in-scope path (§3.2 item 1).

### 9.5 What was deliberately NOT changed

Editor/save/schema/lifecycle, encryption format, bundle IDs, App Groups, keychain groups,
entitlements, Electron profile identity, encrypted local profiles, billing/subscriptions, theme
files, branding strings, and the existing `serverUrls` override surface. Overlaps documented in §8.

---

---

## 10. Explicitly unverified — no success may be claimed for these

### 10.1 Not verified live (mutating endpoints, deliberately not probed)

Read-only constraints meant **no POST/PUT/PATCH/DELETE was ever sent** to any VeyraN host.
Therefore the following are **INFERRED from route presence only**, never observed working:

- New user registration (`POST API/users`)
- Email verification (`POST AUTH/account/verify`)
- The three-leg login ladder (`POST AUTH/connect/token` × 3 grants)
- Password reset (`PATCH API/users/password/reset`, `POST AUTH/account/recover`)
- Logout / token revocation (`POST AUTH/account/logout`, `/connect/revocation`)
- Refresh / session persistence across restart
- **Any actual sync**, attachment upload/download, or monograph publish

### 10.2 Requires real credentials — cannot be done in this environment

End-to-end auth and sync verification needs a real VeyraN account and a real password. Per the
brief, **no real user data may be sent to a new service during tests**, and no credentials are
available here. Live E2E therefore **remains unverified** and must be performed by a human against
a disposable test account.

### 10.3 Requires real devices

iOS/Android behaviour (Keychain-backed token storage, ATS, universal links, background sync) cannot
be verified here. Desktop Electron profile behaviour is likewise unverified.

### 10.4 Server-side issues found but out of scope

- OIDC `issuer` is `http://identity:8264` instead of the public HTTPS URL (§2.3). Server-side
  configuration fix; would break any strict-OIDC client.

### 10.5 Standing statement

**No claim of working production VeyraN sync is made anywhere in this document or in the commits on
this branch.** What is verified is that the servers exist, speak the right protocols on the routes
that could be safely probed, and satisfy the client's version gate. Everything requiring
authentication is unverified.

---

## 11. Review round 2 — defects found in the first implementation

An independent review of commit `2c07e8953` found integration-blocking defects in my own first
attempt. All were real. Recorded here because the failure mode matters more than the fix.

### 11.1 Affinity was recorded from an unverified account (CRITICAL — fixed)

`fetchUser()` falls back to the **cached** user both on exception and on a falsy response body
(`user-manager.ts`, now `fetchUserInternal`). The first implementation called `record()` immediately
after it, so a login where the account lookup _failed_ would still bind the profile: existing
Notesnook notes got relabelled as VeyraN and became eligible to sync. The login attempt itself was
treated as proof.

Fixed: `fetchUserInternal()` now reports `fresh`, true only for a successful response from the
configured API. Affinity is recorded via `recordVerified(fresh)` and a cached user records nothing.

### 11.2 Assuming unrecorded profiles were Notesnook created the inverse leak (CRITICAL — fixed)

The first version inferred `LEGACY_BACKEND_ID` for any unrecorded profile. That is wrong in both
directions, and worse than the review stated: a pre-affinity **VeyraN** profile running a
Notesnook-configured client returned `match`, so its notes would have been uploaded to Notesnook.

Fixed: there is now an explicit `unknown` status that blocks in **both** directions. Where the user
had explicitly saved server URLs, that persisted configuration is used as real evidence
(`evidence: "persisted-config"`); a half-configured override settles nothing. Absent evidence we do
not guess.

### 11.3 Affinity ignored the identity-server trust boundary (fixed)

Affinity keyed on API hostname only, dropping scheme, path, and `AUTH_HOST` entirely. A token is
minted by the identity server, so that is the boundary that decides whether presenting it is safe.

Fixed: the record is now `{v, api, auth}` with `normalizeEndpoint` preserving **scheme** (an
http/https downgrade is not the same backend), **base path**, and **non-default ports**, while still
ignoring case, trailing slashes, and explicit default ports. The old bare-string record carries too
little information to authorise anything and is discarded on read rather than upgraded by guesswork.

### 11.4 Guards ran too late and only on sync (fixed)

The sync check ran _after_ `createConnection()` had already negotiated with the sync host, and
nothing guarded token refresh, SSE, or `fetchUser`.

Fixed, each with a test asserting no network call is attempted:

| Path                                         | Guard                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sync.start`                                 | `assertBackendAllowed()` preflight before any connection is opened; stops auto-sync so it cannot retry in a loop                                                                                                                                                              |
| `TokenManager._refreshToken` / `revokeToken` | optional `guard` callback, injected at all three construction sites                                                                                                                                                                                                           |
| `Database.connectSSE`                        | preflight before the `EventSource` is created                                                                                                                                                                                                                                 |
| `UserManager.fetchUser`                      | preflight; login and signup use the unguarded internal path, since they are what _establishes_ affinity and would otherwise deadlock an unattributable profile. Safe: they talk to the configured API with a token from the configured identity server and send no note data. |

### 11.5 Destructive logout was still reachable (fixed)

`logout()` defaults to `userInitiated: true`, preserving every existing caller's behaviour. The
automatic, server-triggered path passes `false`, which refuses to `db.reset()` a profile whose data
belongs to another backend and publishes `userSessionExpired` instead. A foreign server rejecting our
token is not authority to delete the user's notes.

### 11.6 `Database.host()` had no URL validation (fixed, with a caveat)

`host()` now validates the three account-carrying hosts before applying them and throws on malformed
URLs, non-http(s) schemes, embedded credentials, query/fragment, and **plaintext HTTP to a public
host**. Loopback and RFC1918 addresses still accept HTTP, so the established local and LAN
development overrides keep working (asserted by test).

**Caveat, not fixed:** `host()` still mutates a module-level singleton, so there is one host table
per process and no per-profile scoping. Validating the input does not change that. A correct fix is
to make host configuration instance state on `Database` and thread it through every consumer of
`utils/constants.js` — a broad refactor touching sync, fs, monographs, subscriptions and both apps.
**Out of scope for this branch; it needs its own change.** Until then, multi-profile hosts in one
process remain unsafe.

### 11.7 `NODE_ENV=test` resolves production hosts (NOT fixed — deliberate)

`isProduction()` treats `NODE_ENV === "test"` as production, so the test suite and CI resolve real
production hosts. Confirmed. I did **not** change it: flipping it would silently redirect
`core.tests.yml`'s `test:e2e` job to localhost and change the expectations of existing tests
(`healthcheck.test.ts` deliberately calls a live host). That is a CI-ownership decision, not a
drive-by edit.

Mitigation applied: a test now pins the surprising behaviour so it is visible and any change is
deliberate. **This remains a live finding**, and combined with §7.5 it means CI e2e will exercise
VeyraN with whatever credentials those secrets hold.

### 11.8 What "explicit migration" does and does not prove

`adoptCurrentBackend()` requires both explicit user confirmation and a verified response from the
configured backend, and refuses outright when a record already names a different backend — moving
data between two known backends is a migration, not a checkbox.

Stated plainly: **the client cannot prove that local data is rightfully this account's data on this
server.** No such proof is available to it. Adoption is therefore gated on informed user intent plus
proof that the backend knows the account, and is deliberately restricted to the `unknown` case. A
true Notesnook-to-VeyraN data migration is not implemented and is not attempted.

### 11.9 Integration status

The defects in §11.1-§11.6 are fixed with regression tests. §11.6's singleton caveat and §11.7
remain open and are **not** blocking in themselves, but they are unfixed architectural findings.
Live end-to-end auth and sync are still unverified (§10), so **this branch should not be treated as
integration-complete until a human runs a real login and sync against VeyraN with a disposable
account.**

---

---

## 12. Review round 3 — defects in the round-2 implementation

A further review of `160418209`/`b96d1e3de` found two more critical defects. Both were real, and both
sat in code I had written to fix the previous round. Recorded in full, because the pattern is
instructive: each fix was correct in isolation and wrong in its _order of operations_.

### 12.1 CRITICAL — the fetched account was written before the boundary was checked (fixed)

`fetchUserInternal()` called `setUser(user)` as part of fetching. Login called it and _then_ checked
affinity. So a rejected cross-backend login restored the token but left the **other backend's
identity cached over this profile's own**.

This is worse than a stale field. The cached user carries `salt`, and
`deriveCryptoKey({password, salt: user.salt})` keys all local content from it (§4.3). Overwriting it
silently replaced the profile's identity and its key-derivation input.

Fixed by separating reading from committing:

- `fetchRemoteUser()` — a **pure** read. No writes, no events, and it reads the token via
  `getToken(false, false)` so it cannot trigger a renewal while affinity is still undetermined.
- `commitFetchedUser()` — the write plus the subscription, email-confirmation and `userFetched`
  events, called only _after_ the boundary check passes.
- `fetchUserInternal()` keeps its previous behaviour for background callers.

Order in both login and signup is now: obtain token → **verify (pure read)** → **bind affinity** →
**commit identity** → derive keys.

A latent second bug died with this: `fetchUserInternal`'s subscription-change branch calls
`_refreshToken(true)`, which is now guarded. On a legacy profile with a differing subscription that
would have thrown a confusing refresh error mid-login, after the identity was already clobbered.

### 12.2 CRITICAL — `record()` ignored persisted-config evidence (fixed)

`record()` consulted only `get()` (the stored record), not the full evidence chain from `check()`. A
profile that predates affinity tracking has no record, so a fresh login **rebound it**, even when the
user had explicitly saved Notesnook hosts. The §11.2 evidence mechanism existed but the write path
walked straight past it.

`record()` now switches on `check()`:

| `check()` status                      | `record()`                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `no-user`                             | writes — nothing server-derived exists to endanger                            |
| `match` (evidence `record`)           | no-op                                                                         |
| `match` (evidence `persisted-config`) | promotes to a durable record, so attribution survives a later settings change |
| `mismatch`                            | refuses, record untouched                                                     |
| `unknown`                             | **refuses** — an unattributable profile is never adopted by logging in        |

That last row is the explicit answer to "do not silently adopt an unknown profile". A profile holding
notes it cannot attribute can no longer be bound by authenticating; it needs
`adoptCurrentBackend()` with explicit user intent. `recordVerified()` was deleted: verification is
now enforced structurally, because `fetchRemoteUser()` must return an account before `record()` is
reachable at all.

### 12.3 Signup had no rollback (fixed)

Signup persisted a token, then the user, before binding, with nothing to undo it. `signup()` now
snapshots and delegates to `signupInternal()`, restoring on any failure.

### 12.4 Transactional rollback

Both flows snapshot **all three** account-scoped KV keys — `user`, `token`, `backendAffinity` — and
restore them exactly on rejection, deleting keys that were absent rather than leaving stale values.
The key cache is cleared on restore.

### 12.5 Tests added this round

Every case is asserted against actual KV state, not just the thrown error:

- cached identity **and its salt** unchanged after a rejected login
- pre-login token restored
- existing affinity record untouched
- `isBlocked()` still true afterwards, so **no note data can sync** following a rejection
- `setLastSynced` never called — the sync checkpoint is not reset by a rejected login
- `deriveCryptoKey` never called — no key derived from the foreign salt
- saved Notesnook configuration blocks a VeyraN login and preserves state
- an unattributable profile is not adopted by logging in
- signup rollback restores user, token and affinity together
- signup on a profile with no prior account still binds and commits

### 12.6 Guards from round 2 preserved

The review confirmed the sync preflight, token-refresh, and SSE guards were well placed. All five
guard points are unchanged and verified present: `Sync.start` preflight,
`TokenManager._refreshToken`, `TokenManager.revokeToken`, `Database.connectSSE`,
`UserManager.fetchUser`, plus the non-destructive automatic `logout`.

### 12.7 Integration status

The round-3 defects are closed with regression tests. Still open and unchanged: the host singleton
(§11.6) and `NODE_ENV=test` resolving production hosts (§11.7). Live end-to-end auth and sync remain
unverified (§10).

**Consequence of §12.2 worth stating plainly:** a legacy Notesnook profile can no longer log in to
VeyraN at all without an explicit adoption step. That is intended — it is the conservative reading of
"preserve local access" — but it means the adoption path now needs UI before this is usable for
existing users. No such UI exists in this branch.
