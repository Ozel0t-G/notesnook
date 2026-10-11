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

// A local Simulator Release build is signed ad hoc, so it installs with empty
// entitlements and every Keychain call fails with errSecMissingEntitlement
// (-34018). These cases pin what the database key does there, and that
// physical iOS/iPadOS and Mac Catalyst still go through the Keychain.

export {};

import { IOS_APPGROUPID, isIosSimulator } from "../../utils/constants";

type Credentials = { username: string; password: string };

const mockState = {
  /** react-native-device-info's isEmulatorSync() */
  isSimulator: true,
  /** react-native's Platform.isMacCatalyst */
  isMacCatalyst: false,
  /** When true every Keychain call rejects, as a Simulator build does. */
  keychainRejects: false,
  keychainCalls: [] as string[],
  keychainSetOptions: [] as (Record<string, unknown> | undefined)[],
  keychainStore: {} as Record<string, Credentials>,
  mmkvStores: {} as Record<string, Record<string, string>>
};

const mockKeychainEntitlementError = Object.assign(
  new Error("Internal error when a required entitlement isn't present."),
  { code: "34018" }
);

jest.mock(
  "react-native",
  () => ({
    Platform: {
      OS: "ios",
      get isMacCatalyst() {
        return mockState.isMacCatalyst;
      },
      select: (spec: Record<string, unknown>) => spec.ios ?? spec.default
    }
  }),
  { virtual: true }
);

jest.mock(
  "react-native-device-info",
  () => ({
    getVersion: () => "3.4.16",
    isEmulatorSync: () => mockState.isSimulator
  }),
  { virtual: true }
);

jest.mock(
  "react-native-keychain",
  () => ({
    ACCESSIBLE: {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: "AccessibleWhenUnlockedThisDeviceOnly"
    },
    hasInternetCredentials: async (server: string) => {
      mockState.keychainCalls.push(`has:${server}`);
      if (mockState.keychainRejects) throw mockKeychainEntitlementError;
      return !!mockState.keychainStore[server];
    },
    getInternetCredentials: async (server: string) => {
      mockState.keychainCalls.push(`get:${server}`);
      if (mockState.keychainRejects) throw mockKeychainEntitlementError;
      return mockState.keychainStore[server] || false;
    },
    setInternetCredentials: async (
      server: string,
      username: string,
      password: string,
      options?: Record<string, unknown>
    ) => {
      mockState.keychainCalls.push(`set:${server}`);
      mockState.keychainSetOptions.push(options);
      if (mockState.keychainRejects) throw mockKeychainEntitlementError;
      mockState.keychainStore[server] = { username, password };
    },
    resetInternetCredentials: async (server: string) => {
      mockState.keychainCalls.push(`reset:${server}`);
      if (mockState.keychainRejects) throw mockKeychainEntitlementError;
      delete mockState.keychainStore[server];
    }
  }),
  { virtual: true }
);

jest.mock(
  "react-native-mmkv-storage",
  () => {
    class MMKVLoader {
      private instanceID = "default";

      withInstanceID(id: string) {
        this.instanceID = id;
        return this;
      }

      setProcessingMode() {
        return this;
      }

      disableIndexing() {
        return this;
      }

      initialize() {
        const id = this.instanceID;
        const store = (mockState.mmkvStores[id] = mockState.mmkvStores[id] || {});
        return {
          getString: (key: string) => store[key] ?? null,
          setString: (key: string, value: string) => {
            store[key] = value;
            return true;
          },
          getMap: (key: string) => JSON.parse(store[key] || "null"),
          setMap: (key: string, value: unknown) => {
            store[key] = JSON.stringify(value);
            return true;
          },
          removeItem: (key: string) => {
            delete store[key];
            return true;
          }
        };
      }
    }

    return {
      MMKVLoader,
      ProcessingModes: { SINGLE_PROCESS: 1, MULTI_PROCESS: 2 }
    };
  },
  { virtual: true }
);

jest.mock(
  "@ammarahmed/react-native-sodium",
  () => ({
    __esModule: true,
    default: {
      deriveKey: async (password: string, salt: string) => ({
        key: `key:${salt}:${password}`,
        salt
      })
    }
  }),
  { virtual: true }
);

jest.mock("react-native-get-random-values", () => ({}), { virtual: true });
jest.mock(
  "react-native-securerandom",
  () => ({ generateSecureRandom: async (size: number) => new Uint8Array(size) }),
  { virtual: true }
);
jest.mock("@notesnook/crypto", () => ({}), { virtual: true });
jest.mock("@notesnook/core", () => ({ SubscriptionPlan: {} }), { virtual: true });
jest.mock("@notesnook/intl", () => ({ strings: {} }), { virtual: true });

// encryption.ts only needs the logger from the database module, which pulls in
// the whole database stack.
jest.mock("./index", () => ({
  DatabaseLogger: { info: () => {}, error: () => {}, log: () => {} }
}));

type EncryptionModule = {
  getDatabaseKey: (
    appLockPassword?: string,
    options?: { createIfMissing?: boolean }
  ) => Promise<string | undefined>;
  clearDatabaseKey: () => void;
};

describe("database key storage", () => {
  let encryption: EncryptionModule;

  beforeEach(() => {
    mockState.isSimulator = false;
    mockState.isMacCatalyst = false;
    mockState.keychainRejects = false;
    mockState.keychainCalls = [];
    mockState.keychainSetOptions = [];
    mockState.keychainStore = {};
    mockState.mmkvStores = {};

    // The database key is generated from window.crypto.getRandomValues, which
    // only exists in the app.
    (globalThis as { window?: unknown }).window = {
      crypto: {
        getRandomValues: (array: Uint32Array) => {
          for (let i = 0; i < array.length; i++) array[i] = i + 1;
          return array;
        }
      }
    };

    // The database key is module state, so each case gets its own copy.
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    encryption = require("./encryption") as EncryptionModule;
  });

  test("a first Simulator launch mints and reuses the key without a Keychain", async () => {
    mockState.isSimulator = true;
    // A Release Simulator build has no keychain entitlement at all: every
    // SecItem call rejects, which is what broke the first launch.
    mockState.keychainRejects = true;

    const key = await encryption.getDatabaseKey();
    expect(key).toMatch(/^key:SNuzOcEK3amoqL0WvPeKqw:/);
    expect(mockState.keychainCalls).toEqual([]);

    // The key survives the next launch, still without touching the Keychain.
    encryption.clearDatabaseKey();
    await expect(encryption.getDatabaseKey()).resolves.toBe(key);
    expect(mockState.keychainCalls).toEqual([]);

    expect(mockState.mmkvStores["simulator_key_store"]["notesnook:db"]).toBe(
      JSON.stringify({ username: "notesnook", password: key })
    );
  });

  test("the Simulator never reads the legacy Keychain user key", async () => {
    mockState.isSimulator = true;
    mockState.keychainStore["notesnook"] = {
      username: "notesnook",
      password: "legacy-user-key"
    };

    await encryption.getDatabaseKey();

    expect(mockState.keychainCalls).toEqual([]);
    expect(mockState.mmkvStores["default"].userKeyCipher).toBeUndefined();
  });

  test("a corrupt Simulator database key is rejected, not overwritten", async () => {
    mockState.isSimulator = true;
    const store = (mockState.mmkvStores["simulator_key_store"] = {
      "notesnook:db": "{not json"
    });

    await expect(encryption.getDatabaseKey()).rejects.toThrow(
      /Simulator credentials for notesnook:db are unreadable/
    );

    // The stored record must survive untouched: minting a replacement key here
    // would silently open an empty database over an existing encrypted one.
    expect(store["notesnook:db"]).toBe("{not json");
    expect(mockState.keychainCalls).toEqual([]);
  });

  test("a shape-invalid Simulator database key is rejected, not overwritten", async () => {
    mockState.isSimulator = true;
    for (const invalid of [
      "{}",
      "null",
      "123",
      '"5"',
      '{"username":"n"}',
      '{"password":""}'
    ]) {
      const store = (mockState.mmkvStores["simulator_key_store"] = {
        "notesnook:db": invalid
      });

      await expect(encryption.getDatabaseKey()).rejects.toThrow(
        /Simulator credentials for notesnook:db/
      );

      expect(store["notesnook:db"]).toBe(invalid);
      encryption.clearDatabaseKey();
    }

    expect(mockState.keychainCalls).toEqual([]);
  });

  test("the headless Simulator path also rejects a corrupt database key", async () => {
    mockState.isSimulator = true;
    mockState.mmkvStores["simulator_key_store"] = { "notesnook:db": "not json" };

    await expect(
      encryption.getDatabaseKey(undefined, { createIfMissing: false })
    ).rejects.toThrow(/Simulator credentials for notesnook:db/);

    expect(mockState.mmkvStores["simulator_key_store"]["notesnook:db"]).toBe(
      "not json"
    );
    expect(mockState.keychainCalls).toEqual([]);
  });

  test("a physical iOS build keeps reading and writing the Keychain", async () => {
    const key = await encryption.getDatabaseKey();
    expect(mockState.keychainCalls).toEqual([
      "has:notesnook:db",
      "set:notesnook:db",
      "has:notesnook"
    ]);
    expect(mockState.keychainStore["notesnook:db"]).toEqual({
      username: "notesnook",
      password: key
    });
    // The Simulator store is never created off the Simulator.
    expect(mockState.mmkvStores["simulator_key_store"]).toBeUndefined();

    encryption.clearDatabaseKey();
    await expect(encryption.getDatabaseKey()).resolves.toBe(key);
    expect(mockState.keychainCalls.slice(3)).toEqual([
      "has:notesnook:db",
      "get:notesnook:db",
      "has:notesnook"
    ]);
  });

  test("device and Mac Catalyst keep their existing Keychain access group", async () => {
    await encryption.getDatabaseKey();
    expect(mockState.keychainSetOptions[0]?.accessGroup).toBe(IOS_APPGROUPID);

    // The access group is read once, when the module builds its Keychain
    // options, so Mac Catalyst needs its own copy of the module.
    mockState.isMacCatalyst = true;
    mockState.keychainSetOptions = [];
    mockState.keychainStore = {};
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    encryption = require("./encryption") as EncryptionModule;

    await encryption.getDatabaseKey();
    expect(mockState.keychainSetOptions[0]?.accessGroup).toBe(
      `QXCNJY73A8.${IOS_APPGROUPID}`
    );
  });

  test("a physical iOS build still fails when the Keychain is unreadable", async () => {
    mockState.keychainRejects = true;
    await expect(encryption.getDatabaseKey()).rejects.toThrow(
      "Internal error when a required entitlement isn't present."
    );
  });

  test("only an iOS Simulator build is treated as one", () => {
    mockState.isSimulator = true;
    mockState.isMacCatalyst = false;
    expect(isIosSimulator()).toBe(true);

    // Mac Catalyst is an iOS build too, but it is signed normally and its
    // Keychain works, so it must not take the Simulator path.
    mockState.isMacCatalyst = true;
    expect(isIosSimulator()).toBe(false);

    mockState.isMacCatalyst = false;
    mockState.isSimulator = false;
    expect(isIosSimulator()).toBe(false);
  });
});
