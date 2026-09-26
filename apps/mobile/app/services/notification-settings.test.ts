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

// Notifee's iOS openNotificationSettings() is a documented no-op (it only
// calls native code on Android), so the Tasks settings bridge must route iOS
// through the native NotificationSettingsModule instead and must never
// silently succeed when nothing was actually opened.

let mockPlatformOS: "ios" | "android" = "ios";
let mockAppStateCurrentState: "active" | "background" = "background";
let mockNativeModuleAvailable = true;
const mockOpenNotificationSettings = jest.fn(
  async (): Promise<"notifications" | "settings"> => "notifications"
);
const mockNotifeeOpenNotificationSettings = jest.fn(
  async (_channelId?: string) => {}
);
const mockOpenSettings = jest.fn(async () => {});

jest.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mockPlatformOS;
    }
  },
  AppState: {
    get currentState() {
      return mockAppStateCurrentState;
    },
    addEventListener: () => ({ remove: jest.fn() })
  },
  NativeModules: {
    get NotificationSettingsModule() {
      return mockNativeModuleAvailable
        ? { openNotificationSettings: mockOpenNotificationSettings }
        : undefined;
    }
  },
  Linking: { openSettings: () => mockOpenSettings() }
}));

jest.mock(
  "@notifee/react-native",
  () => ({
    __esModule: true,
    default: {
      openNotificationSettings: (channelId?: string) =>
        mockNotifeeOpenNotificationSettings(channelId)
    }
  }),
  { virtual: true }
);

import { openAppNotificationSettings } from "./notification-settings";

describe("openAppNotificationSettings", () => {
  beforeEach(() => {
    mockPlatformOS = "ios";
    mockAppStateCurrentState = "background";
    mockNativeModuleAvailable = true;
    mockOpenNotificationSettings.mockClear();
    mockOpenNotificationSettings.mockImplementation(
      async () => "notifications"
    );
    mockNotifeeOpenNotificationSettings.mockClear();
    mockOpenSettings.mockClear();
    mockOpenSettings.mockImplementation(async () => {});
  });

  it("on iOS calls the native UIKit bridge and returns its destination", async () => {
    const destination = await openAppNotificationSettings();
    expect(mockOpenNotificationSettings).toHaveBeenCalledTimes(1);
    expect(mockNotifeeOpenNotificationSettings).not.toHaveBeenCalled();
    expect(destination).toBe("notifications");
  });

  it("on iOS surfaces the general Settings fallback destination", async () => {
    mockOpenNotificationSettings.mockImplementation(async () => "settings");
    const destination = await openAppNotificationSettings();
    expect(destination).toBe("settings");
  });

  it("on iOS opens app Settings when the bridge is unavailable", async () => {
    // Simulates the native module failing to link (e.g. a stale build).
    mockNativeModuleAvailable = false;
    await expect(openAppNotificationSettings()).resolves.toBe("settings");
    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
    expect(mockNotifeeOpenNotificationSettings).not.toHaveBeenCalled();
  });

  it("on iOS falls back after a native rejection", async () => {
    mockOpenNotificationSettings.mockImplementation(async () => {
      throw new Error("The system declined to open Settings.");
    });
    await expect(openAppNotificationSettings()).resolves.toBe("settings");
    expect(mockOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("on iOS rejects when both public Settings paths fail", async () => {
    mockOpenNotificationSettings.mockRejectedValue(new Error("Native failed"));
    mockOpenSettings.mockRejectedValue(
      new Error("System Settings unavailable")
    );
    await expect(openAppNotificationSettings()).rejects.toThrow(
      "System Settings unavailable"
    );
  });

  it("rejects a URL success that never leaves the app foreground", async () => {
    mockAppStateCurrentState = "active";
    mockNativeModuleAvailable = false;
    jest.useFakeTimers();
    try {
      const result = openAppNotificationSettings();
      const assertion = expect(result).rejects.toThrow(
        "The Settings app did not open."
      );
      await jest.advanceTimersByTimeAsync(3000);
      await assertion;
      expect(mockOpenSettings).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not mask a verified native Settings failure with another URL attempt", async () => {
    mockOpenNotificationSettings.mockRejectedValue({
      code: "notification_settings_failed",
      message: "Settings stayed closed"
    });
    await expect(openAppNotificationSettings()).rejects.toMatchObject({
      code: "notification_settings_failed"
    });
    expect(mockOpenSettings).not.toHaveBeenCalled();
  });

  it("on Android delegates to notifee and reports the android destination", async () => {
    mockPlatformOS = "android";
    const destination = await openAppNotificationSettings("urgent");
    expect(mockNotifeeOpenNotificationSettings).toHaveBeenCalledWith("urgent");
    expect(mockOpenNotificationSettings).not.toHaveBeenCalled();
    expect(destination).toBe("android");
  });
});
