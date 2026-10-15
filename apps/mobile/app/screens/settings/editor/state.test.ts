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
 * The real `useDragState` store (`state.ts`) driving the two configure-toolbar
 * defects:
 *
 * - BUG 1: `init()` used to await `db.user.getUser()` and return *before* any
 *   local derive, so a stale `data` hydrated from an older build (the
 *   iPad/Android default written on a Mac) kept overriding the effective Mac
 *   groups and the configure-toolbar preview disagreed with the rendered bar.
 *   The fix resolves the *local* preset/data through the same shared resolver
 *   the WebView uses, before the user guard, without touching the database for
 *   a signed-out user.
 * - BUG 2: `savedCustom.length > 0` could not tell an uninitialized snapshot
 *   apart from an explicit empty custom, so `setData([])` followed by a trip
 *   through a built-in preset silently reseeded the list.
 *
 * The store, `zustand/persist` and the MMKV storage are the *real* ones; only
 * the database, the settings store, the two host sources (`Platform.OS` +
 * `isMacCatalyst`) and the resolver module id are mocked. The resolver itself
 * is the real source via `jest.requireActual`
 * - never a fake - so the preview and the WebView cannot disagree in production
 * while the test still runs without a built `dist`.
 */

const mockMmkvData = new Map<string, string>();

/** A bounded in-memory MMKV, both the RN API and zustand's `StateStorage`. */
const mockMmkv = {
  getString: (key: string) => mockMmkvData.get(key),
  setString: (key: string, value: string) => {
    mockMmkvData.set(key, value);
  },
  contains: (key: string) => mockMmkvData.has(key),
  removeItem: (key: string) => {
    mockMmkvData.delete(key);
  },
  // zustand v4 `persist` reads through `getItem`.
  getItem: (key: string) => mockMmkvData.get(key) ?? null,
  setItem: (key: string, value: string) => {
    mockMmkvData.set(key, value);
  }
};

const mockGetUser = jest.fn();
const mockGetToolbarConfig = jest.fn();
const mockSetToolbarConfig = jest.fn();

const mockDb = {
  user: { getUser: mockGetUser },
  settings: {
    getToolbarConfig: mockGetToolbarConfig,
    setToolbarConfig: mockSetToolbarConfig
  }
};

const mockSettingState: {
  deviceMode: string | undefined;
  isAppLoading: boolean;
} = { deviceMode: "mobile", isAppLoading: true };

const mockIsMacCatalyst = jest.fn(() => false);

const mockMigrateToolbar = jest.fn(async (_platform: unknown, tools: any) => tools);

jest.mock("../../../common/database", () => ({
  db: mockDb,
  DatabaseLogger: { log: jest.fn(), info: jest.fn(), error: jest.fn() }
}));

jest.mock("../../../common/database/mmkv", () => ({ MMKV: mockMmkv }));

jest.mock("../../../stores/use-setting-store", () => ({
  useSettingStore: { getState: () => mockSettingState }
}));

jest.mock("../../../utils/constants", () => ({
  isMacCatalyst: mockIsMacCatalyst
}));

/**
 * Mutable host fixture - the SAME host source `state.ts` reads
 * (`Platform.OS` + `isMacCatalyst`). The generic cases keep a non-Apple host
 * (`android`) so their expectations retain the web-default shape; the S2 cases
 * below set `ios`/`android` per test. `presetGroups` reads it per call, but the
 * store's *initial* `data` is computed at module load, so a case that needs a
 * different initial host sets the platform before `loadDragState()`.
 */
jest.mock(
  "react-native",
  () => ({
    Platform: { OS: "android" }
  }),
  { virtual: true }
);

jest.mock("@notesnook/common", () => ({
  CURRENT_TOOLBAR_VERSION: 2,
  migrateToolbar: mockMigrateToolbar
}));

// The real resolver source only needs `strings` at call time; a Proxy keeps the
// built `@notesnook/intl` out of the way without replacing any resolver logic.
jest.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: () => () => "string" })
}));

// `toolbar-definition.ts` imports the icon map at module load; it is irrelevant
// to the resolver contract under test.
jest.mock("@notesnook/editor/dist/cjs/toolbar/icons", () => ({ Icons: {} }));

/**
 * The REAL shared resolver, never a fake: the module id `state.ts` imports is
 * redirected to the actual source, so this suite exercises the same code the
 * editor WebView (`tiptap.tsx`) does.
 */
jest.mock("@notesnook/editor/dist/cjs/toolbar/tool-definitions", () =>
  jest.requireActual(
    "../../../../../../packages/editor/src/toolbar/tool-definitions"
  )
);

import {
  getDefaultPresets,
  getIosToolbarGroups,
  getMacToolbarGroups
} from "@notesnook/editor/dist/cjs/toolbar/tool-definitions";
import { Platform } from "react-native";
// Type-only: erased at compile time, so this never loads the built dist (the
// resolver module id above is redirected to the real source instead).
import type { ToolbarGroupDefinition } from "@notesnook/editor";
import type { DragState } from "./state";

const STORAGE_KEY = "drag-state-storage";

type ToolbarPresets = { custom: ToolbarGroupDefinition[] };

type DragStateModule = {
  useDragState: { getState: () => DragState };
  presets: ToolbarPresets;
};

/**
 * A fresh store instance per test: the store reads `isMacCatalyst()` at module
 * load for its initial `data`, and the persisted state is rehydrated once, so
 * each platform/scenario needs its own module registry. `toolbar-definition`
 * is required inside the same `jest.isolateModules` callback so its `presets`
 * is the exact object `state.ts` reads/clones in this registry, not a
 * different instance from a static top-level import.
 */
function loadDragState(): DragStateModule {
  let loaded: DragStateModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stateModule = require("./state") as {
      useDragState: { getState: () => DragState };
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const toolbarDefinitionModule = require("./toolbar-definition") as {
      presets: ToolbarPresets;
    };
    loaded = {
      useDragState: stateModule.useDragState,
      presets: toolbarDefinitionModule.presets
    };
  });
  return loaded!;
}

/** Point the mocked host at a platform ("android", "ios", ...). */
function setHostPlatform(os: string) {
  (Platform as unknown as { OS: string }).OS = os;
}

/** The persisted `drag-state-storage` payload written by zustand `persist`. */
function persist(preset: string, data: unknown, customPresetData: unknown) {
  mockMmkvData.set(
    STORAGE_KEY,
    JSON.stringify({
      state: { preset, data, customPresetData, dragged: {} },
      version: 0
    })
  );
}

function storedState() {
  const raw = mockMmkvData.get(STORAGE_KEY);
  return raw ? JSON.parse(raw).state : undefined;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockMmkvData.clear();
  mockGetUser.mockResolvedValue(null);
  mockGetToolbarConfig.mockReturnValue(undefined);
  mockSetToolbarConfig.mockClear();
  mockMigrateToolbar.mockImplementation(async (_platform, tools) => tools);
  mockIsMacCatalyst.mockReturnValue(false);
  // Generic non-Apple host fixture: the pre-S2 expectations keep the web
  // default. Apple cases opt in explicitly via `setHostPlatform("ios")`.
  setHostPlatform("android");
  mockSettingState.deviceMode = "mobile";
  // Defer the store's own post-rehydration init so each test calls it itself.
  mockSettingState.isAppLoading = true;
  (globalThis as { logger?: unknown }).logger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn()
  };
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useDragState.init - local preview reconciliation (BUG 1)", () => {
  it("resolves the Mac default from the persisted local data for a signed-out user", async () => {
    mockIsMacCatalyst.mockReturnValue(true);
    mockSettingState.deviceMode = "tablet";
    // An older build persisted the iPad/Android default on this Mac.
    persist("default", getDefaultPresets().default, []);

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const state = useDragState.getState();
    expect(state.preset).toBe("default");
    // Effective groups the WebView will render, not the stale stored ones.
    expect(state.data).toEqual(getMacToolbarGroups());

    // The user guard is kept and no unauthenticated database access happens.
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    expect(mockGetToolbarConfig).not.toHaveBeenCalled();
    expect(mockSetToolbarConfig).not.toHaveBeenCalled();
  });

  it("resolves the non-Mac default to the web default for a signed-out user", async () => {
    mockIsMacCatalyst.mockReturnValue(false);
    persist("default", [["macFormat"], ["checkList"]], []);

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    expect(useDragState.getState().data).toEqual(getDefaultPresets().default);
    expect(mockSetToolbarConfig).not.toHaveBeenCalled();
  });

  it("lets the authenticated database config win, cloned exactly", async () => {
    mockGetUser.mockResolvedValue({ userId: "user-1" });
    const customConfig = [
      ["clearformatting"],
      ["headings", ["code", "subscript"]]
    ];
    mockGetToolbarConfig.mockReturnValue({
      preset: "custom",
      config: customConfig,
      version: 2
    });

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const state = useDragState.getState();
    expect(mockGetToolbarConfig).toHaveBeenCalledWith("mobile");
    expect(mockMigrateToolbar).toHaveBeenCalled();
    expect(state.preset).toBe("custom");
    expect(state.data).toEqual(customConfig);
    expect(state.data).not.toBe(customConfig);
    expect(state.data[1][1]).toEqual(["code", "subscript"]);
    expect(state.customPresetData).toEqual(customConfig);
    expect(state.customPresetData).not.toBe(customConfig);
    expect(state.customPresetData).not.toBe(state.data);
    expect(state.customPresetData[1][1]).not.toBe(state.data[1][1]);
    expect(state.customInitialized).toBe(true);
  });

  it("normalizes an invalid persisted preset for display without writing config", async () => {
    mockIsMacCatalyst.mockReturnValue(false);
    persist("totally-bogus", [], []);

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    expect(useDragState.getState().preset).toBe("default");
    expect(useDragState.getState().data).toEqual(getDefaultPresets().default);
    expect(mockSetToolbarConfig).not.toHaveBeenCalled();
  });
});

describe("useDragState.setPreset - custom seeding and empty custom (BUG 2)", () => {
  it("seeds the first default -> custom switch with the shown Mac groups", async () => {
    mockIsMacCatalyst.mockReturnValue(true);

    const { useDragState } = loadDragState();
    await useDragState.getState().init();
    expect(useDragState.getState().data).toEqual(getMacToolbarGroups());

    useDragState.getState().setPreset("custom");

    const state = useDragState.getState();
    expect(state.preset).toBe("custom");
    expect(state.data).toEqual(getMacToolbarGroups());
    expect(state.customPresetData).toEqual(getMacToolbarGroups());
    expect(state.customInitialized).toBe(true);
    // The DB payload is the exact seeded groups.
    expect(mockSetToolbarConfig).toHaveBeenCalledWith(
      "mobile",
      expect.objectContaining({ preset: "custom" })
    );
  });

  it("keeps an explicit empty custom across custom -> minimal -> custom", async () => {
    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    useDragState.getState().setData([]);
    expect(useDragState.getState().data).toEqual([]);
    expect(useDragState.getState().customInitialized).toBe(true);

    useDragState.getState().setPreset("minimal");
    expect(useDragState.getState().data).toEqual(getDefaultPresets().minimal);

    useDragState.getState().setPreset("custom");
    // Not reseeded from the minimal list: the user's empty custom is preserved.
    expect(useDragState.getState().data).toEqual([]);
    expect(useDragState.getState().customPresetData).toEqual([]);
  });

  it("preserves a custom list's exact order through a preset round-trip", async () => {
    const custom: ToolbarGroupDefinition[] = [
      ["clearformatting"],
      ["headings", ["subscript", "code"]],
      ["addLink", "addInternalLink"]
    ];
    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    useDragState.getState().setData(custom);
    useDragState.getState().setPreset("minimal");
    useDragState.getState().setPreset("custom");

    expect(useDragState.getState().data).toEqual(custom);
    expect(useDragState.getState().data[1][1]).toEqual(["subscript", "code"]);
  });

  it("writes the persisted flag only inside drag-state-storage, never a DB key", async () => {
    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    useDragState.getState().setPreset("minimal");

    const calls = mockSetToolbarConfig.mock.calls;
    const payload = calls[calls.length - 1]?.[1];
    // B3 unchanged: a non-custom preset still persists `config: []`.
    expect(payload).toEqual({
      preset: "minimal",
      config: [],
      version: 2
    });
    expect(storedState().customInitialized).toBe(false);
    expect(mockMmkvData.has("toolbarConfig:mobile")).toBe(false);
  });
});

describe("useDragState - legacy persisted state", () => {
  it("treats a legacy custom with an empty snapshot as an existing empty custom", async () => {
    mockIsMacCatalyst.mockReturnValue(true);
    persist("custom", [], []);

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const state = useDragState.getState();
    expect(state.preset).toBe("custom");
    expect(state.data).toEqual([]);
    // Legacy compat: the missing flag must not be read as "never chose custom".
    expect(state.customInitialized).toBe(true);

    useDragState.getState().setPreset("minimal");
    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual([]);
  });

  it("restores a non-empty legacy snapshot instead of reseeding from the shown list", async () => {
    const legacyCustom = [["bold"], ["checkList"]];
    persist("default", getDefaultPresets().default, legacyCustom);

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    expect(useDragState.getState().customInitialized).toBe(true);
    expect(useDragState.getState().data).toEqual(getDefaultPresets().default);

    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual(legacyCustom);
  });

  it("seeds the shown list when an unknown empty legacy default has no history", async () => {
    persist("default", [], []);

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    expect(useDragState.getState().customInitialized).toBe(false);
    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual(getDefaultPresets().default);
  });
});

describe("useDragState.init - custom snapshot synchronization (BUG 3)", () => {
  it("keeps legacy groups whose custom snapshot was never written", async () => {
    mockIsMacCatalyst.mockReturnValue(true);
    // A legacy build persisted the custom list only in `data`, leaving
    // `customPresetData` empty (the initial `presets["custom"]`).
    persist("custom", [["bold"]], []);

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const state = useDragState.getState();
    expect(state.preset).toBe("custom");
    expect(state.data).toEqual([["bold"]]);
    // The displayed list is authoritative and becomes the known snapshot too.
    expect(state.customPresetData).toEqual([["bold"]]);
    expect(state.data).not.toBe(state.customPresetData);
    expect(state.customInitialized).toBe(true);

    useDragState.getState().setPreset("minimal");
    expect(useDragState.getState().data).toEqual(getDefaultPresets().minimal);

    useDragState.getState().setPreset("custom");
    // The legacy groups survived the trip instead of collapsing to [].
    expect(useDragState.getState().data).toEqual([["bold"]]);
    expect(useDragState.getState().customPresetData).toEqual([["bold"]]);
  });

  it("drops a stale non-empty snapshot when the displayed custom data is empty", async () => {
    mockIsMacCatalyst.mockReturnValue(true);
    // Inconsistent legacy snapshot: the shown custom list is empty, but a
    // stale snapshot still names tools. The displayed data wins and both stay
    // empty, so custom -> minimal -> custom remains an explicit empty custom.
    persist("custom", [], [["bold"]]);

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const state = useDragState.getState();
    expect(state.preset).toBe("custom");
    expect(state.data).toEqual([]);
    expect(state.customPresetData).toEqual([]);

    useDragState.getState().setPreset("minimal");
    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual([]);
    expect(useDragState.getState().customPresetData).toEqual([]);
  });
});

describe("useDragState - reference isolation (B3a)", () => {
  it("setData clones the caller input, the displayed data, and the DB payload independently down to nested groups", async () => {
    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const callerInput: ToolbarGroupDefinition[] = [
      ["bold"],
      ["headings", ["code", "subscript"]]
    ];
    const expectedSnapshot: ToolbarGroupDefinition[] = [
      ["bold"],
      ["headings", ["code", "subscript"]]
    ];

    useDragState.getState().setData(callerInput);

    const dbCalls = mockSetToolbarConfig.mock.calls;
    const dbPayload = dbCalls[dbCalls.length - 1][1] as {
      config: ToolbarGroupDefinition[];
    };

    // Mutate every live reference's nested arrays: the caller's own input,
    // the displayed data, and the DB payload.
    (callerInput[1][1] as string[]).push("caller-mutation");
    (useDragState.getState().data[1][1] as string[]).push("data-mutation");
    (dbPayload.config[1][1] as string[]).push("db-mutation");

    expect(useDragState.getState().customPresetData).toEqual(expectedSnapshot);

    useDragState.getState().setPreset("minimal");
    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual(expectedSnapshot);
  });

  it("mutating the custom snapshot cannot mutate the displayed groups or the global custom template", async () => {
    const { useDragState, presets } = loadDragState();
    const templateSnapshot: ToolbarGroupDefinition[] = JSON.parse(
      JSON.stringify(presets.custom)
    );
    await useDragState.getState().init();

    const seed: ToolbarGroupDefinition[] = [["bold"], ["headings", ["code"]]];
    useDragState.getState().setData(seed);

    const snapshot = useDragState.getState().customPresetData;
    (snapshot[1][1] as string[]).push("snapshot-mutation");

    expect(useDragState.getState().data).toEqual(seed);
    expect(presets.custom).toEqual(templateSnapshot);
  });

  it("a fresh store's initial customPresetData is not an alias of the global custom preset template", () => {
    const { useDragState, presets } = loadDragState();
    const initialCustomPresetData = useDragState.getState().customPresetData;

    expect(initialCustomPresetData).toEqual(presets.custom);
    expect(initialCustomPresetData).not.toBe(presets.custom);

    (initialCustomPresetData as ToolbarGroupDefinition[]).push(["bold"]);
    expect(presets.custom).not.toEqual(initialCustomPresetData);
  });

  it("seeds an independent custom snapshot from the displayed data on the first default -> custom switch", async () => {
    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    useDragState.getState().setPreset("custom");

    const seededState = useDragState.getState();
    expect(seededState.data).toEqual(seededState.customPresetData);
    expect(seededState.data).not.toBe(seededState.customPresetData);

    (seededState.data as ToolbarGroupDefinition[]).push(["bold"]);
    expect(useDragState.getState().customPresetData).not.toEqual(
      useDragState.getState().data
    );
  });
});

describe("useDragState.init - late-init protection (B3b)", () => {
  /**
   * `init()` is called from the persist rehydration and again from
   * `use-app-events` after login, and it is suspended across `await
   * db.user.getUser()` and `await migrateToolbar(...)`. These cases prove that a
   * user edit, a newer concurrent init, or a profile switch that lands while a
   * run is suspended aborts that run instead of overwriting newer state, that
   * the *full* cached config is cloned before an in-place migration can mutate
   * it, and that the residual already-issued SQL write is acknowledged rather
   * than denied.
   */
  it("keeps a user setData custom that lands while init awaits getUser", async () => {
    let resolveUser!: (value: unknown) => void;
    mockGetUser.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUser = resolve;
      })
    );
    mockGetToolbarConfig.mockReturnValue({
      preset: "custom",
      config: [["bold"]],
      version: 2
    });

    const { useDragState } = loadDragState();
    const initPromise = useDragState.getState().init();

    const userEdit: ToolbarGroupDefinition[] = [
      ["headings", ["code", "subscript"]]
    ];
    useDragState.getState().setData(userEdit);
    expect(useDragState.getState().preset).toBe("custom");

    resolveUser({ userId: "user-1" });
    await initPromise;

    const state = useDragState.getState();
    expect(state.preset).toBe("custom");
    expect(state.data).toEqual(userEdit);
    // Aborted before the DB read: the stale authenticated config never applied.
    expect(mockGetToolbarConfig).not.toHaveBeenCalled();
  });

  it("keeps a user setPreset(minimal) that lands while init awaits getUser", async () => {
    let resolveUser!: (value: unknown) => void;
    mockGetUser.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUser = resolve;
      })
    );
    mockGetToolbarConfig.mockReturnValue({
      preset: "custom",
      config: [["bold"]],
      version: 2
    });

    const { useDragState } = loadDragState();
    const initPromise = useDragState.getState().init();

    useDragState.getState().setPreset("minimal");
    expect(useDragState.getState().preset).toBe("minimal");

    resolveUser({ userId: "user-1" });
    await initPromise;

    const state = useDragState.getState();
    expect(state.preset).toBe("minimal");
    expect(state.data).toEqual(getDefaultPresets().minimal);
    expect(mockGetToolbarConfig).not.toHaveBeenCalled();
  });

  it("cannot let an older init overwrite a newer init that already completed", async () => {
    let resolveOlderUser!: (value: unknown) => void;
    mockGetUser
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOlderUser = resolve;
        })
      )
      .mockResolvedValue({ userId: "user-1" });
    mockGetToolbarConfig.mockReturnValue({
      preset: "custom",
      config: [["bold"]],
      version: 2
    });

    const { useDragState } = loadDragState();
    const olderInit = useDragState.getState().init();
    const newerInit = useDragState.getState().init();
    await newerInit;

    expect(useDragState.getState().data).toEqual([["bold"]]);

    // The older run resumes last and must not clobber the newer result.
    resolveOlderUser({ userId: "user-1" });
    await olderInit;

    const state = useDragState.getState();
    expect(state.preset).toBe("custom");
    expect(state.data).toEqual([["bold"]]);
    expect(mockGetToolbarConfig).toHaveBeenCalledTimes(1);
  });

  it("cannot let an older authed init reactivate after a newer signed-out init", async () => {
    // Newest invocation wins even when it is a no-op: the newer `init()`'s
    // user lookup returns `null` (signed-out), so it returns early. That still
    // bumps the generation, so the older authed run must abort and never load
    // the DB config. The older lookup is slotted with a stale authed config to
    // fail this test if it is ever allowed to load.
    let resolveOlderUser!: (value: unknown) => void;
    mockGetUser
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOlderUser = resolve;
        })
      )
      .mockResolvedValueOnce(null);
    mockGetToolbarConfig.mockReturnValue({
      preset: "custom",
      config: [["stale"]],
      version: 2
    });

    const { useDragState } = loadDragState();
    const olderInit = useDragState.getState().init();
    const newerInit = useDragState.getState().init();
    await newerInit;

    // The newer signed-out run left the local fallback in place.
    expect(useDragState.getState().preset).toBe("default");
    expect(useDragState.getState().data).toEqual(getDefaultPresets().default);

    // The older authed run resumes last and must not reactivate.
    resolveOlderUser({ userId: "user-1" });
    await olderInit;

    const state = useDragState.getState();
    expect(state.preset).toBe("default");
    expect(state.data).toEqual(getDefaultPresets().default);
    // Guard 1 aborted the older run before any DB read; no migration and no
    // write either. There is no retry/DB restore inside this step - a later
    // trigger (rehydration / after-login init) would be needed to load it.
    expect(mockGetToolbarConfig).not.toHaveBeenCalled();
    expect(mockMigrateToolbar).not.toHaveBeenCalled();
    expect(mockSetToolbarConfig).not.toHaveBeenCalled();
  });

  it("aborts on a device profile change while init is pending, without any DB read or write", async () => {
    let resolveUser!: (value: unknown) => void;
    mockGetUser.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUser = resolve;
      })
    );
    mockGetToolbarConfig.mockReturnValue({
      preset: "custom",
      config: [["bold"]],
      version: 2
    });

    const { useDragState } = loadDragState();
    const initPromise = useDragState.getState().init();

    // The run captured `mobile`; the profile switches while it is suspended.
    mockSettingState.deviceMode = "tablet";

    resolveUser({ userId: "user-1" });
    await initPromise;

    const state = useDragState.getState();
    expect(state.preset).toBe("default");
    // The abort is intentional and leaves the existing *local* resolved
    // preview/`data` in place - it does not restore the new profile's choices
    // (loading the new profile's DB config / restoring profile choices is out
    // of scope for this bounded step; that is B3c).
    expect(state.data).toEqual(getDefaultPresets().default);
    // No read or write under either the stale or the new profile.
    expect(mockGetToolbarConfig).not.toHaveBeenCalled();
    expect(mockMigrateToolbar).not.toHaveBeenCalled();
    expect(mockSetToolbarConfig).not.toHaveBeenCalled();
  });

  // The clone guarantees the cached *object* is not mutated in place; it does
  // NOT claim the live cache is unmodified overall - the legacy write still
  // *replaces* the cache entry after its SQL await (see Guard 3 in state.ts).
  it("aborts on a user edit during a legacy migration, keeps the edit, and never mutates the cached object in place", async () => {
    mockGetUser.mockResolvedValue({ userId: "user-1" });
    // The live object the real `settings.getToolbarConfig` would return.
    const cachedConfig = {
      preset: "custom",
      config: [["bold"]] as ToolbarGroupDefinition[],
      version: 0,
      extra: "keep"
    };
    mockGetToolbarConfig.mockReturnValue(cachedConfig);

    let migrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      migrationStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    // Faithful migration fake: mirrors the real v0 -> v1 -> v2 `runMigration`
    // chain (v0 pushes ["checkList"]; v1 finds a group containing "addLink"
    // and appends "addInternalLink" into it, else appends ["addInternalLink"];
    // v2 sets the version), mutates the *passed* clone in place and awaits the
    // deferred DB write - exactly like the real `migrateToolbar`.
    mockSetToolbarConfig.mockReturnValueOnce(writeGate);
    mockMigrateToolbar.mockImplementation(async (_platform, tools) => {
      // v0 -> v1
      tools.config?.push(["checkList"]);
      // v1 -> v2
      const group = tools.config?.find(
        (g: any) => Array.isArray(g) && g.includes("addLink")
      );
      if (!group) tools.config?.push(["addInternalLink"]);
      else if (!group.includes("addInternalLink"))
        group.push("addInternalLink");
      tools.version = 2;
      migrationStarted();
      await mockSetToolbarConfig("mobile", tools);
      return tools;
    });

    const { useDragState } = loadDragState();
    const initPromise = useDragState.getState().init();
    await started;

    // The migration mutated the pre-migration clone, never the cached item.
    expect(cachedConfig).toEqual({
      preset: "custom",
      config: [["bold"]],
      version: 0,
      extra: "keep"
    });

    const userEdit: ToolbarGroupDefinition[] = [["headings", ["code"]]];
    useDragState.getState().setData(userEdit);
    expect(useDragState.getState().data).toEqual(userEdit);

    releaseWrite();
    await initPromise;

    const state = useDragState.getState();
    expect(state.preset).toBe("custom");
    // The user's edit wins; the migrated legacy config is not applied.
    expect(state.data).toEqual(userEdit);

    // Residual, acknowledged: the legacy write was already issued before the
    // abort and cannot be cancelled here (no async write queue in scope).
    expect(mockSetToolbarConfig).toHaveBeenCalledTimes(2);
    const [firstPlatform, firstPayload] = mockSetToolbarConfig.mock.calls[0];
    expect(firstPlatform).toBe("mobile");
    expect(firstPayload).toMatchObject({
      preset: "custom",
      version: 2,
      extra: "keep"
    });
    // v0 -> v1 appended ["checkList"], then v1 -> v2 appended
    // ["addInternalLink"] (no existing group contained "addLink").
    expect(firstPayload.config).toEqual([
      ["bold"],
      ["checkList"],
      ["addInternalLink"]
    ]);

    // Still unmutated after the migration fully resolved.
    expect(cachedConfig.config).toEqual([["bold"]]);
  });

  it("clones the cached config faithfully: an absent config stays absent and extra JSON fields survive", async () => {
    mockGetUser.mockResolvedValue({ userId: "user-1" });
    const cachedConfig = { preset: "default", version: 0, extra: { a: 1 } };
    mockGetToolbarConfig.mockReturnValue(cachedConfig);

    type CapturedTools = {
      preset?: string;
      version?: number;
      config?: ToolbarGroupDefinition[];
      extra?: unknown;
    };
    let passed: CapturedTools | undefined;
    mockMigrateToolbar.mockImplementation(async (_platform, tools) => {
      passed = tools as CapturedTools;
      return tools;
    });

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    expect(passed).toBeDefined();
    expect(passed).not.toBe(cachedConfig);
    // The legacy object had no `config` key; the clone must not invent `[]`
    // (the real `runMigration` then has nothing to push into).
    expect(Object.prototype.hasOwnProperty.call(passed, "config")).toBe(false);
    expect(passed?.extra).toEqual({ a: 1 });
    expect(cachedConfig).toEqual({
      preset: "default",
      version: 0,
      extra: { a: 1 }
    });
  });
});

/**
 * B3c: the additive `customPreset` field on the stored `toolbarConfig`. The
 * native writer must carry a known custom list forward across built-in preset
 * writes (so `config: []` no longer drops it) and omit the field entirely when
 * there is no known custom choice; the restore must accept only a strictly
 * bounded, string-typed snapshot and otherwise keep the local choice.
 */
describe("useDragState - custom snapshot persistence (B3c)", () => {
  type CustomPresetPayload = {
    known: true;
    groups: ToolbarGroupDefinition[];
  };
  type ToolbarPayload = {
    preset: string;
    config: ToolbarGroupDefinition[];
    version: number;
    customPreset?: CustomPresetPayload;
  };

  function lastPayload(): ToolbarPayload {
    const calls = mockSetToolbarConfig.mock.calls;
    return calls[calls.length - 1]?.[1] as ToolbarPayload;
  }

  it("setData persists a customPreset snapshot with independent nested clones", async () => {
    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const callerInput: ToolbarGroupDefinition[] = [
      ["bold"],
      ["headings", ["code", "subscript"]]
    ];
    const expected: ToolbarGroupDefinition[] = [
      ["bold"],
      ["headings", ["code", "subscript"]]
    ];

    useDragState.getState().setData(callerInput);

    const payload = lastPayload();
    expect(payload.preset).toBe("custom");
    expect(payload.customPreset).toEqual({ known: true, groups: expected });

    // Every live reference is independent down to the nested subgroup: mutate
    // the caller's input, the displayed data, the DB `config` and the DB
    // `customPreset.groups`.
    (callerInput[1][1] as string[]).push("caller-mutation");
    (useDragState.getState().data[1][1] as string[]).push("data-mutation");
    (payload.config[1][1] as string[]).push("db-config-mutation");
    (payload.customPreset!.groups[1][1] as string[]).push("db-snapshot-mutation");

    expect(useDragState.getState().customPresetData).toEqual(expected);

    useDragState.getState().setPreset("minimal");
    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual(expected);
  });

  it("setPreset(custom) persists the seeded list as customPreset, cloned apart from config", async () => {
    mockIsMacCatalyst.mockReturnValue(true);
    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    useDragState.getState().setPreset("custom");

    const payload = lastPayload();
    expect(payload.config).toEqual(getMacToolbarGroups());
    expect(payload.customPreset).toEqual({
      known: true,
      groups: getMacToolbarGroups()
    });
    // The snapshot is not an alias of the payload's own `config`.
    expect(payload.customPreset!.groups).not.toBe(payload.config);
    expect(payload.customPreset!.groups[0]).not.toBe(payload.config[0]);
  });

  it("preserves a known custom snapshot when a built-in preset is written", async () => {
    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const custom: ToolbarGroupDefinition[] = [
      ["clearformatting"],
      ["headings", ["subscript", "code"]]
    ];
    useDragState.getState().setData(custom);
    useDragState.getState().setPreset("minimal");

    const payload = lastPayload();
    // The whole point of the field: `config: []` still carries the custom.
    expect(payload).toEqual({
      preset: "minimal",
      config: [],
      version: 2,
      customPreset: { known: true, groups: custom }
    });

    // The persisted snapshot is its own clone: mutating the DB payload must not
    // reach the live snapshot (or the fallback custom list) down to subgroups.
    (payload.customPreset!.groups[1][1] as string[]).push("db-mutation");
    expect(useDragState.getState().customPresetData).toEqual(custom);

    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual(custom);
  });

  it("preserves an explicit empty custom snapshot across a built-in write", async () => {
    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    useDragState.getState().setData([]);
    useDragState.getState().setPreset("minimal");

    // An explicit empty custom is a *known* choice: present, not omitted.
    expect(lastPayload()).toEqual({
      preset: "minimal",
      config: [],
      version: 2,
      customPreset: { known: true, groups: [] }
    });

    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual([]);
  });

  it("omits customPreset entirely for an unknown built-in write", async () => {
    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    useDragState.getState().setPreset("minimal");

    const payload = lastPayload();
    // B3 exact-payload compatibility: no injected field, no key order churn.
    expect(payload).toEqual({ preset: "minimal", config: [], version: 2 });
    expect(Object.prototype.hasOwnProperty.call(payload, "customPreset")).toBe(
      false
    );
    expect("customPreset" in payload).toBe(false);
  });

  it("restores a valid stored snapshot for a built-in preset and survives a round-trip", async () => {
    mockGetUser.mockResolvedValue({ userId: "user-1" });
    const snapshot: ToolbarGroupDefinition[] = [
      ["clearformatting"],
      ["headings", ["subscript", "code"]]
    ];
    mockGetToolbarConfig.mockReturnValue({
      preset: "default",
      config: [],
      version: 2,
      customPreset: { known: true, groups: snapshot }
    });

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const state = useDragState.getState();
    expect(state.preset).toBe("default");
    expect(state.data).toEqual(getDefaultPresets().default);
    expect(state.customPresetData).toEqual(snapshot);
    expect(state.customInitialized).toBe(true);
    // Deep clone: the cached DB object is never aliased (incl. subgroups).
    expect(state.customPresetData).not.toBe(snapshot);
    expect(state.customPresetData[1][1]).not.toBe(snapshot[1][1]);

    // The restored snapshot drives custom -> minimal -> custom.
    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual(snapshot);
    useDragState.getState().setPreset("minimal");
    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual(snapshot);
  });

  it("treats the stored custom config as authoritative for both the displayed list and the snapshot", async () => {
    mockGetUser.mockResolvedValue({ userId: "user-1" });
    mockGetToolbarConfig.mockReturnValue({
      preset: "custom",
      config: [["displayed"]],
      version: 2,
      customPreset: { known: true, groups: [["snapshot"]] }
    });

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const state = useDragState.getState();
    expect(state.preset).toBe("custom");
    // `config` wins for the rendered list *and* for the surviving snapshot; a
    // divergent (even valid) metadata value must not be adopted.
    expect(state.data).toEqual([["displayed"]]);
    expect(state.customPresetData).toEqual([["displayed"]]);
    expect(state.customInitialized).toBe(true);
    // ...as two independent clones, never aliasing each other or the cached DB
    // object.
    expect(state.data).not.toBe(state.customPresetData);
    expect(state.data[0]).not.toBe(state.customPresetData[0]);

    // The divergent metadata never resurfaces across a built-in round-trip: the
    // displayed list stays `[["displayed"]]` instead of silently becoming the
    // older `[["snapshot"]]`.
    useDragState.getState().setPreset("minimal");
    expect(useDragState.getState().data).toEqual(getDefaultPresets().minimal);
    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual([["displayed"]]);
    expect(useDragState.getState().customPresetData).toEqual([["displayed"]]);
  });

  it("keeps an explicit empty stored custom config authoritative over conflicting metadata", async () => {
    mockGetUser.mockResolvedValue({ userId: "user-1" });
    mockGetToolbarConfig.mockReturnValue({
      preset: "custom",
      config: [],
      version: 2,
      customPreset: { known: true, groups: [["resurrected"]] }
    });

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const state = useDragState.getState();
    expect(state.preset).toBe("custom");
    // An explicit `config: []` wins even though the metadata is non-empty: both
    // the displayed list and the snapshot stay empty.
    expect(state.data).toEqual([]);
    expect(state.customPresetData).toEqual([]);
    expect(state.customInitialized).toBe(true);

    // The stale metadata must not resurrect the list after a built-in trip.
    useDragState.getState().setPreset("minimal");
    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual([]);
    expect(useDragState.getState().customPresetData).toEqual([]);
  });

  const malformedSnapshots: [string, unknown][] = [
    ["known is false", { known: false, groups: [["bold"]] }],
    ["known is missing", { groups: [["bold"]] }],
    ["known is a string", { known: "true", groups: [["bold"]] }],
    ["groups is not an array", { known: true, groups: "bold" }],
    ["a group is not an array", { known: true, groups: ["bold"] }],
    ["a leaf is a number", { known: true, groups: [[1]] }],
    ["a leaf is null", { known: true, groups: [[null]] }],
    ["a leaf is an object", { known: true, groups: [[{ id: "bold" }]] }],
    ["a subgroup leaf is a number", { known: true, groups: [["headings", [1]]] }],
    ["over-deep nesting", { known: true, groups: [[["bold", ["nested"]]]] }],
    [
      "too many outer groups",
      { known: true, groups: Array.from({ length: 65 }, () => ["bold"]) }
    ],
    [
      "too many group items",
      { known: true, groups: [Array.from({ length: 129 }, () => "bold")] }
    ],
    [
      "too many subgroup items",
      {
        known: true,
        groups: [["headings", Array.from({ length: 65 }, () => "bold")]]
      }
    ],
    ["tool id too long", { known: true, groups: [["x".repeat(129)]] }],
    [
      // 4 * 128 = 512 leaves: inside every per-dimension bound (4 <= 64 groups,
      // 128 <= 128 group items) yet over the aggregate MAX_CUSTOM_TOOLS = 500.
      "aggregate tool count over the total cap",
      {
        known: true,
        groups: Array.from({ length: 4 }, () =>
          Array.from({ length: 128 }, () => "bold")
        )
      }
    ],
    [
      // Own-property hardening: JSON.parse never yields inherited fields, so a
      // crafted prototype carrying `known`/`groups` must be rejected (not
      // treated as valid, and not thrown on).
      "known and groups inherited from a prototype",
      Object.create({ known: true, groups: [["bold"]] })
    ],
    ["customPreset is a string", "custom"],
    ["customPreset is an array", [["bold"]]],
    ["customPreset is null", null]
  ];

  for (const [label, malformed] of malformedSnapshots) {
    it(`ignores a malformed stored snapshot (${label}) and keeps the local known choice`, async () => {
      mockGetUser.mockResolvedValue({ userId: "user-1" });
      const localSnapshot: ToolbarGroupDefinition[] = [["bold"], ["checkList"]];
      persist("default", getDefaultPresets().default, localSnapshot);
      mockGetToolbarConfig.mockReturnValue({
        preset: "minimal",
        config: [],
        version: 2,
        customPreset: malformed
      });

      const { useDragState } = loadDragState();
      // Must not throw on any malformed/unknown shape.
      await useDragState.getState().init();

      const state = useDragState.getState();
      expect(state.preset).toBe("minimal");
      expect(state.data).toEqual(getDefaultPresets().minimal);
      // The malformed value never reaches the live snapshot...
      expect(state.customPresetData).toEqual(localSnapshot);
      // ...and a known local choice is never reset to unknown.
      expect(state.customInitialized).toBe(true);

      useDragState.getState().setPreset("custom");
      expect(useDragState.getState().data).toEqual(localSnapshot);
    });
  }

  it("keeps an unknown local choice unknown when the stored snapshot is absent", async () => {
    mockGetUser.mockResolvedValue({ userId: "user-1" });
    persist("default", [], []);
    mockGetToolbarConfig.mockReturnValue({
      preset: "minimal",
      config: [],
      version: 2
    });

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const state = useDragState.getState();
    expect(state.customPresetData).toEqual([]);
    expect(state.customInitialized).toBe(false);
  });

  it("accepts a stored snapshot at exactly the aggregate cap (500 tools)", async () => {
    mockGetUser.mockResolvedValue({ userId: "user-1" });
    // 4 groups * 125 tools = 500 leaves: inside every per-dimension bound and
    // exactly at MAX_CUSTOM_TOOLS, so it must be treated as a known snapshot.
    const atCap: string[][] = Array.from({ length: 4 }, () =>
      Array.from({ length: 125 }, () => "bold")
    );
    mockGetToolbarConfig.mockReturnValue({
      preset: "minimal",
      config: [],
      version: 2,
      customPreset: { known: true, groups: atCap }
    });

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const state = useDragState.getState();
    expect(state.customInitialized).toBe(true);
    expect(state.customPresetData).toEqual(atCap);

    useDragState.getState().setPreset("custom");
    expect(useDragState.getState().data).toEqual(atCap);
  });

  it("rejects a stored snapshot one tool over the aggregate cap (501 tools)", async () => {
    mockGetUser.mockResolvedValue({ userId: "user-1" });
    // 4 * 125 + 1 = 501 leaves, still <= 64 groups and <= 128 items per group:
    // only the aggregate bound can reject this.
    const overCap: string[][] = Array.from({ length: 4 }, () =>
      Array.from({ length: 125 }, () => "bold")
    );
    overCap.push(["bold"]);
    mockGetToolbarConfig.mockReturnValue({
      preset: "minimal",
      config: [],
      version: 2,
      customPreset: { known: true, groups: overCap }
    });

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const state = useDragState.getState();
    // Treated as unknown metadata: never truncated/partially accepted.
    expect(state.customInitialized).toBe(false);
    expect(state.customPresetData).toEqual([]);
  });

  /**
   * Finding 3: the native restore path round-trips a payload the *real* store
   * itself wrote. No hand-made `persist(...)` / DB fixture is involved - the
   * first store writes through `mockSetToolbarConfig`, that exact payload is
   * captured and replayed into a *fresh* store (fresh module registry + cleared
   * synthetic MMKV) as the authenticated `getToolbarConfig` result.
   */
  describe("native empty-DB restore round-trip from a captured writer payload", () => {
    it("keeps an explicit empty custom across a fresh store restore", async () => {
      const first = loadDragState();
      await first.useDragState.getState().init();

      // The real store writes the empty custom, then carries it forward in a
      // built-in write; capture that exact payload.
      first.useDragState.getState().setData([]);
      first.useDragState.getState().setPreset("minimal");
      const captured = lastPayload();
      expect(captured).toEqual({
        preset: "minimal",
        config: [],
        version: 2,
        customPreset: { known: true, groups: [] }
      });

      // A genuinely fresh store: clear ONLY the synthetic MMKV and reload the
      // module registry. No `persist(...)` fixture is written.
      mockMmkvData.clear();
      mockGetUser.mockResolvedValue({ userId: "user-1" });
      mockGetToolbarConfig.mockReturnValue(captured);

      const second = loadDragState();
      await second.useDragState.getState().init();

      const state = second.useDragState.getState();
      // The built-in preview is still the shown minimal list...
      expect(state.preset).toBe("minimal");
      expect(state.data).toEqual(getDefaultPresets().minimal);
      // ...while the known empty snapshot is restored independently of `data`.
      expect(state.customPresetData).toEqual([]);
      expect(state.customPresetData).not.toBe(state.data);
      expect(state.customInitialized).toBe(true);

      second.useDragState.getState().setPreset("custom");
      expect(second.useDragState.getState().data).toEqual([]);
      expect(second.useDragState.getState().customPresetData).toEqual([]);
    });

    it("restores a nested custom list captured from a built-in write in exact order", async () => {
      const nested: ToolbarGroupDefinition[] = [
        ["clearformatting"],
        ["headings", ["subscript", "code"]],
        ["addLink", "addInternalLink"]
      ];

      const first = loadDragState();
      await first.useDragState.getState().init();

      first.useDragState.getState().setData(nested);
      first.useDragState.getState().setPreset("minimal");
      const captured = lastPayload();
      expect(captured.customPreset).toEqual({ known: true, groups: nested });

      mockMmkvData.clear();
      mockGetUser.mockResolvedValue({ userId: "user-1" });
      mockGetToolbarConfig.mockReturnValue(captured);

      const second = loadDragState();
      await second.useDragState.getState().init();
      // The built-in write restored the snapshot; switching to custom must give
      // back the exact nested list and order, never a reseed.
      second.useDragState.getState().setPreset("custom");

      const state = second.useDragState.getState();
      expect(state.preset).toBe("custom");
      expect(state.data).toEqual(nested);
      expect(state.data[1][1]).toEqual(["subscript", "code"]);
      expect(state.data[2]).toEqual(["addLink", "addInternalLink"]);
    });

    it("seeds from the shown list for a fresh legacy built-in with no metadata", async () => {
      // A legacy built-in payload written before the additive field existed and
      // with no local history: a genuinely fresh store (cleared MMKV).
      mockMmkvData.clear();
      mockGetUser.mockResolvedValue({ userId: "user-1" });
      mockGetToolbarConfig.mockReturnValue({
        preset: "minimal",
        config: [],
        version: 2
      });

      const { useDragState } = loadDragState();
      await useDragState.getState().init();

      const state = useDragState.getState();
      expect(state.customInitialized).toBe(false);
      expect(state.customPresetData).toEqual([]);

      // Unknown local choice: switching to custom seeds the editable list from
      // what is currently shown.
      useDragState.getState().setPreset("custom");
      expect(useDragState.getState().data).toEqual(getDefaultPresets().minimal);
    });
  });
});

/**
 * S2: the native store resolves its built-in presets through the SAME host
 * source the WebView gets (`Platform.OS` + `isMacCatalyst`). An iPhone/iPad now
 * gets the compact `ios` preset, Mac Catalyst keeps its precedence, Android and
 * every other host keep the existing web default - and none of it is persisted:
 * the resolver flags are inputs, not stored state.
 */
describe("useDragState - native host wiring (S2)", () => {
  it("resolves the compact iOS default on a fresh iPhone/iPad store", async () => {
    setHostPlatform("ios");

    const { useDragState } = loadDragState();
    // The module-load initial `data` is already the iOS bar...
    expect(useDragState.getState().data).toEqual(getIosToolbarGroups());

    await useDragState.getState().init();

    // ...and the first init keeps it for a signed-out user.
    const state = useDragState.getState();
    expect(state.preset).toBe("default");
    expect(state.data).toEqual(getIosToolbarGroups());
    expect(state.data).not.toEqual(getDefaultPresets().default);
    expect(state.data).not.toEqual(getMacToolbarGroups());
  });

  it("reconciles a stale persisted web default to the iOS bar on the first init", async () => {
    setHostPlatform("ios");
    // An older build (or the WebView before this wiring) showed the web default.
    persist("default", getDefaultPresets().default, []);

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    expect(useDragState.getState().data).toEqual(getIosToolbarGroups());
    // Local reconciliation only: the signed-out run still touches no database.
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    expect(mockGetToolbarConfig).not.toHaveBeenCalled();
    expect(mockSetToolbarConfig).not.toHaveBeenCalled();
  });

  it("never persists the host platform: an iOS default resolution writes no config", async () => {
    setHostPlatform("ios");

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    // No DB read/write for the purely local iOS resolution...
    expect(mockGetToolbarConfig).not.toHaveBeenCalled();
    expect(mockSetToolbarConfig).not.toHaveBeenCalled();

    // ...and no new field in the persisted drag-state payload. The stored shape
    // is the B3 one; the host flag is derived, never written.
    const stored = storedState();
    expect(stored.preset).toBe("default");
    expect(stored.data).toEqual(getIosToolbarGroups());
    expect(stored.customInitialized).toBe(false);
    expect(
      Object.keys(stored).some((key) => /ios|platform|maccatalyst/i.test(key))
    ).toBe(false);
  });

  it("keeps the existing web default on an Android host", async () => {
    setHostPlatform("android");

    const { useDragState } = loadDragState();
    expect(useDragState.getState().data).toEqual(getDefaultPresets().default);

    await useDragState.getState().init();
    expect(useDragState.getState().data).toEqual(getDefaultPresets().default);
    expect(mockSetToolbarConfig).not.toHaveBeenCalled();
  });

  it("lets Mac Catalyst win over the iOS compact preset", async () => {
    setHostPlatform("ios");
    mockIsMacCatalyst.mockReturnValue(true);

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const state = useDragState.getState();
    expect(state.data).toEqual(getMacToolbarGroups());
    expect(state.data).not.toEqual(getIosToolbarGroups());

    // Mac precedence holds for every built-in resolution, not just the initial.
    useDragState.getState().setPreset("minimal");
    useDragState.getState().setPreset("default");
    expect(useDragState.getState().data).toEqual(getMacToolbarGroups());
  });

  it("recreates the iOS resolution in a genuinely fresh store without leaking prior state", async () => {
    setHostPlatform("android");
    const first = loadDragState();
    await first.useDragState.getState().init();
    expect(first.useDragState.getState().data).toEqual(
      getDefaultPresets().default
    );

    // A genuinely fresh store: clear ONLY the synthetic MMKV and reload the
    // module registry, now on an iPhone/iPad host.
    mockMmkvData.clear();
    setHostPlatform("ios");

    const second = loadDragState();
    await second.useDragState.getState().init();
    expect(second.useDragState.getState().data).toEqual(getIosToolbarGroups());
  });

  it("returns independent clones of the resolved iOS groups and keeps the B3 payload shape", async () => {
    setHostPlatform("ios");

    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    const expected = getIosToolbarGroups();
    // The shown iOS list is a clone: mutating its nested "more" subgroup (the
    // only nested group of `IOS_TOOLBAR_GROUPS`) cannot reach the module
    // singleton...
    const nested = useDragState.getState().data.find(group => Array.isArray(group[0]))?.[0] as string[];
    nested.push("mutated");
    expect(getIosToolbarGroups()).toEqual(expected);

    // ...and a built-in write on iOS still persists the exact B3 payload
    // (`config: []`, no host field, no version bump).
    useDragState.getState().setPreset("minimal");
    const calls = mockSetToolbarConfig.mock.calls;
    const payload = calls[calls.length - 1][1];
    expect(payload).toEqual({ preset: "minimal", config: [], version: 2 });
    expect("ios" in payload).toBe(false);
    expect("macCatalyst" in payload).toBe(false);
    expect(useDragState.getState().data).toEqual(getDefaultPresets().minimal);
  });

  it("keeps a custom list byte-identical on an iPhone/iPad host", async () => {
    setHostPlatform("ios");

    const custom: ToolbarGroupDefinition[] = [
      ["clearformatting"],
      ["headings", ["subscript", "code"]]
    ];
    const { useDragState } = loadDragState();
    await useDragState.getState().init();

    useDragState.getState().setData(custom);
    useDragState.getState().setPreset("minimal");
    useDragState.getState().setPreset("custom");

    // The host wiring only changes the built-in `default`; a custom list is
    // never re-resolved through the platform.
    expect(useDragState.getState().data).toEqual(custom);
    expect(useDragState.getState().customPresetData).toEqual(custom);
  });
});
