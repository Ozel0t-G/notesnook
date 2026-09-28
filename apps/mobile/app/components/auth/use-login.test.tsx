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

const mockEmail = jest.fn();
const mockPassword = jest.fn();
const mockMfa = jest.fn();
const mockComplete = jest.fn();
const mockPresentMfa = jest.fn();
const mockFinish = jest.fn();
const mockSetFieldError = jest.fn();
let mockStep: "password" | "mfa" = "mfa";

jest.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: (_, key) => () => String(key) })
}));
jest.mock("../../common/database", () => ({
  DatabaseLogger: { error: jest.fn() },
  db: {
    user: {
      authenticateEmail: (...args: unknown[]) => mockEmail(...args),
      getPendingAuthenticationStep: () => mockStep,
      authenticatePassword: (...args: unknown[]) => mockPassword(...args),
      authenticateMultiFactorCode: (...args: unknown[]) => mockMfa(...args)
    }
  }
}));
jest.mock("../../services/event-manager", () => ({
  ToastManager: { show: jest.fn(), error: jest.fn() },
  eSendEvent: jest.fn()
}));
jest.mock("../../utils/events", () => ({ eCloseSimpleDialog: "close-dialog" }));
jest.mock("./two-factor", () => ({
  __esModule: true,
  default: { present: (...args: unknown[]) => mockPresentMfa(...args) }
}));
jest.mock("../ui/input/form-input", () => ({
  createFormRef: () => ({
    validateField: () => false,
    validate: () => true,
    getValue: () => " Person@Example.test ",
    getValues: () => ({ email: " Person@Example.test ", password: "password" }),
    setError: (...args: unknown[]) => mockSetFieldError(...args)
  })
}));
jest.mock("./account-bootstrap", () => ({
  ACCOUNT_SETUP_NOTICE_MS: 120_000,
  completeAccountBootstrap: (...args: unknown[]) => mockComplete(...args)
}));

import { LoginSteps, useLogin } from "./use-login";

let current!: ReturnType<typeof useLogin>;
let renderer: TestRenderer.ReactTestRenderer;

function Harness() {
  current = useLogin(mockFinish);
  return null;
}

describe("mobile sign in", () => {
  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    mockStep = "mfa";
    mockEmail.mockResolvedValue({ primaryMethod: "email" });
    mockMfa.mockResolvedValue(true);
    mockPassword.mockResolvedValue(undefined);
    mockComplete.mockImplementation(async (onReady) => {
      await onReady?.();
      return { id: "account", email: "person@example.test" };
    });
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
  });
  afterEach(async () => {
    await act(async () => renderer.unmount());
    jest.useRealTimers();
  });

  test("password challenges skip MFA even when additional_data is absent", async () => {
    mockStep = "password";
    mockEmail.mockResolvedValue(undefined);
    await act(async () => {
      await current.login();
    });
    expect(current.step).toBe(LoginSteps.passwordAuth);
    expect(mockPresentMfa).not.toHaveBeenCalled();
    expect(mockEmail).toHaveBeenCalledWith("person@example.test");
  });

  test("MFA success invokes its callback once with true", async () => {
    await act(async () => {
      await current.login();
    });
    const callback = jest.fn();
    const onerror = jest.fn();
    await act(async () => {
      await mockPresentMfa.mock.calls[0][0](
        { code: "123456", method: "email" },
        callback,
        onerror
      );
    });
    expect(callback.mock.calls).toEqual([[true]]);
    expect(onerror).not.toHaveBeenCalled();
    expect(current.step).toBe(LoginSteps.passwordAuth);
    expect(current.loading).toBe(false);
  });

  test("completion failure is awaited, visible and retries without reauthenticating", async () => {
    await act(async () => current.setStep(LoginSteps.passwordAuth));
    mockComplete.mockRejectedValueOnce(new Error("local read failed"));
    await act(async () => {
      await current.login();
    });
    expect(current.error?.message).toBe("accountSetupIncomplete");
    expect(current.loading).toBe(false);
    expect(mockFinish).not.toHaveBeenCalled();
    await act(async () => {
      await current.login();
    });
    expect(mockPassword).toHaveBeenCalledTimes(1);
    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(mockFinish).toHaveBeenCalledTimes(1);
  });

  test("wrong passwords produce a localized field error and retain a retry path", async () => {
    await act(async () => current.setStep(LoginSteps.passwordAuth));
    mockPassword.mockRejectedValueOnce(new Error("Password is incorrect."));
    await act(async () => {
      await current.login();
    });
    expect(mockSetFieldError).toHaveBeenCalledWith(
      "password",
      "emailOrPasswordIncorrect"
    );
    expect(mockComplete).not.toHaveBeenCalled();
    await act(async () => {
      await current.login();
    });
    expect(mockPassword).toHaveBeenCalledTimes(2);
    expect(mockFinish).toHaveBeenCalledTimes(1);
  });

  test("a late core success cannot navigate an unmounted login screen", async () => {
    await act(async () => current.setStep(LoginSteps.passwordAuth));
    let resolve!: () => void;
    mockPassword.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      })
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = current.login();
    });
    await act(async () => renderer.unmount());
    await act(async () => {
      resolve();
      await pending;
    });
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockFinish).not.toHaveBeenCalled();
  });

  test("a slow operation stops the spinner without committing or starting a second login", async () => {
    jest.useFakeTimers();
    await act(async () => current.setStep(LoginSteps.passwordAuth));
    let resolve!: () => void;
    mockPassword.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      })
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = current.login();
    });
    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });
    expect(current.loading).toBe(false);
    expect(current.error?.message).toBe("accountSetupTimedOut");
    expect(mockComplete).not.toHaveBeenCalled();
    await act(async () => {
      await current.login();
    });
    expect(mockPassword).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve();
      await pending;
    });
    expect(mockFinish).toHaveBeenCalledTimes(1);
  });
});
