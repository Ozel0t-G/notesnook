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

// A widget tap can launch this process while the user is also opening the app,
// so the interactive and the headless paths race for the same encrypted
// database by design.

export {};

const mockState = {
  keyExists: true,
  keyRequests: [] as (boolean | undefined)[],
  initCalls: 0,
  initFails: false,
  isInitialized: false,
  openGate: Promise.resolve(),
  openDatabase: () => {}
};

// Virtual: this suite exercises the initialization gate, not the real package.
jest.mock(
  "@notesnook/common",
  () => ({
    database: {
      get isInitialized() {
        return mockState.isInitialized;
      },
      host: () => {},
      setup: () => {},
      init: async () => {
        mockState.initCalls++;
        await mockState.openGate;
        if (mockState.initFails) throw new Error("migration failed");
        mockState.isInitialized = true;
      }
    },
    getFeature: () => undefined,
    getFeatureLimit: async () => ({})
  }),
  { virtual: true }
);
jest.mock("@notesnook/core", () => ({
  hosts: {
    API_HOST: "https://api.veyran.northcore.space",
    AUTH_HOST: "https://auth.veyran.northcore.space",
    SSE_HOST: "https://events.veyran.northcore.space",
    SUBSCRIPTIONS_HOST: "https://legacy-billing.invalid",
    ISSUES_HOST: "https://legacy-issues.invalid",
    MONOGRAPH_HOST: "https://share.veyran.northcore.space",
    NOTESNOOK_HOST: "https://veyran.northcore.space"
  },
  logger: { scope: () => ({ info: () => {}, error: () => {} }) }
}));
jest.mock("@notesnook/intl", () => ({
  strings: { databaseSetupFailed: () => "database setup failed" }
}));
jest.mock("@streetwriters/kysely", () => ({
  SqliteAdapter: class {},
  SqliteIntrospector: class {},
  SqliteQueryCompiler: class {}
}));
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("react-native-gzip", () => ({
  deflate: () => {},
  inflate: () => {}
}));
jest.mock("../../utils/sse/even-source-ios", () => ({
  __esModule: true,
  default: class {}
}));
jest.mock("../../utils/sse/event-source", () => ({
  __esModule: true,
  default: class {}
}));
jest.mock("../filesystem", () => ({ FileStorage: {} }));
jest.mock("./logger", () => ({}));
jest.mock("./sqlite.kysely", () => ({ RNSqliteDriver: class {} }));
jest.mock("./storage", () => ({ Storage: {} }));
jest.mock("../../services/settings", () => ({
  __esModule: true,
  default: { getProperty: () => undefined }
}));
jest.mock("./encryption", () => ({
  getDatabaseKey: async (
    _password?: string,
    options?: { createIfMissing?: boolean }
  ) => {
    mockState.keyRequests.push(options?.createIfMissing);
    // A caller that refuses to create one gets nothing when none is stored;
    // one that may create it mints it, as a first launch does.
    if (options?.createIfMissing === false && !mockState.keyExists)
      return undefined;
    mockState.keyExists = true;
    return "database-key";
  }
}));

type DatabaseModule = {
  initializeDatabaseOnce: (
    password?: string,
    options?: { createDatabaseKey?: boolean }
  ) => Promise<void>;
};

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("shared encrypted database initialization", () => {
  let subject: DatabaseModule;

  beforeEach(() => {
    mockState.keyExists = true;
    mockState.keyRequests = [];
    mockState.initCalls = 0;
    mockState.initFails = false;
    mockState.isInitialized = false;
    mockState.openGate = new Promise<void>((resolve) => {
      mockState.openDatabase = resolve;
    });
    // The gate is module state, so each case gets its own copy of it.
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    subject = require("./index") as DatabaseModule;
  });

  test("a concurrent UI and headless start open the database exactly once", async () => {
    const headless = subject.initializeDatabaseOnce(undefined, {
      createDatabaseKey: false
    });
    const ui = subject.initializeDatabaseOnce();
    await settled();
    expect(mockState.initCalls).toBe(1);
    // Only the first caller reached the key, and it refused to create one.
    expect(mockState.keyRequests).toEqual([false]);
    mockState.openDatabase();
    await expect(Promise.all([headless, ui])).resolves.toEqual([
      undefined,
      undefined
    ]);
    expect(mockState.initCalls).toBe(1);
  });

  test("headless work refuses an in-flight initializer that may create a key", async () => {
    mockState.keyExists = false;
    const ui = subject.initializeDatabaseOnce();
    await expect(
      subject.initializeDatabaseOnce(undefined, { createDatabaseKey: false })
    ).rejects.toThrow("cannot share a key-creating attempt");
    mockState.openDatabase();
    await expect(ui).resolves.toBeUndefined();
    expect(mockState.keyRequests).toEqual([undefined]);
    expect(mockState.initCalls).toBe(1);
  });

  test("an already open database is not opened again", async () => {
    mockState.isInitialized = true;
    await expect(subject.initializeDatabaseOnce()).resolves.toBeUndefined();
    expect(mockState.initCalls).toBe(0);
    expect(mockState.keyRequests).toEqual([]);
  });

  test("a refused database key fails the caller and does not create one", async () => {
    mockState.keyExists = false;
    await expect(
      subject.initializeDatabaseOnce(undefined, { createDatabaseKey: false })
    ).rejects.toThrow("database setup failed");
    expect(mockState.keyRequests).toEqual([false]);
    expect(mockState.initCalls).toBe(0);
    expect(mockState.keyExists).toBe(false);
  });

  test("a first launch is not failed by a headless attempt that refused to create a key", async () => {
    // The widget path never creates a database key. The UI, which may, waits
    // for it rather than opening the database twice, and then opens it itself.
    mockState.keyExists = false;
    mockState.openDatabase();
    const headless = subject.initializeDatabaseOnce(undefined, {
      createDatabaseKey: false
    });
    const ui = subject.initializeDatabaseOnce();
    await expect(headless).rejects.toThrow("database setup failed");
    await expect(ui).resolves.toBeUndefined();
    expect(mockState.initCalls).toBe(1);
    expect(mockState.keyRequests).toEqual([false, undefined]);
  });

  test("a failed attempt does not block a later one with a password", async () => {
    mockState.initFails = true;
    const failing = subject.initializeDatabaseOnce(undefined, {
      createDatabaseKey: false
    });
    await settled();
    mockState.openDatabase();
    await expect(failing).rejects.toThrow("migration failed");

    mockState.initFails = false;
    mockState.openGate = Promise.resolve();
    await expect(
      subject.initializeDatabaseOnce("app-lock-password")
    ).resolves.toBeUndefined();
    expect(mockState.initCalls).toBe(2);
    expect(mockState.keyRequests).toEqual([false, undefined]);
  });
});
