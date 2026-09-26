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

import hosts from "../src/utils/constants.ts";
import { Offers } from "../src/api/offers.ts";
import { BillingUnavailableError } from "../src/api/veyran-billing-policy.ts";
import { test, expect } from "vitest";

// VeyraN does not operate Notesnook's promo/offer billing backend (see
// artifacts/veyran-brand-entitlement-audit.md on agent/claude-brand-entitlements).
// `Offers.getCode` now fails closed before it ever reaches
// `hosts.SUBSCRIPTIONS_HOST`, so these upstream live-network cases no longer
// apply; this test instead proves the fail-closed contract holds even when
// pointed at the real host.
test("get offer code is unavailable in VeyraN", async () => {
  hosts.SUBSCRIPTIONS_HOST = "https://subscriptions.streetwriters.co";
  await expect(Offers.getCode("TESTOFFER", "android")).rejects.toBeInstanceOf(
    BillingUnavailableError
  );
});

test("get invalid offer code is unavailable in VeyraN", async () => {
  hosts.SUBSCRIPTIONS_HOST = "https://subscriptions.streetwriters.co";
  await expect(
    Offers.getCode("INVALIDOFFER", "android")
  ).rejects.toBeInstanceOf(BillingUnavailableError);
});
