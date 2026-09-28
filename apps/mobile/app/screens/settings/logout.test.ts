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
let mockDataChanged: () => void;
const mockUnsubscribe = jest.fn();
const mockAlert = jest.fn();
const mockLogout = jest.fn(async () => {});
const mockHasUnsyncedChanges = jest.fn(async () => false);
const mockIsBlocked = jest.fn(async () => false);
const mockBackup = jest.fn(
  async (): Promise<{ path?: string; error?: Error }> => ({
    path: "/safe-backup.nnbackupz"
  })
);
const mockNavigate = jest.fn();
const mockSetIsLoggingOut = jest.fn();
const mockStartProgress = jest.fn();
const mockEndProgress = jest.fn();
const mockToastError = jest.fn();
const mockToastShow = jest.fn();
let mockAppStateChanged: (state: string) => void;
const mockRemoveLifecycle = jest.fn();
let mockSignedInUser: { id: string } | null = { id: "qa-user" };

jest.mock("@notesnook/core", () => ({
  EVENTS: { databaseUpdated: "db:updated" }
}));
jest.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: (_, key) => () => String(key) })
}));
jest.mock("react-native", () => ({
  Alert: { alert: (...args: unknown[]) => mockAlert(...args) },
  AppState: {
    currentState: "active",
    addEventListener: (_name: string, handler: (state: string) => void) => {
      mockAppStateChanged = handler;
      return { remove: mockRemoveLifecycle };
    }
  }
}));
jest.mock("../../common/database", () => ({
  DatabaseLogger: { error: jest.fn() },
  db: {
    syncer: {
      sync: {
        autoSync: {
          stop: jest.fn(),
          start: jest.fn().mockResolvedValue(undefined)
        }
      },
      stop: jest.fn().mockResolvedValue(undefined)
    },
    fs: () => ({ cancel: jest.fn().mockResolvedValue(undefined) }),
    withAccountDataWriteBarrier: async (
      callback: (assertUnchanged: () => void) => Promise<unknown>
    ) => callback(() => {}),
    eventManager: {
      subscribe: (_event: string, handler: () => void) => {
        mockDataChanged = handler;
        return { unsubscribe: mockUnsubscribe };
      }
    },
    hasUnsyncedChanges: () => mockHasUnsyncedChanges(),
    user: {
      logout: (...args: unknown[]) => mockLogout(...(args as [])),
      backendAffinity: { isBlocked: () => mockIsBlocked() }
    }
  }
}));
jest.mock("../../components/auth/common", () => ({ AuthMode: { login: 0 } }));
jest.mock("../../components/dialogs/progress", () => ({
  startProgress: (...args: unknown[]) => mockStartProgress(...args),
  endProgress: () => mockEndProgress(),
  updateProgress: jest.fn()
}));
jest.mock("../../services/backup", () => ({
  __esModule: true,
  default: { run: (...args: unknown[]) => mockBackup(...(args as [])) }
}));
jest.mock("../../services/event-manager", () => ({
  ToastManager: {
    error: (...args: unknown[]) => mockToastError(...args),
    show: (...args: unknown[]) => mockToastShow(...args)
  }
}));
jest.mock("../../services/navigation", () => ({
  __esModule: true,
  default: { navigate: (...args: unknown[]) => mockNavigate(...args) }
}));
jest.mock("../../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => ({
      user: mockSignedInUser,
      setIsLoggingOut: (value: boolean) => mockSetIsLoggingOut(value)
    })
  }
}));

import { logoutUser } from "./logout";

type Button = {
  text: string;
  onPress: () => void;
  style?: string;
  isPreferred?: boolean;
};
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
async function choose(index: number, text: string) {
  await flush();
  const buttons: Button[] = mockAlert.mock.calls[index][2];
  const button = buttons.find((button) => button.text === text);
  expect(button).toBeDefined();
  if (!button) throw new Error(`Missing native alert action: ${text}`);
  button.onPress();
  await flush();
}

describe("native VeyraN sign-out safety", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignedInUser = { id: "qa-user" };
    mockHasUnsyncedChanges.mockResolvedValue(false);
    mockIsBlocked.mockResolvedValue(false);
    mockLogout.mockResolvedValue(undefined);
    mockBackup.mockResolvedValue({ path: "/safe-backup.nnbackupz" });
  });

  it("Cancel and native dismissal preserve the profile without navigation", async () => {
    const pending = logoutUser();
    await choose(0, "cancel");
    expect(await pending).toBe(false);
    expect(mockBackup).not.toHaveBeenCalled();
    expect(mockLogout).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockSetIsLoggingOut).not.toHaveBeenCalled();
    const dismissed = logoutUser();
    await flush();
    mockAlert.mock.calls[1][3].onDismiss();
    expect(await dismissed).toBe(false);
  });

  it("warns about unsynced data, prefers backup, then opens login only after logout", async () => {
    mockHasUnsyncedChanges.mockResolvedValue(true);
    const pending = logoutUser();
    await flush();
    expect(mockAlert.mock.calls[0][1]).toContain("unsyncedChangesWarning");
    expect(mockAlert.mock.calls[0][2][1]).toMatchObject({
      text: "signOutWithBackup",
      isPreferred: true
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    await choose(0, "signOutWithBackup");
    expect(await pending).toBe(true);
    expect(mockBackup).toHaveBeenCalledWith(false, "local", "full", {
      requireLocalAttachments: true
    });
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("Auth", { mode: 0 });
    expect(mockSetIsLoggingOut.mock.calls).toEqual([[true], [false]]);
  });

  it("resets logging state when a failed backup is canceled", async () => {
    mockBackup.mockResolvedValue({
      error: new Error("private backup failure")
    });
    const pending = logoutUser();
    await choose(0, "signOutWithBackup");
    expect(mockAlert.mock.calls[1][1]).not.toContain("private backup failure");
    await choose(1, "cancel");
    expect(await pending).toBe(false);
    expect(mockLogout).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockSetIsLoggingOut.mock.calls).toEqual([[true], [false]]);
  });

  it("does not treat a concurrent/skipped backup as successful", async () => {
    mockBackup.mockResolvedValue({});
    const pending = logoutUser();
    await choose(0, "signOutWithBackup");
    expect(mockAlert.mock.calls[1][0]).toBe("failedToTakeBackup");
    await choose(1, "cancel");
    expect(await pending).toBe(false);
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it("allows an explicitly confirmed sign-out without backup for a safe profile", async () => {
    const pending = logoutUser();
    await choose(0, "signOutWithoutBackup");
    expect(await pending).toBe(true);
    expect(mockBackup).not.toHaveBeenCalled();
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it("requires backup for unsynced changes and cannot bypass a failed backup", async () => {
    mockHasUnsyncedChanges.mockResolvedValue(true);
    mockBackup.mockResolvedValue({ error: new Error("failed") });
    const pending = logoutUser();
    await flush();
    expect(
      mockAlert.mock.calls[0][2].map((button: Button) => button.text)
    ).toEqual(["cancel", "signOutWithBackup"]);
    await choose(0, "signOutWithBackup");
    expect(
      mockAlert.mock.calls[1][2].map((button: Button) => button.text)
    ).toEqual(["cancel"]);
    await choose(1, "cancel");
    expect(await pending).toBe(false);
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it("requires a saved backup for an affinity-blocked/recovery profile", async () => {
    mockIsBlocked.mockResolvedValue(true);
    const pending = logoutUser();
    await flush();
    expect(
      mockAlert.mock.calls[0][2].map((button: Button) => button.text)
    ).toEqual(["cancel", "signOutWithBackup"]);
    expect(mockAlert.mock.calls[0][1]).toContain("signOutBackupRequired");
    await choose(0, "signOutWithBackup");
    expect(await pending).toBe(true);
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it("cannot bypass a failed required backup", async () => {
    mockIsBlocked.mockResolvedValue(true);
    mockBackup.mockRejectedValue(new Error("failed"));
    const pending = logoutUser();
    await choose(0, "signOutWithBackup");
    expect(
      mockAlert.mock.calls[1][2].map((button: Button) => button.text)
    ).toEqual(["cancel"]);
    await choose(1, "cancel");
    expect(await pending).toBe(false);
    expect(mockLogout).not.toHaveBeenCalled();
    expect(
      mockSetIsLoggingOut.mock.calls[mockSetIsLoggingOut.mock.calls.length - 1]
    ).toEqual([false]);
  });

  it("refuses unbacked destruction if affinity becomes blocked during confirmation", async () => {
    mockIsBlocked.mockResolvedValueOnce(false).mockResolvedValue(true);
    const pending = logoutUser();
    await choose(0, "signOutWithoutBackup");
    expect(await pending).toBe(false);
    expect(mockLogout).not.toHaveBeenCalled();
    expect(mockToastShow).toHaveBeenCalledWith({
      message: "signOutBackupRequired",
      type: "info"
    });
  });

  it("coalesces duplicate taps and always clears progress after core failure", async () => {
    mockLogout.mockRejectedValue(new Error("logout failed"));
    const pending = logoutUser();
    expect(await logoutUser()).toBe(false);
    await choose(0, "signOutWithoutBackup");
    expect(await pending).toBe(false);
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(
      mockSetIsLoggingOut.mock.calls[mockSetIsLoggingOut.mock.calls.length - 1]
    ).toEqual([false]);
    expect(mockEndProgress).toHaveBeenCalled();
  });
  it("refuses deletion when an in-flight edit changes data after backup started", async () => {
    mockHasUnsyncedChanges.mockResolvedValue(true);
    mockBackup.mockImplementationOnce(async () => {
      mockDataChanged();
      return { path: "/older-backup.nnbackupz" };
    });
    const pending = logoutUser();
    await choose(0, "signOutWithBackup");
    expect(await pending).toBe(false);
    expect(mockLogout).not.toHaveBeenCalled();
    expect(mockUnsubscribe).toHaveBeenCalled();
    expect(mockStartProgress).toHaveBeenCalledWith(
      expect.objectContaining({ canHideProgress: false })
    );
  });
  it("rechecks data immediately before core clears the local profile", async () => {
    mockLogout.mockImplementationOnce(async (...args: []) => {
      const options = (
        args as unknown as [
          boolean,
          undefined,
          { beforeClearLocalData: () => void }
        ]
      )[2];
      mockDataChanged();
      options.beforeClearLocalData();
    });
    const pending = logoutUser();
    await choose(0, "signOutWithBackup");
    expect(await pending).toBe(false);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });
  it("preserves the profile when the app backgrounds during backup", async () => {
    mockBackup.mockImplementationOnce(async () => {
      mockAppStateChanged("background");
      return { path: "/safe-backup.nnbackupz" };
    });
    const pending = logoutUser();
    await choose(0, "signOutWithBackup");
    expect(await pending).toBe(false);
    expect(mockLogout).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockRemoveLifecycle).toHaveBeenCalled();
  });
  it("returns to login if core reset finished but a cleanup handler failed", async () => {
    mockLogout.mockImplementationOnce(async () => {
      mockSignedInUser = null;
      throw new Error("Native cleanup failed after reset");
    });
    const pending = logoutUser();
    await choose(0, "signOutWithBackup");
    expect(await pending).toBe(false);
    expect(mockNavigate).toHaveBeenCalledWith("Auth", { mode: 0 });
    expect(mockToastError).toHaveBeenCalled();
  });
});
