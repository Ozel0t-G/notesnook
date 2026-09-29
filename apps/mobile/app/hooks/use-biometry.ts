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

import { strings } from "@notesnook/intl";
import React from "react";
import BiometricService, { BiometryKind } from "../services/biometrics";

const NAMES: Record<BiometryKind, string> = {
  faceId: "Face ID",
  touchId: "Touch ID",
  opticId: "Optic ID",
  none: ""
};

const SYMBOLS: Record<BiometryKind, string> = {
  faceId: "faceid",
  touchId: "touchid",
  opticId: "opticid",
  none: "lock.fill"
};

let cached: BiometryKind | undefined;
// Resolved once at startup so synchronous labels (settings rows) are right.
void BiometricService.biometryKind().then((value) => {
  cached = value;
});

/** Synchronous best-known lock title for static settings rows. */
export function cachedBiometryLockTitle() {
  const kind = cached || "none";
  return kind === "none"
    ? strings.passcodeLock()
    : strings.biometryAndPasscode(NAMES[kind]);
}

export function cachedBiometryName() {
  return NAMES[cached || "none"];
}

/** The device's biometry as the UI should name and draw it. */
export function useBiometry() {
  const [kind, setKind] = React.useState<BiometryKind>(cached || "none");
  React.useEffect(() => {
    let alive = true;
    BiometricService.biometryKind().then((value) => {
      cached = value;
      if (alive) setKind(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return {
    kind,
    name: NAMES[kind],
    symbol: SYMBOLS[kind],
    /** "Face ID & Passcode" / "Passcode Lock" (iOS Settings wording). */
    lockTitle: kind === "none" ? strings.passcodeLock() : strings.biometryAndPasscode(NAMES[kind]),
    unlockTitle:
      kind === "none"
        ? strings.unlockWithBiometrics()
        : strings.unlockWithBiometryName(NAMES[kind])
  };
}

export async function biometryLockTitle() {
  const kind = await BiometricService.biometryKind();
  return kind === "none"
    ? strings.passcodeLock()
    : strings.biometryAndPasscode(NAMES[kind]);
}
