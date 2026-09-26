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

// The Shortcuts actions that do not open the app run in the main app process in
// the background, which can be a cold start with no App component and no editor.
// These cover what that process is allowed to do before it answers Shortcuts.

const mockState = {
  locked: false,
  persistedAppLock: false,
  migrationsRequired: false,
  initialized: false
};
const mockInitializeDatabaseOnce = jest.fn(
  async (
    _password?: string,
    _options?: { createDatabaseKey?: boolean }
  ): Promise<void> => {
    mockState.initialized = true;
  }
);
const mockExecute = jest.fn(async (_request: unknown) => ({
  status: "ok",
  value: "done"
}));

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
  NativeModules: { VeyraNIntentModule: {} },
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => {} };
    }
  }
}));
jest.mock("../common/database", () => ({
  get db() {
    return {
      isInitialized: mockState.initialized,
      migrations: { required: () => mockState.migrationsRequired }
    };
  },
  DatabaseLogger: { error: () => {}, info: () => {} },
  initializeDatabaseOnce: (
    password?: string,
    options?: { createDatabaseKey?: boolean }
  ) => mockInitializeDatabaseOnce(password, options)
}));
jest.mock("./app-intent-requests", () => ({
  HEADLESS_APP_INTENT_ACTIONS: new Set([
    "completeTask",
    "todayTasks",
    "suggestTasks",
    "resolveTasks"
  ]),
  appIntentLocked: () => mockState.locked,
  appLockBlocksHeadlessAccess: () => mockState.persistedAppLock,
  executeAppIntentRequest: (request: unknown) => mockExecute(request)
}));

import {
  isHeadlessAppIntentRequest,
  runHeadlessAppIntentRequest
} from "./app-intent-host";

const request = {
  id: "11111111-2222-3333-4444-555555555555",
  action: "completeTask" as const,
  payload: { entityId: `${"0".repeat(32)}:${"a".repeat(24)}` }
};

describe("cold start Shortcuts actions", () => {
  beforeEach(() => {
    mockState.locked = false;
    mockState.persistedAppLock = false;
    mockState.migrationsRequired = false;
    mockState.initialized = false;
    mockInitializeDatabaseOnce.mockClear();
    mockExecute.mockClear();
    mockExecute.mockResolvedValue({ status: "ok", value: "done" });
  });

  test("a cold process opens the Task domain once and answers the action", async () => {
    await expect(runHeadlessAppIntentRequest(request)).resolves.toEqual({
      status: "ok",
      value: "done"
    });
    expect(mockInitializeDatabaseOnce).toHaveBeenCalledWith(undefined, {
      createDatabaseKey: false
    });
    expect(mockExecute).toHaveBeenCalledWith(request);
  });

  test("App Lock refuses the action before the database is opened", async () => {
    // The in-memory lock flag is still false in a headless process, so this has
    // to come from persisted settings, and it has to come first.
    mockState.locked = true;
    await expect(runHeadlessAppIntentRequest(request)).resolves.toEqual({
      status: "locked",
      value: ""
    });
    expect(mockInitializeDatabaseOnce).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("a warm process refuses persisted App Lock before database access", async () => {
    // The UI lock flag can still say unlocked in a warm background process.
    mockState.locked = false;
    mockState.persistedAppLock = true;
    await expect(runHeadlessAppIntentRequest(request)).resolves.toEqual({
      status: "locked",
      value: ""
    });
    expect(mockInitializeDatabaseOnce).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("an unavailable database key fails the action instead of creating one", async () => {
    mockInitializeDatabaseOnce.mockRejectedValueOnce(
      new Error("Failed to get database key")
    );
    await expect(runHeadlessAppIntentRequest(request)).resolves.toEqual({
      status: "unavailable",
      value: ""
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("a pending migration answers neither a read nor a completion", async () => {
    mockState.migrationsRequired = true;
    await expect(runHeadlessAppIntentRequest(request)).resolves.toEqual({
      status: "unavailable",
      value: ""
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("this host only claims the actions that do not open the app", () => {
    expect(isHeadlessAppIntentRequest(request)).toBe(true);
    for (const action of ["todayTasks", "suggestTasks", "resolveTasks"])
      expect(isHeadlessAppIntentRequest({ ...request, action })).toBe(true);
    // The creating actions belong to the bridge inside the mounted app. Keeping
    // the two owners disjoint is what stops one request from being executed
    // twice against the Task domain.
    for (const action of ["createTask", "createNote", "somethingElse"])
      expect(isHeadlessAppIntentRequest({ ...request, action })).toBe(false);
  });

  test("a malformed request cannot reach the Task domain", () => {
    for (const invalid of [
      null,
      "string",
      { ...request, id: "" },
      { ...request, id: "x".repeat(65) },
      { ...request, payload: undefined },
      { ...request, payload: ["entityId"] },
      { ...request, payload: { entityId: 7 } },
      { ...request, payload: { entityId: "x".repeat(4097) } },
      {
        ...request,
        payload: Array.from({ length: 17 }).reduce<Record<string, string>>(
          (payload, _item, index) => ({ ...payload, [`key${index}`]: "value" }),
          {}
        )
      }
    ])
      expect(isHeadlessAppIntentRequest(invalid)).toBe(false);
  });
});
