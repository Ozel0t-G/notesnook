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

import type { FeatureResult } from "@notesnook/common";
import {
  getFeatureGate,
  isFeatureDenied,
  resolveFeatureGate
} from "./feature-gate";

const result = (isAllowed: boolean): FeatureResult =>
  ({
    id: "appLock",
    isAllowed,
    caption: true,
    error: "not available"
  } as FeatureResult);

describe("settings feature gate", () => {
  /**
   * Regression: `useIsFeatureAvailable` resolves asynchronously, so a gated
   * Settings row reads `undefined` until the check settles. Treating that as
   * denied made client-supported rows (App Lock, custom toolbar, ...) flash
   * the crown badge and a disabled control, and swallow the first tap, before
   * the allowed result arrived.
   */
  test("an unresolved feature is pending, not denied", () => {
    expect(getFeatureGate(undefined)).toBe("pending");
    expect(isFeatureDenied(undefined)).toBe(false);
  });

  test("only a resolved denial is denied", () => {
    expect(getFeatureGate(result(false))).toBe("denied");
    expect(isFeatureDenied(result(false))).toBe(true);
  });

  test("a resolved allowance is allowed", () => {
    expect(getFeatureGate(result(true))).toBe("allowed");
    expect(isFeatureDenied(result(true))).toBe(false);
  });
});

describe("resolveFeatureGate (action-time gate)", () => {
  /**
   * Regression: the action-time gate must never fail open while the async
   * check is still pending. Previously a pending hook result returned `true`,
   * so a quick tap could enter an unsupported backend feature before the check
   * settled. Pending must be resolved by awaiting a fresh check.
   */
  test("pending then allowed awaits the check and allows", async () => {
    const check = jest.fn().mockResolvedValue(result(true));
    await expect(resolveFeatureGate(undefined, check)).resolves.toEqual({
      gate: "allowed"
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  test("pending then denied awaits the check, denies and reports the error", async () => {
    const check = jest.fn().mockResolvedValue(result(false));
    await expect(resolveFeatureGate(undefined, check)).resolves.toEqual({
      gate: "denied",
      error: "not available"
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  test("a resolved allowance is honored without a fresh check", async () => {
    const check = jest.fn().mockResolvedValue(result(false));
    await expect(resolveFeatureGate(result(true), check)).resolves.toEqual({
      gate: "allowed"
    });
    expect(check).not.toHaveBeenCalled();
  });

  test("a resolved denial stays blocked without a fresh check", async () => {
    const check = jest.fn().mockResolvedValue(result(true));
    await expect(resolveFeatureGate(result(false), check)).resolves.toEqual({
      gate: "denied",
      error: "not available"
    });
    expect(check).not.toHaveBeenCalled();
  });

  test("a rejected check denies instead of failing open", async () => {
    const check = jest.fn().mockRejectedValue(new Error("network"));
    const resolution = await resolveFeatureGate(undefined, check);
    expect(resolution).toEqual({ gate: "denied" });
    // No error to report, so callers must supply their own honest message
    // instead of rendering an empty toast (e.g. the 2FA picker's SMS row).
    expect(resolution).not.toHaveProperty("error");
  });

  /**
   * Regression: the 2FA method picker gates the SMS row with
   * `resolveFeatureGate(featureAvailable, () => isFeatureAvailable("sms2FA"))`.
   * `useIsFeatureAvailable` is still `undefined` on a fast tap, so the guard
   * has to await the fresh check instead of short-circuiting on the raw hook
   * value (which let the tap fail open into SMS setup). This pins the contract
   * the call site relies on: pending + a resolved sms2FA denial yields a denied
   * gate carrying the honest, app-scoped error - never an allow.
   */
  test("pending sms2FA tap denies with the honest error, never an allow", async () => {
    const smsDenied = {
      id: "sms2FA",
      isAllowed: false,
      caption: true,
      error: "SMS-based 2FA isn't available in this app."
    } as FeatureResult;
    const check = jest.fn().mockResolvedValue(smsDenied);
    await expect(resolveFeatureGate(undefined, check)).resolves.toEqual({
      gate: "denied",
      error: "SMS-based 2FA isn't available in this app."
    });
    expect(check).toHaveBeenCalledTimes(1);
  });
});
