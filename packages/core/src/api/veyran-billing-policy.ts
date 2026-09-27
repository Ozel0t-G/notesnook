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
 * VeyraN entitlement policy note (see artifacts/veyran-brand-entitlement-audit.md
 * in the agent/claude-brand-entitlements branch):
 *
 * This build does not operate, and must never call, Notesnook's commercial
 * billing/marketing backend (subscriptions, checkout, pricing, Notesnook
 * Circle partner offers). Every client-supported feature is granted locally
 * by the VeyraN feature policy in `@notesnook/common`'s `is-feature-available`
 * module instead of a paid plan — this is a deliberate per-feature capability
 * decision, never a blanket "isPro = true".
 *
 * The classes in subscriptions.ts, circle.ts, and pricing.ts are Notesnook's
 * original commercial-billing API clients. They are kept in the tree for
 * upstream compatibility and possible future re-enablement, but every method
 * on them is routed through `assertBillingEnabled` below, which throws
 * *before* touching the access token, `fetch`, or any Notesnook host
 * constant. `VEYRAN_BILLING_DISABLED` is the single switch; flipping it back
 * to `false` restores the original upstream behavior verbatim.
 */
export const VEYRAN_BILLING_DISABLED = true;

export class BillingUnavailableError extends Error {
  constructor(action: string) {
    super(`${action} is unavailable in VeyraN.`);
    this.name = "BillingUnavailableError";
  }
}

export function assertBillingEnabled(action: string): void {
  if (VEYRAN_BILLING_DISABLED) throw new BillingUnavailableError(action);
}
