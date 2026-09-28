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
const mockSetUser = jest.fn();
const mockSetPremium = jest.fn();
let mockCurrentUser: { subscription?: { plan: string } } | null;
jest.mock("@notesnook/core", () => ({ SubscriptionPlan: { FREE: "free" } }));
jest.mock("@notesnook/intl", () => ({ strings: {} }));
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("react-native-iap", () => ({}));
jest.mock("../common/database", () => ({
  db: { user: { getUser: () => mockGetUser() } }
}));
jest.mock("../common/database/mmkv", () => ({ MMKV: {} }));
jest.mock("../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => ({
      user: mockCurrentUser,
      setPremium: mockSetPremium,
      setUser: mockSetUser
    })
  }
}));
jest.mock("./event-manager", () => ({
  presentSheet: jest.fn(),
  ToastManager: {}
}));
jest.mock("./settings", () => ({ __esModule: true, default: {} }));
import PremiumService from "./premium";
it("cannot restore an old account through a deferred commercial-metadata read", async () => {
  let resolveOldRead!: (user: object) => void;
  mockGetUser.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveOldRead = resolve;
      })
  );
  mockCurrentUser = { subscription: { plan: "legacy-plan" } };
  const pending = PremiumService.setPremiumStatus();
  mockCurrentUser = null;
  resolveOldRead?.({
    id: "old-account",
    subscription: { plan: "legacy-plan" }
  });
  await pending;
  expect(mockGetUser).not.toHaveBeenCalled();
  expect(mockSetUser).not.toHaveBeenCalled();
  expect(mockCurrentUser).toBeNull();
});
