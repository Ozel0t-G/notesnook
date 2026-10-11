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

import { SubscriptionPlan } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { Platform } from "react-native";
import { getVersion, isEmulatorSync } from "react-native-device-info";

export const IOS_APPGROUPID = "group.com.ozel0t.note.notesnookpencil";
export const FILE_SIZE_LIMIT = 500 * 1024 * 1024;
export const IMAGE_SIZE_LIMIT = 50 * 1024 * 1024;

/**
 * The only place the Apple team id is written down. It is needed to build the
 * team-prefixed keychain access group Mac Catalyst requires; nothing else
 * should hardcode it.
 */
const APPLE_TEAM_ID = "QXCNJY73A8";

/** Mac Catalyst is an iOS build whose Mac App ID has no App Group in its
 * provisioning profile, so the shared container and the unprefixed keychain
 * access group behave differently there. iPhone/iPad must not be affected. */
export function isMacCatalyst() {
  return Platform.OS === "ios" && Platform.isMacCatalyst;
}

/**
 * Access group passed to react-native-keychain.
 *
 * iOS: the App Group doubles as the Keychain access group and is declared with
 * the `$(AppIdentifierPrefix)` prefix in the entitlements, so every existing
 * install reads and writes it through the unprefixed name. Do not change this.
 *
 * Mac Catalyst: the Mac App ID's profile grants no App Group, and the Keychain
 * only accepts an access group the profile allows. Passing the unprefixed group
 * fails with errSecMissingEntitlement (-34018), which is why the database key
 * could never be stored and the database never opened on Mac. The profile does
 * grant `<team id>.*`, so the team-prefixed form of the same group is used
 * instead. Note that `getInternetCredentials`/`hasInternetCredentials` in
 * react-native-keychain 4.0.5 query without an access group at all and therefore
 * still find the item, because the prefixed group is the app's default (its only
 * `keychain-access-groups` entry).
 */
export function getKeychainAccessGroup(): string {
  return isMacCatalyst() ? `${APPLE_TEAM_ID}.${IOS_APPGROUPID}` : IOS_APPGROUPID;
}

/**
 * Whether this process can use the App Group container.
 *
 * False on Mac Catalyst: the Mac App ID is provisioned without an App Group, so
 * code that touches the shared container must fall back to the app's own
 * sandbox there instead of throwing (see getAppGroupPath).
 *
 * Also false on the iOS Simulator: a local Simulator build is signed ad hoc
 * without a provisioning profile and is installed with empty entitlements, so
 * it has no App Group container and `pathForAppGroup` is unavailable there too.
 * Physical iPhone/iPad are unaffected.
 */
export function hasAppGroupContainer(): boolean {
  return !isMacCatalyst() && !isIosSimulator();
}

/**
 * Whether this process is an iOS Simulator build.
 *
 * A local Simulator build is signed ad hoc (`CODE_SIGN_IDENTITY=-`) without a
 * provisioning profile, so it is installed with empty entitlements: there is no
 * App Group container and no Keychain access group at all, and every SecItem
 * call rejects with errSecMissingEntitlement (-34018). That is why the database
 * key is kept outside the Keychain there (see encryption.ts).
 *
 * Mac Catalyst is excluded even when it reports itself as an emulated OS: it is
 * signed normally and its team-prefixed access group does work (see
 * getKeychainAccessGroup), so it must keep the real Keychain.
 */
export function isIosSimulator(): boolean {
  return Platform.OS === "ios" && !isMacCatalyst() && isEmulatorSync();
}

/**
 * App group id for react-native-sodium (`appGroupId` on encryptFile/decryptFile).
 * `undefined` makes it use the app's own cache directory, which is what Mac
 * Catalyst has to fall back to; sodium treats a missing value as "no shared
 * container" and explicitly tolerates the NSNull it arrives as.
 */
export function getAppGroupIdForNative(): string | undefined {
  return hasAppGroupContainer() ? IOS_APPGROUPID : undefined;
}

/**
 * `appGroup` value for the background uploader (react-native-upload). It has to
 * stay a string: its native code only skips the shared container for an *empty*
 * string, while a null value arrives there as NSNull, which it would send a
 * string selector to and crash on. So Mac Catalyst passes an empty string
 * instead of `undefined`.
 */
export function getUploaderAppGroup(): string {
  return hasAppGroupContainer() ? IOS_APPGROUPID : "";
}

export const BETA = getVersion().includes("beta");

// No VeyraN store listing is configured. Old Notesnook listing URLs must
// never be used for VeyraN update or rating actions.
export const STORE_LINK: string | undefined = undefined;

export const GROUP = {
  default: "default",
  none: "none",
  abc: "abc",
  year: "year",
  week: "week",
  month: "month"
};

export const SORT = {
  dateModified: "Date modified",
  dateEdited: "Date edited",
  dateCreated: "Date created",
  title: "Title",
  dueDate: "Due date",
  relevance: "Relevance",
  dateDeleted: "Date deleted"
};

export const itemSkus = [
  "notesnook.essential.monthly",
  "notesnook.essential.yearly",
  "notesnook.pro.monthly",
  "notesnook.pro.yearly",
  "notesnook.pro.monthly.tier2",
  "notesnook.pro.yearly.tier2",
  "notesnook.pro.monthly.tier3",
  "notesnook.pro.yearly.tier3",
  "notesnook.believer.monthly",
  "notesnook.believer.yearly",
  "notesnook.believer.5year"
];

export function planToDisplayName(plan: SubscriptionPlan): string {
  switch (plan) {
    case SubscriptionPlan.FREE:
      return strings.freePlan();
    case SubscriptionPlan.ESSENTIAL:
      return strings.essentialPlan();
    case SubscriptionPlan.LEGACY_PRO:
    case SubscriptionPlan.PRO:
      return strings.proPlan();
    case SubscriptionPlan.BELIEVER:
      return strings.believerPlan();
    case SubscriptionPlan.EDUCATION:
      return strings.educationPlan();
    default:
      return strings.freePlan();
  }
}

export const SUBSCRIPTION_STATUS = {
  BASIC: 0,
  TRIAL: 1,
  BETA: 2,
  PREMIUM: 5,
  PREMIUM_EXPIRED: 6,
  PREMIUM_CANCELLED: 7
};

export const SUBSCRIPTION_STATUS_STRINGS = {
  0: "Basic",
  1: "Trial",
  2: Platform.OS === "ios" ? "Pro" : "Beta",
  5: "Pro",
  6: "Expired",
  7: "Pro (cancelled)"
};

export const SUBSCRIPTION_PROVIDER = {
  0: null,
  1: {
    type: "iOS",
    title: "Subscribed on iOS",
    desc: "You subscribed to Notesnook Pro on iOS using Apple In App Purchase. You can cancel anytime with your iTunes Account settings.",
    icon: "ios"
  },
  2: {
    type: "Android",
    title: "Subscribed on Android",
    desc: "You subscribed to Notesnook Pro on Android Phone/Tablet using Google In App Purchase.",
    icon: "android"
  },
  3: {
    type: "Web",
    title: "Subscribed on Web",
    desc: "You subscribed to Notesnook Pro on the Web/Desktop App.",
    icon: "web"
  }
};

export const EDITOR_LINE_HEIGHT = {
  DEFAULT: 1.2,
  MAX: 10,
  MIN: 1
};
