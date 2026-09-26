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

import { describe, expect, it, vi } from "vitest";
import { SubscriptionPlan } from "../../types.js";
import { BillingUnavailableError } from "../veyran-billing-policy.js";
import Subscriptions from "../subscriptions.js";
import { Circle } from "../circle.js";
import { Pricing } from "../pricing.js";
import { Offers } from "../offers.js";

// Every billing/pricing/circle network call must be observable here: if any
// guarded method reaches into `http`, one of these spies fires and the test
// fails. This is the "no Notesnook request" proof for the VeyraN build.
const httpSpies = {
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn()
};
vi.mock("../../utils/http.js", () => ({
  default: {
    get: (...args: unknown[]) => httpSpies.get(...args),
    post: Object.assign((...args: unknown[]) => httpSpies.post(...args), {
      json: (...args: unknown[]) => httpSpies.post(...args)
    }),
    delete: (...args: unknown[]) => httpSpies.delete(...args),
    patch: Object.assign((...args: unknown[]) => httpSpies.patch(...args), {
      json: (...args: unknown[]) => httpSpies.patch(...args)
    })
  }
}));

/**
 * A `db` stand-in that throws if any property on it is ever read. If a
 * guarded method reached past `assertBillingEnabled` far enough to touch
 * `this.db.tokenManager` or `this.db.user`, this proxy — not just the http
 * spies — would fail the test first.
 */
function untouchableDb() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `db.${String(prop)} was accessed; billing call was not blocked before touching the database/token manager`
        );
      }
    }
  ) as any;
}

function expectNoHttpCalls() {
  expect(httpSpies.get).not.toHaveBeenCalled();
  expect(httpSpies.post).not.toHaveBeenCalled();
  expect(httpSpies.delete).not.toHaveBeenCalled();
  expect(httpSpies.patch).not.toHaveBeenCalled();
}

describe("VeyraN billing policy: Subscriptions", () => {
  it.each([
    ["cancel", () => new Subscriptions(untouchableDb()).cancel()],
    ["pause", () => new Subscriptions(untouchableDb()).pause()],
    ["resume", () => new Subscriptions(untouchableDb()).resume()],
    ["refund", () => new Subscriptions(untouchableDb()).refund("reason")],
    ["transactions", () => new Subscriptions(untouchableDb()).transactions()],
    ["invoice", () => new Subscriptions(untouchableDb()).invoice("txn-1")],
    ["updateUrl", () => new Subscriptions(untouchableDb()).updateUrl()],
    ["redeemCode", () => new Subscriptions(untouchableDb()).redeemCode("code")],
    [
      "checkoutUrl",
      () =>
        new Subscriptions(untouchableDb()).checkoutUrl(
          SubscriptionPlan.PRO,
          "monthly"
        )
    ],
    ["preview", () => new Subscriptions(untouchableDb()).preview("product-1")],
    ["change", () => new Subscriptions(untouchableDb()).change("product-1")]
  ])("%s rejects and makes no network request", async (_name, run) => {
    await expect(run()).rejects.toBeInstanceOf(BillingUnavailableError);
    expectNoHttpCalls();
  });
});

describe("VeyraN billing policy: Circle", () => {
  it.each([
    ["partners", () => new Circle(untouchableDb()).partners()],
    ["redeem", () => new Circle(untouchableDb()).redeem("partner-1")]
  ])("%s rejects and makes no network request", async (_name, run) => {
    await expect(run()).rejects.toBeInstanceOf(BillingUnavailableError);
    expectNoHttpCalls();
  });
});

describe("VeyraN billing policy: Pricing", () => {
  it.each([
    ["sku", () => Pricing.sku("apple", "monthly", "pro")],
    ["products", () => Pricing.products()]
  ])("%s rejects and makes no network request", async (_name, run) => {
    await expect(run()).rejects.toBeInstanceOf(BillingUnavailableError);
    expectNoHttpCalls();
  });
});

describe("VeyraN billing policy: Offers", () => {
  it("getCode rejects and makes no network request", async () => {
    await expect(
      Offers.getCode("PROMO", "android")
    ).rejects.toBeInstanceOf(BillingUnavailableError);
    expectNoHttpCalls();
  });
});

describe("checkoutUrl privacy", () => {
  it("never builds a URL containing the account email or id", async () => {
    // Even if VEYRAN_BILLING_DISABLED were ever flipped back, this documents
    // the exact leak the architecture review flagged: `checkoutUrl` embeds
    // `user.id` and `user.email` in a plain query string sent to Notesnook.
    // The guard above is what currently prevents it from ever being called.
    await expect(
      new Subscriptions(untouchableDb()).checkoutUrl(
        SubscriptionPlan.PRO,
        "monthly"
      )
    ).rejects.toThrow(/unavailable/i);
  });
});
