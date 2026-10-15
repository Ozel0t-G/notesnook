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

/**
 * Rendered regression suite for the *real* `VaultDialog` guarded-share
 * lifecycle.
 *
 * The dialog is mounted with `react-test-renderer` and driven through the exact
 * paths the app uses: the captured `eOpenVaultDialog` subscription callback and
 * the positive/negative callbacks the dialog hands to `DialogButtons`. The real
 * dialog, the real `convertNoteToText` gate, and the real request-lifecycle
 * code run here — only the peripheral edges are doubled: the native view
 * primitives, the OS share sheet and clipboard, the biometric prompt, the event
 * bus, the database boundary and the leaf UI components.
 *
 * Nothing in this file proves the vault crypto: `db.vault.open` hands back a
 * synthetic already-decrypted note, and the structural plaintext check mirrors
 * Core's `isCipher` shape. The cases below pin down *routing and lifetime*: which
 * captured note is exported, which sender guard is consulted, which older async
 * work may not overwrite or close a newer request, and that the captured
 * `onShareComplete` fires at most once per request.
 */

import type { Note, NoteContent } from "@notesnook/core";
import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";

/** Note fixture that also declares the caller-supplied inline content. */
type NoteWithContent = Note & { content?: NoteContent<boolean> };

const CIPHER = { cipher: "Y2lwaGVy", iv: "aXY=", salt: "c2FsdA==" };

function makeNote(overrides: Record<string, unknown> = {}): NoteWithContent {
  return {
    id: "note-1",
    type: "note",
    title: "A note",
    content: { type: "tiptap", data: "decrypted body" },
    ...overrides
  } as unknown as NoteWithContent;
}

/** The already-decrypted note `db.vault.open` hands back as the unlock grant. */
function unlockedNote(
  overrides: Record<string, unknown> = {}
): Note & { content?: NoteContent<false> } {
  return makeNote(overrides) as unknown as Note & {
    content?: NoteContent<false>;
  };
}

function encryptedStoredContent(noteId = "note-1") {
  return {
    id: `content-${noteId}`,
    type: "tiptap",
    noteId,
    data: CIPHER,
    locked: true,
    dateEdited: 0,
    localOnly: false
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/* ------------------------------------------------------------------------- */
/* Doubles                                                                    */
/* ------------------------------------------------------------------------- */

const mockBus = {
  handlers: new Map<string, Set<unknown>>(),
  published: [] as { name: string; args: unknown[] }[],
  reset() {
    this.handlers.clear();
    this.published.length = 0;
  },
  publish(name: string, ...args: unknown[]) {
    this.published.push({ name, args });
    this.handlers.get(name)?.forEach((handler) => {
      (handler as (...a: unknown[]) => unknown)(...args);
    });
  }
};

type MockFormRef = {
  values: Record<string, string>;
  setValue: jest.Mock;
  getValue: jest.Mock;
  getValues: jest.Mock;
  setError: jest.Mock;
  getError: jest.Mock;
  clearErrors: jest.Mock;
  registerField: jest.Mock;
  unregisterField: jest.Mock;
  validateField: jest.Mock;
  validate: jest.Mock;
  subscribe: jest.Mock;
  subscribeChange: jest.Mock;
};

type MockDialogButtonProps = {
  onPressPositive?: () => void | Promise<void>;
  onPressNegative?: () => void;
  loading?: boolean;
  positiveTitle?: string;
};

type OpenVaultHandler = (data: Vault) => Promise<void>;

let mockFormRefInstance: MockFormRef | null = null;
let mockEnableBiometrics: (() => void) | undefined;
let mockDialogButtons: MockDialogButtonProps | null = null;

jest.mock("react-native", () => ({
  View: ({ children }: { children?: unknown }) => children ?? null,
  TextInput: () => null,
  InteractionManager: {
    runAfterInteractions: (callback?: () => void) => {
      callback?.();
      return { cancel: jest.fn() };
    }
  },
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: (s: unknown) => s
  },
  Platform: { OS: "ios", isPad: false, isMacCatalyst: false },
  ActivityIndicator: () => null,
  TouchableOpacity: () => null,
  Pressable: () => null,
  Modal: () => null,
  SafeAreaView: () => null,
  KeyboardAvoidingView: () => null,
  useWindowDimensions: () => ({
    width: 390,
    height: 844,
    fontScale: 1,
    scale: 2
  }),
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) }
}));

jest.mock("@notesnook/core", () => {
  const looksEncrypted = (content: unknown) => {
    if (!content || typeof content !== "object") return false;
    const data = (content as { data?: unknown }).data;
    if (!data || typeof data !== "object") return false;
    return "cipher" in data && "iv" in data && "salt" in data;
  };
  return {
    isEncryptedContent: (content: unknown) => looksEncrypted(content),
    isDecryptedContent: (content: unknown) => !looksEncrypted(content),
    VAULT_ERRORS: { wrongPassword: "wrong password" }
  };
});

jest.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: (_target, key) => () => String(key) })
}));

jest.mock("@notesnook/theme", () => {
  const leaf = new Proxy({} as Record<string, string>, {
    get: () => "#000000"
  });
  const colors = new Proxy({} as Record<string, typeof leaf>, {
    get: () => leaf
  });
  return { useThemeColors: () => ({ colors, isDark: false }) };
});

jest.mock("@react-native-clipboard/clipboard", () => ({
  __esModule: true,
  default: { setString: jest.fn() }
}));

jest.mock("react-native-share", () => ({
  __esModule: true,
  default: { open: jest.fn() }
}));

jest.mock("../../../common/database", () => ({
  DatabaseLogger: { log: jest.fn(), info: jest.fn(), error: jest.fn() },
  db: {
    vault: {
      open: jest.fn(),
      add: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
      unlock: jest.fn(async () => true),
      create: jest.fn(async () => undefined),
      changePassword: jest.fn(async () => undefined)
    },
    vaults: { itemExists: jest.fn(), default: jest.fn() },
    content: { findByNoteId: jest.fn() },
    notes: { export: jest.fn() },
    relations: {
      from: jest.fn(() => ({ get: jest.fn(async () => []) }))
    },
    user: {
      getUser: jest.fn(async () => null),
      verifyPassword: jest.fn(async () => true)
    },
    eventManager: { subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) }
  }
}));

jest.mock("../../../services/biometrics", () => ({
  __esModule: true,
  default: {
    isBiometryAvailable: jest.fn(),
    hasInternetCredentials: jest.fn(),
    getCredentials: jest.fn(),
    storeCredentials: jest.fn(async () => undefined),
    resetCredentials: jest.fn(async () => undefined)
  }
}));

jest.mock("../../../services/device-detection", () => ({
  DDS: { isTab: false }
}));

jest.mock("../../../services/navigation", () => ({
  __esModule: true,
  default: {
    queueRoutesForUpdate: jest.fn(),
    navigate: jest.fn(),
    push: jest.fn(),
    goBack: jest.fn()
  }
}));

jest.mock("../../../services/event-manager", () => ({
  VaultRequestType: {
    CreateVault: "createVault",
    LockNote: "lockNote",
    UnlockNote: "unlockNote",
    PermanentUnlock: "permanentUnlock",
    GoToEditor: "goToEditor",
    ShareNote: "shareNote",
    CopyNote: "copyNote",
    DeleteNote: "deleteNote",
    EnableFingerprint: "enableFingerprint",
    RevokeFingerprint: "revokeFingerprint",
    ChangePassword: "changePassword",
    ClearVault: "clearVault",
    DeleteVault: "deleteVault",
    CustomAction: "customAction"
  },
  eSendEvent: (name: string, ...args: unknown[]) =>
    mockBus.publish(name, ...args),
  eSubscribeEvent: (name: string, handler: unknown) => {
    if (!mockBus.handlers.has(name)) mockBus.handlers.set(name, new Set());
    mockBus.handlers.get(name)!.add(handler);
    return { unsubscribe: () => mockBus.handlers.get(name)?.delete(handler) };
  },
  eUnSubscribeEvent: (name: string, handler: unknown) => {
    mockBus.handlers.get(name)?.delete(handler);
  },
  ToastManager: { show: jest.fn(), error: jest.fn(), hide: jest.fn() },
  openVault: jest.fn()
}));

jest.mock("../../../utils/elevation", () => ({
  getElevationStyle: jest.fn(() => ({}))
}));

jest.mock("../../../utils/events", () => ({
  eCloseActionSheet: "eCloseActionSheet",
  eCloseVaultDialog: "eCloseVaultDialog",
  eOnLoadNote: "eOnLoadNote",
  eOpenVaultDialog: "eOpenVaultDialog",
  eUpdateNoteInEditor: "eUpdateNoteInEditor"
}));

jest.mock("../../../utils/functions", () => ({
  deleteItems: jest.fn(async () => undefined)
}));

jest.mock("../../../utils/global-refs", () => ({
  fluidTabsRef: { current: { goToPage: jest.fn() } }
}));

jest.mock("../../../utils/time", () => ({
  sleep: jest.fn(async () => undefined)
}));

jest.mock("../../../utils/styles", () => ({
  DefaultAppStyles: {
    GAP: 12,
    GAP_VERTICAL: 10,
    GAP_SMALL: 6,
    GAP_VERTICAL_SMALL: 4
  }
}));

jest.mock("../../../utils/size", () => ({
  AppFontSize: { xs: 11, sm: 13, md: 15, lg: 17, xl: 20 }
}));

jest.mock("../../../stores/use-user-store", () => ({
  useUserStore: (selector: (state: { user: unknown }) => unknown) =>
    selector({ user: null })
}));

jest.mock("../../dialog/base-dialog", () => ({
  __esModule: true,
  default: ({ children }: { children?: unknown }) => children ?? null
}));

jest.mock("../../dialog/dialog-buttons", () => ({
  __esModule: true,
  default: (props: {
    onPressPositive?: () => void | Promise<void>;
    onPressNegative?: () => void;
    loading?: boolean;
    positiveTitle?: string;
  }) => {
    mockDialogButtons = props;
    return null;
  }
}));

jest.mock("../../dialog/dialog-header", () => ({
  __esModule: true,
  default: () => null
}));

jest.mock("../../toast", () => ({
  Toast: () => null
}));

jest.mock("../../ui/button", () => ({
  Button: (props: { icon?: string; onPress?: () => void }) => {
    if (props.icon === "fingerprint") mockEnableBiometrics = props.onPress;
    return null;
  }
}));

jest.mock("../../ui/input/form-input", () => {
  const build = (initial: Record<string, string>) => {
    const values: Record<string, string> = { ...initial };
    const errors: Record<string, string> = {};
    const ref = {
      values,
      setValue: jest.fn((name: string, value: string) => {
        values[name] = value;
      }),
      getValue: jest.fn((name: string) => values[name] ?? ""),
      getValues: jest.fn(() => ({ ...values })),
      setError: jest.fn((name: string, error?: string) => {
        if (error) errors[name] = error;
        else delete errors[name];
      }),
      getError: jest.fn((name: string) => errors[name]),
      clearErrors: jest.fn(() => {
        Object.keys(errors).forEach((key) => delete errors[key]);
      }),
      registerField: jest.fn(),
      unregisterField: jest.fn(),
      validateField: jest.fn(() => undefined),
      validate: jest.fn(() => true),
      subscribe: jest.fn(() => () => undefined),
      subscribeChange: jest.fn(() => () => undefined)
    };
    // The production dialog calls `useRef(createFormRef(...))`: the factory runs
    // on every render, but `useRef` retains only the FIRST result. Capture that
    // retained instance once per mounted dialog (reset in `beforeEach`) instead
    // of letting every later render's throwaway win. This is the ref a
    // request-type-agnostic test must drive, including request types whose
    // dialog body renders no password field at all.
    if (!mockFormRefInstance) mockFormRefInstance = ref;
    return ref;
  };
  return {
    __esModule: true,
    default: () => null,
    createFormRef: (initial: Record<string, string>) => build(initial),
    validators: {
      required: () => () => undefined,
      matchField: () => () => undefined
    }
  };
});

jest.mock("../../ui/seperator", () => ({
  __esModule: true,
  default: () => null
}));

jest.mock("../../ui/typography/paragraph", () => ({
  __esModule: true,
  default: () => null
}));

jest.mock("../../ui/pressable", () => ({
  Pressable: () => null
}));

jest.mock("../../ui/AppIcon", () => ({
  __esModule: true,
  default: () => null
}));

import Clipboard from "@react-native-clipboard/clipboard";
import Share from "react-native-share";
import { db } from "../../../common/database";
import BiometricService from "../../../services/biometrics";
import {
  ToastManager,
  VaultRequestType
} from "../../../services/event-manager";
import type { Vault } from "../../../services/event-manager";
import type { NoteSenderGuard } from "../../../utils/note-to-text";
import { VaultDialog } from "./index";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const dbVault = db.vault as unknown as Record<string, jest.Mock>;
const dbVaults = db.vaults as unknown as {
  itemExists: jest.Mock;
  default: jest.Mock;
};
const dbContent = db.content as unknown as { findByNoteId: jest.Mock };
const dbNotes = db.notes as unknown as { export: jest.Mock };
const biometrics = BiometricService as unknown as Record<string, jest.Mock>;
const shareOpen = Share.open as unknown as jest.Mock;
const clipboardSetString = Clipboard.setString as unknown as jest.Mock;
const toastShow = ToastManager.show as unknown as jest.Mock;

/* ------------------------------------------------------------------------- */
/* Harness                                                                    */
/* ------------------------------------------------------------------------- */

let tree: ReactTestRenderer | undefined;

const renderDialog = () => {
  act(() => {
    tree = create(<VaultDialog />);
  });
};

const openHandlers = () =>
  [...(mockBus.handlers.get("eOpenVaultDialog") ?? [])] as OpenVaultHandler[];

/** The single live `eOpenVaultDialog` handler the mounted dialog registered. */
const currentOpenHandler = () => {
  const handlers = openHandlers();
  return handlers[handlers.length - 1];
};

/** Emits an inbound `eOpenVaultDialog` request and lets it settle. */
const emitOpen = async (data: Vault) => {
  await act(async () => {
    await currentOpenHandler()?.(data);
  });
};

/** Starts an inbound request without waiting for it to settle. */
const startOpen = (data: Vault) => {
  let pending: Promise<unknown> = Promise.resolve();
  act(() => {
    pending = Promise.resolve(currentOpenHandler()?.(data));
  });
  return pending;
};

const setPassword = (password: string) => {
  mockFormRefInstance?.setValue("password", password);
};

/** Presses the real positive button and resolves once its async work is done. */
const pressPositive = async () => {
  await act(async () => {
    await mockDialogButtons?.onPressPositive?.();
  });
};

/** Starts a positive press without waiting for its async work to finish. */
const pressPositiveDeferred = () => {
  let pending: Promise<unknown> = Promise.resolve();
  act(() => {
    pending = Promise.resolve(mockDialogButtons?.onPressPositive?.());
  });
  return pending;
};

/**
 * Drains the microtask queue so the dialog's async chain progresses up to
 * whatever user-controlled deferred is holding it.
 */
const flushMicrotasks = async () => {
  await act(async () => {});
};

const pressNegative = () => {
  act(() => {
    mockDialogButtons?.onPressNegative?.();
  });
};

const shareOptions = (index = 0) =>
  shareOpen.mock.calls[index][0] as Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  mockBus.reset();
  mockFormRefInstance = null;
  mockDialogButtons = null;
  mockEnableBiometrics = undefined;

  [
    dbVault.open,
    dbVaults.itemExists,
    dbVaults.default,
    dbContent.findByNoteId,
    dbNotes.export,
    biometrics.isBiometryAvailable,
    biometrics.hasInternetCredentials,
    biometrics.getCredentials,
    shareOpen
  ].forEach((mock) => mock.mockReset());

  dbVaults.default.mockResolvedValue({ id: "vault-1" });
  dbVaults.itemExists.mockResolvedValue(true);
  dbContent.findByNoteId.mockResolvedValue(undefined);
  dbNotes.export.mockResolvedValue("exported text");
  dbVault.open.mockResolvedValue(unlockedNote());
  biometrics.isBiometryAvailable.mockResolvedValue(false);
  biometrics.hasInternetCredentials.mockResolvedValue(false);
  biometrics.getCredentials.mockResolvedValue(undefined);
  shareOpen.mockResolvedValue(undefined);

  renderDialog();
});

afterEach(() => {
  if (tree) act(() => tree?.unmount());
  tree = undefined;
});

/* ------------------------------------------------------------------------- */
/* Guarded primary share                                                      */
/* ------------------------------------------------------------------------- */

describe("guarded share uses the captured sender guard and note", () => {
  it("exports the vault-member note's decrypted content and opens the share sheet", async () => {
    const guard = jest.fn(() => true);
    const done = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: guard,
      onShareComplete: done
    });
    setPassword("pw");
    await pressPositive();

    expect(guard).toHaveBeenCalledWith("note-1");
    expect(dbNotes.export).toHaveBeenCalledWith(
      "note-1",
      expect.objectContaining({
        contentItem: { type: "tiptap", data: "decrypted body" },
        format: "txt"
      })
    );
    expect(clipboardSetString).not.toHaveBeenCalled();
    expect(shareOpen).toHaveBeenCalledTimes(1);
    expect(shareOptions()).toMatchObject({
      title: "A note",
      failOnCancel: false,
      message: "exported text"
    });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("unlocks a non-member whose stored content is encrypted (fallback) and shares", async () => {
    dbVaults.itemExists.mockResolvedValue(false);
    dbContent.findByNoteId.mockResolvedValue(encryptedStoredContent());
    const guard = jest.fn(() => true);
    const done = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: guard,
      onShareComplete: done
    });
    setPassword("pw");
    await pressPositive();

    expect(dbContent.findByNoteId).toHaveBeenCalledWith("note-1");
    expect(dbNotes.export).toHaveBeenCalledWith(
      "note-1",
      expect.objectContaining({
        contentItem: { type: "tiptap", data: "decrypted body" }
      })
    );
    expect(shareOpen).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("opens the share sheet for a legitimately empty export", async () => {
    dbNotes.export.mockResolvedValue("");
    const done = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: jest.fn(() => true),
      onShareComplete: done
    });
    setPassword("pw");
    await pressPositive();

    // `""` is a valid conversion, not a failure: the sheet still opens.
    expect(shareOpen).toHaveBeenCalledTimes(1);
    expect(shareOptions().message).toBe("");
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("guarded share aborts truthfully", () => {
  it("aborts before any export when the captured guard is already stale", async () => {
    const guard = jest.fn(() => false);
    const done = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: guard,
      onShareComplete: done
    });
    setPassword("pw");
    await pressPositive();

    // The very first, pre-await fence refuses: no biometric probe, no
    // membership lookup, no unlock and no dialog are ever reached.
    expect(biometrics.isBiometryAvailable).not.toHaveBeenCalled();
    expect(biometrics.hasInternetCredentials).not.toHaveBeenCalled();
    expect(dbVaults.itemExists).not.toHaveBeenCalled();
    expect(dbVault.open).not.toHaveBeenCalled();
    expect(dbNotes.export).not.toHaveBeenCalled();
    expect(shareOpen).not.toHaveBeenCalled();
    expect(clipboardSetString).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
    expect(mockDialogButtons).toBeNull();
  });

  it("drops the exported text without sharing when the sender changes after export", async () => {
    // The fence stays confirmed through the preflight and the unlock; the
    // sender changes exactly while the export runs, so the export's text is
    // produced but its now-stale result is discarded instead of shared.
    let senderActive = true;
    const guard = jest.fn(() => senderActive);
    const done = jest.fn();
    dbNotes.export.mockImplementationOnce(async () => {
      senderActive = false;
      return "exported text";
    });

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: guard,
      onShareComplete: done
    });
    setPassword("pw");
    await pressPositive();

    // The export ran, but its stale result is discarded.
    expect(dbNotes.export).toHaveBeenCalledTimes(1);
    expect(shareOpen).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("shows the generic error and never shares when the exporter declines", async () => {
    dbNotes.export.mockResolvedValue(false);
    const done = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: jest.fn(() => true),
      onShareComplete: done
    });
    setPassword("pw");
    await pressPositive();

    expect(shareOpen).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "somethingWentWrong",
        type: "error",
        context: "global"
      })
    );
    expect(done).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------- */
/* Guarded primary: the fence revalidates around every await                  */
/* ------------------------------------------------------------------------- */

// A supplied guard that is not callable must fail closed before any database,
// biometric or dialog work: `undefined` (legacy) is the only inert value.
const NON_FUNCTION_GUARDS: Array<[string, unknown]> = [
  ["null", null],
  ["false", false],
  ["0", 0],
  ["an empty string", ""],
  ["a plain object", {}]
];

describe("guarded primary fails closed around every await", () => {
  it.each(NON_FUNCTION_GUARDS)(
    "does not touch the database or show the dialog for a non-callable guard (%s)",
    async (_label, guardValue) => {
      const done = jest.fn();

      await emitOpen({
        requestType: VaultRequestType.ShareNote,
        item: makeNote(),
        shareGuard: guardValue as unknown as NoteSenderGuard,
        onShareComplete: done
      });
      setPassword("pw");
      await pressPositive();

      expect(biometrics.isBiometryAvailable).not.toHaveBeenCalled();
      expect(biometrics.hasInternetCredentials).not.toHaveBeenCalled();
      expect(dbVaults.itemExists).not.toHaveBeenCalled();
      expect(dbContent.findByNoteId).not.toHaveBeenCalled();
      expect(dbVault.open).not.toHaveBeenCalled();
      expect(dbNotes.export).not.toHaveBeenCalled();
      expect(shareOpen).not.toHaveBeenCalled();
      expect(done).toHaveBeenCalledTimes(1);
      expect(mockDialogButtons).toBeNull();
    }
  );

  it("aborts before the membership lookup when the sender changes after the biometric probe", async () => {
    let senderActive = true;
    const guard = jest.fn(() => senderActive);
    const done = jest.fn();
    biometrics.isBiometryAvailable.mockImplementationOnce(async () => {
      senderActive = false;
      return false;
    });

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: guard,
      onShareComplete: done
    });

    expect(biometrics.isBiometryAvailable).toHaveBeenCalledTimes(1);
    expect(biometrics.hasInternetCredentials).not.toHaveBeenCalled();
    expect(dbVaults.itemExists).not.toHaveBeenCalled();
    expect(dbVault.open).not.toHaveBeenCalled();
    expect(shareOpen).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
    expect(mockDialogButtons).toBeNull();
  });

  it("aborts before the content lookup when the sender changes after the membership check", async () => {
    let senderActive = true;
    const guard = jest.fn(() => senderActive);
    const done = jest.fn();
    dbVaults.itemExists.mockImplementationOnce(async () => {
      senderActive = false;
      return false;
    });

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: guard,
      onShareComplete: done
    });

    expect(dbVaults.itemExists).toHaveBeenCalledTimes(1);
    expect(dbContent.findByNoteId).not.toHaveBeenCalled();
    expect(dbVault.open).not.toHaveBeenCalled();
    expect(shareOpen).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
    expect(mockDialogButtons).toBeNull();
  });

  it("aborts after the note unlock without sharing when the sender changes mid-unlock", async () => {
    let senderActive = true;
    const guard = jest.fn(() => senderActive);
    const done = jest.fn();
    dbVault.open.mockImplementationOnce(async () => {
      senderActive = false;
      return unlockedNote();
    });

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: guard,
      onShareComplete: done
    });
    setPassword("pw");
    await pressPositive();

    expect(dbVault.open).toHaveBeenCalledTimes(1);
    expect(dbNotes.export).not.toHaveBeenCalled();
    expect(shareOpen).not.toHaveBeenCalled();
    expect(clipboardSetString).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------- */
/* Legacy (unguarded) share                                                   */
/* ------------------------------------------------------------------------- */

describe("legacy share without a guard keeps its exact behavior", () => {
  it("shares with the legacy options and no guard fencing", async () => {
    const done = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      onShareComplete: done
    });
    setPassword("pw");
    await pressPositive();

    expect(dbNotes.export).toHaveBeenCalledWith(
      "note-1",
      expect.objectContaining({
        contentItem: { type: "tiptap", data: "decrypted body" },
        format: "txt"
      })
    );
    expect(shareOpen).toHaveBeenCalledTimes(1);
    const options = shareOptions();
    expect(Object.keys(options).sort()).toEqual([
      "failOnCancel",
      "message",
      "title"
    ]);
    expect(options).toMatchObject({
      title: "A note",
      failOnCancel: false,
      message: "exported text"
    });
    expect(done).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------- */
/* Completion lifetime                                                        */
/* ------------------------------------------------------------------------- */

describe("request completion lifetime", () => {
  it("completes a cancelled pending unlock exactly once and never shares", async () => {
    const unlock = deferred<unknown>();
    dbVault.open.mockImplementationOnce(() => unlock.promise);
    const done = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: jest.fn(() => true),
      onShareComplete: done
    });
    setPassword("pw");
    const pendingPress = pressPositiveDeferred();
    await flushMicrotasks();

    pressNegative();
    expect(done).toHaveBeenCalledTimes(1);

    unlock.resolve(unlockedNote());
    await act(async () => {
      await pendingPress;
    });

    expect(shareOpen).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("cancels a share whose export is still pending without opening the sheet", async () => {
    const exporter = deferred<string | false>();
    dbNotes.export.mockImplementationOnce(() => exporter.promise);
    const done = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: jest.fn(() => true),
      onShareComplete: done
    });
    setPassword("pw");
    const pendingPress = pressPositiveDeferred();
    await flushMicrotasks();

    pressNegative();
    expect(done).toHaveBeenCalledTimes(1);

    exporter.resolve("late text");
    await act(async () => {
      await pendingPress;
    });

    expect(shareOpen).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("keeps the pending intent alive across a wrong password for a retry", async () => {
    dbVault.open
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(unlockedNote());
    const done = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: jest.fn(() => true),
      onShareComplete: done
    });
    setPassword("pw");
    await pressPositive();

    expect(shareOpen).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(mockFormRefInstance?.getError("password")).toBe("passwordIncorrect");

    await pressPositive();

    expect(shareOpen).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("releases the completion once when the share sheet rejects", async () => {
    shareOpen.mockRejectedValueOnce(new Error("user cancelled"));
    const done = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: jest.fn(() => true),
      onShareComplete: done
    });
    setPassword("pw");
    await pressPositive();

    expect(shareOpen).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("completes each replaced request exactly once", async () => {
    const doneA = jest.fn();
    const doneB = jest.fn();
    const doneC = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.GoToEditor,
      item: makeNote({ id: "note-a" }),
      onShareComplete: doneA
    });
    await emitOpen({
      requestType: VaultRequestType.GoToEditor,
      item: makeNote({ id: "note-b" }),
      onShareComplete: doneB
    });

    expect(doneA).toHaveBeenCalledTimes(1);
    expect(doneB).not.toHaveBeenCalled();

    await emitOpen({
      requestType: VaultRequestType.GoToEditor,
      item: makeNote({ id: "note-c" }),
      onShareComplete: doneC
    });

    expect(doneA).toHaveBeenCalledTimes(1);
    expect(doneB).toHaveBeenCalledTimes(1);
    expect(doneC).not.toHaveBeenCalled();
  });

  it("completes a pending request once on unmount without sharing", async () => {
    const unlock = deferred<unknown>();
    dbVault.open.mockImplementationOnce(() => unlock.promise);
    const done = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote(),
      shareGuard: jest.fn(() => true),
      onShareComplete: done
    });
    setPassword("pw");
    const pendingPress = pressPositiveDeferred();
    await flushMicrotasks();

    act(() => {
      tree?.unmount();
    });
    tree = undefined;

    expect(done).toHaveBeenCalledTimes(1);
    expect(shareOpen).not.toHaveBeenCalled();

    unlock.resolve(unlockedNote());
    await act(async () => {
      await pendingPress;
    });

    expect(shareOpen).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------- */
/* Cross-request races                                                        */
/* ------------------------------------------------------------------------- */

describe("older requests cannot touch a newer one", () => {
  it("keeps a replacement pending when an older copy finishes", async () => {
    const exporter = deferred<string | false>();
    const doneB = jest.fn();
    dbVault.open.mockResolvedValueOnce(unlockedNote({ id: "note-a" }));
    dbNotes.export.mockImplementationOnce(() => exporter.promise);
    await emitOpen({
      requestType: VaultRequestType.CopyNote,
      item: makeNote({ id: "note-a" })
    });
    setPassword("pw");
    const pendingCopy = pressPositiveDeferred();
    await flushMicrotasks();

    const biometry = deferred<boolean>();
    biometrics.isBiometryAvailable.mockImplementationOnce(
      () => biometry.promise
    );
    const pendingB = startOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote({ id: "note-b" }),
      shareGuard: (id) => id === "note-b",
      onShareComplete: doneB
    });
    exporter.resolve("obsolete copy");
    await act(async () => {
      await pendingCopy;
    });
    expect(doneB).not.toHaveBeenCalled();
    expect(clipboardSetString).not.toHaveBeenCalled();

    biometry.resolve(false);
    await act(async () => {
      await pendingB;
    });
    dbVault.open.mockResolvedValueOnce(unlockedNote({ id: "note-b" }));
    setPassword("pw");
    await pressPositive();
    expect(shareOpen).toHaveBeenCalledTimes(1);
    expect(doneB).toHaveBeenCalledTimes(1);
  });

  it("ignores the previous dialog's button while a replacement is preparing", async () => {
    const doneA = jest.fn();
    const doneB = jest.fn();
    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote({ id: "note-a" }),
      shareGuard: () => true,
      onShareComplete: doneA
    });

    const biometry = deferred<boolean>();
    biometrics.isBiometryAvailable.mockImplementationOnce(
      () => biometry.promise
    );
    const pendingB = startOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote({ id: "note-b" }),
      shareGuard: (id) => id === "note-b",
      onShareComplete: doneB
    });

    setPassword("pw");
    await pressPositive();
    expect(dbVault.open).not.toHaveBeenCalled();
    expect(shareOpen).not.toHaveBeenCalled();
    expect(doneA).toHaveBeenCalledTimes(1);
    expect(doneB).not.toHaveBeenCalled();

    biometry.resolve(false);
    await act(async () => {
      await pendingB;
    });
    dbVault.open.mockResolvedValue(unlockedNote({ id: "note-b" }));
    setPassword("pw");
    await pressPositive();
    expect(dbVault.open).toHaveBeenCalledWith("note-b", "pw");
    expect(shareOpen).toHaveBeenCalledTimes(1);
    expect(doneB).toHaveBeenCalledTimes(1);
  });

  it("does not let an older open install refs or dispatch over a newer request", async () => {
    const biometry = deferred<boolean>();
    biometrics.isBiometryAvailable.mockImplementationOnce(
      () => biometry.promise
    );
    const doneA = jest.fn();
    const doneB = jest.fn();

    const pendingA = startOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote({ id: "note-a" }),
      shareGuard: jest.fn(() => true),
      onShareComplete: doneA
    });

    await emitOpen({
      requestType: VaultRequestType.CopyNote,
      item: makeNote({ id: "note-b" }),
      title: "B",
      onShareComplete: doneB
    });
    expect(doneA).toHaveBeenCalledTimes(1);

    biometry.resolve(false);
    await act(async () => {
      await pendingA;
    });

    // The newer request still owns the dialog: its action runs, the older
    // guarded Share does not.
    setPassword("pw");
    await pressPositive();
    expect(clipboardSetString).toHaveBeenCalledWith("exported text");
    expect(shareOpen).not.toHaveBeenCalled();

    // The newer request's own completion fires once when its action ends.
    expect(doneB).toHaveBeenCalledTimes(1);
    expect(doneA).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch an older deferred unlock under a newer request's action", async () => {
    const unlock = deferred<unknown>();
    dbVault.open.mockImplementationOnce(() => unlock.promise);
    const doneA = jest.fn();
    const doneB = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote({ id: "note-a" }),
      shareGuard: jest.fn(() => true),
      onShareComplete: doneA
    });
    setPassword("pw");
    const pendingPressA = pressPositiveDeferred();
    await flushMicrotasks();

    await emitOpen({
      requestType: VaultRequestType.CopyNote,
      item: makeNote({ id: "note-b" }),
      title: "B",
      onShareComplete: doneB
    });
    expect(doneA).toHaveBeenCalledTimes(1);
    expect(doneB).not.toHaveBeenCalled();

    unlock.resolve(unlockedNote());
    await act(async () => {
      await pendingPressA;
    });

    expect(shareOpen).not.toHaveBeenCalled();
    expect(doneA).toHaveBeenCalledTimes(1);

    pressNegative();
    expect(doneB).toHaveBeenCalledTimes(1);
  });

  it("does not write biometric credentials into a newer request's form", async () => {
    const credentials = deferred<{ password: string }>();
    biometrics.isBiometryAvailable.mockImplementationOnce(async () => true);
    biometrics.hasInternetCredentials.mockImplementationOnce(async () => true);
    biometrics.getCredentials.mockImplementationOnce(() => credentials.promise);
    const doneA = jest.fn();

    const pendingA = startOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote({ id: "note-a" }),
      shareGuard: jest.fn(() => true),
      onShareComplete: doneA
    });
    // Let A install its refs and reach the credential prompt.
    await flushMicrotasks();
    expect(biometrics.getCredentials).toHaveBeenCalledTimes(1);

    await emitOpen({
      requestType: VaultRequestType.CopyNote,
      item: makeNote({ id: "note-b" }),
      title: "B",
      onShareComplete: jest.fn()
    });
    expect(doneA).toHaveBeenCalledTimes(1);

    credentials.resolve({ password: "biometric-secret" });
    await act(async () => {
      await pendingA;
    });

    expect(mockFormRefInstance?.getValue("password")).toBe("");
    expect(shareOpen).not.toHaveBeenCalled();
  });

  it("does not let a completed older share call the newer request's callback", async () => {
    const sheet = deferred<void>();
    shareOpen.mockImplementationOnce(() => sheet.promise);
    // `db.vault.open(id)` returns the decrypted note for that id in
    // production; the sender fence insists the exported note is the one that
    // was requested, so this fixture unlocks the requested note-a rather than
    // a generic default one.
    dbVault.open.mockImplementationOnce(async (id: string) => {
      return unlockedNote({ id });
    });
    const doneA = jest.fn();
    const doneB = jest.fn();

    await emitOpen({
      requestType: VaultRequestType.ShareNote,
      item: makeNote({ id: "note-a" }),
      shareGuard: jest.fn(() => true),
      onShareComplete: doneA
    });
    setPassword("pw");
    const pendingPressA = pressPositiveDeferred();
    await flushMicrotasks();

    // A has already dispatched its own share sheet.
    expect(shareOpen).toHaveBeenCalledTimes(1);
    expect(doneA).not.toHaveBeenCalled();

    await emitOpen({
      requestType: VaultRequestType.CopyNote,
      item: makeNote({ id: "note-b" }),
      title: "B",
      onShareComplete: doneB
    });
    expect(doneA).toHaveBeenCalledTimes(1);
    expect(doneB).not.toHaveBeenCalled();

    sheet.resolve();
    await act(async () => {
      await pendingPressA;
    });

    expect(doneA).toHaveBeenCalledTimes(1);
    expect(doneB).not.toHaveBeenCalled();

    pressNegative();
    expect(doneB).toHaveBeenCalledTimes(1);
  });
});

describe("owned legacy actions and preflight failures", () => {
  it.each(["biometry", "membership", "content", "guard"])(
    "completes a failed Share preflight exactly once: %s",
    async (edge) => {
      const done = jest.fn();
      const guard = jest.fn(() => true);
      if (edge === "biometry")
        biometrics.isBiometryAvailable.mockRejectedValue(
          new Error("synthetic failure")
        );
      if (edge === "membership")
        dbVaults.itemExists.mockRejectedValue(new Error("synthetic failure"));
      if (edge === "content") {
        dbVaults.itemExists.mockResolvedValue(false);
        dbContent.findByNoteId.mockRejectedValue(
          new Error("synthetic failure")
        );
      }
      if (edge === "guard")
        guard.mockImplementation(() => {
          throw new Error("synthetic guard failure");
        });
      await emitOpen({
        item: makeNote(),
        requestType: VaultRequestType.ShareNote,
        shareGuard: guard,
        onShareComplete: done
      });
      expect(done).toHaveBeenCalledTimes(1);
      expect(shareOpen).not.toHaveBeenCalled();
      expect(dbNotes.export).not.toHaveBeenCalled();
      expect(tree?.toJSON()).toBeNull();
    }
  );
  it.each([
    VaultRequestType.LockNote,
    VaultRequestType.PermanentUnlock,
    VaultRequestType.ChangePassword,
    VaultRequestType.ClearVault,
    VaultRequestType.DeleteVault,
    VaultRequestType.EnableFingerprint,
    VaultRequestType.RevokeFingerprint
  ])("preserves legacy effects and completion for %s", async (requestType) => {
    const done = jest.fn();
    await emitOpen({ item: makeNote(), requestType, onShareComplete: done });
    setPassword("synthetic password");
    mockFormRefInstance?.setValue("newPassword", "synthetic replacement");
    await pressPositive();
    await flushMicrotasks();
    if (requestType === VaultRequestType.LockNote)
      expect(dbVault.add).toHaveBeenCalledWith("note-1");
    if (requestType === VaultRequestType.PermanentUnlock)
      expect(dbVault.remove).toHaveBeenCalledWith(
        "note-1",
        "synthetic password"
      );
    if (requestType === VaultRequestType.ChangePassword)
      expect(dbVault.changePassword).toHaveBeenCalledWith(
        "synthetic password",
        "synthetic replacement"
      );
    if (requestType === VaultRequestType.ClearVault)
      expect(dbVault.clear).toHaveBeenCalledWith("synthetic password");
    if (requestType === VaultRequestType.DeleteVault)
      expect(dbVault.delete).toHaveBeenCalledWith(false);
    if (requestType === VaultRequestType.EnableFingerprint)
      expect(biometrics.storeCredentials).toHaveBeenCalledWith(
        "synthetic password"
      );
    if (requestType === VaultRequestType.RevokeFingerprint)
      expect(biometrics.resetCredentials).toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])(
    "creates the vault and closes only after its own final action (with note: %s)",
    async (withNote) => {
      const done = jest.fn();
      await emitOpen({
        item: withNote ? makeNote() : undefined,
        requestType: VaultRequestType.CreateVault,
        onShareComplete: done
      });
      setPassword("synthetic password");
      await pressPositive();
      await flushMicrotasks();
      expect(dbVault.create).toHaveBeenCalledWith("synthetic password");
      if (withNote) expect(dbVault.add).toHaveBeenCalledWith("note-1");
      expect(done).toHaveBeenCalledTimes(1);
    }
  );
  it("retains the permanent-unlock request through nested biometric enrollment", async () => {
    biometrics.isBiometryAvailable.mockResolvedValue(true);
    const done = jest.fn();
    const credentials = deferred<void>();
    biometrics.storeCredentials.mockReturnValueOnce(credentials.promise);
    await emitOpen({
      item: makeNote(),
      requestType: VaultRequestType.PermanentUnlock,
      onShareComplete: done
    });
    act(() => mockEnableBiometrics?.());
    setPassword("synthetic password");
    await pressPositive();
    await flushMicrotasks();
    expect(dbVault.remove).toHaveBeenCalledWith("note-1", "synthetic password");
    expect(biometrics.storeCredentials).toHaveBeenCalledWith(
      "synthetic password"
    );
    expect(done).not.toHaveBeenCalled();
    await act(async () => {
      credentials.resolve(undefined);
    });
    await flushMicrotasks();
    expect(done).toHaveBeenCalledTimes(1);
  });
  it("retains the existing custom unlock callback after its own close", async () => {
    const onUnlock = jest.fn();
    await emitOpen({
      item: makeNote(),
      requestType: VaultRequestType.CustomAction,
      onUnlock
    });
    setPassword("synthetic password");
    await pressPositive();
    expect(onUnlock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note-1" }),
      "synthetic password"
    );
  });
  it("keeps a synchronously reentrant replacement as the newest owner", async () => {
    const newestDone = jest.fn();
    const oldDone = jest.fn(() => {
      void currentOpenHandler()?.({
        item: makeNote(),
        requestType: VaultRequestType.ShareNote,
        shareGuard: () => true,
        onShareComplete: newestDone
      });
    });
    await emitOpen({
      item: makeNote(),
      requestType: VaultRequestType.ShareNote,
      shareGuard: () => true,
      onShareComplete: oldDone
    });
    await emitOpen({
      item: makeNote(),
      requestType: VaultRequestType.CopyNote
    });
    await flushMicrotasks();
    setPassword("synthetic password");
    await pressPositive();
    expect(oldDone).toHaveBeenCalledTimes(1);
    expect(shareOpen).toHaveBeenCalledTimes(1);
    expect(newestDone).toHaveBeenCalledTimes(1);
  });
});
