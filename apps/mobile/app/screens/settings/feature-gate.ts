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

import type { FeatureId, FeatureResult } from "@notesnook/common";

/**
 * Which of the three states a feature-gated settings row is in.
 *
 * `useIsFeatureAvailable` resolves asynchronously, so it reports `undefined`
 * until its first `isFeatureAvailable(...)` promise settles. That "not asked
 * yet" moment is not a denial: treating it as one made every gated row flash
 * the crown badge and a disabled control - and silently swallow the tap -
 * before the (allowed) result arrived, so a client-supported feature such as
 * App Lock looked like a subscription gate the build does not actually
 * enforce. Only a *resolved* `isAllowed: false` is a denial.
 */
export type FeatureGate = "pending" | "allowed" | "denied";

export function getFeatureGate<TId extends FeatureId>(
  result: FeatureResult<TId> | undefined
): FeatureGate {
  if (!result) return "pending";
  return result.isAllowed ? "allowed" : "denied";
}

/** True only once the feature has resolved as unavailable. */
export function isFeatureDenied<TId extends FeatureId>(
  result: FeatureResult<TId> | undefined
): boolean {
  return getFeatureGate(result) === "denied";
}

export type FeatureGateResolution =
  | { gate: "allowed" }
  | { gate: "denied"; error?: string };

/**
 * Resolves a feature gate at *action time* without ever failing open.
 *
 * `result` is the hook's asynchronously-resolved value and stays `undefined`
 * until its check settles. Treating that pending window as "allowed" opened the
 * gate for a fast tap *before* the check finished - a quick tap could enter an
 * unsupported backend feature, and a merely slow check was indistinguishable
 * from an allowed one. So a pending result is resolved by awaiting a fresh
 * `check()`; a resolved result is honored as-is and never re-checked. A
 * rejection is treated as a denial (fail-closed), so a broken check can never
 * grant access.
 */
export async function resolveFeatureGate<TId extends FeatureId>(
  result: FeatureResult<TId> | undefined,
  check: () => Promise<FeatureResult<TId>>
): Promise<FeatureGateResolution> {
  let resolved = result;
  if (!resolved) {
    try {
      resolved = await check();
    } catch {
      return { gate: "denied" };
    }
  }
  if (!resolved || !resolved.isAllowed) {
    return { gate: "denied", error: resolved?.error };
  }
  return { gate: "allowed" };
}
