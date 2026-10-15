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

import type { User } from "@notesnook/core";
import { useMemo } from "react";
import { strings } from "@notesnook/intl";
import { useSettingStore } from "../../stores/use-setting-store";
import { useUserStore } from "../../stores/use-user-store";
import type { SettingSection } from "./types";

type AccountSessionState = { expired: boolean; setupRequired: boolean };

/** The session flags the recovery row keys its visibility on. */
function useAccountSessionState(): AccountSessionState {
  const expired = useSettingStore((state) => state.settings.sessionExpired);
  const setupRequired = useUserStore((state) => state.accountSetupRequired);
  return useMemo(
    () => ({ expired: expired === true, setupRequired: setupRequired === true }),
    [expired, setupRequired]
  );
}

export function createAccountSection(
  managementSections: SettingSection[],
  signOut: () => Promise<unknown>,
  /**
   * Optional: open the ordinary VeyraN sign-in screen. When provided, the
   * incomplete/expired session gets a real, actionable row (a normal
   * `type`-less row so it becomes a button — a `component` row is rendered
   * disabled). It never signs out, resets or clears anything.
   */
  signIn?: () => void
): SettingSection {
  const recoverySections: SettingSection[] = signIn
    ? [
        {
          id: "veyran-account-recovery",
          name: strings.signInToVeyran(),
          description: strings.reloginToYourAccount(),
          icon: "login",
          useHook: () => useAccountSessionState(),
          hidden: (current) => {
            const { expired, setupRequired } =
              (current as AccountSessionState) || {};
            return !(expired || setupRequired);
          },
          modifer: () => signIn()
        }
      ]
    : [];
  return {
    id: "account",
    name: strings.account(),
    useHook: () => useUserStore((state) => state.user),
    hidden: (user) => !user,
    sections: [
      {
        id: "veyran-account-identity",
        name: strings.veyranAccount(),
        type: "component",
        icon: "account-outline",
        useHook: () => useUserStore((state) => state.user),
        description: (user) => (user as User)?.email || ""
      },
      {
        id: "veyran-account-session",
        name: (current) => {
          const { expired, setupRequired } = current as AccountSessionState;
          return setupRequired
            ? strings.accountSetupNeedsAttention()
            : expired
            ? strings.sessionExpired()
            : strings.veyranAccountSession();
        },
        description: (current) => {
          const { expired, setupRequired } = current as AccountSessionState;
          return setupRequired
            ? strings.accountSetupIncomplete()
            : expired
            ? strings.reloginToYourAccount()
            : "";
        },
        useHook: () => useAccountSessionState(),
        type: "component",
        icon: "shield-check-outline"
      },
      ...recoverySections,
      ...managementSections,
      {
        id: "logout",
        name: strings.signOut(),
        description: strings.signOutLocalDataWarning(),
        icon: "logout",
        showActionProgress: true,
        modifer: async () => {
          await signOut();
        }
      }
    ]
  };
}

export function createSignedOutAccountSection(
  signIn: () => void
): SettingSection {
  return {
    id: "account-signed-out",
    name: strings.account(),
    useHook: () => useUserStore((state) => state.user),
    hidden: (user) => !!user,
    sections: [
      {
        id: "veyran-sign-in",
        name: strings.signInToVeyran(),
        description: strings.signInToVeyranDesc(),
        icon: "login",
        modifer: signIn
      }
    ]
  };
}

export function createLocalDataSection(
  deleteLocalData: () => void
): SettingSection {
  return {
    id: "local-data",
    name: strings.data(),
    useHook: () => useUserStore((state) => state.user),
    hidden: (user) => !!user,
    sections: [
      {
        id: "delete-data",
        type: "danger",
        name: strings.deleteLocalData(),
        description: strings.deleteLocalDataDesc(),
        icon: "delete",
        modifer: deleteLocalData
      }
    ]
  };
}
