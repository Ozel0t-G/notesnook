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

import { CURRENT_TOOLBAR_VERSION, migrateToolbar } from "@notesnook/common";
import type { ToolbarCustomPreset } from "@notesnook/core";
import type { ToolbarGroupDefinition } from "@notesnook/editor";
import { resolveToolbarGroups } from "@notesnook/editor/dist/cjs/toolbar/tool-definitions";
import { Platform } from "react-native";
import { create } from "zustand";
import { StateStorage, persist } from "zustand/middleware";
import { db } from "../../../common/database";
import { MMKV } from "../../../common/database/mmkv";
import { useSettingStore } from "../../../stores/use-setting-store";
import { isMacCatalyst } from "../../../utils/constants";
import { presets } from "./toolbar-definition";
export type ToolDefinition = string | string[];

export type DraggedItem = {
  item?: ToolDefinition | ToolDefinition[];
  type?: "tool" | "group" | "subgroup";
  height?: number;
  groupIndex?: number;
};

export type DraggableItem = {
  item: ToolDefinition | ToolDefinition[];
  index: number;
  parentIndex?: number;
  groupIndex?: number;
};

export interface DragState {
  dragged: DraggedItem;
  setDragged: (dragged: DraggedItem) => void;
  data: ToolbarGroupDefinition[];
  customPresetData: ToolbarGroupDefinition[];
  /**
   * Whether `customPresetData` is a *known* custom snapshot. Without it an
   * explicit empty custom (`setData([])`) is indistinguishable from "the user
   * never chose custom", so switching back to custom would silently reseed the
   * list. Persisted inside the existing `drag-state-storage` key only - no new
   * database key, column or config version - and optional so state written by
   * builds that predate the flag rehydrates cleanly.
   */
  customInitialized?: boolean;
  setData: (data: ToolbarGroupDefinition[]) => void;
  preset: "default" | "minimal" | "custom";
  setPreset: (preset: "default" | "minimal" | "custom") => void;
  init: () => Promise<void>;
}

function clone<T>(value: T[]) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Deep clone for any JSON value (here: the stored `ToolbarConfig` object). The
 * array-only `clone` above cannot be used for the cached config; JSON semantics
 * are deliberately relied upon - an absent `config` stays absent (never coerced
 * to `[]`) and extra JSON fields survive exactly.
 */
function cloneJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Bumped by `setData`/`setPreset` *before* they issue their database write, so
 * an `init()` that is suspended across an `await` can tell that the user
 * changed the toolbar while it was in flight. Kept in the module closure (never
 * in the persisted zustand state, so it survives no rehydration and adds no
 * storage key).
 */
let mutationRevision = 0;

/**
 * Incremented at the start of every `init()`; a run only keeps going while it
 * is still the newest one. `init()` is called from the persist rehydration and
 * again from `use-app-events` after login, so overlapping runs are real.
 *
 * "Newest wins" also holds when the newest run ends early - e.g. its user
 * lookup returns `null` (signed-out) or no stored config exists: the counter is
 * still bumped, so an older authed run that resumes afterwards is aborted by
 * Guard 1 and must *not* reactivate. Such an aborted run is not retried inside
 * this step; the authenticated config is restored only by a later trigger (a
 * fresh rehydration / after-login `init`), never by a retry here.
 */
let initGeneration = 0;

/**
 * Bounds for a persisted/restored `customPreset` snapshot - the *additive*
 * metadata only. This field round-trips through JSON (either the zustand
 * `drag-state-storage` value or the stored `toolbarConfig` in the database), so
 * a restore treats it as untrusted input and accepts only a *bounded*,
 * string-typed nested group list instead of handing arbitrary JSON to the
 * toolbar renderer. The per-dimension limits are deliberately generous compared
 * to any real toolbar (a handful of groups with a handful of tools) and
 * `MAX_CUSTOM_TOOLS` additionally bounds the *total* leaf count, so the
 * per-dimension product (64 * 128 * 64) cannot be abused by a crafted payload.
 *
 * Only this *new metadata* is validated and bounded: an oversize or otherwise
 * unknown-shaped snapshot is ignored (treated as unknown), never truncated or
 * partially accepted, and the existing displayed `config` / the local custom
 * list are never truncated, filtered or changed by this validator.
 */
const MAX_CUSTOM_GROUPS = 64;
const MAX_CUSTOM_GROUP_ITEMS = 128;
const MAX_CUSTOM_SUBGROUP_ITEMS = 64;
const MAX_TOOL_ID_LENGTH = 128;
/**
 * Aggregate bound on the total number of tool ids (group leaves plus subgroup
 * leaves) in a snapshot. The per-dimension caps above alone still admit ~524288
 * leaves, so a single fixed-depth loop sums the leaves and rejects anything
 * over this total *before* the untrusted groups are cloned (no recursion, no
 * partial accept).
 */
const MAX_CUSTOM_TOOLS = 500;

/** A tool id is a real (bounded) string - never a number, null or object. */
function isValidToolId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TOOL_ID_LENGTH;
}

/**
 * Strict, bounded structural validator for the additive `customPreset` field.
 * Accepts only `known === true` plus `groups` shaped exactly like
 * `ToolbarGroupDefinition[]`: an outer array of group arrays whose entries are
 * either a tool id string or a subgroup array of tool id strings. Rejects a
 * missing/`false` `known`, a non-array `groups`, non-array groups, non-string
 * leaves (null/number/object), a nested array *inside* a subgroup (over-depth)
 * and anything over the length bounds above.
 */
function isValidCustomPreset(value: unknown): value is ToolbarCustomPreset {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { known?: unknown; groups?: unknown };
  // Own properties only. JSON.parse never yields inherited fields, so a crafted
  // object whose `known` / `groups` come from a prototype (rather than the
  // parsed payload) must be rejected instead of validated via a cast.
  if (
    !Object.prototype.hasOwnProperty.call(candidate, "known") ||
    candidate.known !== true ||
    !Object.prototype.hasOwnProperty.call(candidate, "groups")
  ) {
    return false;
  }

  const groups = candidate.groups;
  if (!Array.isArray(groups) || groups.length > MAX_CUSTOM_GROUPS) return false;

  // Single fixed-depth pass that also sums every leaf (group tool ids + subgroup
  // tool ids) and bails out as soon as the total exceeds MAX_CUSTOM_TOOLS - the
  // aggregate bound the per-dimension caps below cannot express on their own.
  let leaves = 0;
  for (const group of groups) {
    if (!Array.isArray(group) || group.length > MAX_CUSTOM_GROUP_ITEMS) {
      return false;
    }
    for (const item of group) {
      if (isValidToolId(item)) {
        leaves++;
      } else {
        if (!Array.isArray(item) || item.length > MAX_CUSTOM_SUBGROUP_ITEMS) {
          return false;
        }
        for (const tool of item) {
          if (!isValidToolId(tool)) return false;
          leaves++;
        }
      }
      if (leaves > MAX_CUSTOM_TOOLS) return false;
    }
  }
  return true;
}

/**
 * Read + validate the additive `customPreset` snapshot off a stored toolbar
 * config. The stored config is deliberately taken as `unknown`: it comes from
 * persisted (possibly tampered) JSON, so the field is validated structurally
 * instead of trusted via a cast. The returned value is the *validated* preset
 * object; callers must still deep-clone it before handing it to the store so
 * the cached database object can never alias live UI state.
 */
function readCustomPresetSnapshot(
  config: unknown
): ToolbarCustomPreset | undefined {
  const candidate =
    config && typeof config === "object"
      ? (config as { customPreset?: unknown }).customPreset
      : undefined;
  return isValidCustomPreset(candidate) ? candidate : undefined;
}

/**
 * The `customPreset` field to persist, with an independent deep clone of the
 * groups. Every writer uses this so the DB payload, the displayed `data` and
 * the local snapshot stay independent down to nested subgroups.
 */
function customPresetField(
  groups: ToolbarGroupDefinition[]
): ToolbarCustomPreset {
  return { known: true, groups: clone(groups) };
}

/**
 * A custom snapshot is *known* when the user has chosen custom at least once
 * (persisted `customInitialized`) or when a non-empty legacy snapshot survived
 * from a build that predates the flag. An unknown, empty snapshot is the only
 * state that seeds the editable list from what is currently shown.
 */
function hasKnownCustomSnapshot(state: {
  customInitialized?: boolean;
  customPresetData?: ToolbarGroupDefinition[];
}) {
  return (
    state.customInitialized === true ||
    (Array.isArray(state.customPresetData) && state.customPresetData.length > 0)
  );
}

/**
 * The effective groups of a stored preset, resolved by the same shared
 * resolver the editor WebView uses, so the configure-toolbar preview and the
 * rendered toolbar are laid out from one source instead of two hand-kept lists.
 *
 * The host flags are read per call from the *same* host source the WebView gets
 * (`globalThis.__PLATFORM__` is injected as `Platform.OS`, see
 * `screens/editor/index.tsx`): on Mac Catalyst the `default` preset is the
 * Notes-style "Aa" + lists bar (`macFormat`), an iPhone/iPad (an iOS host that
 * is not Mac Catalyst) gets the compact `ios` preset, and every other host -
 * Android included - keeps the existing web default. The platform is read from
 * `Platform.OS` / `isMacCatalyst`, never from the persisted `deviceMode`.
 *
 * The WebView's own opt-in uses the same host rule (`ios: true` in
 * `useSettings.ts`), so the preview and the rendered toolbar resolve the bridged
 * preset payload from one effective source and no longer diverge.
 * `IOS_TOOLBAR_GROUPS` retains every tool of the web default exactly once
 * (pinned by the editor toolbar-configuration tests), so nothing silently
 * disappears on either side. Only the baseline raw cached embedded tools-only
 * *legacy* payload (no `toolbarPreset`) is preserved by these exact groups on
 * the first frame; the actual native path sends the stored tools and preset
 * together (`tools: useDragState.data` plus `toolbarPreset: useDragState.preset`
 * in `use-editor-events.tsx`), and `configure-toolbar` consumes that `data`, so
 * there is no universal raw-legacy promise and no `presets.default` consumer.
 *
 * Nothing here is persisted: `ios`/`macCatalyst` are resolver inputs only, so no
 * stored config, version, cache key or payload shape changes.
 */
function presetGroups(preset: "default" | "minimal") {
  return resolveToolbarGroups({
    toolbarPreset: preset,
    macCatalyst: isMacCatalyst(),
    ios: Platform.OS === "ios" && !isMacCatalyst()
  });
}

const VALID_PRESETS: DragState["preset"][] = ["default", "minimal", "custom"];

function normalizePreset(preset: unknown): DragState["preset"] {
  return VALID_PRESETS.includes(preset as DragState["preset"])
    ? (preset as DragState["preset"])
    : "default";
}

export const useDragState = create<DragState, any>(
  persist(
    (set, get) => ({
      preset: "default",
      dragged: {},
      setDragged: (dragged) => {
        set({ dragged });
      },
      data: presetGroups("default"),
      customPresetData: clone(presets["custom"]),
      customInitialized: false,
      setData: (data) => {
        // Invalidate any suspended `init()` *before* the write is issued: a
        // user edit must never be overwritten by a stale late init.
        mutationRevision++;
        db.settings.setToolbarConfig(
          useSettingStore.getState().deviceMode || ("mobile" as any),
          {
            preset: "custom",
            config: clone(data),
            version: CURRENT_TOOLBAR_VERSION,
            /**
             * Persist the explicit custom choice *next to* the config, inside
             * the same `toolbarConfig:<deviceMode>` value (no new key, column
             * or config version). `customPresetField` deep-clones the groups,
             * so the DB payload does not alias the caller's input, the
             * displayed `data` or the local snapshot down to nested subgroups.
             */
            customPreset: customPresetField(data)
          }
        );
        set({
          data: clone(data),
          preset: "custom",
          // Independent clone: must not alias `data`, the DB payload, or the
          // caller's input array down to nested groups.
          customPresetData: clone(data),
          // An explicit save - even of an empty list - is a real custom choice
          // that must survive a trip through the built-in presets unchanged.
          customInitialized: true
        });
      },
      setPreset: (preset) => {
        /**
         * Switching to `custom` seeds the editable list from what is
         * currently shown only when there is no *known* custom snapshot yet,
         * so the group/tool drop indices match the list the user was looking
         * at. A known snapshot is restored unchanged (never reset here) -
         * including an explicit empty one, which must survive
         * custom -> minimal -> custom instead of being silently reseeded.
         */
        const state = get();
        const known = hasKnownCustomSnapshot(state);
        const customData: ToolbarGroupDefinition[] | undefined =
          preset === "custom"
            ? known
              ? clone(state.customPresetData ?? [])
              : clone(state.data)
            : undefined;

        /**
         * The `customPreset` snapshot to persist alongside the config. A custom
         * write always carries its own list. A *built-in* write must carry the
         * known custom snapshot forward - the whole point of the additive field
         * - and omit it entirely when there is no known custom choice, so a
         * legacy payload keeps its exact JSON bytes (see the B3 exact-payload
         * assertion in `state.test.ts`). An explicit *empty* custom is a known
         * choice too and is preserved as `groups: []`.
         */
        const snapshotGroups: ToolbarGroupDefinition[] | undefined =
          preset === "custom"
            ? (customData as ToolbarGroupDefinition[])
            : known
            ? state.customPresetData ?? []
            : undefined;

        // See `setData`: the pending `init()` is invalidated before the write.
        mutationRevision++;
        db.settings.setToolbarConfig(
          useSettingStore.getState().deviceMode || ("mobile" as any),
          {
            preset,
            config: preset === "custom" ? clone(customData as any[]) : [],
            version: CURRENT_TOOLBAR_VERSION,
            ...(snapshotGroups
              ? { customPreset: customPresetField(snapshotGroups) }
              : {})
          }
        );
        set({
          preset,
          data:
            preset === "custom"
              ? clone(customData as ToolbarGroupDefinition[])
              : presetGroups(preset),
          ...(preset === "custom"
            ? {
                // Independent clone so mutating the displayed `data` cannot
                // reach back into the stored custom snapshot (or vice versa).
                customPresetData: clone(customData as ToolbarGroupDefinition[]),
                customInitialized: true
              }
            : {})
        });
      },
      init: async () => {
        /**
         * Late-init protection (B3b). Capture this run's generation, the
         * current mutation revision and the normalized device profile
         * *synchronously*, before the first `await`, so a user edit, a newer
         * `init()` or a profile switch that happens while we are suspended can
         * abort this run instead of overwriting it. The local reconcile below
         * uses the raw zustand `set` and therefore does not invalidate this run.
         */
        const generation = ++initGeneration;
        const capturedRevision = mutationRevision;
        const capturedProfile =
          useSettingStore.getState().deviceMode || ("mobile" as any);

        /**
         * The abort predicate, evaluated at every await boundary with the same
         * captured values: still the newest run, no user mutation in between,
         * and the device profile unchanged.
         */
        const isCurrentInit = () =>
          mutationRevision === capturedRevision &&
          generation === initGeneration &&
          (useSettingStore.getState().deviceMode || ("mobile" as any)) ===
            capturedProfile;

        /**
         * Reconcile the *local* preview (hydrated from the persisted
         * `drag-state-storage`) with the groups the editor actually renders,
         * and do it *before* the async user lookup. The editor WebView
         * resolves the same preset through the same shared resolver
         * (`tiptap.tsx`), so a stale `data` written by an older build - e.g.
         * the iPad/Android default on Mac Catalyst - must be replaced by the
         * host's effective groups for signed-out users too. No database is
         * touched here; the authenticated config still wins below.
         */
        const localState = get();
        const localPreset = normalizePreset(localState.preset);
        if (localPreset === "custom") {
          // A legacy custom list lives in `data`; keep it byte-for-byte (and
          // deep-cloned) instead of resolving it as a built-in preset. The
          // displayed list is authoritative, so it also becomes the *known*
          // custom snapshot: an older build could have left
          // `customPresetData` empty or stale, and `setPreset("custom")`
          // restores from it, so without this sync `custom -> minimal ->
          // custom` would silently drop the legacy groups. Cloning separately
          // keeps `data` and the snapshot independent.
          const data = clone(
            Array.isArray(localState.data) ? localState.data : []
          );
          set({
            preset: "custom",
            data,
            customPresetData: clone(data),
            customInitialized: true
          });
        } else {
          set({
            preset: localPreset,
            data: presetGroups(localPreset),
            // A non-empty legacy snapshot (from a build without the flag)
            // still marks an existing custom choice; `false`/absent means
            // "no choice yet" and may seed the shown list later.
            customInitialized: hasKnownCustomSnapshot(localState)
          });
        }

        const user = await db.user?.getUser();
        if (!user) return;
        // Guard 1: abort *before* any database read if the user edited the
        // toolbar, a newer init started, or the profile changed while we
        // awaited the user lookup.
        //
        // A profile change is an intentional abort: it deliberately leaves the
        // existing *local* resolved preview/`data` in place (the reconcile
        // above already ran for the captured profile) and does not restore the
        // new profile. Loading the new profile's DB config / restoring profile
        // choices is out of scope for this bounded step (B3c); nothing
        // auto-reinits here.
        if (!isCurrentInit()) return;

        const storedToolbarConfig =
          db.settings.getToolbarConfig(capturedProfile);
        if (!storedToolbarConfig) {
          logger.info("DragState", "No user defined toolbar config was found");
          return;
        }

        // Guard 2 (redundant defense-in-depth at this call boundary): the
        // `getToolbarConfig` read above is synchronous, so no `await` separates
        // it from Guard 1 and there is no *distinct* async window here. The
        // cheap check is kept as an invariant at the point the cached object is
        // handed to an in-place migration - it guards future changes that would
        // insert an await, not a third independent protection today.
        if (!isCurrentInit()) return;

        /**
         * Clone the *full* stored config before migrating. The real
         * `migrateToolbar` mutates its argument (`config.push(...)`,
         * `version = ...`) in place, so passing the live cached object returned
         * by `settings.getToolbarConfig` would mutate *that exact object* on an
         * aborted init. The JSON clone guarantees the object returned by the
         * cache is never mutated in place; it does *not* make the live cache
         * unmodified overall (the legacy write still replaces the cache entry -
         * see Guard 3). JSON clone semantics are intended here: an absent
         * `config` stays absent (never coerced to `[]`) and extra JSON fields
         * survive exactly.
         */
        const toolbarConfig = await migrateToolbar(
          capturedProfile,
          cloneJSON(storedToolbarConfig)
        );

        /**
         * Guard 3 (post-await): protect the store from a migration that
         * resolved after the user already took over.
         *
         * Residuals, accepted and not fixed in this bounded step:
         *
         * - Write ordering: the real `migrateToolbar` issues its legacy
         *   `database.settings.setToolbarConfig(...)` *before* it resolves, so
         *   an already-requested SQL write cannot be cancelled here and a
         *   migrated snapshot may still land in the database. This step does
         *   not (and does not claim to) fix database snapshot loss - that would
         *   need an async write queue / full DB restore, which is out of scope.
         * - Live cache replacement: the clone above stops the migration from
         *   mutating the cached *object* in place, but that same legacy
         *   `setToolbarConfig` -> `collection.upsert` still *replaces* the cache
         *   entry (with a new object) after its SQL await. So the live cache is
         *   not "unmodified overall"; only the object handed to us is.
         */
        if (!isCurrentInit()) return;

        const preset = normalizePreset(toolbarConfig?.preset);
        /**
         * B3c restore: only a strictly validated snapshot is trusted. A
         * malformed/unknown-shaped `customPreset` is ignored *without*
         * resetting the local choice - the else branch below then keeps
         * `hasKnownCustomSnapshot(get())` - and never throws.
         */
        const storedSnapshot = readCustomPresetSnapshot(toolbarConfig);

        if (preset === "custom") {
          // The stored `config` is authoritative for BOTH the displayed list
          // and the custom snapshot: the user's real custom list is what the
          // config says, so a divergent (even valid) `customPreset` metadata
          // value must never resurface a *different* list after a trip through
          // a built-in preset. An explicit `config: []` likewise wins, deleting
          // a stale non-empty metadata. Without this, `custom -> builtin ->
          // custom` would silently swap the displayed list for the older
          // metadata. Two independent clones keep `data` and the snapshot from
          // aliasing each other (or the cached DB object) down to subgroups.
          const config = clone((toolbarConfig?.config as any[]) ?? []);
          set({
            preset,
            data: config,
            customPresetData: clone(config),
            // A stored custom config is a real custom choice even when the
            // persisted flag was missing (legacy) or false.
            customInitialized: true
          });
        } else {
          set({
            preset,
            data: presetGroups(preset),
            ...(storedSnapshot
              ? {
                  /**
                   * A valid snapshot for a *built-in* preset is the whole point
                   * of the field: the user's last custom list must be restored
                   * (deep-cloned, never aliasing the cached DB object) and
                   * marked known so `custom -> minimal -> custom` restores it
                   * instead of reseeding from the built-in groups.
                   */
                  customPresetData: clone(storedSnapshot.groups),
                  customInitialized: true
                }
              : {
                  // Never clobber a known local custom snapshot just because
                  // the currently selected preset is a built-in one, and never
                  // reset a known choice to unknown on a malformed/absent one.
                  customInitialized: hasKnownCustomSnapshot(get())
                })
          });
        }
      }
    }),
    {
      name: "drag-state-storage", // unique name
      getStorage: () => MMKV as unknown as StateStorage,
      onRehydrateStorage: () => {
        return () => {
          if (!useSettingStore.getState().isAppLoading) {
            useDragState.getState().init();
          } else {
            setTimeout(() => {
              useDragState.getState().init();
            }, 1000);
          }
        };
      } // (optional) by default, 'localStorage' is used
    }
  )
);
