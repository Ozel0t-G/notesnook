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

import Sodium, { Cipher, Password } from "@ammarahmed/react-native-sodium";
import { SerializedKey } from "@notesnook/crypto";
import { Platform } from "react-native";
import "react-native-get-random-values";
import * as Keychain from "react-native-keychain";
import { MMKVLoader, ProcessingModes } from "react-native-mmkv-storage";
import { generateSecureRandom } from "react-native-securerandom";
import {
  getKeychainAccessGroup,
  hasAppGroupContainer,
  isIosSimulator
} from "../../utils/constants";
import { DatabaseLogger } from ".";
import { MMKV } from "./mmkv";

// Database key cipher is persisted across different user sessions hence it has
// it's independent storage which we will never clear. This is only used when application has
// app lock with password enabled.
export const CipherStorage = new MMKVLoader()
  .withInstanceID("cipher_storage")
  .setProcessingMode(
    Platform.OS === "ios" && hasAppGroupContainer()
      ? ProcessingModes.MULTI_PROCESS
      : ProcessingModes.SINGLE_PROCESS
  )
  .disableIndexing()
  .initialize();

const IOS_KEYCHAIN_SERVICE_NAME = "com.ozel0t.note.notesnookpencil";
const KEYCHAIN_SERVER_DBKEY = "notesnook:db";

const NOTESNOOK_APPLOCK_KEY_SALT = "kBwr1Kre86ebOZ8ThLu2OA";
const NOTESNOOK_DB_KEY_SALT = "SNuzOcEK3amoqL0WvPeKqw";

const DB_KEY_CIPHER = "databaseKeyCipher";
const USER_KEY_CIPHER = "userKeyCipher";
const APPLOCK_CIPHER = "applockCipher";

const KEYSTORE_CONFIG = Platform.select({
  ios: {
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    // The App Group doubles as the Keychain access group. Mac Catalyst has no
    // App Group in its Mac App ID's profile, so it uses the team-prefixed form
    // of the same group, which is the only one the Keychain accepts there (see
    // getKeychainAccessGroup). iPhone/iPad keep the unprefixed group.
    accessGroup: getKeychainAccessGroup(),
    service: IOS_KEYCHAIN_SERVICE_NAME
  },
  android: {}
});

/**
 * The legacy user-key Keychain entry (the database key uses
 * KEYCHAIN_SERVER_DBKEY above). Every Keychain read/write in this file now goes
 * through the storage helpers below, so the Simulator has a single place to
 * substitute (see getSimulatorKeyStore).
 */
const KEYCHAIN_SERVER_USERKEY = "notesnook";

const SIMULATOR_KEY_STORE_ID = "simulator_key_store";

type StoredCredentials = { username: string; password: string };

let simulatorKeyStore: ReturnType<MMKVLoader["initialize"]> | undefined;

/**
 * Storage for the database key on the iOS Simulator.
 *
 * A local Simulator build is ad-hoc signed with no provisioning profile, so it
 * has empty entitlements and therefore no Keychain access group: every SecItem
 * call — including the access-group-less `hasInternetCredentials` probe that
 * getDatabaseKey starts with — rejects with errSecMissingEntitlement (-34018).
 * No service or access group can change that from JavaScript, because the
 * process holds no keychain entitlement at all.
 *
 * So on the Simulator, and only there, the database key is kept in a dedicated
 * MMKV instance inside the app sandbox. This is a local test surface for the
 * dedicated simulator account: physical iOS/iPadOS and Mac Catalyst builds keep
 * using the Keychain, with the same services, options and accessibility class
 * as before.
 */
function getSimulatorKeyStore() {
  if (!simulatorKeyStore) {
    simulatorKeyStore = new MMKVLoader()
      .withInstanceID(SIMULATOR_KEY_STORE_ID)
      .setProcessingMode(ProcessingModes.SINGLE_PROCESS)
      .disableIndexing()
      .initialize();
  }
  return simulatorKeyStore;
}

async function hasStoredCredentials(server: string) {
  if (isIosSimulator()) {
    const stored = getSimulatorKeyStore().getString(server);
    // Absence (null/undefined) is the only case that means the credentials do
    // not exist yet. A present-but-empty entry is a corrupt record that must be
    // fatal, never silently treated as absent.
    if (stored == null) return false;
    if (!stored) {
      const error = new Error(
        `Simulator credentials for ${server} are unreadable`
      );
      DatabaseLogger.error(error, "Simulator database key is unreadable");
      throw error;
    }
    return true;
  }
  return await Keychain.hasInternetCredentials(server);
}

async function getStoredCredentials(server: string) {
  if (!isIosSimulator()) return await Keychain.getInternetCredentials(server);

  const stored = getSimulatorKeyStore().getString(server);
  // No entry at all means the credentials genuinely do not exist yet, which is
  // the only case callers treat as "absent" (and may then mint a new key).
  if (stored == null) return false;

  // A present-but-unreadable entry must be fatal, never "absent". Returning
  // false here would make getDatabaseKey fall through to the mint branch and
  // overwrite a corrupt record with a brand-new key — silently opening an empty
  // database on top of an existing encrypted one.
  let credentials: unknown;
  try {
    credentials = JSON.parse(stored);
  } catch {
    // Never log or rethrow the raw SyntaxError: its message can embed stored
    // key bytes. Only a fixed, sanitized error leaves this function.
    const error = new Error(
      `Simulator credentials for ${server} are unreadable`
    );
    DatabaseLogger.error(error, "Simulator database key is unreadable");
    throw error;
  }

  if (
    typeof credentials !== "object" ||
    credentials === null ||
    typeof (credentials as StoredCredentials).username !== "string" ||
    typeof (credentials as StoredCredentials).password !== "string" ||
    !(credentials as StoredCredentials).password
  ) {
    const error = new Error(
      `Simulator credentials for ${server} have an invalid shape`
    );
    DatabaseLogger.error(error, "Simulator database key is unreadable");
    throw error;
  }

  return credentials as StoredCredentials;
}

async function setStoredCredentials(
  server: string,
  username: string,
  password: string
) {
  if (isIosSimulator()) {
    getSimulatorKeyStore().setString(
      server,
      JSON.stringify({ username, password })
    );
    return;
  }
  return await Keychain.setInternetCredentials(
    server,
    username,
    password,
    KEYSTORE_CONFIG
  );
}

async function resetStoredCredentials(server: string) {
  if (isIosSimulator()) {
    getSimulatorKeyStore().removeItem(server);
    return;
  }
  return await Keychain.resetInternetCredentials(server);
}

function generatePassword() {
  const length = 80;
  //@ts-ignore
  const crypto = window.crypto || window.msCrypto;
  if (typeof crypto === "undefined") {
    throw new Error(
      "Crypto API is not supported. Please upgrade your web browser"
    );
  }
  const charset =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&+_{}[]():<>/?;";
  const indexes = crypto.getRandomValues(new Uint32Array(length));
  let secret = "";
  for (const index of indexes) {
    secret += charset[index % charset.length];
  }
  return secret;
}

export async function encryptDatabaseKeyWithPassword(appLockPassword: string) {
  const key = (await getDatabaseKey()) as string;
  const appLockCredentials = await Sodium.deriveKey(
    appLockPassword,
    NOTESNOOK_APPLOCK_KEY_SALT
  );
  const databaseKeyCipher = (await encrypt(appLockCredentials, key)) as Cipher;
  MMKV.setMap(DB_KEY_CIPHER, databaseKeyCipher);
  // We reset the database key from keychain once app lock password is set.
  await resetStoredCredentials(KEYCHAIN_SERVER_DBKEY);
  return true;
}

export async function restoreDatabaseKeyToKeyChain(appLockPassword: string) {
  const databaseKeyCipher = CipherStorage.getMap(DB_KEY_CIPHER) as Cipher;
  const databaseKey = (await decrypt(
    {
      password: appLockPassword
    },
    databaseKeyCipher
  )) as string;

  await setStoredCredentials(KEYCHAIN_SERVER_DBKEY, "notesnook", databaseKey);
  MMKV.removeItem(DB_KEY_CIPHER);
  return true;
}

export async function setAppLockVerificationCipher(appLockPassword: string) {
  try {
    const appLockCredentials = await Sodium.deriveKey(
      appLockPassword,
      NOTESNOOK_APPLOCK_KEY_SALT
    );
    const encrypted = (await encrypt(
      appLockCredentials,
      generatePassword()
    )) as Cipher;
    CipherStorage.setMap(APPLOCK_CIPHER, encrypted);
    DatabaseLogger.info("setAppLockVerificationCipher");
  } catch (e) {
    DatabaseLogger.error(e);
  }
}

export async function clearAppLockVerificationCipher() {
  CipherStorage.removeItem(APPLOCK_CIPHER);
}

export async function validateAppLockPassword(appLockPassword: string) {
  try {
    const appLockCipher: Cipher = CipherStorage.getMap(
      APPLOCK_CIPHER
    ) as Cipher;
    if (!appLockCipher) return true;
    const key = await Sodium.deriveKey(appLockPassword, appLockCipher.salt);
    const decrypted = await decrypt(key, appLockCipher);

    DatabaseLogger.info(
      `validateAppLockPassword: ${typeof decrypted === "string"}`
    );
    return typeof decrypted === "string";
  } catch (e) {
    // A failed authentication tag means the password really is wrong. Anything
    // else (a missing or malformed field, unreadable storage) is not, and
    // reporting it as an incorrect password sends the user round a loop that
    // retyping cannot fix. The return type has to stay boolean because two of
    // the callers do not wrap this, so the distinction is recorded in the log.
    const error = e as Error & { code?: string };
    const isWrongPassword =
      error?.message === "FAILURE" || error?.code === "BAD_MAC";

    if (!isWrongPassword) {
      DatabaseLogger.error(
        error,
        "validateAppLockPassword failed for a reason other than a wrong password"
      );
    } else {
      DatabaseLogger.info("validateAppLockPassword: incorrect password");
    }
    return false;
  }
}

let DB_KEY: string | undefined;
export function clearDatabaseKey() {
  DB_KEY = undefined;
  DatabaseLogger.info("Cleared database key");
}

export type DatabaseKeyOptions = {
  /** Background paths (the Task widget completion) must never mint a key: an
   * unreadable Keychain has to fail the action instead of opening a new empty
   * database on top of the user's existing encrypted one. */
  createIfMissing?: boolean;
};

export async function getDatabaseKey(
  appLockPassword?: string,
  options?: DatabaseKeyOptions
) {
  if (DB_KEY) return DB_KEY;
  if (appLockPassword) {
    const databaseKeyCipher: Cipher = CipherStorage.getMap(
      "databaseKeyCipher"
    ) as Cipher;
    const databaseKey = await decrypt(
      {
        password: appLockPassword
      },
      databaseKeyCipher
    );
    DatabaseLogger.info("Getting database key from cipher");
    DB_KEY = databaseKey;
  }

  if (!DB_KEY) {
    const hasKey = await hasStoredCredentials(KEYCHAIN_SERVER_DBKEY);
    if (hasKey) {
      const credentials = await getStoredCredentials(KEYCHAIN_SERVER_DBKEY);

      // The probe said the credentials exist, so a missing password here is a
      // corrupt/inconsistent record. Fail instead of dereferencing it: leaving
      // DB_KEY undefined would fall through to the mint branch below and
      // overwrite the stored key.
      if (!credentials || !credentials.password) {
        const error = new Error(
          `Stored credentials for ${KEYCHAIN_SERVER_DBKEY} are unreadable`
        );
        DatabaseLogger.error(error, "Simulator database key is unreadable");
        throw error;
      }

      DatabaseLogger.info("Getting database key from Keychain");
      DB_KEY = credentials.password;
    }
  }

  if (!DB_KEY && options?.createIfMissing === false) {
    DatabaseLogger.info(
      "Database key is unavailable and this path may not create one"
    );
    return undefined;
  }

  if (!DB_KEY) {
    DatabaseLogger.info("Generating new database key");
    const password = generatePassword();
    const derivedDatabaseKey = await Sodium.deriveKey(
      password,
      NOTESNOOK_DB_KEY_SALT
    );

    DB_KEY = derivedDatabaseKey.key as string;

    await setStoredCredentials(KEYCHAIN_SERVER_DBKEY, "notesnook", DB_KEY);
  }

  if (await hasStoredCredentials(KEYCHAIN_SERVER_USERKEY)) {
    const userKeyCredentials = await getStoredCredentials(
      KEYCHAIN_SERVER_USERKEY
    );

    if (userKeyCredentials) {
      const userKeyCipher: Cipher = (await encrypt(
        {
          key: DB_KEY,
          salt: NOTESNOOK_DB_KEY_SALT
        },
        userKeyCredentials.password
      )) as Cipher;
      // Store encrypted user key in MMKV
      MMKV.setMap(USER_KEY_CIPHER, userKeyCipher);
      await resetStoredCredentials(KEYCHAIN_SERVER_USERKEY);
    }
    DatabaseLogger.info("Migrated user credentials to cipher storage");
  }

  if (!DB_KEY) {
    throw new Error(
      `Failed to get database key, ${await hasStoredCredentials(
        KEYCHAIN_SERVER_DBKEY
      )}`
    );
  }

  return DB_KEY;
}

export async function deriveCryptoKeyFallback(data: SerializedKey) {
  if (Platform.OS !== "ios") return;
  try {
    if (!data.password || !data.salt)
      throw new Error(
        "Invalid password and salt provided to deriveCryptoKeyFallback"
      );

    const credentials = await Sodium.deriveKeyFallback?.(
      data.password,
      data.salt
    );

    if (!credentials) return;

    const userKeyCipher = (await encrypt(
      {
        key: (await getDatabaseKey()) as string,
        salt: NOTESNOOK_DB_KEY_SALT
      },
      credentials.key as string
    )) as Cipher<"base64">;
    DatabaseLogger.info("User key fallback stored: ", {
      userKeyCipher: !!userKeyCipher
    });

    // Store encrypted user key in MMKV
    MMKV.setMap(USER_KEY_CIPHER, userKeyCipher);
  } catch (e) {
    DatabaseLogger.error(e);
    throw e;
  }
}

export async function deriveCryptoKey(data: SerializedKey) {
  try {
    if (!data.password || !data.salt)
      throw new Error("Invalid password and salt provided to deriveCryptoKey");

    const credentials = (await Sodium.deriveKey(
      data.password,
      data.salt
    )) as Password;
    const userKeyCipher = (await encrypt(
      {
        key: (await getDatabaseKey()) as string,
        salt: NOTESNOOK_DB_KEY_SALT
      },
      credentials.key as string
    )) as Cipher<"base64">;
    DatabaseLogger.info("User key stored: ", {
      userKeyCipher: !!userKeyCipher
    });

    // Store encrypted user key in MMKV
    MMKV.setMap(USER_KEY_CIPHER, userKeyCipher);
  } catch (e) {
    DatabaseLogger.error(e);
    throw e;
  }
}

/** Preserve the exact encrypted MMKV value; never expose the plaintext key. */
export async function snapshotCryptoKeyState() {
  const cipher = MMKV.getMap(USER_KEY_CIPHER);
  return cipher ? JSON.parse(JSON.stringify(cipher)) : undefined;
}

export async function restoreCryptoKeyState(state: unknown) {
  if (state === undefined || state === null) MMKV.removeItem(USER_KEY_CIPHER);
  else MMKV.setMap(USER_KEY_CIPHER, state as Cipher<"base64">);
}

export async function getCryptoKey() {
  try {
    const keyCipher: Cipher = MMKV.getMap(USER_KEY_CIPHER) as Cipher;
    if (!keyCipher) {
      DatabaseLogger.info("User key cipher is null");
      return undefined;
    }

    const key = await decrypt(
      {
        key: (await getDatabaseKey()) as string,
        salt: keyCipher.salt
      },
      keyCipher
    );

    return key;
  } catch (e) {
    DatabaseLogger.error(e);
  }
}

export async function removeCryptoKey() {
  try {
    MMKV.removeItem(USER_KEY_CIPHER);
    await resetStoredCredentials(KEYCHAIN_SERVER_USERKEY);
    return true;
  } catch (e) {
    DatabaseLogger.error(e);
  }
}

export async function getRandomBytes(length: number) {
  return await generateSecureRandom(length);
}

export async function hash(
  password: string,
  email: string,
  options?: { usesFallback?: boolean }
) {
  DatabaseLogger.log(`Hashing password: fallback: ${options?.usesFallback}`);

  if (options?.usesFallback && Platform.OS !== "ios") {
    return "";
  }

  return (
    options?.usesFallback
      ? await Sodium.hashPasswordFallback?.(password, email)
      : await Sodium.hashPassword(password, email)
  ) as string;
}

export async function generateCryptoKey(password: string, salt?: string) {
  return Sodium.deriveKey(password, salt) as Promise<SerializedKey>;
}

export async function generateCryptoKeyFallback(
  password: string,
  salt?: string
): Promise<SerializedKey> {
  return Sodium.deriveKeyFallback?.(
    password,
    salt as string
  ) as Promise<SerializedKey>;
}

export function getAlgorithm(base64Variant: number) {
  return `xcha-argon2i13-${base64Variant}`;
}

export async function decrypt(password: SerializedKey, data: Cipher<"base64">) {
  const _data = { ...data };
  _data.output = "plain";

  if (!password.salt) password.salt = data.salt;

  if (Platform.OS === "ios" && !password.key && password.password) {
    const key = await Sodium.deriveKey(password.password, password.salt);
    try {
      return await Sodium.decrypt(key, _data);
    } catch (e) {
      // Whatever happens while trying the fallback must not replace the
      // original failure: callers match on its message ("FAILURE") to report an
      // incorrect password, and deriveKeyFallback can now reject on its own.
      try {
        const fallbackKey = await Sodium.deriveKeyFallback?.(
          password.password,
          password.salt
        );
        if (fallbackKey) {
          DatabaseLogger.info("Using fallback key for decryption");
          return await Sodium.decrypt(fallbackKey, _data);
        }
      } catch (fallbackError) {
        DatabaseLogger.error(fallbackError, "Fallback decryption failed");
      }
      throw e;
    }
  }

  return await Sodium.decrypt(password, _data);
}

export async function decryptMulti(
  password: Password,
  data: Cipher<"base64">[]
) {
  data = data.map((d) => {
    d.output = "plain";
    return d;
  });

  if (data.length && !password.salt) {
    password.salt = data[0].salt;
  }

  if (Platform.OS === "ios" && !password.key && password.password) {
    const key = await Sodium.deriveKey(password.password, password.salt);
    try {
      return await Sodium.decryptMulti(key, data);
    } catch (e) {
      // See decrypt(): the original error is what callers act on.
      try {
        const fallbackKey = await Sodium.deriveKeyFallback?.(
          password.password,
          password.salt as string
        );
        if (fallbackKey) {
          DatabaseLogger.info("Using fallback key for decryption");
          return await Sodium.decryptMulti(fallbackKey, data);
        }
      } catch (fallbackError) {
        DatabaseLogger.error(fallbackError, "Fallback decryption failed");
      }
      throw e;
    }
  }

  return await Sodium.decryptMulti(password, data);
}

export function parseAlgorithm(alg: string) {
  if (!alg) return {};
  const [enc, kdf, compressed, compressionAlg, base64variant] = alg.split("-");
  return {
    encryptionAlgorithm: enc,
    kdfAlgorithm: kdf,
    compressionAlgorithm: compressionAlg,
    isCompress: compressed === "1",
    base64_variant: base64variant
  };
}

export async function encrypt(password: SerializedKey, plainText: string) {
  const result = await Sodium.encrypt<"base64">(password, {
    type: "plain",
    data: plainText
  });

  return {
    ...result,
    alg: getAlgorithm(7)
  };
}

export async function encryptMulti(
  password: SerializedKey,
  plainText: string[]
) {
  const results = await Sodium.encryptMulti<"base64">(
    password,
    plainText.map((item) => ({
      type: "plain",
      data: item
    }))
  );

  return !results
    ? []
    : results.map((result) => ({
        ...result,
        alg: getAlgorithm(7)
      }));
}
