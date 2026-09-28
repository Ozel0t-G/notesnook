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
import * as RNIap from "react-native-iap";
import { db } from "../common/database";
import { MMKV } from "../common/database/mmkv";
import { useUserStore } from "../stores/use-user-store";
import { presentSheet, ToastManager } from "./event-manager";
import SettingsService from "./settings";

async function setPremiumStatus() {
  // Identity belongs to account hydration, never legacy commercial metadata.
  useUserStore.getState().setPremium(get());
}

async function loadProductsAndSubs(): Promise<{
  subs: RNIap.Subscription[];
  products: RNIap.Product[];
}> {
  return { subs: [], products: [] };
}

function get() {
  // if (__DEV__ || Config.isTesting === "true") return true;
  return (
    useUserStore.getState().user?.subscription?.plan !== undefined &&
    useUserStore.getState().user?.subscription?.plan !== SubscriptionPlan.FREE
  );
}

const showVerifyEmailDialog = () => {
  presentSheet({
    title: strings.confirmEmail(),
    paragraph: strings.emailConfirmationLinkSent(),
    action: async () => {
      try {
        const lastVerificationEmailTime =
          SettingsService.get().lastVerificationEmailTime;
        if (
          lastVerificationEmailTime &&
          Date.now() - lastVerificationEmailTime < 60000 * 2
        ) {
          ToastManager.show({
            heading: strings.waitBeforeResendEmail(),
            type: "error",
            context: "local"
          });

          return;
        }
        await db.user.sendVerificationEmail();
        SettingsService.set({
          lastVerificationEmailTime: Date.now()
        });

        ToastManager.show({
          heading: strings.verificationEmailSent(),
          message: strings.emailConfirmationLinkSent(),
          type: "success",
          context: "local"
        });
      } catch (e) {
        ToastManager.show({
          heading: strings.failedToSendVerificationEmail(),
          message: (e as Error).message,
          type: "error",
          context: "local"
        });
      }
    },
    actionText: strings.resendEmail()
  });
};

const subscriptions = {
  trialStatus: false,
  setTrialStatus: (status: boolean) => {
    subscriptions.trialStatus = status;
  },
  /**
   *
   * @returns {RNIap.Purchase} subscription
   */
  get: () => {
    if (Platform.OS === "android") return;
    const _subscriptions = MMKV.getString("subscriptionsIOS");
    if (!_subscriptions) return [];
    return JSON.parse(_subscriptions) as (
      | RNIap.SubscriptionPurchase
      | RNIap.ProductPurchase
    )[];
  },
  /**
   *
   * @param {RNIap.Purchase} subscription
   * @returns
   */
  set: async (
    subscription: RNIap.SubscriptionPurchase | RNIap.ProductPurchase
  ) => {
    if (Platform.OS === "android") return;
    const _subscriptions = subscriptions.get();
    if (!_subscriptions) return;

    const index = _subscriptions.findIndex(
      (s) => s.transactionId === subscription.transactionId
    );
    if (index === -1) {
      _subscriptions.unshift(subscription);
    } else {
      _subscriptions[index] = subscription;
    }
    MMKV.setString("subscriptionsIOS", JSON.stringify(_subscriptions));
  },
  remove: async (transactionId: string) => {
    if (Platform.OS === "android") return;
    const _subscriptions = subscriptions.get();
    if (!_subscriptions) return;

    const index = _subscriptions.findIndex(
      (s) => s.transactionId === transactionId
    );
    if (index !== -1) {
      _subscriptions.splice(index);
      MMKV.setString("subscriptionsIOS", JSON.stringify(_subscriptions));
    }
  },
  /**
   *
   * @param {RNIap.Purchase} subscription
   */
  verify: async (
    _subscription: RNIap.SubscriptionPurchase | RNIap.ProductPurchase
  ) => {
    throw new Error("VeyraN does not verify Notesnook purchases.");
  },
  clear: async (
    _subscription?: RNIap.SubscriptionPurchase | RNIap.ProductPurchase
  ) => {
    if (Platform.OS === "android") return;
    const _subscriptions = subscriptions.get();
    if (!_subscriptions) return;
    let subscription = null;
    if (_subscription) {
      subscription = _subscription;
    } else {
      subscription = _subscriptions.length > 0 ? _subscriptions[0] : null;
    }

    if (subscription) {
      await RNIap.finishTransaction({
        purchase: subscription
      });
      await RNIap.clearTransactionIOS();
      await subscriptions.remove(subscription.transactionId as string);
    }
  }
};

const PremiumService = {
  setPremiumStatus,
  get,
  showVerifyEmailDialog,
  loadProductsAndSubs: loadProductsAndSubs,
  subscriptions
};

export default PremiumService;
