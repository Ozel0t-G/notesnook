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

import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockSignup = jest.fn();
const mockReady = jest.fn();
const mockGetUser = jest.fn();
const mockHideAuth = jest.fn();
const mockChangeMode = jest.fn();
const mockSetState = jest.fn();

jest.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: (_, key) => () => String(key) })
}));
jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({ colors: { primary: {}, secondary: {}, error: {} } })
}));
jest.mock("react-native", () => ({
  View: "view",
  TouchableOpacity: "touchable",
  useWindowDimensions: () => ({ width: 390, height: 840 })
}));
jest.mock("react-native-keyboard-aware-scroll-view", () => ({
  KeyboardAwareScrollView: "scroll"
}));
jest.mock("../../common/database", () => ({
  DatabaseLogger: { error: jest.fn() },
  db: {
    user: {
      signup: (...args: unknown[]) => mockSignup(...args),
      assertAccountReady: () => mockReady(),
      getUser: () => mockGetUser()
    },
    settings: { getProfile: () => ({ id: "profile" }) }
  }
}));
jest.mock("../../services/device-detection", () => ({ DDS: { isTab: false } }));
jest.mock("../../services/settings", () => ({
  __esModule: true,
  default: { set: jest.fn() }
}));
jest.mock("../../services/sync", () => ({
  __esModule: true,
  default: { run: jest.fn() }
}));
jest.mock("../../stores/use-user-store", () => ({
  useUserStore: {
    getState: () => ({ syncing: false }),
    setState: (state: unknown) => mockSetState(state)
  }
}));
jest.mock("../../services/event-manager", () => ({ eSendEvent: jest.fn() }));
jest.mock("../../services/message", () => ({
  clearMessage: jest.fn(),
  setEmailVerifyMessage: jest.fn()
}));
jest.mock("../../utils/events", () => ({ eUserLoggedIn: "608" }));
jest.mock("../../utils/size", () => ({
  AppFontSize: { xxl: 24, xs: 12, sm: 16 }
}));
jest.mock("../../utils/styles", () => ({
  DefaultAppStyles: { GAP: 16, GAP_VERTICAL: 12 }
}));
jest.mock("../loading", () => ({ Loading: "loading" }));
jest.mock("../ui/button", () => ({ Button: "button" }));
jest.mock("../ui/typography/heading", () => ({
  __esModule: true,
  default: "heading"
}));
jest.mock("../ui/typography/paragraph", () => ({
  __esModule: true,
  default: "paragraph"
}));
jest.mock("../ui/AppIcon", () => ({ __esModule: true, default: "icon" }));
jest.mock("./header", () => ({ AuthHeader: "header" }));
jest.mock("./common", () => ({
  hideAuth: (...args: unknown[]) => mockHideAuth(...args)
}));
jest.mock("../ui/input/form-input", () => ({
  __esModule: true,
  default: "input",
  validators: { required: jest.fn(), email: jest.fn(), matchField: jest.fn() },
  createFormRef: () => ({
    validate: () => true,
    getValues: () => ({
      email: " Person@Example.test ",
      password: "password",
      confirmPassword: "password"
    }),
    setError: jest.fn()
  })
}));

import { Signup } from "./signup";

let renderer: TestRenderer.ReactTestRenderer;
const button = (id: string) => renderer.root.findByProps({ testID: id });

describe("mobile account creation screen", () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    mockSignup.mockResolvedValue(undefined);
    mockGetUser.mockResolvedValue(undefined);
    mockReady.mockResolvedValue({
      user: {
        id: "account",
        email: "person@example.test",
        isEmailConfirmed: true
      },
      lastSynced: 0
    });
    await act(async () => {
      renderer = TestRenderer.create(
        <Signup changeMode={mockChangeMode} welcome />
      );
    });
  });
  afterEach(async () => {
    await act(async () => renderer.unmount());
    jest.useRealTimers();
  });

  test("registration leaves setup through Library only after the core commit is ready", async () => {
    let resolve!: () => void;
    mockSignup.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      })
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = button("signup-submit").props.onPress();
    });
    expect(button("account-setup-progress")).toBeDefined();
    expect(mockHideAuth).not.toHaveBeenCalled();
    await act(async () => {
      resolve();
      await pending;
    });
    expect(mockSignup).toHaveBeenCalledWith("person@example.test", "password");
    expect(mockSetState).toHaveBeenCalledTimes(1);
    expect(mockHideAuth).toHaveBeenCalledWith(undefined, true);
  });

  test("failed registration shows safe localized retry and sign-in actions", async () => {
    mockSignup.mockRejectedValueOnce(new Error("server stack trace"));
    await act(async () => {
      await button("signup-submit").props.onPress();
    });
    expect(button("account-setup-error").props.children).toBe(
      "accountSetupFailed"
    );
    expect(button("account-setup-retry").props.disabled).toBe(false);
    expect(mockHideAuth).not.toHaveBeenCalled();
    await act(async () => {
      await button("account-setup-retry").props.onPress();
    });
    expect(mockSignup).toHaveBeenCalledTimes(2);
    expect(mockHideAuth).toHaveBeenCalledTimes(1);
  });

  test("UI hydration retry does not register a second account", async () => {
    mockReady.mockRejectedValueOnce(
      new Error("storage temporarily unavailable")
    );
    await act(async () => {
      await button("signup-submit").props.onPress();
    });
    await act(async () => {
      await button("account-setup-retry").props.onPress();
    });
    expect(mockSignup).toHaveBeenCalledTimes(1);
    expect(mockHideAuth).toHaveBeenCalledTimes(1);
  });

  test("a remounted committed account completes without repeating registration", async () => {
    mockGetUser.mockResolvedValue({ id: "account" });
    await act(async () => {
      await button("signup-submit").props.onPress();
    });
    expect(mockSignup).not.toHaveBeenCalled();
    expect(mockHideAuth).toHaveBeenCalledTimes(1);
  });

  test("watchdog ends spinner while preventing concurrent retry and permitting return to sign in", async () => {
    jest.useFakeTimers();
    let resolve!: () => void;
    mockSignup.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      })
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = button("signup-submit").props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });
    expect(
      renderer.root.findAllByProps({ testID: "account-setup-progress" })
    ).toHaveLength(0);
    expect(button("account-setup-error").props.children).toBe(
      "accountSetupTimedOut"
    );
    expect(button("account-setup-retry").props.disabled).toBe(true);
    expect(button("account-setup-login").props.disabled).not.toBe(true);
    await act(async () => {
      button("account-setup-login").props.onPress();
    });
    expect(mockChangeMode).toHaveBeenCalledWith(0);
    await act(async () => renderer.unmount());
    await act(async () => {
      resolve();
      await pending;
    });
    expect(mockHideAuth).not.toHaveBeenCalled();
  });
});
