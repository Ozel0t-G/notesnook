# VeyraN product independence migration — in progress

Status as of 2026-09-26. This is a checkpoint, not a completion report. Branch `test` remains at `ee41914ca` for application code; none of the migration branches has been integrated.

## Before and current state

| Area | Current `test` behavior | Branch work awaiting acceptance |
| --- | --- | --- |
| Brand and entitlements | Product-facing Notesnook plan/upgrade paths remain. | `agent/claude-brand-entitlements` has signed billing and feature-policy commits, plus uncommitted UI work. Review found remaining upgrade UI, paid-plan fallback, and unverified storage limits. |
| Account and sync | Core/web defaults still include Notesnook/Streetwriters production hosts. | `agent/claude-backend-auth` has signed host and backend-affinity commits. Review found unsafe legacy-profile relabeling and incomplete auth boundary checks. Do not integrate yet. |
| Appearance | Existing themes/defaults remain. | `agent/claude-theme` has four signed commits for VeyraN Light/Dark/System. Review found upstream theme API calls, incomplete local theme selection, upstream product metadata, and a two-launch mobile migration. Do not integrate yet. |

The existing iOS/iPadOS Library, Tasks, Search, New Note navigation and All Notes/Inbox order remain intact. The main checkout's unrelated TestFlight/web changes remain uncommitted and untouched by this migration.

## Verified network findings

The backend audit at `agent/claude-backend-auth:artifacts/veyran-backend-audit.md` recorded read-only service probes. `auth.veyran.northcore.space` serves the expected IdentityServer4 discovery and `/health`; `api.veyran.northcore.space` reports compatible sync version 1; `events.veyran.northcore.space` serves SSE; `files.veyran.northcore.space` is MinIO; `share.veyran.northcore.space` serves the sharing viewer; and `veyran.northcore.space` serves the web client. Registration, login, reset, sync, attachment transfer, and sharing were **not** exercised with an account.

The client uses `API_HOST/s3` for attachment presigning; no client `FILES_HOST` contract is established. Current `test` still has Notesnook/Streetwriters auth, API, event, billing, issue, theme, dictionary, update, and abuse-reporting endpoints. A normal-operation network audit has **not** passed.

## Feature and theme policy status

The entitlement branch's first commit blocks 11 legacy subscription methods plus related billing entry points before token or HTTP access. Its second commit grants selected client-supported features without setting `isPro=true`. It still falls back to Notesnook plan values for backend-dependent features and retains paid-plan UI paths, so capability and service-limit behavior remains unresolved.

The theme branch defines VeyraN Light and Dark and includes migration logic intended to preserve custom themes. Its standalone validator passed 310 contrast/structure assertions. Mobile/web unit tests, live System switching, custom-theme selection, iPhone/iPad/macOS visual QA, and editor appearance regression have **not** passed. The themes currently contain upstream homepage/author metadata and still touch the upstream themes API.

## Safety and review gates

- Preserve GPL/AGPL notices, copyright, open-source attribution, and internal bundle/App Group/Keychain/Electron identities. No legal notices or compatibility identifiers have been removed on `test`.
- A read-only architecture review identified live Notesnook billing routes. A read-only security review confirmed that `Database.host()` mutates a global host table without URL validation, and current/legacy user records use distinct stores.
- Focused Codex branch reviews rejected the first backend-affinity implementation and the theme branch for the issues above. The entitlement branch's first commits are also held for remaining plan/UI gaps. Independent final architecture, migration, security, diff, and final acceptance reviews remain pending on an integrated build.
- No fresh registration, verification, login, password reset, session persistence, cross-client sync, file transfer, public share, editor save/reopen, Apple Pencil, ARM64, desktop, or Web release build was run for this migration. Do not infer these passed from prior navigation work.
- Claude performed the branch analysis and implementation with delegated agent tasks; commits visible so far are signed. The second Claude quota window ended on 2026-09-26 with a reported 10:30 p.m. Europe/Oslo reset. A same-thread continuation is scheduled.

## Next acceptance steps

1. Have Claude correct the backend-affinity trust boundary and add login/logout/sync regression tests, then independently review those fixes before any host-default commit is cherry-picked.
2. Have Claude finish brand/UI cleanup and replace paid-plan fallback and old storage tiers with honest VeyraN capability/limit handling.
3. Have Claude make built-in themes selectable offline, stop upstream theme calls for VeyraN themes, correct product metadata, and fix one-launch mobile migration; run theme tests and visual QA.
4. Integrate reviewed signed commits deliberately into `test`, preserving unrelated dirty files. Run focused tests, then major build/E2E and network gates. Record any unavailable live-account/device tests explicitly.

This report will be updated with integrated results before the migration can be called complete.

## Review checkpoint after the 2026-09-26 10:30 p.m. quota reset

Claude resumed all three isolated worktrees with delegated agents. A new quota limit stopped branding and theme work at a reported 3:40 a.m. Europe/Oslo reset. No implementation branch was integrated into `test`.

- **Brand:** signed commits `9f7f8cf9b`, `d2302c159`, and `937410151` remove a paid/legacy-plan fallback, remove several web purchase routes, and add an audit. Codex review still found unverified Notesnook storage/file-size tiers, reachable Notesnook help/support and mobile paywall paths, upstream trial and web subscription-update flows, and a web editor permission callback that no longer respects a silent denial. The branch is clean but blocked.
- **Backend:** signed commits `160418209`, `b96d1e3de`, and `0040a9ea0` add preflight guards, stronger host validation, and tests. Claude reported 63 new core tests and 6 web tests passing, with database-level sync tests unavailable due a native `better-sqlite3` build failure. Independent Codex review still found that a fetched remote user is saved before backend affinity is accepted; `record()` ignores saved server configuration, and signup lacks rollback. These can replace local cached identity or rebind existing notes. The branch is clean but blocked. Live account/sync was not tested.
- **Theme:** the four earlier signed commits remain. Claude's follow-up has uncommitted picker, upstream-call, metadata, migration, and test edits. It also left incidental package-lock, font, and TypeScript build-info changes that must be classified and cleaned before commits. No integration or visual/device validation occurred.

The dedicated disposable VeyraN test inbox needed for live registration and sync has been requested from the user. Until one is available, production account-flow results remain unverified. The next same-thread continuation is scheduled after the reported quota reset.
