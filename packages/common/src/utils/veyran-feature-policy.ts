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
 * this") from CAPABILITY ("does this actually work here, in this app"):
 *
 * - `VEYRAN_CLIENT_SUPPORTED_FEATURES`: the feature is fully implemented by
 *   this client and only ever reads/writes the local on-device database
 *   (notes, notebooks, tags, reminders, editor/UI preferences, local
 *   history, local export/import). Nothing server-side distinguishes a
 *   free account from a paid one for these, so VeyraN grants them
 *   unconditionally — equivalent to Notesnook's top "believer" tier —
 *   without ever contacting Notesnook's billing service.
 * - `VEYRAN_BACKEND_DEPENDENT_FEATURES`: the opposite case, listed
 *   explicitly (not just "everything else") so a newly added feature must
 *   be classified on purpose instead of silently inheriting one behavior or
 *   the other. Each depends on a Notesnook-operated backend that VeyraN
 *   does not run, or does not run for a free/unpaid account:
 *     - `storage`, `fileSize`: enforced server-side by Notesnook's
 *       sync/attachment infrastructure regardless of what this client
 *       claims. Unlocking these client-side would let the UI promise
 *       uploads the server will reject, so they keep the real FREE-tier
 *       limit that Notesnook's servers actually enforce for this account.
 *     - `monographAnalytics`, `sms2FA`, `notesnookCircle`: services VeyraN
 *       does not provide at all (monograph view analytics collection, SMS
 *       delivery for 2FA, and Notesnook's own partner-offer marketplace).
 *       These stay unavailable, with an honest "not supported by this app"
 *       message instead of Notesnook's default "upgrade your plan" copy,
 *       since upgrading does nothing here.
 *
 * `getFeatureLimitFromPlan` in `is-feature-available.ts` consults
 * `isVeyranClientSupported` before falling back to the plan-derived limit,
 * which is the only integration point this policy needs.
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

export const VEYRAN_BACKEND_DEPENDENT_FEATURES: ReadonlySet<FeatureId> =
  new Set<FeatureId>([
    "storage",
    "fileSize",
    "monographAnalytics",
    "sms2FA",
    "notesnookCircle"
  ]);

export function isVeyranClientSupported(id: FeatureId): boolean {
  return VEYRAN_CLIENT_SUPPORTED_FEATURES.has(id);
}

export function isVeyranBackendDependent(id: FeatureId): boolean {
  return VEYRAN_BACKEND_DEPENDENT_FEATURES.has(id);
}
