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
const mockResetCredentials = jest.fn();
const mockClearMMKV = jest.fn();
const mockResetTabs = jest.fn();
const mockClearStores = jest.fn();
const mockQueueRoutes = jest.fn();
const mockResetSettings = jest.fn();
const mockSetUser = jest.fn();
const mockSetState = jest.fn();
const mockSyncing = jest.fn();
const mockLoggingOut = jest.fn();
jest.mock("./biometrics", () => ({
  __esModule: true,
  default: { resetCredentials: () => mockResetCredentials() }
}));
jest.mock("../common/database/mmkv", () => ({
  MMKV: { clearStore: () => mockClearMMKV() }
}));
jest.mock("../screens/editor/tiptap/use-tab-store", () => ({
  resetTabStore: () => mockResetTabs()
}));
jest.mock("../stores", () => ({ clearAllStores: () => mockClearStores() }));
jest.mock("../stores/create-db-collection-store", () => ({
  refreshAllStores: jest.fn()
}));
jest.mock("../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => ({
      setUser: mockSetUser,
      setSyncing: mockSyncing,
      setIsLoggingOut: mockLoggingOut
    }),
    setState: mockSetState
  }
}));
jest.mock("./navigation", () => ({
  __esModule: true,
  default: { queueRoutesForUpdate: () => mockQueueRoutes() }
}));
jest.mock("./settings", () => ({
  __esModule: true,
  default: { resetSettings: () => mockResetSettings() }
}));
jest.mock("./event-manager", () => ({ eSendEvent: jest.fn() }));
jest.mock("../utils/events", () => ({ eAfterSync: "after-sync" }));
import { resetMobileAccountSession } from "./account-logout";

beforeEach(() => {
  jest.clearAllMocks();
  mockResetCredentials.mockResolvedValue(undefined);
});
it("finishes the signed-out UI even when native Keychain removal rejects", async () => {
  mockResetCredentials.mockRejectedValueOnce(new Error("Keychain unavailable"));
  await expect(resetMobileAccountSession()).rejects.toThrow(
    "Keychain unavailable"
  );
  expect(mockSetUser).toHaveBeenCalledWith(null);
  expect(mockSetState).toHaveBeenCalledWith({ accountSetupRequired: false });
  expect(mockClearMMKV).toHaveBeenCalledTimes(1);
  expect(mockResetTabs).toHaveBeenCalledTimes(1);
  expect(mockClearStores).toHaveBeenCalledTimes(1);
  expect(mockResetSettings).toHaveBeenCalledTimes(1);
  expect(mockQueueRoutes).toHaveBeenCalledTimes(1);
  expect(mockSyncing).toHaveBeenCalledWith(false);
});
it("does not finish cleanup before the native operation settles", async () => {
  let finish!: () => void;
  mockResetCredentials.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const pending = resetMobileAccountSession();
  await Promise.resolve();
  expect(mockSetUser).not.toHaveBeenCalled();
  finish();
  await pending;
  expect(mockSetUser).toHaveBeenCalledWith(null);
});
