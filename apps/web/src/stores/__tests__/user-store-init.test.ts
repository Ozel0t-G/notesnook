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

// Regression coverage for offline desktop startup.
//
// Selecting offline/no-account use and creating a local note must not make the
// next launch fail. Backend affinity intentionally blocks account fetches for a
// profile whose local data cannot be attributed to a backend, so `UserStore.init`
// must not call `fetchUser()` when there is no cached authenticated user. When a
// cached user does exist, the fetch (and any resulting BackendMismatchError) must
// still run and stay visible.
//
// Run from `apps/web` (the vitest config sets `dir: "./__tests__/"`, so point the
// scanner at this directory):
//   npx vitest run --dir src/stores/__tests__

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { User } from "@notesnook/core";

vi.mock("../../common/db", () => ({
  db: {
    eventManager: {
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      publish: vi.fn()
    },
    user: {
      getUser: vi.fn(),
      fetchUser: vi.fn()
    }
  }
}));

vi.mock("../../utils/config", () => ({
  default: {
    get: vi.fn(() => false),
    set: vi.fn(),
    logout: vi.fn()
  }
}));

vi.mock("../../navigation", () => ({ hashNavigate: vi.fn() }));

vi.mock("../../dialogs/confirm", () => ({
  ConfirmDialog: { show: vi.fn() }
}));

vi.mock("../../common", () => ({ resetFeatures: vi.fn() }));

vi.mock("@notesnook/core", () => ({
  EVENTS: {
    userSessionExpired: "userSessionExpired",
    userSubscriptionUpdated: "userSubscriptionUpdated",
    userEmailConfirmed: "userEmailConfirmed",
    userLoggedOut: "userLoggedOut"
  }
}));

vi.mock("@notesnook/intl", () => ({
  strings: {
    loggedOut: () => "logged out",
    okay: () => "okay"
  }
}));

import { EVENTS } from "@notesnook/core";
import { db } from "../../common/db";
import Config from "../../utils/config";
import { store } from "../user-store";

const getUser = vi.mocked(db.user.getUser);
const fetchUser = vi.mocked(db.user.fetchUser);
const configGet = Config.get as unknown as Mock;

const fakeUser = { id: "user-1", email: "user@example.com" } as unknown as User;

beforeEach(() => {
  vi.clearAllMocks();
  configGet.mockReturnValue(false);
  store.set({ user: undefined, isLoggedIn: undefined });
});

describe("UserStore.init", () => {
  it("does not fetch and resolves when there is no cached user (offline startup)", async () => {
    getUser.mockResolvedValue(undefined);

    const result = await store.init();

    expect(getUser).toHaveBeenCalledTimes(1);
    expect(fetchUser).not.toHaveBeenCalled();
    expect(result).toBe(false);
    expect(store.get().isLoggedIn).toBe(false);
    expect(store.get().user).toBeUndefined();
  });

  it("still fetches a cached user and surfaces a backend-affinity mismatch", async () => {
    getUser.mockResolvedValue(fakeUser);
    fetchUser.mockRejectedValue(
      new Error(
        "BackendMismatchError: Fetching your account is blocked because this profile's data cannot be attributed to a backend."
      )
    );

    await expect(store.init()).rejects.toThrow(/BackendMismatchError/);

    // The guard is preserved: a cached user still triggers the fetch, and the
    // error is not swallowed.
    expect(fetchUser).toHaveBeenCalledTimes(1);
  });

  it("marks the user logged in when a cached user fetches successfully", async () => {
    getUser.mockResolvedValue(fakeUser);
    fetchUser.mockResolvedValue(fakeUser);

    const result = await store.init();

    expect(fetchUser).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
    expect(store.get().isLoggedIn).toBe(true);
    expect(store.get().user).toBe(fakeUser);
  });

  it("does not fetch when the session expired flag is set", async () => {
    getUser.mockResolvedValue(fakeUser);
    // An expired session is still a cached user, so the fetch must be skipped
    // and the session-expired event published instead.
    configGet.mockImplementation((key: string) => key === "sessionExpired");

    const result = await store.init();

    expect(fetchUser).not.toHaveBeenCalled();
    expect(db.eventManager.publish).toHaveBeenCalledWith(
      EVENTS.userSessionExpired
    );
    expect(result).toBe(false);
  });
});
