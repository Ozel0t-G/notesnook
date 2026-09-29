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

export {};
const mockGetUser = jest.fn();
const mockReady = jest.fn();
const mockRecover = jest.fn();
// The factory runs while this module's own top-level consts are still being
// initialised, so every reference has to be indirect. Binding `mockGetUser`
// directly would capture `undefined` and the suite would silently test a
// database stub with no methods on it.
jest.mock("../common/database", () => ({
  db: {
    user: {
      getUser: () => mockGetUser(),
      assertAccountReady: (options: unknown) => mockReady(options),
      recoverInterruptedSignup: () => mockRecover()
    }
  },
  DatabaseLogger: { error: jest.fn() }
}));
import { readStoredAccountSession } from "./account-session";
const account = { id: "veyran-user", email: "qa@example.test" };
beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockResolvedValue(account);
  mockRecover.mockResolvedValue(false);
  mockReady.mockResolvedValue({ user: account, lastSynced: 12 });
});
test("restores a cached account and checkpoint without requiring fresh network tokens", async () => {
  await expect(readStoredAccountSession(true)).resolves.toEqual({
    user: account,
    lastSynced: 12,
    recovered: false,
    setupRequired: false
  });
  expect(mockReady).toHaveBeenCalledWith({ allowExpiredSession: true });
  expect(mockRecover).toHaveBeenCalledTimes(1);
});
test("keeps cached identity visible when readiness is blocked", async () => {
  mockReady.mockRejectedValue(new Error("affinity blocked"));
  await expect(readStoredAccountSession(true)).resolves.toEqual({
    user: account,
    recovered: false,
    setupRequired: true
  });
});
test("keeps unknown-origin data in a repair state when rollback is unsafe", async () => {
  mockRecover.mockRejectedValue(new Error("local data remains"));
  await expect(readStoredAccountSession(true)).resolves.toMatchObject({
    user: account,
    setupRequired: true
  });
});
test("a safe interrupted fresh signup returns to sign in without inventing an identity", async () => {
  mockRecover.mockResolvedValue(true);
  mockGetUser.mockResolvedValue(undefined);
  await expect(readStoredAccountSession(true)).resolves.toEqual({
    user: undefined,
    recovered: true,
    setupRequired: false
  });
  expect(mockReady).not.toHaveBeenCalled();
});
test("core commit hydration does not try to recover its active transaction", async () => {
  await readStoredAccountSession();
  expect(mockRecover).not.toHaveBeenCalled();
});
