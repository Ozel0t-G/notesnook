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

import type { FeatureId } from "./is-feature-available.js";

/**
 * VeyraN feature policy — see
 * `artifacts/veyran-brand-entitlement-audit.md` on branch
 * `agent/claude-brand-entitlements` for the full inventory this is derived
 * from.
 *
 * Notesnook gates every one of its features behind a paid subscription
 * plan, checked against `user.subscription.plan`. VeyraN does not sell a
 * subscription — the billing API in `@notesnook/core`'s
 * `veyran-billing-policy` refuses to reach Notesnook's servers at all — so
 * every VeyraN account is permanently on the FREE plan. Blanket-granting
 * "pro" (`isPro = true`) was rejected because it would *also* silently claim
 * that network-backed premium services this app doesn't operate actually
 * work, which is false and would fail confusingly at the point of use.
 *
 * Instead this module splits ENTITLEMENT ("is the user allowed to use
 * this") from CAPABILITY ("does this actually work here, in this app"),
 * across three explicit, mutually exclusive buckets — every feature id must
 * land in exactly one, so a newly added feature has to be classified on
 * purpose instead of silently inheriting a default (`ALL_FEATURE_IDS` plus
 * the completeness test in `__tests__/veyran-feature-policy.test.ts`
 * enforce this):
 *
 * - `VEYRAN_CLIENT_SUPPORTED_FEATURES`: the feature is fully implemented by
 *   this client and only ever reads/writes the local on-device database
 *   (notes, notebooks, tags, reminders, editor/UI preferences, local
 *   history, local export/import). Nothing server-side distinguishes a
 *   free account from a paid one for these, so VeyraN grants them
 *   unconditionally — equivalent to Notesnook's top "believer" tier —
 *   without ever contacting Notesnook's billing service.
 * - `VEYRAN_SERVICE_MANAGED_LIMITS`: `storage` and `fileSize`. The
 *   configured service enforces real capacity. The client has no verified
 *   numeric VeyraN contract, so it permits an upload attempt and handles a
 *   server rejection. It never derives capacity from a legacy plan or
 *   promises unlimited capacity.
 * - `VEYRAN_BACKEND_DEPENDENT_FEATURES`: `monographAnalytics`, `sms2FA`,
 *   `notesnookCircle` — discrete on/off services VeyraN does not operate at
 *   all (monograph view-analytics collection, SMS delivery for 2FA, and
 *   Notesnook's own partner-offer marketplace, the last of which is
 *   unconditionally blocked at the API layer regardless of plan — see
 *   `veyran-billing-policy.ts`). Unlike storage/fileSize, a wrong guess here
 *   fails as a broken half-completed action (e.g. 2FA setup). These always resolve at the FREE tier —
 *   unavailable — regardless of what `subscription.plan` reports, with an
 *   honest "not supported by this app" message instead of Notesnook's
 *   default "upgrade your plan" copy, since upgrading does nothing here.
 *
 * `getFeatureLimitFromPlan` in `is-feature-available.ts` consults
 * `isVeyranServiceManaged`, `isVeyranClientSupported`, and
 * `isVeyranBackendDependent`. Legacy plan tiers cannot enable a capability.
 */
export const VEYRAN_CLIENT_SUPPORTED_FEATURES: ReadonlySet<FeatureId> =
  new Set<FeatureId>([
    "fullQualityImages",
    "blockLinking",
    "taskList",
    "outlineList",
    "callout",
    "colors",
    "tags",
    "notebooks",
    "activeReminders",
    "shortcuts",
    "defaultNotebookAndTag",
    "recurringReminders",
    "pinNoteInNotification",
    "createNoteFromNotificationDrawer",
    "defaultSidebarTab",
    "customHomepage",
    "markdownShortcuts",
    "fontLigatures",
    "customToolbarPreset",
    "customizableSidebar",
    "disableTrashCleanup",
    "appLock",
    "maxNoteVersions",
    "fullOfflineMode",
    "syncControls",
    "expiringNotes",
    "exportTableAsCsv",
    "importCsvToTable",
    "androidLauncherShortcuts",
    "monographLinksAndEmbeds"
  ]);

export const VEYRAN_SERVICE_MANAGED_LIMITS: ReadonlySet<FeatureId> =
  new Set<FeatureId>(["storage", "fileSize"]);

export const VEYRAN_BACKEND_DEPENDENT_FEATURES: ReadonlySet<FeatureId> =
  new Set<FeatureId>(["monographAnalytics", "sms2FA", "notesnookCircle"]);

export function isVeyranClientSupported(id: FeatureId): boolean {
  return VEYRAN_CLIENT_SUPPORTED_FEATURES.has(id);
}

export function isVeyranServiceManaged(id: FeatureId): boolean {
  return VEYRAN_SERVICE_MANAGED_LIMITS.has(id);
}

export function isVeyranBackendDependent(id: FeatureId): boolean {
  return VEYRAN_BACKEND_DEPENDENT_FEATURES.has(id);
}
