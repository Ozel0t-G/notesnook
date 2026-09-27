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

import { User } from "../types.js";
import http from "../utils/http.js";
import constants, { getPersistedHostOverrides } from "../utils/constants.js";
import TokenManager, { Token } from "./token-manager.js";
import { EV, EVENTS } from "../common.js";
import { HealthCheck } from "./healthcheck.js";
import Database from "./index.js";
import { SerializedKeyPair, SerializedKey, Cipher } from "@notesnook/crypto";
import { logger } from "../logger.js";
import { assertBillingEnabled } from "./veyran-billing-policy.js";
import { KEY_VERSION, KeyVersion } from "./sync/types.js";
import {
  KeyId,
  KeyManager,
  KeyTypeFromId,
  UnwrapKeyReturnType
} from "./key-manager.js";
import { BackendAffinity } from "./backend-affinity.js";
import { bindCredential } from "../utils/credential-host-binding.js";

const ENDPOINTS = {
  signup: "/users",
  token: "/connect/token",
  user: "/users",
  deleteUser: "/users/delete",
  patchUser: "/account",
  verifyUser: "/account/verify",
  revoke: "/connect/revocation",
  recoverAccount: "/account/recover",
  resetUser: "/users/reset",
  activateTrial: "/subscriptions/trial"
};

class UserManager {
  private tokenManager: TokenManager;
  private keyManager: KeyManager;
  // Interim MFA credentials are never persisted over an existing session.
  // A process exit during login therefore leaves the previous session intact.
  private pendingLogin?: {
    email: string;
    token: Token;
    backend: ReturnType<BackendAffinity["current"]>;
    serverSettings: string;
  };
  readonly backendAffinity: BackendAffinity;
  constructor(private readonly db: Database) {
    this.keyManager = new KeyManager(db);
    this.backendAffinity = new BackendAffinity(db);
    this.tokenManager = new TokenManager(db.kv, db.eventManager, (op) =>
      this.backendAffinity.assertAllowed(op)
    );

    EV.subscribe(EVENTS.userUnauthorized, async (url: string) => {
      if (url.includes("/connect/token")) return;

      // A session issued by a different identity server will always be
      // rejected by the configured one. Refreshing it would fail with
      // invalid_grant and take us into logout(), which calls db.reset() and
      // destroys the local database. The data is not the server's to delete:
      // stop, and ask for a re-login instead, which leaves local notes
      // readable. The same applies when we cannot attribute the profile at all.
      const affinity = await this.backendAffinity.check();
      if (affinity.status === "mismatch" || affinity.status === "unknown") {
        logger.warn(
          "Refusing to refresh or revoke a session across a backend boundary.",
          { ...affinity }
        );
        this.db.eventManager.publish(EVENTS.userSessionExpired);
        return;
      }
      if (!(await HealthCheck.auth())) return;

      try {
        await this.tokenManager._refreshToken(true);
      } catch (e) {
        if (
          e instanceof Error &&
          (e.message === "invalid_grant" || e.message === "invalid_client")
        ) {
          // Not user-initiated, so this must not be allowed to wipe local data
          // if the boundary changed underneath us between the check above and
          // here.
          await this.logout(
            false,
            `Your token has been revoked. Error: ${e.message}.`,
            { userInitiated: false }
          );
        }
      }
    });
  }

  async init() {
    const user = await this.getUser();
    if (!user) return;
  }

  async signup(email: string, password: string) {
    email = email.toLowerCase();
    const expected = this.captureConfiguration();
    await this.backendAffinity.assertAllowed("Creating an account");
    this.assertConfigurationUnchanged(expected);

    // Account proof stays in memory until it is ready to commit locally.
    const snapshot = await this.snapshotSession();
    this.assertConfigurationUnchanged(expected);
    if (snapshot.user)
      throw new Error(
        "This profile already belongs to an account. Start a new profile to create another account; local notes were not changed."
      );
    let user: User;
    try {
      user = await this.signupInternal(email, password, snapshot);
    } catch (e) {
      if (snapshot.mutationStarted) await this.rollbackSession(snapshot);
      throw e;
    }
    this.db.eventManager.publish(EVENTS.userLoggedIn, user);
    await this.publishFetchedUserSafely(user, snapshot.user);
  }

  private async signupInternal(
    email: string,
    password: string,
    snapshot: Awaited<ReturnType<UserManager["snapshotSession"]>>
  ) {
    const hashedPassword = await this.db.storage().hash(password, email);
    this.assertConfigurationUnchanged(snapshot);
    const grantedToken = await http.post(
      `${snapshot.backend.api}${ENDPOINTS.signup}`,
      {
        email,
        password: hashedPassword,
        client_id: "notesnook"
      }
    );
    this.assertConfigurationUnchanged(snapshot);
    bindCredential(grantedToken.access_token, snapshot.backend);

    // Verify without writing, so a profile that cannot be bound keeps its own
    // cached identity and salt.
    const user = await this.fetchRemoteUser(
      grantedToken.access_token,
      snapshot
    );
    if (!user)
      throw new Error(
        "Could not confirm the new account against the configured server, so nothing on this device was changed. Please check your connection and try again."
      );

    snapshot.rollbackAccessToken = grantedToken.access_token;

    this.assertConfigurationUnchanged(snapshot);
    if (snapshot.user && snapshot.user.id !== user.id)
      throw new Error(
        "This profile belongs to a different account. Its local notes were not changed or uploaded. Start a new profile to create another account."
      );

    await this.beginSessionMutation(snapshot);
    await this.bindProfileToConfiguredBackend();
    await this.tokenManager.saveToken(grantedToken);
    await this.commitFetchedUser(user, snapshot.user, false);
    await this.db.setLastSynced(0);

    snapshot.cryptoKeyTouched = true;
    await this.db.storage().deriveCryptoKey({
      password,
      salt: user.salt
    });

    const masterKey = await this.getMasterKey();
    if (!masterKey) throw new Error("User encryption key not generated.");
    await this.updateUser(
      {
        dataEncryptionKey: await this.keyManager.wrapKey(
          await this.db.crypto().generateRandomKey(),
          masterKey
        ),
        attachmentsKey: await this.keyManager.wrapKey(
          await this.db.crypto().generateRandomKey(),
          masterKey
        ),
        monographPasswordsKey: await this.keyManager.wrapKey(
          await this.db.crypto().generateRandomKey(),
          masterKey
        )
      },
      grantedToken.access_token,
      snapshot
    );

    this.assertConfigurationUnchanged(snapshot);
    await this.db.syncer.devices.register(
      grantedToken.access_token,
      snapshot.backend.api
    );
    await this.finishSessionMutation(snapshot, {
      userId: user.id,
      accessToken: grantedToken.access_token,
      requiresDevice: true,
      resetSync: true
    });

    return user;
  }

  async authenticateEmail(email: string) {
    if (!email) throw new Error("Email is required.");

    email = email.toLowerCase();

    const expected = this.captureConfiguration();
    await this.backendAffinity.assertAllowed("Signing in");
    this.assertConfigurationUnchanged(expected);
    this.pendingLogin = undefined;
    const { backend, serverSettings } = expected;

    const result = await http.post(`${backend.auth}${ENDPOINTS.token}`, {
      email,
      grant_type: "email",
      client_id: "notesnook"
    });

    this.assertConfigurationUnchanged({ backend, serverSettings });
    bindCredential(result.access_token, backend);
    this.pendingLogin = {
      email,
      token: { ...result, t: Date.now() } as Token,
      backend,
      serverSettings
    };
    return result.additional_data;
  }

  async authenticateMultiFactorCode(code: string, method: string) {
    if (!code || !method) throw new Error("code & method are required.");

    const token = this.pendingLogin?.token;
    if (!token || token.scope !== "auth:grant_types:mfa")
      throw new Error("No token found.");
    this.assertPendingLoginConfiguration();

    const response = await http.post(
      `${this.pendingLogin!.backend.auth}${ENDPOINTS.token}`,
      {
        grant_type: "mfa",
        client_id: "notesnook",
        "mfa:code": code,
        "mfa:method": method
      },
      token.access_token
    );
    this.assertPendingLoginConfiguration();
    bindCredential(response.access_token, this.pendingLogin!.backend);
    if (this.pendingLogin)
      this.pendingLogin.token = { ...response, t: Date.now() } as Token;
    return true;
  }

  async authenticatePassword(
    email: string,
    password: string,
    hashedPassword?: string,
    sessionExpired?: boolean
  ) {
    if (!email || !password) throw new Error("email & password are required.");

    const token =
      this.pendingLogin?.token ??
      (await this.tokenManager.getToken(false, false));
    if (!token || token.scope !== "auth:grant_types:mfa_password")
      throw new Error("No token found.");

    email = email.toLowerCase();
    if (this.pendingLogin && this.pendingLogin.email !== email)
      throw new Error("The login email changed. Start sign in again.");
    const expected = this.pendingLogin || this.captureConfiguration();
    await this.backendAffinity.assertAllowed("Signing in");
    this.assertConfigurationUnchanged(expected);
    this.assertPendingLoginConfiguration();
    if (!hashedPassword) {
      hashedPassword = await this.db.storage().hash(password, email);
    }
    const snapshot = await this.snapshotSession();
    this.assertConfigurationUnchanged(expected);
    let authenticatedUser: User;
    try {
      let usesFallback = false;
      this.assertConfigurationUnchanged(expected);
      const grantedToken = await http
        .post(
          `${expected.backend.auth}${ENDPOINTS.token}`,
          {
            grant_type: "mfa_password",
            client_id: "notesnook",
            scope: "notesnook.sync offline_access IdentityServerApi",
            password: hashedPassword
          },
          token.access_token
        )
        .catch(async (e) => {
          if (e instanceof Error && e.message === "Password is incorrect.") {
            hashedPassword = await this.db
              .storage()
              .hash(password, email, { usesFallback: true });
            if (hashedPassword === null) return Promise.reject(e);
            usesFallback = true;
            this.assertConfigurationUnchanged(expected);
            return await http.post(
              `${expected.backend.auth}${ENDPOINTS.token}`,
              {
                grant_type: "mfa_password",
                client_id: "notesnook",
                scope: "notesnook.sync offline_access IdentityServerApi",
                password: hashedPassword
              },
              token.access_token
            );
          }
          return Promise.reject(e);
        });

      this.assertConfigurationUnchanged(expected);
      bindCredential(grantedToken.access_token, expected.backend);

      // Verify before committing anything. `fetchRemoteUser` writes nothing, so
      // a rejected cross-backend login cannot leave another backend's identity
      // (and salt) cached over this profile's own.
      const user = await this.fetchRemoteUser(
        grantedToken.access_token,
        expected
      );
      if (!user)
        throw new Error(
          "Could not confirm your account against the configured server, so nothing on this device was changed. Please check your connection and try again."
        );

      snapshot.rollbackAccessToken = grantedToken.access_token;

      if (snapshot.user && snapshot.user.id !== user.id)
        throw new Error(
          "This profile belongs to a different account. Its local notes were not changed or uploaded. Start a new profile to sign in to another account."
        );

      this.assertConfigurationUnchanged(snapshot);

      // Only now, with the account verified and the boundary checked, is it safe
      // to replace the cached identity.
      await this.beginSessionMutation(snapshot);
      await this.bindProfileToConfiguredBackend();
      await this.tokenManager.saveToken(grantedToken);
      await this.commitFetchedUser(user, snapshot.user, false);

      if (!sessionExpired) {
        await this.db.setLastSynced(0);
      }

      if (!sessionExpired) {
        this.assertConfigurationUnchanged(expected);
        await this.db.syncer.devices.register(
          grantedToken.access_token,
          expected.backend.api
        );
      }

      snapshot.cryptoKeyTouched = true;
      if (usesFallback) {
        await this.db.storage().deriveCryptoKeyFallback({
          password,
          salt: user.salt
        });
      } else {
        await this.db.storage().deriveCryptoKey({
          password,
          salt: user.salt
        });
      }
      await this.finishSessionMutation(snapshot, {
        userId: user.id,
        accessToken: grantedToken.access_token,
        requiresDevice: !sessionExpired,
        resetSync: !sessionExpired
      });
      this.pendingLogin = undefined;
      authenticatedUser = user;
    } catch (e) {
      // Put the profile back exactly as it was: cached identity, token and
      // affinity record. Leaving any of the three half-updated is what would
      // let local notes become eligible to sync to the wrong backend.
      if (snapshot.mutationStarted) await this.rollbackSession(snapshot);
      if (!(e instanceof Error && e.message === "Password is incorrect."))
        this.pendingLogin = undefined;
      throw e;
    }
    this.db.eventManager.publish(EVENTS.userLoggedIn, authenticatedUser);
    await this.publishFetchedUserSafely(authenticatedUser, snapshot.user);
  }

  async getSessions() {
    const token = await this.tokenManager.getAccessToken();
    if (!token) return;
    await http.get(`${constants.AUTH_HOST}/account/sessions`, token);
  }

  /** Verify a recovery-code account before adding its token to this profile. */
  async authenticateRecoveryCode(userId: string, authCode: string) {
    if (!userId || !authCode)
      throw new Error("Recovery code and account are required.");
    const expected = this.captureConfiguration();
    await this.backendAffinity.assertAllowed("Recovering your account");
    this.assertConfigurationUnchanged(expected);
    const snapshot = await this.snapshotSession();
    this.assertConfigurationUnchanged(expected);

    if (snapshot.token)
      throw new Error(
        "This profile already has a session. Sign in normally or use a new profile."
      );
    if (snapshot.user && snapshot.user.id !== userId)
      throw new Error(
        "This profile belongs to another account. Local notes were not changed."
      );
    if (
      !snapshot.user &&
      (snapshot.affinity ||
        snapshot.cryptoKeyState != null ||
        snapshot.deviceId ||
        snapshot.lastSynced ||
        (await this.hasLocalAccountData()))
    )
      throw new Error(
        "This profile contains local account data. Open a new profile for recovery; local notes were not changed."
      );

    const grantedToken = await this.tokenManager.exchangeAuthorizationCode(
      userId,
      authCode
    );
    this.assertConfigurationUnchanged(expected);
    const remoteUser = await this.fetchRemoteUser(
      grantedToken.access_token,
      expected
    );
    this.assertConfigurationUnchanged(expected);
    if (!remoteUser || remoteUser.id !== userId)
      throw new Error(
        "The recovery account could not be verified against this server. Local notes were not changed."
      );
    if (snapshot.user && snapshot.user.salt !== remoteUser.salt)
      throw new Error(
        "The recovery account has a different encryption identity. Local notes were not changed."
      );

    try {
      await this.beginSessionMutation(snapshot);
      await this.bindProfileToConfiguredBackend();
      await this.tokenManager.saveToken(grantedToken);
      await this.commitFetchedUser(remoteUser, snapshot.user, false);
      await this.finishSessionMutation(snapshot, {
        userId: remoteUser.id,
        accessToken: grantedToken.access_token,
        requiresDevice: false,
        resetSync: false,
        requiresCryptoKey: false
      });
    } catch (error) {
      if (snapshot.mutationStarted) await this.rollbackSession(snapshot);
      throw error;
    }
    await this.publishFetchedUserSafely(remoteUser, snapshot.user);
    return remoteUser;
  }

  private async hasLocalAccountData() {
    // Collection.count() deliberately excludes soft-deleted records. A
    // trashed note or a deleted Task is still account data and must never be
    // silently claimed by a new backend. Read the raw SQL tables instead.
    const tables = [
      "notes",
      "notebooks",
      "content",
      "attachments",
      "tags",
      "colors",
      "shortcuts",
      "reminders",
      "relations",
      "vaults",
      "notehistory",
      "sessioncontent",
      "monographs",
      "inboxitemshistory",
      "settings"
    ] as const;
    for (const table of tables)
      if (
        await this.db
          .sql()
          .selectFrom(table)
          .select("id")
          .limit(1)
          .executeTakeFirst()
      )
        return true;
    return (
      this.db.legacyNotes.count() > 0 ||
      this.db.legacyTags.count() > 0 ||
      this.db.legacyColors.count() > 0 ||
      !!(await this.db.storage().read("settings"))
    );
  }

  async clearSessions(all = false) {
    const token = await this.tokenManager.getToken();
    if (!token) return;
    const { access_token, refresh_token } = token;
    await http.post(
      `${constants.AUTH_HOST}/account/sessions/clear?all=${all}`,
      { refresh_token },
      access_token
    );
  }

  async activateTrial() {
    assertBillingEnabled("Activating a trial");
    const token = await this.tokenManager.getAccessToken();
    if (!token) return false;
    await http.post(
      `${constants.SUBSCRIPTIONS_HOST}${ENDPOINTS.activateTrial}`,
      null,
      token
    );
    return true;
  }

  /**
   * @param options.userInitiated defaults to true. Only an explicit sign-out
   * may reset local data. A server rejecting a token has no authority to
   * delete notes, regardless of whether the backend affinity still matches.
   */
  async logout(
    revoke = true,
    reason?: string,
    options?: { userInitiated?: boolean }
  ) {
    const userInitiated = options?.userInitiated ?? true;
    if (!userInitiated) {
      if (!(await this.backendAffinity.isBlocked())) {
        try {
          await this.db.kv().delete("token");
        } catch (error) {
          // A token that could not be deleted must not be refreshed or used.
          this.backendAffinity.quarantine();
          logger.error(error, "Could not clear an expired session token");
        }
      }
      this.pendingLogin = undefined;
      this.db.eventManager.publish(EVENTS.userSessionExpired);
      return;
    }

    try {
      await this.db.syncer.devices.unregister();
      if (revoke) await this.tokenManager.revokeToken();
    } catch (e) {
      logger.error(e, "Error logging out user.", { revoke, reason });
    } finally {
      this.keyManager.clearCache();
      await this.db.reset();
      this.db.eventManager.publish(EVENTS.userLoggedOut, reason);
      this.db.eventManager.publish(EVENTS.appRefreshRequested);
    }
  }

  /**
   * Bind this profile to the configured backend after it has positively
   * identified the account.
   *
   * Refuses to relabel a profile that is already bound elsewhere. Logging in to
   * a different server does not transfer ownership of data that was synced from
   * another one, so this throws rather than overwriting, and the caller rolls
   * the session back. Resolving it is an explicit migration decision, exposed
   * separately via `backendAffinity.adoptCurrentBackend`.
   */
  private async bindProfileToConfiguredBackend() {
    const outcome = await this.backendAffinity.record({
      pendingLocalMutation: true
    });
    if (!outcome.ok) {
      const { stored, configured, status } = outcome.conflict;
      if (status === "unknown")
        throw new Error(
          "This device already holds notes that cannot be attributed to a server, so it was not bound to this account. Your local notes are unchanged and were not uploaded. Sign in to the server they came from, start a new profile, or confirm explicitly that they belong to this account."
        );
      throw new Error(
        `This profile's data belongs to a different server (api ${stored?.api}, auth ${stored?.auth}) than the one you signed in to (api ${configured.api}, auth ${configured.auth}). Your local notes are unchanged and were not uploaded. Sign in to the original server, or start a new profile.`
      );
    }
    return outcome;
  }

  setUser(user: User) {
    return this.db.kv().write("user", user);
  }

  getUser() {
    return this.db.kv().read("user");
  }

  /**
   * @deprecated
   */
  getLegacyUser() {
    return this.db.storage().read<User>("user");
  }

  async resetUser(removeAttachments = true) {
    const token = await this.tokenManager.getAccessToken();
    if (!token) return;
    await http.post(
      `${constants.API_HOST}${ENDPOINTS.resetUser}`,
      { removeAttachments },
      token
    );
    return true;
  }

  private async updateUser(
    partial: Partial<User>,
    accessToken?: string,
    expected = this.captureConfiguration()
  ) {
    const user = await this.getUser();
    if (!user) return;

    const token = accessToken || (await this.tokenManager.getAccessToken());
    this.assertConfigurationUnchanged(expected);
    await http.patch.json(
      `${expected.backend.api}${ENDPOINTS.user}`,
      partial,
      token
    );

    await this.setUser({ ...user, ...partial });
  }

  async deleteUser(password: string) {
    const token = await this.tokenManager.getAccessToken();
    const user = await this.getUser();
    if (!token || !user) return;

    await http.post(
      `${constants.API_HOST}${ENDPOINTS.deleteUser}`,
      {
        password: await this.db.storage().hash(password, user.email, {
          usesFallback: await this.usesFallbackPWHash(password)
        })
      },
      token
    );
    await this.logout(false, "Account deleted.");
    return true;
  }

  /**
   * Fetch the account from the configured backend.
   *
   * Blocked when this profile's data belongs to a different backend, so a
   * background refresh cannot reach a foreign server. The login and signup
   * flows pass `skipAffinityGuard`, because they are the operations that
   * establish affinity in the first place and would otherwise deadlock a
   * profile that predates it. That is safe: they talk to the configured API
   * with a token minted by the configured identity server, and send no local
   * note data.
   */
  async fetchUser(): Promise<User | undefined> {
    await this.backendAffinity.assertAllowed("Fetching your account");
    return (await this.fetchUserInternal()).user;
  }

  /**
   * @returns `fresh` is true only when `user` came from a successful response
   * from the configured backend. A cached user is returned with `fresh: false`,
   * and must never be treated as proof of which backend the data belongs to.
   */
  private async fetchUserInternal(): Promise<{
    user?: User;
    fresh: boolean;
  }> {
    this.keyManager.clearCache();

    const oldUser = await this.getUser();
    try {
      const token = await this.tokenManager.getAccessToken();
      if (!token) return { user: undefined, fresh: false };
      const user = await http.get(
        `${constants.API_HOST}${ENDPOINTS.user}`,
        token
      );
      if (user) {
        await this.commitFetchedUser(user, oldUser);
        return { user, fresh: true };
      } else {
        // The server answered but gave us nothing usable. This is not proof of
        // anything, so the cached user is returned unverified.
        return { user: oldUser, fresh: false };
      }
    } catch (e) {
      logger.error(e, "Error fetching user");
      return { user: oldUser, fresh: false };
    }
  }

  /**
   * Read the account from the configured backend without writing anything.
   *
   * Used by login and signup to verify the account *before* the profile is
   * bound to a backend or the cached identity is replaced. It must stay free of
   * side effects: the cached user carries the salt that local content is keyed
   * from, so overwriting it before the backend boundary has been checked would
   * leave a rejected login with another backend's identity in place.
   *
   * Reads the stored token directly rather than through `getAccessToken`, so a
   * renewal cannot be triggered while affinity is still undetermined.
   */
  private async fetchRemoteUser(
    accessToken?: string,
    expected = this.captureConfiguration()
  ): Promise<User | undefined> {
    const token =
      accessToken ||
      (await this.tokenManager.getToken(false, false))?.access_token;
    if (!token) return undefined;
    try {
      this.assertConfigurationUnchanged(expected);
      const user = await http.get(
        `${expected.backend.api}${ENDPOINTS.user}`,
        token
      );
      return user || undefined;
    } catch (e) {
      logger.error(e, "Error verifying account against the configured backend");
      return undefined;
    }
  }

  /** Persist a freshly fetched account and emit the events that follow from it. */
  private async commitFetchedUser(
    user: User,
    oldUser?: User,
    publishEvents = true
  ) {
    await this.setUser(user);
    if (publishEvents) await this.publishFetchedUser(user, oldUser);
  }

  private async publishFetchedUserSafely(user: User, oldUser?: User) {
    try {
      await this.publishFetchedUser(user, oldUser);
    } catch (error) {
      // A nonessential event or plan refresh cannot undo a committed login.
      logger.error(error, "Could not publish updated account metadata");
    }
  }

  private async publishFetchedUser(user: User, oldUser?: User) {
    if (
      oldUser &&
      (oldUser.subscription.plan !== user.subscription.plan ||
        oldUser.subscription.status !== user.subscription.status ||
        oldUser.subscription.provider !== user.subscription.provider)
    ) {
      await this.tokenManager._refreshToken(true);
      this.db.eventManager.publish(
        EVENTS.userSubscriptionUpdated,
        user.subscription
      );
    }
    if (oldUser && !oldUser.isEmailConfirmed && user.isEmailConfirmed)
      this.db.eventManager.publish(EVENTS.userEmailConfirmed);
    this.db.eventManager.publish(EVENTS.userFetched, user);
  }

  /**
   * Capture every locally persisted account marker, including the opaque
   * platform key-store state. A failed signup or final login commit must put
   * them back together; interim MFA tokens never enter this snapshot.
   */
  private async snapshotSession() {
    return {
      user: await this.db.kv().read("user"),
      token: await this.db.kv().read("token"),
      affinity: await this.db.kv().read("backendAffinity"),
      lastSynced: await this.db.kv().read("lastSynced"),
      deviceId: await this.db.kv().read("deviceId"),
      cryptoKeyState: await this.db.storage().snapshotCryptoKeyState(),
      cryptoKeyTouched: false,
      mutationStarted: false,
      syncActivity: undefined as
        | { autoSyncActive: boolean; connectionActive: boolean }
        | undefined,
      syncTeardownConfirmed: false,
      rollbackAccessToken: undefined as string | undefined,
      backend: this.backendAffinity.current(),
      serverSettings: JSON.stringify(getPersistedHostOverrides() || {})
    };
  }

  private captureConfiguration() {
    return {
      backend: this.backendAffinity.current(),
      serverSettings: JSON.stringify(getPersistedHostOverrides() || {})
    };
  }

  private assertConfigurationUnchanged(
    snapshot: Pick<
      Awaited<ReturnType<UserManager["snapshotSession"]>>,
      "backend" | "serverSettings"
    >
  ) {
    const current = this.backendAffinity.current();
    if (
      current.api !== snapshot.backend.api ||
      current.auth !== snapshot.backend.auth ||
      JSON.stringify(getPersistedHostOverrides() || {}) !==
        snapshot.serverSettings
    )
      throw new Error("Server settings changed during sign in. Start again.");
  }

  private assertPendingLoginConfiguration() {
    if (this.pendingLogin) this.assertConfigurationUnchanged(this.pendingLogin);
  }

  /** A durable intent must exist before the first local account write. */
  private async beginSessionMutation(
    snapshot: Awaited<ReturnType<UserManager["snapshotSession"]>>
  ) {
    snapshot.syncActivity = this.db.syncer.snapshotRecoveryState?.();
    await this.db.storage().write("backendRecoveryRequired", true);
    if (
      (await this.db.storage().read<boolean>("backendRecoveryRequired")) !==
      true
    )
      throw new Error("Could not persist account recovery intent.");
    snapshot.mutationStarted = true;
    // The durable marker is now in place. Tear down any old sync connection
    // and upload queue before changing identity, token, or encryption state.
    await this.db.eventManager.publishWithResult(EVENTS.backendRecoveryStarted);
    snapshot.syncTeardownConfirmed = true;
  }

  private async finishSessionMutation(
    snapshot: Awaited<ReturnType<UserManager["snapshotSession"]>>,
    expected: {
      userId: string;
      accessToken: string;
      requiresDevice: boolean;
      resetSync: boolean;
      requiresCryptoKey?: boolean;
    }
  ) {
    this.assertConfigurationUnchanged(snapshot);
    await this.verifyCommittedSession(expected);

    // All account state is now known to be committed. An interrupted marker
    // delete is resolved by reading the marker: still present means rollback;
    // absent means commit. A failed read cannot undo a verified commit.
    let cleanupError: unknown;
    try {
      await this.db.storage().remove("backendRecoveryRequired");
    } catch (error) {
      cleanupError = error;
    }
    let markerPresent: boolean;
    try {
      markerPresent =
        (await this.db.storage().read<boolean>("backendRecoveryRequired")) ===
        true;
    } catch (error) {
      logger.error(error, "Could not confirm recovery-intent cleanup");
      snapshot.mutationStarted = false;
      return;
    }
    if (markerPresent)
      throw (
        cleanupError || new Error("Could not clear account recovery intent.")
      );
    snapshot.mutationStarted = false;
  }

  private async verifyCommittedSession(expected: {
    userId: string;
    accessToken: string;
    requiresDevice: boolean;
    resetSync: boolean;
    requiresCryptoKey?: boolean;
  }) {
    const kv = this.db.kv();
    const user = await kv.read("user");
    const token = await kv.read("token");
    const affinity = await this.backendAffinity.get();
    const current = this.backendAffinity.current();
    if (
      user?.id !== expected.userId ||
      token?.access_token !== expected.accessToken ||
      affinity?.api !== current.api ||
      affinity?.auth !== current.auth
    )
      throw new Error("Could not verify committed account identity.");
    if (expected.resetSync && (await kv.read("lastSynced")) !== 0)
      throw new Error("Could not verify committed sync checkpoint.");
    if (expected.requiresDevice && !(await kv.read("deviceId")))
      throw new Error("Could not verify committed device registration.");
    if (
      expected.requiresCryptoKey !== false &&
      (await this.db.storage().snapshotCryptoKeyState()) == null
    )
      throw new Error("Could not verify committed encryption key.");
  }

  private async rollbackSession(
    snapshot: Awaited<ReturnType<UserManager["snapshotSession"]>>
  ) {
    let deviceError: unknown;
    try {
      const newDeviceId = await this.db.kv().read("deviceId");
      if (newDeviceId && newDeviceId !== snapshot.deviceId)
        await this.db.syncer.devices.unregister(
          snapshot.rollbackAccessToken,
          snapshot.backend.api
        );
    } catch (error) {
      deviceError = error;
      logger.error(error, "Could not inspect or unregister a failed device");
    }
    let kvError: unknown;
    let keyError: unknown;
    let verificationError: unknown;
    try {
      await this.restoreSession(snapshot);
    } catch (error) {
      kvError = error;
    }
    if (snapshot.cryptoKeyTouched) {
      try {
        await this.db.storage().restoreCryptoKeyState(snapshot.cryptoKeyState);
      } catch (error) {
        keyError = error;
      }
    }
    if (!kvError && !keyError) {
      try {
        await this.verifyRestoredSession(snapshot);
      } catch (error) {
        verificationError = error;
      }
    }
    if (!snapshot.syncTeardownConfirmed && !verificationError)
      verificationError = new Error(
        "Active sync traffic could not be confirmed stopped."
      );
    if (!deviceError && !kvError && !keyError && !verificationError) {
      try {
        await this.db.storage().remove("backendRecoveryRequired");
        if (await this.db.storage().read<boolean>("backendRecoveryRequired"))
          throw new Error("Could not clear account recovery intent.");
        snapshot.mutationStarted = false;
      } catch (error) {
        verificationError = error;
      }
    }
    this.keyManager.clearCache();
    if (deviceError || kvError || keyError || verificationError) {
      this.backendAffinity.quarantine();
      logger.error(
        deviceError || kvError || keyError || verificationError,
        "Account rollback failed; durable recovery intent retained"
      );
      if (!snapshot.syncTeardownConfirmed)
        throw new Error(
          "Account recovery could not safely stop active sync traffic. Local notes and prior credentials were preserved, and network access is blocked until this profile is repaired."
        );
      throw new Error(
        "Account rollback could not be completed. Local note records were not deleted, and network access is blocked until the profile is repaired."
      );
    }
    if (
      snapshot.syncTeardownConfirmed &&
      snapshot.syncActivity &&
      this.isOriginalSessionUsable(snapshot)
    ) {
      try {
        this.assertConfigurationUnchanged(snapshot);
        await this.backendAffinity.assertAllowed("Resuming restored sync");
        await this.db.syncer.resumeAfterRecovery(snapshot.syncActivity);
      } catch (error) {
        // Local rollback is complete and verified. A transient reconnect
        // failure must not relabel it as a failed data restoration.
        logger.error(error, "Could not resume sync after account rollback");
      }
    }
  }

  private isOriginalSessionUsable(
    snapshot: Awaited<ReturnType<UserManager["snapshotSession"]>>
  ) {
    const token = snapshot.token;
    return Boolean(
      snapshot.user &&
        token?.access_token &&
        typeof token.t === "number" &&
        typeof token.expires_in === "number" &&
        Date.now() < token.t + token.expires_in * 1000
    );
  }

  private async verifyRestoredSession(
    snapshot: Awaited<ReturnType<UserManager["snapshotSession"]>>
  ) {
    const kv = this.db.kv();
    for (const [key, expected] of [
      ["user", snapshot.user],
      ["token", snapshot.token],
      ["backendAffinity", snapshot.affinity],
      ["lastSynced", snapshot.lastSynced],
      ["deviceId", snapshot.deviceId]
    ] as const) {
      const actual = await kv.read(key);
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Could not verify restored ${key}.`);
    }
    if (snapshot.cryptoKeyTouched) {
      const actual = await this.db.storage().snapshotCryptoKeyState();
      if (JSON.stringify(actual) !== JSON.stringify(snapshot.cryptoKeyState))
        throw new Error("Could not verify restored encryption key.");
    }
  }

  private async restoreSession(
    snapshot: Awaited<ReturnType<UserManager["snapshotSession"]>>
  ) {
    await this.db.kv().restoreSessionState({
      user: snapshot.user,
      token: snapshot.token,
      backendAffinity: snapshot.affinity,
      lastSynced: snapshot.lastSynced,
      deviceId: snapshot.deviceId
    });
  }

  changePassword(oldPassword: string, newPassword: string) {
    return this.updatePassword("change", {
      old_password: oldPassword,
      new_password: newPassword
    });
  }

  async changeMarketingConsent(enabled: boolean) {
    const token = await this.tokenManager.getAccessToken();
    if (!token) return;

    await http.patch(
      `${constants.AUTH_HOST}${ENDPOINTS.patchUser}`,
      {
        type: "change_marketing_consent",
        enabled: enabled
      },
      token
    );
  }

  resetPassword(options: {
    newPassword: string;
    encryptionKey: SerializedKey;
  }) {
    return this.updatePassword("reset", {
      new_password: options.newPassword,
      encryptionKey: options.encryptionKey
    });
  }

  async resetPasswordWithoutRecoveryKey(newPassword: string) {
    if (!newPassword) throw new Error("New password is required.");

    const token = await this.tokenManager.getAccessToken();
    const user = await this.getUser();
    if (!token || !user) throw new Error("You are not logged in.");

    const updateUserPayload: Partial<User> = {};
    const newMasterKey = await this.db
      .storage()
      .generateCryptoKey(newPassword, user.salt);

    updateUserPayload.dataEncryptionKey = await this.keyManager.wrapKey(
      await this.db.crypto().generateRandomKey(),
      newMasterKey
    );

    if (!(await this.resetUser())) throw new Error("Failed to reset user.");

    await http.patch.json(
      `${constants.API_HOST}/users/password/reset`,
      {
        newPassword: await this.db
          .storage()
          .hash(newPassword, user.email.toLowerCase()),
        userKeys: updateUserPayload
      },
      token
    );

    await this.db.storage().deriveCryptoKey({
      password: newPassword,
      salt: user.salt
    });

    this.keyManager.clearCache();
    await this.setUser({
      ...user,
      ...updateUserPayload,
      attachmentsKey: undefined,
      monographPasswordsKey: undefined,
      inboxKeys: undefined,
      legacyDataEncryptionKey: undefined
    });

    return true;
  }

  async getDataEncryptionKeys(): Promise<
    { version: KeyVersion; key: SerializedKey }[] | undefined
  > {
    const masterKey = await this.getMasterKey();
    logger.info("master key exists: ", { masterKey: !!masterKey });
    if (!masterKey) return;

    const dataEncryptionKey = await this.keyManager.get("dataEncryptionKey", {
      refetchUser: false
    });
    logger.info("DEK exists: ", { dataEncryptionKey: !!dataEncryptionKey });
    if (!dataEncryptionKey)
      return [
        {
          key: masterKey,
          version: KEY_VERSION.LEGACY
        }
      ];
    const keys: { version: KeyVersion; key: SerializedKey }[] = [];

    const legacyDataEncryptionKey = await this.keyManager.get(
      "legacyDataEncryptionKey",
      {
        refetchUser: false
      }
    );
    logger.info("legacy DEK exists: ", {
      legacyDataEncryptionKey: !!legacyDataEncryptionKey
    });
    if (legacyDataEncryptionKey)
      keys.push({
        key: await this.keyManager.unwrapKey(
          legacyDataEncryptionKey,
          masterKey
        ),
        version: KEY_VERSION.LEGACY
      });
    keys.push({
      key: await this.keyManager.unwrapKey(dataEncryptionKey, masterKey),
      version: KEY_VERSION.DEK
    });
    logger.info("Keys:", {
      keys: keys.length,
      keyVersions: keys.map((k) => k.version)
    });
    return keys;
  }

  async getMasterKey(): Promise<SerializedKey | undefined> {
    const user = await this.getUser();
    if (!user) return;
    const key = await this.db.storage().getCryptoKey();
    if (!key) return;
    return { key, salt: user.salt };
  }

  /**
   * @deprecated
   */
  async getLegacyEncryptionKey(): Promise<SerializedKey | undefined> {
    const user = await this.getLegacyUser();
    if (!user) return;
    const key = await this.db.storage().getCryptoKey();
    if (!key) return;
    return { key, salt: user.salt };
  }

  private async getUserKey<TId extends KeyId>(
    id: TId,
    config: {
      generateKey: () => Promise<SerializedKey | SerializedKeyPair>;
      errorContext: string;
    }
  ): Promise<UnwrapKeyReturnType<KeyTypeFromId<TId>> | undefined> {
    try {
      const masterKey = await this.getMasterKey();
      if (!masterKey) return;

      const wrappedKey = await this.keyManager.get(id);

      if (!wrappedKey) {
        const key = await config.generateKey();
        await this.updateUser({
          [id]: await this.keyManager.wrapKey(key, masterKey)
        });
        return key as UnwrapKeyReturnType<KeyTypeFromId<TId>>;
      }

      return (await this.keyManager.unwrapKey(
        wrappedKey,
        masterKey
      )) as UnwrapKeyReturnType<KeyTypeFromId<TId>>;
    } catch (e) {
      logger.error(e, `Could not get ${config.errorContext}.`);
      if (e instanceof Error)
        throw new Error(
          `Could not get ${config.errorContext}. Error: ${e.message}`
        );
    }
  }

  async getAttachmentsKey() {
    return this.getUserKey("attachmentsKey", {
      generateKey: () => this.db.crypto().generateRandomKey(),
      errorContext: "attachments encryption key"
    });
  }

  async getMonographPasswordsKey() {
    return this.getUserKey("monographPasswordsKey", {
      generateKey: () => this.db.crypto().generateRandomKey(),
      errorContext: "monographs encryption key"
    });
  }

  async getInboxKeys() {
    return this.getUserKey("inboxKeys", {
      generateKey: () => this.db.crypto().generatePGPKeyPair(),
      errorContext: "inbox encryption keys"
    });
  }

  async hasInboxKeys() {
    const user = await this.getUser();
    if (!user) return false;

    return !!user.inboxKeys;
  }

  async discardInboxKeys() {
    this.keyManager.clearCache();

    const user = await this.getUser();
    if (!user) return;

    const token = await this.tokenManager.getAccessToken();
    await http.patch.json(
      `${constants.API_HOST}${ENDPOINTS.user}`,
      { inboxKeys: { public: null, private: null } },
      token
    );

    await this.setUser({ ...user, inboxKeys: undefined });
  }

  async saveInboxKeys(keys: SerializedKeyPair) {
    const userEncryptionKey = await this.getMasterKey();
    if (!userEncryptionKey) return;

    const updatePayload = {
      inboxKeys: {
        public: keys.publicKey,
        private: await this.db
          .storage()
          .encrypt(userEncryptionKey, keys.privateKey)
      }
    };
    await this.updateUser(updatePayload);
    this.keyManager.clearCache();
  }

  async sendVerificationEmail(newEmail?: string) {
    const token = await this.tokenManager.getAccessToken();
    if (!token) return;
    await http.post(
      `${constants.AUTH_HOST}${ENDPOINTS.verifyUser}`,
      { newEmail },
      token
    );
  }

  async changeEmail(newEmail: string, password: string, code: string) {
    const token = await this.tokenManager.getAccessToken();
    if (!token) return;

    const user = await this.getUser();
    if (!user) return;

    const email = newEmail.toLowerCase();

    try {
      await http.patch(
        `${constants.AUTH_HOST}${ENDPOINTS.patchUser}`,
        {
          type: "change_email",
          new_email: newEmail,
          password: await this.db.storage().hash(password, email, {
            usesFallback: await this.usesFallbackPWHash(password)
          }),
          verification_code: code
        },
        token
      );
    } catch (e) {
      const error = e as Error;
      if (error.message === "Invalid token.") throw new Error("Invalid code.");
      throw error;
    }
  }

  recoverAccount(email: string) {
    return http.post(`${constants.AUTH_HOST}${ENDPOINTS.recoverAccount}`, {
      email,
      client_id: "notesnook"
    });
  }

  async verifyPassword(password: string) {
    try {
      const user = await this.getUser();
      const key = await this.getMasterKey();
      if (!user || !key) return false;

      const cipher = await this.db.storage().encrypt(key, "notesnook");
      const plainText = await this.db.storage().decrypt({ password }, cipher);
      return plainText === "notesnook";
    } catch (e) {
      logger.error(e);
      return false;
    }
  }

  private async fetchEncryptionVerifier(): Promise<
    Cipher<"base64"> | undefined
  > {
    const token = await this.tokenManager.getAccessToken();
    return http.get(`${constants.API_HOST}/users/verifier`, token);
  }

  async verifyEncryptionKey(key: SerializedKey) {
    const user = await this.getUser();
    if (!user) throw new Error("User not found.");

    const verifiers = [
      user.attachmentsKey,
      user.monographPasswordsKey,
      user.legacyDataEncryptionKey,
      user.dataEncryptionKey,
      user.inboxKeys?.private
    ].filter((v): v is Cipher<"base64"> => !!v);

    if (verifiers.length === 0) {
      const verifier = await this.fetchEncryptionVerifier();
      if (verifier) verifiers.push(verifier);
      else
        throw new Error(
          "Encryption key cannot be verified: no encryption verifier found."
        );
    }

    for (const verifier of verifiers) {
      const decryptedData = await this.db
        .storage()
        .decrypt(key, verifier)
        .then(() => true)
        .catch(() => false);
      if (!decryptedData)
        throw new Error(
          "Your data cannot be decrypted using the provided encryption key."
        );
    }
  }

  private async updatePassword(
    type: "change" | "reset",
    data: {
      new_password: string;
      old_password?: string;
      encryptionKey?: SerializedKey;
    }
  ) {
    const { new_password, old_password } = data;
    if (!new_password) throw new Error("New password is required.");

    const token = await this.tokenManager.getAccessToken();
    const user = await this.getUser();
    if (!token || !user) throw new Error("You are not logged in.");

    const { email, salt } = user;

    if (old_password && !(await this.verifyPassword(old_password)))
      throw new Error("Incorrect old password.");
    if (old_password && !data.encryptionKey)
      data.encryptionKey = await this.getMasterKey();

    if (!data.encryptionKey) throw new Error("Encryption key is required.");

    // we must be 100% sure that the provided encryption key is valid before
    // proceeding
    await this.verifyEncryptionKey(data.encryptionKey);

    const updateUserPayload: Partial<User> = {};
    const newMasterKey = await this.db
      .storage()
      .generateCryptoKey(new_password, salt);

    if (user.attachmentsKey) {
      updateUserPayload.attachmentsKey = await this.keyManager.rewrapKey(
        user.attachmentsKey,
        data.encryptionKey,
        newMasterKey
      );
    }
    if (user.monographPasswordsKey) {
      updateUserPayload.monographPasswordsKey = await this.keyManager.rewrapKey(
        user.monographPasswordsKey,
        data.encryptionKey,
        newMasterKey
      );
    }
    if (user.inboxKeys) {
      updateUserPayload.inboxKeys = await this.keyManager.rewrapKey(
        user.inboxKeys,
        data.encryptionKey,
        newMasterKey
      );
    }

    if (user.legacyDataEncryptionKey)
      updateUserPayload.legacyDataEncryptionKey =
        await this.keyManager.rewrapKey(
          user.legacyDataEncryptionKey,
          data.encryptionKey,
          newMasterKey
        );
    if (user.dataEncryptionKey)
      updateUserPayload.dataEncryptionKey = await this.keyManager.rewrapKey(
        user.dataEncryptionKey,
        data.encryptionKey,
        newMasterKey
      );

    if (!user.legacyDataEncryptionKey && !user.dataEncryptionKey) {
      updateUserPayload.dataEncryptionKey = await this.keyManager.wrapKey(
        await this.db.crypto().generateRandomKey(),
        newMasterKey
      );
      updateUserPayload.legacyDataEncryptionKey = await this.keyManager.wrapKey(
        data.encryptionKey,
        newMasterKey
      );
    }

    const oldPassword = old_password
      ? // we don't lowercase email here to allow user accounts with
        // mixed cased emails to change their passwords. Once that is done,
        // we will lowercase the email in the backend.
        await this.db.storage().hash(old_password, email, {
          usesFallback: await this.usesFallbackPWHash(old_password)
        })
      : null;

    await http.patch.json(
      `${constants.API_HOST}/users/password/${type}`,
      {
        oldPassword: oldPassword,
        newPassword: await this.db
          .storage()
          .hash(new_password, email.toLowerCase()),
        userKeys: updateUserPayload
      },
      token
    );

    await this.db.storage().deriveCryptoKey({
      password: new_password,
      salt
    });

    this.keyManager.clearCache();
    await this.setUser({ ...user, ...updateUserPayload });

    return true;
  }

  private async usesFallbackPWHash(password: string) {
    const user = await this.getUser();
    const encryptionKey = await this.getMasterKey();
    if (!user || !encryptionKey) return false;
    const fallbackCryptoKey = await this.db
      .storage()
      .generateCryptoKeyFallback(password, user.salt);
    if (!fallbackCryptoKey) return false;
    const cryptoKey = await this.db
      .storage()
      .generateCryptoKey(password, user.salt);

    if (!encryptionKey.key || !fallbackCryptoKey.key || !cryptoKey.key)
      throw new Error("Failed to generate crypto keys.");

    if (
      fallbackCryptoKey.key !== encryptionKey.key &&
      cryptoKey.key !== encryptionKey.key
    )
      throw new Error("Wrong password.");

    return fallbackCryptoKey.key === encryptionKey.key;
  }
}

export default UserManager;
