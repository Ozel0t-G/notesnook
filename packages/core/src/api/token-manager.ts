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
import { EVENTS } from "../common.js";
import { withTimeout, Mutex } from "async-mutex";
import { logger } from "../logger.js";
import { KVStorageAccessor } from "../interfaces.js";
import EventManager from "../utils/event-manager.js";
import { bindCredential } from "../utils/credential-host-binding.js";

export type Token = {
  access_token: string;
  t: number;
  expires_in: number;
  scope: string;
  refresh_token: string;
};

type Scope = (typeof SCOPES)[number];

const SCOPES = [
  "notesnook.sync",
  "offline_access",
  "IdentityServerApi",
  "auth:grant_types:mfa",
  "auth:grant_types:mfa_password"
] as const;
const ENDPOINTS = {
  token: "/connect/token",
  revoke: "/connect/revocation",
  temporaryToken: "/account/token",
  logout: "/account/logout"
};
class TokenManager {
  logger = logger.scope("TokenManager");
  private REFRESH_TOKEN_MUTEX = withTimeout(
    new Mutex(),
    10 * 1000,
    new Error("Timed out while refreshing access token.")
  );

  /**
   * @param guard optional preflight invoked before any request that carries or
   * mints session credentials. It throws when the configured identity server is
   * not the one this profile's session belongs to, so a refresh token is never
   * presented to a foreign backend. Optional so the class stays usable in
   * contexts that have no database.
   */
  constructor(
    private readonly storage: KVStorageAccessor,
    private readonly eventManager: EventManager,
    private readonly guard?: (operation: string) => Promise<unknown>
  ) {}

  private captureHosts() {
    return { api: constants.API_HOST, auth: constants.AUTH_HOST };
  }

  private assertHostsUnchanged(
    expected: ReturnType<TokenManager["captureHosts"]>
  ) {
    if (
      constants.API_HOST !== expected.api ||
      constants.AUTH_HOST !== expected.auth
    )
      throw new Error(
        "Server settings changed while using account credentials. Start again."
      );
  }

  async getToken(renew = true, forceRenew = false): Promise<Token | undefined> {
    // A durable recovery intent may coexist with an unexpired access token.
    // Guard every credential read, not just refresh, so account and sync
    // callers cannot use a partially committed session after a restart.
    const expected = this.captureHosts();
    if (this.guard) await this.guard("Using your session");
    this.assertHostsUnchanged(expected);
    const token = await this.storage().read("token");
    if (this.guard) await this.guard("Using your session");
    this.assertHostsUnchanged(expected);
    if (!token || !token.access_token) return;

    this.logger.info("Access token requested");

    const isExpired = renew && this._isTokenExpired(token);
    if (this._isTokenRefreshable(token) && (forceRenew || isExpired)) {
      await this._refreshToken(forceRenew);
      return await this.getToken(false, false);
    }

    bindCredential(token.access_token, expected);
    return token;
  }

  _isTokenExpired(token: Token) {
    const { t, expires_in } = token;
    const expiryMs = t + expires_in * 1000;
    return Date.now() >= expiryMs;
  }

  _isTokenRefreshable(token: Token) {
    const { scope, refresh_token } = token;
    if (!refresh_token || !scope) return false;

    const scopes = scope.split(" ");
    return scopes.includes("offline_access") && Boolean(refresh_token);
  }

  async getAccessToken(
    scopes: Scope[] = ["notesnook.sync", "IdentityServerApi"],
    forceRenew = false
  ) {
    return await getSafeToken(
      async () => {
        const token = await this.getToken(true, forceRenew);
        if (!token || !token.scope) return;
        if (!scopes.some((s) => token.scope.includes(s))) return;
        return token.access_token;
      },
      "Error getting access token:",
      this.eventManager
    );
  }

  async _refreshToken(forceRenew = false) {
    await this.REFRESH_TOKEN_MUTEX.runExclusive(async () => {
      const expected = this.captureHosts();
      // Presenting a refresh token to an identity server that did not mint it
      // leaks the credential and provokes an invalid_grant, which historically
      // led to a destructive logout.
      if (this.guard) await this.guard("Refreshing your session");
      this.assertHostsUnchanged(expected);
      this.logger.info("Refreshing access token");

      const token = await this.getToken(false, false);
      this.assertHostsUnchanged(expected);
      if (!token) throw new Error("No access token found to refresh.");
      if (!forceRenew && !this._isTokenExpired(token)) {
        return;
      }

      const { refresh_token, scope } = token;
      if (!refresh_token || !scope) {
        this.eventManager.publish(EVENTS.userSessionExpired);
        this.logger.error(new Error("Token not found."));
        return;
      }

      if (this.guard) await this.guard("Refreshing your session");
      this.assertHostsUnchanged(expected);
      const refreshTokenResponse = await http.post(
        `${expected.auth}${ENDPOINTS.token}`,
        {
          refresh_token,
          grant_type: "refresh_token",
          scope: scope,
          client_id: "notesnook"
        }
      );
      if (this.guard) await this.guard("Saving your refreshed session");
      this.assertHostsUnchanged(expected);
      await this.saveToken(refreshTokenResponse);
      this.eventManager.publish(EVENTS.tokenRefreshed);
    });
  }

  async revokeToken() {
    const expected = this.captureHosts();
    if (this.guard) await this.guard("Signing out of the server");
    const token = await this.getToken();
    if (!token) return;
    const { access_token } = token;

    this.assertHostsUnchanged(expected);
    await this.storage().delete("token");
    this.assertHostsUnchanged(expected);
    await http.post(`${expected.auth}${ENDPOINTS.logout}`, null, access_token);
  }

  saveToken(tokenResponse: Omit<Token, "t">) {
    this.logger.info("Saving new token");
    if (!tokenResponse || !tokenResponse.access_token) return;
    const token: Token = { ...tokenResponse, t: Date.now() };
    bindCredential(token.access_token, this.captureHosts());
    return this.storage().write("token", token);
  }

  async getAccessTokenFromAuthorizationCode(userId: string, authCode: string) {
    const expected = this.captureHosts();
    if (this.guard) await this.guard("Completing your sign in");
    this.assertHostsUnchanged(expected);
    const grantedToken = await http.post(
      `${expected.auth}${ENDPOINTS.temporaryToken}`,
      {
        authorization_code: authCode,
        user_id: userId,
        client_id: "notesnook"
      }
    );
    if (this.guard) await this.guard("Saving your session");
    this.assertHostsUnchanged(expected);
    return await this.saveToken(grantedToken);
  }
}
export default TokenManager;

async function getSafeToken<T>(
  action: () => Promise<T>,
  errorMessage: string,
  eventManager: EventManager
) {
  try {
    return await action();
  } catch (e) {
    logger.error(e, errorMessage);
    if (
      e instanceof Error &&
      (e.message === "invalid_grant" || e.message === "invalid_client")
    ) {
      eventManager.publish(EVENTS.userSessionExpired);
    }
    throw e;
  }
}
