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

const mockReady = jest.fn();
const mockStore = { syncing: false };
const mockSetState = jest.fn();
const mockSettings = jest.fn();
const mockEvent = jest.fn();
const mockSync = jest.fn();
const mockClearMessage = jest.fn();
const mockVerifyMessage = jest.fn();
const mockProfile = { id: "local-profile" };

jest.mock("../../common/database", () => ({
  db: {
    user: { assertAccountReady: () => mockReady() },
    settings: { getProfile: () => mockProfile }
  }
}));
jest.mock("../../services/settings", () => ({
  __esModule: true,
  default: { set: (state: unknown) => mockSettings(state) }
}));
jest.mock("../../services/sync", () => ({
  __esModule: true,
  default: { run: (...args: unknown[]) => mockSync(...args) }
}));
jest.mock("../../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => mockStore,
    setState: (state: unknown) => mockSetState(state)
  }
}));
jest.mock("../../services/event-manager", () => ({
  eSendEvent: (...args: unknown[]) => mockEvent(...args)
}));
jest.mock("../../services/message", () => ({
  clearMessage: () => mockClearMessage(),
  setEmailVerifyMessage: () => mockVerifyMessage()
}));
jest.mock("../../utils/events", () => ({ eUserLoggedIn: "608" }));

import { completeAccountBootstrap, SignupAttempt } from "./account-bootstrap";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("mobile account bootstrap", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStore.syncing = false;
    mockReady.mockResolvedValue({
      user: {
        id: "account",
        email: "person@example.test",
        isEmailConfirmed: true
      },
      lastSynced: 0
    });
  });

  test("does not expose a user, navigate or start sync before readiness is proven", async () => {
    const ready = deferred<unknown>();
    mockReady.mockReturnValue(ready.promise);
    const navigate = jest.fn();
    const finish = completeAccountBootstrap(navigate);
    expect(mockSetState).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
    ready.resolve({
      user: { id: "account", isEmailConfirmed: true },
      lastSynced: 0
    });
    await finish;
    expect(mockSetState).toHaveBeenCalledWith({
      user: { id: "account", isEmailConfirmed: true },
      profile: mockProfile,
      lastSynced: 0,
      accountSetupRequired: false
    });
    expect(mockSettings).toHaveBeenCalledWith({
      sessionExpired: false,
      userEmailConfirmed: true,
      encryptedBackup: true,
      introCompleted: true
    });
    expect(mockSetState.mock.invocationCallOrder[0]).toBeLessThan(
      navigate.mock.invocationCallOrder[0]
    );
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockVerifyMessage).not.toHaveBeenCalled();
  });

  test("quarantined or partial transactions cannot enter the app", async () => {
    mockReady.mockRejectedValue(new Error("recovery required"));
    const navigate = jest.fn();
    await expect(completeAccountBootstrap(navigate)).rejects.toThrow(
      "recovery required"
    );
    expect(mockSetState).not.toHaveBeenCalled();
    expect(mockSettings).not.toHaveBeenCalled();
    expect(mockEvent).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  test("only unconfirmed server accounts receive the existing email verification message", async () => {
    mockReady.mockResolvedValue({
      user: { id: "account", isEmailConfirmed: false }
    });
    await completeAccountBootstrap();
    expect(mockVerifyMessage).toHaveBeenCalledTimes(1);
    expect(mockSetState.mock.calls[0][0].lastSynced).toBe("Never");
  });

  test("a completion retry never registers an already committed account again", async () => {
    const attempt = new SignupAttempt();
    const register = jest.fn().mockResolvedValue(undefined);
    const complete = jest
      .fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValue(undefined);
    await expect(attempt.run(register, complete)).rejects.toThrow(
      "storage unavailable"
    );
    await attempt.run(register, complete);
    expect(register).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  test("concurrent retries share the in-flight transaction and completion", async () => {
    const registration = deferred<void>();
    const attempt = new SignupAttempt();
    const register = jest.fn(() => registration.promise);
    const complete = jest.fn().mockResolvedValue(undefined);
    const first = attempt.run(register, complete);
    const second = attempt.run(register, complete);
    expect(first).toBe(second);
    registration.resolve(undefined);
    await first;
    expect(register).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test("a rolled-back core attempt can be safely retried through core's continuation", async () => {
    const attempt = new SignupAttempt();
    const register = jest
      .fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValue(undefined);
    const complete = jest.fn().mockResolvedValue(undefined);
    await expect(attempt.run(register, complete)).rejects.toThrow(
      "network timeout"
    );
    expect(complete).not.toHaveBeenCalled();
    await attempt.run(register, complete);
    expect(register).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
