# VeyraN brand & entitlement audit

Branch `agent/claude-brand-entitlements`. Records the inventory, classification, and
implementation decisions for: (1) removing Notesnook commercial upgrade/subscription
UX from normal product surfaces, and (2) a centralized VeyraN feature policy that
distinguishes entitlement (is the user allowed) from capability (does it actually
work here), instead of a blanket `isPro = true`. Product identity/branding work
(display name, icon, bundle/App-record naming) is already recorded in
`docs/veyran-branding.md`; this file is scoped to commercial UX and entitlements.

## Classification legend

Every meaningful `Notesnook`/`Streetwriters`/`Pro`/`Upgrade`/`Trial`/`Subscribe`/
pricing reference or feature gate found in this audit falls into one of:

- **A — legal attribution**: license headers, copyright notices, `LICENSE`/`NOTICE.md`,
  upstream credit. Always preserved, never touched.
- **B — internal identity**: `@notesnook/*` package names, bundle IDs, App Group,
  Keychain group/service strings, Electron `appId`/user-data directory, `.nnbackup`
  UTI, `nn://` stored links, DB/collection/storage keys, App Lock sentinel. Always
  preserved.
- **C — development reference**: comments, test fixtures, build scripts, internal
  type/variable names not shown to users. Left alone unless they leak into UI.
- **D — product-facing legacy branding**: user-visible copy (titles, labels, toasts,
  dialogs). Candidate for VeyraN rewording; only touched here where it also was
  commercial-upgrade copy (see below) — a broader class-D sweep across the ~140
  files that reference "Notesnook"/"Pro"/"Upgrade" in UI strings is **not** done in
  this pass (see "Not done" at the end).
- **E — network dependency**: requires a Notesnook-operated backend (billing,
  Circle marketplace, monograph analytics, SMS 2FA, sync/auth/attachments). Must be
  reported honestly rather than pretended to work.

## 1. Billing entry points: fail closed (packages/core)

Independent architecture review found `packages/core/src/api/subscriptions.ts`
still reached live Notesnook billing hosts, including `checkoutUrl` embedding the
account email/id in a plain query string to `NOTESNOOK_HOST`. `circle.ts`,
`pricing.ts`, and `offers.ts` had the same class of problem (all call
`SUBSCRIPTIONS_HOST`/`NOTESNOOK_HOST` directly).

**Fix** (commit `fae8698e1`): `packages/core/src/api/veyran-billing-policy.ts`
exports `assertBillingEnabled(action)`, which throws `BillingUnavailableError`
before any of these methods touches the access token, `fetch`, or a host
constant. `VEYRAN_BILLING_DISABLED = true` is the single switch. Guarded:
`Subscriptions.{cancel,pause,resume,refund,transactions,invoice,updateUrl,
redeemCode,checkoutUrl,preview,change}`, `Circle.{partners,redeem}`,
`Pricing.{sku,products}`, `Offers.getCode`.

**Tests**: `packages/core/src/api/__tests__/veyran-billing-policy.test.ts` (17
cases) prove, for every guarded method, that no `http.get/post/delete/patch` call
fires and that the database/token manager is never touched (a `Proxy` that throws
on any property read stands in for `db`). `packages/core/__e2e__/offers.test.js`
was rewritten to assert the fail-closed contract instead of a live-network
snapshot; its stale snapshot was removed.

**Out of scope, not edited**: `packages/core/src/utils/constants.ts` (the host
constants themselves) — backend-auth branch territory.

## 2. Centralized VeyraN feature policy (packages/common)

`packages/common/src/utils/is-feature-available.ts` is Notesnook's existing
feature-gate engine: 35 features, each with a per-plan `Limit`
(free/essential/pro/believer/legacyPro). It resolves a user's plan via
`db.user.getUser().subscription.plan`.

New module `packages/common/src/utils/veyran-feature-policy.ts` classifies every
one of the 35 feature ids into exactly one of two sets (verified by test, no gaps,
no overlap):

### VEYRAN_CLIENT_SUPPORTED_FEATURES (30 features)

Fully implemented by the client, touching only the local on-device database or a
pure UI/editor preference: `fullQualityImages`, `blockLinking`, `taskList`,
`outlineList`, `callout`, `colors`, `tags`, `notebooks`, `activeReminders`,
`shortcuts`, `defaultNotebookAndTag`, `recurringReminders`,
`pinNoteInNotification`, `createNoteFromNotificationDrawer`, `defaultSidebarTab`,
`customHomepage`, `markdownShortcuts`, `fontLigatures`, `customToolbarPreset`,
`customizableSidebar`, `disableTrashCleanup`, `appLock`, `maxNoteVersions`,
`fullOfflineMode`, `syncControls`, `expiringNotes`, `exportTableAsCsv`,
`importCsvToTable`, `androidLauncherShortcuts`, `monographLinksAndEmbeds`.

These resolve at the **believer** (top) tier for every VeyraN account,
unconditionally — this is the "entitlement" half: nothing server-side
distinguishes a free from a paid account for these, and billing is disabled, so
gating them behind a payment this app doesn't sell would just be broken UX.

### VEYRAN_BACKEND_DEPENDENT_FEATURES (5 features)

`storage`, `fileSize`, `monographAnalytics`, `sms2FA`, `notesnookCircle`. These
**always** resolve at the **free** tier — regardless of what
`user.subscription.plan` actually says. This was the substance of a Codex
integration-review finding against the first draft of this policy (see
"Correction after review" below).

- `storage`, `fileSize`: enforced server-side by Notesnook's sync/attachment
  infrastructure. VeyraN cannot verify a paid tier's quota still applies to a
  given account, so it does not infer or display one — the FREE-tier number is
  the only one this app can vouch for. Error copy no longer says "not available
  on this plan" (misleading — implies paying fixes it); it now states the real
  limit plainly (`"You have used all of your 50MB/mo of storage."`,
  `"Files up to 10MB are supported."`).
- `monographAnalytics`, `sms2FA`, `notesnookCircle`: services VeyraN does not
  operate at all (monograph view-analytics collection, SMS delivery for 2FA,
  Notesnook's own partner-offer marketplace — the last is hard-blocked at the API
  layer by `Circle.partners`/`Circle.redeem` in §1). Error copy states this
  honestly (`"...isn't available in this app."`), not "upgrade your plan."

### Correction after review: paid/legacy accounts

The first version of this policy left backend-dependent features falling back to
`PLAN_TO_AVAILABILITY[plan]` when the id wasn't client-supported — i.e. it assumed
every VeyraN account is always on the FREE plan (true for a brand-new signup,
since billing is disabled) but did not account for a user signing into VeyraN with
an **already-existing, still-active** Notesnook Pro/Believer/Education/Legacy-Pro
account (sync and auth are untouched by this branch, so such a login is real).
Codex's review correctly flagged that this let a paid/legacy account's
`subscription.plan` field silently mark `monographAnalytics`/`sms2FA`/
`notesnookCircle` as `isAllowed: true` — `notesnookCircle` in particular is a lie
in every case, since its API is unconditionally blocked by §1 regardless of plan.

**Fix**: `getFeatureLimitFromPlan` now checks `isVeyranBackendDependent(id)`
*before* falling back to the account's plan, forcing `"free"` unconditionally.
Tests added: `packages/common/src/utils/__tests__/veyran-feature-policy.test.ts`
now mocks `db.user.getUser()` to return a PRO/BELIEVER/EDUCATION/LEGACY_PRO
subscription and asserts every backend-dependent feature still resolves the
FREE-tier `Limit` object (not the account's real tier), while every
client-supported feature still resolves believer regardless of the account's
plan. A further block asserts the actual `isFeatureAvailable()` outputs a paid
account would see in the UI: `isAllowed: false` and honest, non-"plan" error text
for `notesnookCircle`/`sms2FA`/`monographAnalytics`, and the real FREE-tier
caption (not a paid one) for `storage`/`fileSize`. 184 test cases total, all
passing.

### Guard against drift

`ALL_FEATURE_IDS` (exported from `is-feature-available.ts`) plus a completeness
test ensures every current and future feature id is classified into exactly one
of the two sets — an unclassified id fails the test loudly instead of silently
inheriting a default.

## 3. Commercial UX removal (apps/web, apps/mobile)

With the feature policy above, nearly every per-feature "Upgrade"/paywall trigger
in the product is now a dead code path (the gated feature is unconditionally
allowed). The following surfaces were **not** neutralized by that alone —
each is a persistent, unconditional, or backend-dependent-only prompt — and
were addressed directly:

| Surface | File(s) | Action |
| --- | --- | --- |
| Post-login/-signup "choose a plan" redirect | `apps/web/src/views/auth.tsx` | Both `openURL("/plans", ...)` calls replaced with `openURL("/", ...)` — straight into the app. |
| `/plans`, `/checkout`, `/payments` routes | `apps/web/src/bootstrap.tsx` | Unregistered (Notesnook plan-selection, Paddle checkout, payment-return pages). |
| `/buy`, `/buy/:code` hash routes | `apps/web/src/navigation/hash-routes.tsx` | Unregistered. |
| Persistent "Upgrade to Pro" nav-menu item | `apps/web/src/components/navigation-menu/index.tsx` | Removed (was unconditional once logged in and not already subscribed — not gated by any feature check). |
| `checkFeature`/`withFeatureCheck` opening `UpgradeDialog` | `apps/web/src/common/index.ts`, `apps/web/src/common/toasts.ts` | `UpgradeDialog.show(...)` path removed entirely; every disallowed-feature outcome now shows a plain toast with the feature's honest error text, no "Upgrade" action button. |
| Monograph analytics "Upgrade" button | `apps/web/src/components/publish-view/index.tsx` | Replaced with the honest error text (no click action). |
| Editor permission-denied dialog | `apps/web/src/components/editor/tiptap.tsx` | `UpgradeDialog.show(...)` branch removed; always shows the honest toast. |
| Block-linking "Upgrade now" button | `apps/web/src/dialogs/note-linking-dialog.tsx` | Removed; honest error text only. |
| Subscription management (auto-renew, pause/resume/cancel/refund, update payment, billing history, gift-code redemption) | `apps/web/src/dialogs/settings/index.tsx` (unregisters `SubscriptionSettings`), sidebar entries for "subscription" | Settings section and sidebar entry unregistered — these all called the now-guarded `db.subscriptions.*` methods and would otherwise throw `BillingUnavailableError` when clicked. |
| Notesnook Circle (partner marketplace) | `apps/web/src/dialogs/settings/index.tsx` (unregisters `NotesnookCircleSettings`, removes sidebar entry + `CircleEmpty` icon import); `apps/mobile/app/screens/settings/settings-data.tsx` (removes the `notesnook-circle` entry) | Removed from both platforms' Settings — calls `db.circle.partners()`/`.redeem()`, guarded in §1. |
| Redeem gift code (mobile) | `apps/mobile/app/screens/settings/settings-data.tsx` | `hidden: () => true` — was only conditionally hidden before, now unconditionally hidden since `db.subscriptions.redeemCode` always throws. |

**Design choice, matching §1's pattern**: entry points are *unregistered*
(routes not added to the route table, settings sections not added to the
`SettingsGroups`/`settingsGroups` array), not deleted outright. The underlying
dialog/view files (`buy-dialog/*`, `views/plans.tsx`, `views/checkout.tsx`,
`views/payments.tsx`, `subscription-settings.ts`, `notesnook-circle-settings.ts`,
`circle-partners.tsx`, `subscription-status.tsx`, `notesnook-circle.tsx` on
mobile) remain in the tree, unreachable from normal navigation, so this is a
single-point, low-risk change to reverse if a future decision restores billing.
Each removal is documented inline with a comment pointing back to this file.

Every touched file was scanned after editing for now-unused imports
(`BuyDialog`, `UpgradeDialog`, `SubscriptionSettings`, `NotesnookCircleSettings`,
`CircleEmpty`, `isUserSubscribed`, `Pro` icon, etc.) and cleaned up — the repo's
`unused-imports/no-unused-imports` ESLint rule is `error`, and these would fail
lint otherwise.

## 4. Not done in this pass — explicit remaining scope

Being precise about what is and is not finished, per the instruction not to claim
full completion:

- **Full "Notesnook"/"Pro"/"Premium"/"Upgrade"/"Trial" product-copy sweep is not
  done.** An initial repo-wide scan found ~140 files across apps/web,
  apps/mobile, apps/desktop referencing these tokens; only the ones that were
  also active commercial-upgrade *entry points* (table above) were addressed.
  Plain product-facing labels that merely say "Notesnook" without a commercial
  action attached (e.g. some settings copy, dialog titles, accessibility labels)
  were not sTruck through this pass and remain Notesnook-branded.
- **`apps/desktop`** was not separately audited in this session (the desktop app
  shares `apps/web`'s renderer, so the fixes above apply there too, but
  desktop-specific chrome — menu bar, tray — was not re-checked for stray
  "Upgrade"/"Pro" items).
- **`packages/intl/src/strings.ts` / `locale/en.po`** were not edited. Several
  string ids (`notesnookCircle`, `notesnookCircleDesc`, `redeemGiftCode`,
  `upgradeToPro`, `upgrade`, `subDetails`, etc.) are now unused from the removed
  entry points but still defined and still used by the *unregistered* files
  described above; left alone since those files may be restored later and intl
  key removal risks breaking other locales' `.po` files, which is out of scope
  for this branch to touch without coordinating with the intl/localization
  owner.
- **The many per-feature `actionText: strings.upgrade()` / `PaywallSheet.present`
  call sites in `apps/mobile`** (roughly 40, enumerated via grep in this file's
  history) were **not** individually edited, except `sms2FA`'s (see below). With
  the feature policy in place, the ones gating a client-supported feature (the
  large majority — reminders, notebooks, tags, toolbar, shortcuts, etc.) are dead
  code paths: `isAllowed` is now always `true` for those, so the paywall branch
  never executes. The remaining live path other than `sms2FA` is
  `fileSize`/`storage` (upload-size checks — a real, honest limit, not a paywall
  wording problem needing a UI change).
  `apps/mobile/app/screens/settings/2fa.tsx`'s SMS-2FA picker *was* fixed: its
  "Upgrade" toast action and `PaywallSheet.present` call were removed, leaving
  just the honest `featureAvailable.error` toast (mirrors the web
  `checkFeature`/`toasts.ts` fix). **Residual, not fixed**: the small orange
  "Pro" crown badge icon next to the SMS option in
  `apps/web/src/dialogs/mfa/steps.tsx` (`sms2FAFeature?.isAllowed === false &&
  <Pro size={16} color="orange" />`) still visually signals "paid feature";
  clicking it now correctly shows the honest toast (via `withFeatureCheck` →
  the fixed `checkFeature`), but the badge itself wasn't swept. Likely other
  `<Pro .../>` badge usages elsewhere in the web UI (the icon is imported
  broadly) were not inventoried in this pass.
- **`packages/core/src/utils/constants.ts`** (host constants) and any
  backend/auth code were not touched, per scope — coordinate with the
  backend-auth branch if disabling/rehosting `SUBSCRIPTIONS_HOST` or
  `NOTESNOOK_HOST` themselves is ever wanted; today only the *client calls* into
  them are blocked (§1).
- **`apps/desktop` menu/tray "Upgrade" items**, if any exist independent of the
  shared web renderer, were not checked.
- A full apps/web TypeScript typecheck could not be completed end-to-end in this
  session: `@notesnook/editor`, `@notesnook/ui`, `@notesnook/theme`,
  `@notesnook/crypto`, `@notesnook/streamable-fs`, `@notesnook/desktop` are not
  built in this worktree (building the full workspace was out of scope for
  time). `@notesnook/common` was built and typechecks clean; the touched web
  files were instead verified by full diff review and a targeted grep for
  dangling references to every symbol removed (imports, identifiers) — all
  clean, no leftover references found.

## Validation performed

- `packages/core`: focused vitest run of `veyran-billing-policy.test.ts` — 17/17
  passing. Full-suite run not attempted (native `better-sqlite3-multiple-ciphers`
  fails to build in this environment — unrelated `clang: unsupported option
  '-maes'` toolchain issue, pre-existing, not caused by this branch).
- `packages/common`: focused vitest run of `veyran-feature-policy.test.ts` —
  184/184 passing. `tsc --noEmit` clean (after building `@notesnook/logger` and
  `@notesnook/common` itself so `@notesnook/core` types resolve).
- `git diff --check` clean; every touched file scanned for now-dangling
  identifiers after edits.
- No lockfile drift committed: `npm install --ignore-scripts` runs used to
  obtain local tooling left `package-lock.json`/`packages/common/package-lock.json`
  diffs that were reverted before committing, since they were unrelated
  dependency-resolution noise, not source changes.

## Commits on this branch

- `fae8698e1` — `core(billing): fail closed on all Notesnook billing entry points`
- `d2db83bd1` — `common(entitlements): grant client-supported features without billing`
- (pending at time of writing) — commercial-UX removal + the paid/legacy-account
  fix to the feature policy described in §2/§3 above.

## Cross-branch coordination notes

- **backend-auth branch**: `packages/core/src/utils/constants.ts` (host
  constants) was read but not edited. If that branch changes
  `SUBSCRIPTIONS_HOST`/`NOTESNOOK_HOST` or auth/sync behavior, re-verify §1's
  guards still sit in front of every network call in `subscriptions.ts`,
  `circle.ts`, `pricing.ts`, `offers.ts`.
- **theme branch**: not touched. `apps/web/src/dialogs/settings/index.tsx`
  imports `ScopedThemeProvider` and theme-related settings groups untouched
  besides the two removed groups (`SubscriptionSettings`,
  `NotesnookCircleSettings`), which have no theme dependency.
- **intl/localization**: several string ids used only by now-unregistered
  billing/Circle screens are candidates for eventual removal or rewording, but
  that wasn't done here (see §4) to avoid `.po` churn without that owner's
  input.

## Codex completion pass (2026-09-27)

This section supersedes the earlier "not done" list above where noted. The
signed Claude commits remain intact; this pass continues their work.

- The VeyraN feature policy now has explicit client-supported, unavailable
  service, and service-managed-limit buckets. `storage` and `fileSize` no longer
  use Notesnook FREE/PRO/legacy subscription tiers. The client attempts an
  attachment upload and lets the configured service accept or reject it; no
  unverified numeric limit or unlimited server capacity is promised.
- Core `UserManager.activateTrial` now rejects before token access or HTTP. The
  existing subscription, pricing, offers and Circle guards still reject before
  HTTP. Mobile StoreKit product loading/receipt verification is disabled, and
  purchase listeners are not registered in normal app startup.
- Normal mobile account creation and login no longer navigate to the PayWall.
  Mobile settings, user sheet, side menu, notebook/link and attachment paths no
  longer present upgrades or check a legacy plan to grant functionality. The
  Web promo announcement CTA is removed, and both clients reject remote
  announcements with upstream/commercial-plan content. Error and migration
  surfaces preserve local diagnostics without forwarding to upstream support.
- Upstream support, docs, terms, privacy, community, store, rating and update
  links were removed from normal mobile/Web flows where VeyraN-owned
  destinations are not configured. The mobile update sheet is inert and its
  historic store link is unset. Legal license and upstream source links remain.
  Deep-link recognizers and local backup folder names are compatibility data.
- Core host display labels are neutral service labels so diagnostics do not
  call the VeyraN API a Notesnook sync server after backend integration.
  Commercial/issue production host defaults use inert `.invalid` domains.
  The remaining explicit client overrides must be reviewed in the backend
  integration branch; guards still block all billing calls before HTTP.
- Focused validation: common feature/announcement-policy Vitest 191/191, Core billing
  Vitest 19/19, common `tsc --noEmit` pass, Prettier parse/format checks and
  `git diff --check` pass. Mobile TypeScript was blocked in this worktree by
  absent Detox/Jest/@react-native/typescript-config types. End-to-end account,
  UI, device and network tests remain integration gates.

### Remaining classified references

- **Legal attribution:** license headers, About/License upstream source and
  copyright references remain by design.
- **Internal compatibility:** `notesnookCircle` feature identifier,
  `@notesnook/*` packages, old deep-link formats, storage locations, and
  bundle/App Group/Keychain identifiers remain by design.
- **Unregistered legacy UI:** original billing and paywall component files
  remain in the repository for compatibility, but normal navigation no longer
  invokes them. Core billing entry points fail closed even if called directly.
- **Other workstreams:** default auth/sync/issue/CORS hosts and theme service
  routing are owned by backend/network/theme branches. They must be reviewed
  after integration; this branch alone does not pass the production network
  gate.
