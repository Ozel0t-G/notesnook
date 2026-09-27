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

import http from "../utils/http.js";
import constants from "../utils/constants.js";
import TokenManager from "./token-manager.js";
import { assertCredentialDestination } from "../utils/credential-host-binding.js";

const ENDPOINTS = {
  setup: "/mfa",
  enable: "/mfa",
  disable: "/mfa",
  recoveryCodes: "/mfa/codes",
  send: "/mfa/send"
};

class MFAManager {
  constructor(
    private readonly tokenManager: TokenManager,
    private readonly pendingLoginCredential?: () => Promise<
      { accessToken: string; authHost: string } | undefined
    >
  ) {}

  async setup(type: "app" | "sms" | "email", phoneNumber?: string) {
    const token = await this.tokenManager.getAccessToken();
    if (!token) return;
    return await http.post(
      `${constants.AUTH_HOST}${ENDPOINTS.setup}`,
      {
        type,
        phoneNumber
      },
      token
    );
  }

  async enable(type: "app" | "sms" | "email", code: string) {
    return this._enable(type, code, false);
  }

  /**
   *
   * @param {"app" | "sms" | "email"} type
   * @param {string} code
   * @returns
   */
  async enableFallback(type: "app" | "sms" | "email", code: string) {
    return this._enable(type, code, true);
  }

  async _enable(
    type: "app" | "sms" | "email",
    code: string,
    isFallback: boolean
  ) {
    const token = await this.tokenManager.getAccessToken();
    if (!token) return;
    return await http.patch(
      `${constants.AUTH_HOST}${ENDPOINTS.enable}`,
      { type, code, isFallback },
      token
    );
  }

  async disable() {
    const token = await this.tokenManager.getAccessToken();
    if (!token) return;
    return await http.delete(
      `${constants.AUTH_HOST}${ENDPOINTS.disable}`,
      token
    );
  }

  async codes() {
    const token = await this.tokenManager.getAccessToken();
    if (!token) return;
    return await http.get(
      `${constants.AUTH_HOST}${ENDPOINTS.recoveryCodes}`,
      token
    );
  }

  async sendCode(method: "sms" | "email") {
    // The email grant is intentionally kept only in memory until the account
    // has been verified. A fresh profile has no persisted token to read here.
    const pending = await this.pendingLoginCredential?.();
    if (pending) {
      const url = `${pending.authHost}${ENDPOINTS.send}`;
      assertCredentialDestination(pending.accessToken, url);
      return await http.post(url, { type: method }, pending.accessToken);
    }
    const token = await this.tokenManager.getAccessToken([
      "IdentityServerApi",
      "auth:grant_types:mfa"
    ]);
    if (!token) throw new Error("Unauthorized.");
    const url = `${constants.AUTH_HOST}${ENDPOINTS.send}`;
    assertCredentialDestination(token, url);
    return await http.post(
      url,
      {
        type: method
      },
      token
    );
  }
}

export default MFAManager;
