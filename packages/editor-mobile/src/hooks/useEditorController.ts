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

import { Editor, scrollIntoViewById } from "@notesnook/editor";
import { keepLastLineInView } from "@notesnook/editor/extensions/keep-in-view/keep-in-view.js";
import { strings } from "@notesnook/intl";
import {
  ThemeDefinition,
  useThemeColors,
  useThemeEngineStore
} from "@notesnook/theme";
import {
  MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import {
  getRoot,
  isReactNative,
  post,
  postAsyncWithTimeout,
  saveTheme
} from "../utils";
import { injectCss, transform } from "../utils/css";
import { EditorEvents } from "../utils/editor-events";
import { pendingSaveRequests } from "../utils/pending-saves";
import { useTabContext, useTabStore } from "./useTabStore";

type Attachment = {
  hash: string;
  filename: string;
  mime: string;
  size: number;
};

export type Selection = {
  [name: string]: {
    text?: string;
    length?: number;
    attributes?: Record<string, unknown>;
    type?: "mark" | "node";
  };
};

type Timers = {
  selectionChange: NodeJS.Timeout | null;
  change: NodeJS.Timeout | null;
  wordCounter: NodeJS.Timeout | null;
  scroll: NodeJS.Timeout | null;
};

/**
 * One outbound save (body or title) tracked end to end. It is registered the
 * moment the save starts - *before* the pending-request lookup is awaited - and
 * stays registered until the native acknowledgement settled, so overlapping
 * saves of the same kind can all be awaited. A single promise slot would be
 * overwritten by the next save and the older one would be silently dropped.
 */
type SaveTask = {
  kind: "content" | "title";
  tabId: string;
  noteId?: string;
  sessionId?: string;
  logicalSessionId?: string;
  generation: number;
  status: "pending" | "delivered" | "failed";
  promise: Promise<void>;
};

/** A debounced body save that has been scheduled but has not started yet. */
type ScheduledContentJob = {
  tabId: string;
  noteId?: string;
  sessionId?: string;
  logicalSessionId?: string;
  editor: Editor;
  ignoreEdit?: boolean;
  generation: number;
};

/**
 * The identity a piece of outbound work was captured for: the tab, the transport
 * session and - when native provides it - the *logical* edit session id of the
 * tab (`session.id`). The logical id is what lets a note that was still unsaved
 * when its save started (`noteId` undefined) be recognised again once native
 * assigned it a note id, without ever mixing two different notes of one tab.
 */
type SaveIdentity = {
  tabId: string;
  noteId?: string;
  sessionId?: string;
  logicalSessionId?: string;
};

/**
 * One settled outcome, tracked independently per (kind, captured identity). A
 * body failure is kept until a newer *body* delivery of the very same work item
 * supersedes it; a title delivery never clears it, and a delivery for another
 * note can never erase it - which the previous single last-record slot did.
 */
type OutcomeRecord = SaveIdentity & {
  kind: "content" | "title";
  status: "delivered" | "failed";
  generation: number;
};

/**
 * Safety valve for *clean* records only: once a large number of distinct work
 * items accumulated, delivered outcomes are forgotten oldest-first. A failed
 * outcome is never dropped here - it stays for the lifetime of the hook instance
 * until a newer, same-scope/same-kind delivery of the very same work item
 * supersedes it, so a pending failure can never be silently forgotten and then
 * misreported as a clean `nothing-pending`.
 */
const OUTCOME_RECORDS_LIMIT = 64;

/** The editor's failure overlay id (see `editor.tsx`, dismiss button included). */
const SAVING_FAILED_OVERLAY_ID = "editor-saving-failed-overlay";

/**
 * The native "logical history" id that identifies the edit session of a tab.
 * Real tab items carry it (`session.id`, see `useTabStore`), but the shared
 * `TabItem` type deliberately omits it, so it is read structurally and stays
 * optional: without it an unsaved note is never correlated with a named one.
 */
function readLogicalSessionId(session: unknown): string | undefined {
  const id = (session as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id.length ? id : undefined;
}

/**
 * Whether two captured identities belong to the same owned piece of work.
 *
 * - A known note id only ever matches the same known note id.
 * - Two still-unsaved identities match only when they belong to the same logical
 *   edit session; when either side carries a logical session id the two must be
 *   equal, so two *different* unsaved notes of one tab (or two different logical
 *   sessions) are never merged - otherwise a delivery of one would mask the
 *   failure of the other. Only the legacy both-absent case stays a match, and it
 *   is never bound to a named note.
 * - An unsaved identity (`noteId` undefined) only correlates with a now-assigned
 *   one when both carry the *same* logical session id, i.e. it is the very same
 *   edit session and not another note of the same tab.
 * - Without a logical session id an unknown id stays ambiguous and is never
 *   forced onto a named note (fail closed; the normal save path is untouched).
 */
function isSameOwnedIdentity(a: SaveIdentity, b: SaveIdentity) {
  if (a.tabId !== b.tabId) return false;
  if (a.sessionId !== b.sessionId) return false;
  if (a.noteId !== undefined && b.noteId !== undefined)
    return a.noteId === b.noteId;
  if (a.noteId === undefined && b.noteId === undefined) {
    if (a.logicalSessionId === undefined && b.logicalSessionId === undefined)
      return true;
    return (
      a.logicalSessionId !== undefined &&
      a.logicalSessionId === b.logicalSessionId
    );
  }
  return (
    a.logicalSessionId !== undefined &&
    a.logicalSessionId === b.logicalSessionId
  );
}

/**
 * Forgets delivered outcomes only. Failed outcomes are kept for the lifetime of
 * the hook instance (see {@link OUTCOME_RECORDS_LIMIT}); the loop therefore drops
 * the overflowing *clean* records oldest-first and never `shift()`s a failure.
 */
function pruneOutcomeRecords(records: OutcomeRecord[]) {
  if (records.length <= OUTCOME_RECORDS_LIMIT) return;
  let overflow = records.length - OUTCOME_RECORDS_LIMIT;
  for (let i = 0; i < records.length && overflow > 0; ) {
    if (records[i].status === "delivered") {
      records.splice(i, 1);
      overflow -= 1;
    } else {
      i += 1;
    }
  }
}

/**
 * Finds the failure overlay that belongs to *this* editor, starting from the
 * editor's own content node and walking only a small, bounded number of its
 * ancestors. In the real editor the overlay is a direct child of the outer
 * editor root, which sits three levels above the ProseMirror content node
 * (`.theme-scope-editor` -> `#editor-container-scroller` -> editor root, see
 * `editor.tsx`); with several mounted editors the first matching id in the whole
 * document may belong to another (inactive) tab, so there is deliberately no
 * document-wide lookup fallback: when the owner's DOM is unavailable, nothing is
 * touched.
 */
function findOwnedFailureOverlay(
  contentDiv: HTMLElement | null
): HTMLElement | null {
  let node: HTMLElement | null = contentDiv;
  let depth = 0;
  while (node && depth < 4) {
    for (const child of Array.from(node.children)) {
      if (child.id === SAVING_FAILED_OVERLAY_ID) return child as HTMLElement;
    }
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

/**
 * The outcome of {@link EditorController.flushOutboundSaves}:
 *
 * - `delivered`: every already-outbound save of the flushed tab/note/session
 *   (including the body save that was still debouncing) was acknowledged.
 * - `nothing-pending`: there is no Share-eligible outbound save to wait for.
 * - `busy`: the editor is loading; nothing was drained.
 * - `failed`: at least one save of this tab/note/session failed (it stays an
 *   offline pending request and keeps the existing failure overlay).
 * - `stale`: the tab/note/session or the owning controller instance changed, the
 *   tab is no longer the active one (or was unmounted), or a newer edit was
 *   accepted while waiting; the caller must not treat the note as flushed.
 */
export type OutboundSaveStatus =
  | "delivered"
  | "nothing-pending"
  | "busy"
  | "failed"
  | "stale";

/** The tab/note/session a flush was performed for. */
export type OutboundSaveSnapshot = {
  tabId: string;
  noteId?: string;
  sessionId?: string;
};

export type OutboundSaveResult = {
  status: OutboundSaveStatus;
  /** Monotonic per-hook edit generation the status was computed against. */
  revision: number;
  snapshot: OutboundSaveSnapshot;
};

function scrollIntoView(editor: Editor) {
  if (__PLATFORM__ == "android") return;
  setTimeout(() => {
    if (!editor.isFocused) return;
    keepLastLineInView(editor);
  }, 1);
}

export type EditorController = {
  selectionChange: (editor: Editor) => void;
  titleChange: (title: string) => void;
  contentChange: (editor: Editor, ignoreEdit?: boolean) => void;
  scroll: (event: React.UIEvent<HTMLDivElement, UIEvent>) => void;
  title: string;
  setTitle: React.Dispatch<React.SetStateAction<string>>;
  openFilePicker: (type: "image" | "file" | "camera" | "handwriting") => void;
  editHandwriting: (image: Attachment) => void;
  openTemplatePicker: () => void;
  downloadAttachment: (attachment: Attachment) => void;
  previewAttachment: (attachment: Attachment) => void;
  content: MutableRefObject<string | null>;
  onUpdate: () => void;
  titlePlaceholder: string;
  openLink: (url: string) => boolean;
  setTitlePlaceholder: React.Dispatch<React.SetStateAction<string>>;
  countWords: (ms: number) => void;
  copyToClipboard: (text: string) => void;
  getAttachmentData: (attachment: Partial<Attachment>) => Promise<string>;
  updateTab: () => void;
  loading: boolean;
  setLoading: (value: boolean) => void;
  getTableOfContents: () => any[];
  scrollIntoView: (id: string) => void;
  passwordInputRef: MutableRefObject<HTMLInputElement | null>;
  focusPassInput: () => void;
  blurPassInput: () => void;
  scrollToSearchResult: (index: number) => void;
  getContentDiv: () => HTMLElement | null;
  /**
   * Drains the outbound save pipeline (the debounced body save plus every
   * already-in-flight body/title save) for the tab/note/session that is open
   * right now, and resolves once all of them were acknowledged by native.
   *
   * The acknowledgement is a *transport* receipt, not a database commit: the
   * caller (header / Share) still has to wait for the native save barrier.
   */
  flushOutboundSaves: () => Promise<OutboundSaveResult>;
};
export function useEditorController({
  update,
  getTableOfContents,
  scrollTo,
  scrollTop,
  getContentDiv
}: {
  update: (
    scrollTop?: number,
    selection?: { to: number; from: number },
    searchResultIndex?: number
  ) => void;
  getTableOfContents: () => any[];
  scrollTo: (top: number) => void;
  scrollTop: () => number;
  getContentDiv: () => HTMLElement | null;
}): EditorController {
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const tab = useTabContext();
  const tabRef = useRef(tab);
  tabRef.current = tab;
  /**
   * The module `getContentDiv` is passed in as a prop (and, like `update`, is
   * rebuilt by the editor). It is only used for the *visible* failure recovery,
   * so it is read through a ref that always holds the latest one: the save
   * callbacks keep their stable identity across ordinary re-renders (the flush
   * ownership check depends on that) without adding a changing dependency.
   */
  const getContentDivRef = useRef(getContentDiv);
  getContentDivRef.current = getContentDiv;
  /**
   * Holds the latest bounded, owner-scoped failure recovery. It is (re)assigned
   * during render - after the stable controller methods exist - so the save
   * callbacks can invoke it without depending on it and without changing their
   * identity. It is a ref because the recovery needs the live registry entry,
   * which would otherwise create a circular dependency with the flush.
   */
  const recoverVisibleFailureRef = useRef<
    (identity: SaveIdentity, blurOwnEditor: boolean) => void
  >(() => {});

  const [loading, setLoading] = useState(false);
  const setTheme = useThemeEngineStore((store) => store.setTheme);
  const { colors } = useThemeColors("editor");
  const [title, setTitle] = useState("");
  const [titlePlaceholder, setTitlePlaceholder] = useState(strings.noteTitle());
  const htmlContentRef = useRef<string | null>(null);
  const updateTabOnFocus = useRef(false);
  const timers = useRef<Timers>({
    selectionChange: null,
    change: null,
    wordCounter: null,
    scroll: null
  });
  const hasRestored = useRef(false);

  /** Set while this hook instance is unmounted. */
  const destroyedRef = useRef(false);
  /**
   * Monotonic per-hook edit generation. Every accepted body/title edit bumps it,
   * so a flush that needs more than one await can tell whether a newer edit
   * appeared while it was waiting (and abort instead of reporting a stale note
   * as flushed).
   */
  const generationRef = useRef(0);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  /** The debounced body save that is still waiting for its timer. */
  const scheduledContentJobRef = useRef<ScheduledContentJob | null>(null);
  const contentTasksRef = useRef<Set<SaveTask>>(new Set());
  const titleTasksRef = useRef<Set<SaveTask>>(new Set());
  const outcomeRecordsRef = useRef<OutcomeRecord[]>([]);

  const recordOutcome = useCallback(
    (
      kind: "content" | "title",
      generation: number,
      ok: boolean,
      identity: SaveIdentity
    ) => {
      const records = outcomeRecordsRef.current;
      const existing = records.find(
        (record) =>
          record.kind === kind && isSameOwnedIdentity(record, identity)
      );
      if (existing) {
        // An older save that settles late must not erase the outcome of a newer
        // one: only a newer outcome supersedes what is recorded.
        if (generation < existing.generation) return;
        existing.status = ok ? "delivered" : "failed";
        existing.generation = generation;
        existing.tabId = identity.tabId;
        existing.noteId = identity.noteId;
        existing.sessionId = identity.sessionId;
        existing.logicalSessionId = identity.logicalSessionId;
      } else {
        records.push({
          kind,
          status: ok ? "delivered" : "failed",
          generation,
          ...identity
        });
      }
      pruneOutcomeRecords(records);
    },
    []
  );

  if (!tabRef.current.session?.noteId && loading) {
    setTimeout(() => {
      if (!tabRef.current.session?.noteId && loading) {
        setLoading(false);
      }
    }, 3000);
  }

  const selectionChange = useCallback((_editor: Editor) => {}, []);

  const titleChange = useCallback(
    (title: string) => {
      if (!isReactNative()) return;
      const currentSessionId = globalThis.sessionId;
      const editedAt = Date.now();

      const tabId = tabRef.current.id;
      const noteId = tabRef.current.session?.noteId;
      const logicalSessionId = readLogicalSessionId(tabRef.current.session);
      const identity: SaveIdentity = {
        tabId,
        noteId,
        sessionId: currentSessionId,
        logicalSessionId
      };
      generationRef.current += 1;
      const generation = generationRef.current;
      post(EditorEvents.contentchange, undefined, tabId, noteId);
      const params = [
        {
          title
        },
        tabId,
        noteId,
        currentSessionId,
        // Title input posts every edit. Give a busy native/WebView queue the
        // same acknowledgement window as body saves without treating a slow
        // transport receipt as an immediate failure that interrupts typing.
        5000
      ];

      const task: SaveTask = {
        kind: "title",
        tabId,
        noteId,
        sessionId: currentSessionId,
        logicalSessionId,
        generation,
        status: "pending",
        promise: Promise.resolve()
      };
      titleTasksRef.current.add(task);

      const run = async () => {
        try {
          const pendingTitleIds =
            await pendingSaveRequests.getPendingTitleIds();
          const ack = postAsyncWithTimeout(EditorEvents.title, ...params)
            .then(() => {
              if (pendingTitleIds.length) {
                dbLogger(
                  "log",
                  `Title saved: ${title}, removing ${pendingTitleIds.length} pending requests `
                );
              }
              pendingSaveRequests.removePendingTitlesById(pendingTitleIds);
              recordOutcome("title", generation, true, identity);
              task.status = "delivered";
            })
            .catch((e) => {
              dbLogger("error", e);
              dbLogger(
                "log",
                `Saving title failed, setting pending request ${pendingTitleIds.length}`
              );
              if (params[2]) {
                pendingSaveRequests.setTitle(params, editedAt);
              }
              // The offline request and the failed outcome are recorded
              // unconditionally; only the *visible* recovery is owner-scoped.
              recoverVisibleFailureRef.current(identity, true);
              recordOutcome("title", generation, false, identity);
              task.status = "failed";
            });
          await ack;
        } catch (e) {
          // The pending-request lookup failed before anything was sent: the
          // title stays unsent and is reported truthfully as failed.
          dbLogger("error", e);
          recordOutcome("title", generation, false, identity);
          task.status = "failed";
        } finally {
          titleTasksRef.current.delete(task);
        }
      };

      task.promise = run();
    },
    [recordOutcome]
  );

  const countWords = useCallback((ms = 300) => {
    if (typeof timers.current.wordCounter === "number")
      clearTimeout(timers.current.wordCounter);
    timers.current.wordCounter = setTimeout(() => {
      statusBars[tabRef.current.id]?.current?.updateWords();
    }, ms);
  }, []);

  useEffect(() => {
    injectCss(transform(colors));
  }, [colors]);

  /**
   * Starts the outbound body save for a scheduled job and returns its task. The
   * task is registered before the first await (and its promise spans the whole
   * `pendingContentIds` lookup plus the native acknowledgement), so a flush can
   * await *every* overlapping save instead of only the newest one.
   *
   * The channel, payload, timeout, offline persistence and failure overlay are
   * unchanged: this is the same body the 100ms timer used to run inline.
   */
  const runContentSave = useCallback(
    (job: ScheduledContentJob) => {
      const {
        tabId,
        noteId,
        sessionId,
        logicalSessionId,
        editor,
        ignoreEdit,
        generation
      } = job;
      const identity: SaveIdentity = {
        tabId,
        noteId,
        sessionId,
        logicalSessionId
      };
      const task: SaveTask = {
        kind: "content",
        tabId,
        noteId,
        sessionId,
        logicalSessionId,
        generation,
        status: "pending",
        promise: Promise.resolve()
      };
      contentTasksRef.current.add(task);

      const run = async () => {
        const editedAt = Date.now();
        try {
          // The HTML capture itself can throw (a torn-down or mid-reconfigure
          // editor). It belongs inside this guard: outside it the throw would
          // reject the whole flush promise and leak the task below.
          htmlContentRef.current = editor.getHTML();

          const params = [
            {
              html: htmlContentRef.current,
              ignoreEdit: ignoreEdit
            },
            tabId,
            noteId,
            sessionId,
            5000
          ];

          const pendingContentIds =
            await pendingSaveRequests.getPendingContentIds();
          const ack = postAsyncWithTimeout(EditorEvents.content, ...params)
            .then(() => {
              if (pendingContentIds.length) {
                dbLogger(
                  "log",
                  `Content saved, removing ${pendingContentIds.length} pending requests`
                );
              }
              pendingSaveRequests.removePendingContentsById(pendingContentIds);
              recordOutcome("content", generation, true, identity);
              task.status = "delivered";
            })
            .catch((e) => {
              dbLogger("error", e);
              dbLogger(
                "log",
                `Saving content failed, setting pending request ${
                  pendingContentIds.length + 1
                }`
              );
              if (params[2]) {
                pendingSaveRequests.setContent(params, editedAt);
              }

              // The offline request and the failed outcome are recorded
              // unconditionally; only the *visible* recovery is owner-scoped.
              recoverVisibleFailureRef.current(identity, false);
              recordOutcome("content", generation, false, identity);
              task.status = "failed";
            });

          logger("info", "Editor saving content", params[1], params[2]);
          await ack;
        } catch (e) {
          // The capture or the pending-request lookup failed before anything
          // was sent: the body save stays unsent and is reported truthfully as
          // failed, never as an unhandled rejection.
          dbLogger("error", e);
          recordOutcome("content", generation, false, identity);
          task.status = "failed";
        } finally {
          contentTasksRef.current.delete(task);
        }
      };

      task.promise = run();
      return task;
    },
    [recordOutcome]
  );

  const contentChange = useCallback(
    (editor: Editor, ignoreEdit?: boolean) => {
      if (!isReactNative()) return;
      if (editorControllers[tabRef.current.id]?.loading) {
        logger("info", "Edit skipped, tab is in loading state");
        return;
      }

      if (ignoreEdit) {
        logger("info", "Ignoring ignoreEdit update, a save is already pending");
        return;
      }

      const currentSessionId = globalThis.sessionId;
      const tabId = tabRef.current.id;
      const noteId = tabRef.current.session?.noteId;
      const logicalSessionId = readLogicalSessionId(tabRef.current.session);
      post(EditorEvents.contentchange, undefined, tabId, noteId);
      if (!editor) return;
      if (typeof timers.current.change === "number") {
        clearTimeout(timers.current?.change);
      }

      generationRef.current += 1;
      scheduledContentJobRef.current = {
        tabId,
        noteId,
        sessionId: currentSessionId,
        logicalSessionId,
        editor,
        ignoreEdit,
        generation: generationRef.current
      };

      timers.current.change = setTimeout(() => {
        timers.current.change = null;
        const job = scheduledContentJobRef.current;
        if (!job) return;
        scheduledContentJobRef.current = null;

        if (tabRef.current.session?.noteId !== job.noteId) {
          logger(
            "info",
            `Edit discarded, tab ${job.tabId} moved from note ${job.noteId} to ${tabRef.current.session?.noteId}`
          );
          return;
        }
        if (editorControllers[job.tabId]?.loading) {
          logger("info", "Edit discarded, tab is in loading state");
          return;
        }

        runContentSave(job);
      }, 100);

      countWords(5000);
    },
    [countWords, runContentSave]
  );

  useEffect(() => {
    destroyedRef.current = false;
    const owned = timers.current;
    return () => {
      destroyedRef.current = true;
      // The debounced body timer is *not* cancelled here: it owns text the user
      // typed and has not persisted yet, and dropping it on unmount would
      // silently discard that edit. It keeps running on its own and delivers the
      // exact captured payload (with the note's explicit metadata) through the
      // existing channel; only a *Share flush* is refused after unmount
      // (`destroyedRef`), which is a transport-eligibility decision, never a
      // cancellation of owned data.
      //
      // Only the other timers this hook instance owns are released. Foreign
      // controllers, editors and pending resolvers belong to the app and are
      // never cleared here.
      if (owned.selectionChange !== null) {
        clearTimeout(owned.selectionChange);
        owned.selectionChange = null;
      }
      if (owned.wordCounter !== null) {
        clearTimeout(owned.wordCounter);
        owned.wordCounter = null;
      }
      if (owned.scroll !== null) {
        clearTimeout(owned.scroll);
        owned.scroll = null;
      }
    };
  }, []);

  /**
   * Drains the outbound save pipeline for the tab/note/session that is open
   * right now:
   *
   * 1. `busy`/`stale`/unsaved-note are decided before anything is drained, so a
   *    loading editor, a moved tab or a tab that is not the active one can never
   *    be reported as flushed.
   * 2. The still debouncing body save is started immediately (its timer is
   *    cancelled *and* its slot nulled, so it cannot save twice).
   * 3. Every body/title save that already started for the same
   *    tab/note/session is awaited - including saves that are still inside
   *    their pending-request lookup, and a save that was captured before native
   *    assigned the note id (correlated through the same logical edit session).
   * 4. The tab/note/session, the active tab, the owning controller instance, the
   *    editor's loading state and the edit generation are re-validated after the
   *    wait; anything that changed makes the result `stale` (or `busy`) instead
   *    of a false `delivered`.
   *
   * Owned here: nothing. The pipeline keeps using the existing
   * `editor-event:content`/`editor-event:title` channels, their payloads and
   * timeouts, the existing offline persistence and the existing failure
   * overlay. The offline queue is never replayed from here (`editor.tsx` owns
   * that once on load), and no HTML is exported through a new channel.
   *
   * Contract for the caller (header/Share), which owns its own mounted/activity
   * intent epoch, captures this stable method once and only trusts a *positive*
   * result: `revision` describes the generation the (positive) status was
   * computed against and is only meaningful for `delivered` - a `stale`/`busy`/
   * `failed` result reports the *current* generation, not a claim that this
   * generation was saved. A single `delivered` is not enough on its own either:
   * the caller must keep its captured epoch/note/snapshot and re-check that
   * `revision` is unchanged (or flush once more) before posting metadata. An
   * acknowledgement is a transport receipt, never a database commit, and a
   * snapshot match alone is never an ABA-safe "saved" claim.
   */
  const flushOutboundSaves = useCallback(async () => {
    const capturedGeneration = generationRef.current;
    const tabId = tabRef.current.id;
    const noteId = tabRef.current.session?.noteId;
    const sessionId = globalThis.sessionId;
    const logicalSessionId = readLogicalSessionId(tabRef.current.session);
    const identity: SaveIdentity = {
      tabId,
      noteId,
      sessionId,
      logicalSessionId
    };
    const snapshot: OutboundSaveSnapshot = { tabId, noteId, sessionId };

    const result = (status: OutboundSaveStatus): OutboundSaveResult => ({
      status,
      revision: generationRef.current,
      snapshot
    });
    /**
     * The editor republishes a freshly built controller object on every render
     * (even for a theme change or a keystroke), so raw object identity is
     * useless here. The controller's *method* is stable for the lifetime of
     * this hook instance, so comparing it against the live registry entry
     * accepts ordinary re-renders and rejects remounts/replacements.
     */
    const isCurrentOwner = () =>
      editorControllers[tabId]?.flushOutboundSaves === flushOutboundSaves;
    /**
     * Only the tab the user is actually looking at may be flushed. A background
     * tab's debounced save is *not* cancelled by this: it keeps running on its
     * own timer and delivers its own captured metadata to its own note.
     */
    const isActiveTab = () => useTabStore.getState().currentTab === tabId;
    const isLoading = () =>
      loadingRef.current || editorControllers[tabId]?.loading === true;
    const failedKind = () =>
      outcomeRecordsRef.current.some(
        (record) =>
          record.status === "failed" && isSameOwnedIdentity(record, identity)
      );

    if (destroyedRef.current) return result("stale");
    if (!isReactNative()) return result("nothing-pending");
    if (isLoading()) return result("busy");
    if (!isCurrentOwner()) return result("stale");
    if (!isActiveTab()) return result("stale");
    // A note that was never persisted is not Share-eligible yet. Its first-save
    // path is left exactly as it is (it keeps running on its own timer).
    if (!noteId) return result("nothing-pending");

    const tasks: SaveTask[] = [];
    for (const task of contentTasksRef.current) {
      if (isSameOwnedIdentity(task, identity)) tasks.push(task);
    }
    for (const task of titleTasksRef.current) {
      if (isSameOwnedIdentity(task, identity)) tasks.push(task);
    }
    const scheduledJob = scheduledContentJobRef.current;
    if (scheduledJob && isSameOwnedIdentity(scheduledJob, identity)) {
      scheduledContentJobRef.current = null;
      if (timers.current.change !== null) {
        clearTimeout(timers.current.change);
      }
      timers.current.change = null;
      tasks.push(runContentSave(scheduledJob));
    }

    if (!tasks.length) {
      return result(failedKind() ? "failed" : "nothing-pending");
    }

    await Promise.all(tasks.map((task) => task.promise));

    if (destroyedRef.current) return result("stale");
    if (!isCurrentOwner()) return result("stale");
    // The editor may have started loading (another note being opened) while the
    // acknowledgement was outstanding: that is `busy`, never a positive result.
    if (isLoading()) return result("busy");
    if (!isActiveTab()) return result("stale");
    if (generationRef.current !== capturedGeneration) return result("stale");
    if (
      tabRef.current.id !== tabId ||
      tabRef.current.session?.noteId !== noteId ||
      globalThis.sessionId !== sessionId
    ) {
      return result("stale");
    }

    return result(failedKind() ? "failed" : "delivered");
  }, [runContentSave]);

  /**
   * The bounded, owner-scoped *visible* failure recovery. Offline persistence
   * and the outcome record happen unconditionally in the save callbacks; this
   * only decides whether the failure may be shown to the user in the tab they
   * are looking at right now.
   *
   * It fires solely when every one of these still holds:
   * - the hook instance is mounted,
   * - the tab, transport session and (via the same logical-session correlation
   *   as the save pipeline) the note are the very ones the save was captured
   *   for - so a tab that moved on to another note is never blurred or focused,
   * - the tab is the active one, and
   * - this instance still owns the tab's registry entry (same method identity as
   *   the flush check), i.e. no other editor instance took the tab over.
   *
   * The overlay is then looked up from *this* editor's own DOM (see
   * {@link findOwnedFailureOverlay}), never document-wide, so a duplicate id in
   * another mounted tab can not be targeted.
   */
  recoverVisibleFailureRef.current = (
    identity: SaveIdentity,
    blurOwnEditor: boolean
  ) => {
    if (destroyedRef.current) return;
    const currentIdentity: SaveIdentity = {
      tabId: tabRef.current.id,
      noteId: tabRef.current.session?.noteId,
      sessionId: globalThis.sessionId,
      logicalSessionId: readLogicalSessionId(tabRef.current.session)
    };
    if (!isSameOwnedIdentity(currentIdentity, identity)) return;
    if (useTabStore.getState().currentTab !== identity.tabId) return;
    if (
      editorControllers[identity.tabId]?.flushOutboundSaves !==
      flushOutboundSaves
    ) {
      return;
    }
    const overlayElement = findOwnedFailureOverlay(
      getContentDivRef.current?.() ?? null
    );
    if (!overlayElement) return;
    overlayElement.style.display = "flex";
    if (blurOwnEditor) editors[identity.tabId]?.commands?.blur();
    overlayElement.focus();
  };

  const scroll = useCallback(
    (_event: React.UIEvent<HTMLDivElement, UIEvent>) => {
      if (!hasRestored.current) return;
      const value = _event.currentTarget.scrollTop;
      if (timers.current.scroll !== null) clearTimeout(timers.current.scroll);
      timers.current.scroll = setTimeout(() => {
        if (
          tabRef.current.session?.noteId &&
          tabRef.current.session?.noteId ===
            useTabStore.getState().getCurrentNoteId()
        ) {
          post(
            EditorEvents.saveScroll,
            {
              scrollTop: value,
              selection: {
                to: editors[tabRef.current.id]?.state.selection.to,
                from: editors[tabRef.current.id]?.state.selection.from
              }
            },
            tabRef.current.id,
            tabRef.current.session?.noteId
          );
        }
      }, 300);
    },
    []
  );

  const onUpdate = useCallback(() => {
    update();
    logger("info", "Updating content...");
  }, [update]);

  useEffect(() => {
    if (tab.session?.locked) {
      htmlContentRef.current = "";
      setLoading(true);
      onUpdate();
    }
  }, [tab.session?.locked, onUpdate]);

  const onMessage = useCallback(
    (event: Event & { data?: string }) => {
      if (event?.data?.[0] !== "{") return;
      const message = JSON.parse(event.data);
      const type = message.type;
      const value = message.value;

      if (message.tabId !== tabRef.current.id && type !== "native:status") {
        return;
      }

      const editor = editors[tabRef.current.id];
      switch (type) {
        case "native:updatehtml": {
          htmlContentRef.current = value.data;
          if (tabRef.current.id !== useTabStore.getState().currentTab) {
            updateTabOnFocus.current = true;
          } else {
            if (!editor) break;
            editor?.commands.setContent(htmlContentRef.current, false, {
              preserveWhitespace: true
            });

            if (value.selection) {
              editor.commands.setTextSelection(value.selection);
            }

            scrollTo?.(value.scrollTop || 0);
            hasRestored.current = true;
            setLoading(false);
            countWords(0);
          }

          break;
        }
        case "native:html":
          if (htmlContentRef.current === value.data) {
            setLoading(false);
            break;
          }
          htmlContentRef.current = value.data;
          logger("info", "LOADING NOTE HTML");
          if (!editor) break;
          update(value.scrollTop, value.selection, value.searchResultIndex);
          hasRestored.current = true;
          setTimeout(() => {
            countWords(0);
          }, 300);
          break;
        case "native:theme":
          setTheme(message.value);
          setTimeout(() => {
            saveTheme(message.value as ThemeDefinition);
          });
          break;
        case "native:title":
          setTitle(value);
          break;
        case "native:titleplaceholder":
          setTitlePlaceholder(value);
          break;
        case "native:status":
          break;
        case "native:keyboardShown":
          if (editor) {
            scrollIntoView(editor as any);
          }
          break;
        case "native:resolve":
          if (pendingResolvers[value.resolverId]) {
            pendingResolvers[value.resolverId](value.data);
          }
          break;
        default:
          break;
      }
      post(type); // Notify that message was delivered successfully.
    },
    [update, setTheme, scrollTo, countWords]
  );

  useEffect(() => {
    getRoot()?.addEventListener("message", onMessage);
    return () => {
      getRoot()?.removeEventListener("message", onMessage);
    };
  }, [onMessage]);

  const openFilePicker = useCallback(
    (type: "image" | "file" | "camera" | "handwriting") => {
      post(
        EditorEvents.filepicker,
        type,
        tabRef.current.id,
        tabRef.current.session?.noteId
      );
    },
    []
  );

  const editHandwriting = useCallback((image: Attachment) => {
    post(
      EditorEvents.editHandwriting,
      image,
      tabRef.current.id,
      tabRef.current.session?.noteId
    );
  }, []);

  const openTemplatePicker = useCallback(() => {
    post(
      EditorEvents.openTemplatePicker,
      undefined,
      tabRef.current.id,
      tabRef.current.session?.noteId
    );
  }, []);

  const downloadAttachment = useCallback((attachment: Attachment) => {
    post(
      EditorEvents.download,
      attachment,
      tabRef.current.id,
      tabRef.current.session?.noteId
    );
  }, []);
  const previewAttachment = useCallback((attachment: Attachment) => {
    post(
      EditorEvents.previewAttachment,
      attachment,
      tabRef.current.id,
      tabRef.current.session?.noteId
    );
  }, []);
  const openLink = useCallback((url: string) => {
    post(
      EditorEvents.link,
      url,
      tabRef.current.id,
      tabRef.current.session?.noteId
    );
    return true;
  }, []);

  const copyToClipboard = (text: string) => {
    post(EditorEvents.copyToClipboard, text);
  };

  const getAttachmentData = (attachment: Partial<Attachment>) => {
    return postAsyncWithTimeout(EditorEvents.getAttachmentData, {
      attachment
    });
  };

  const scrollToSearchResult = useCallback((index: number) => {
    const marks = document.getElementsByTagName("nn-search-result");
    if (marks.length > index) {
      const mark = marks[index];
      if (mark) {
        mark.scrollIntoView({
          behavior: "instant",
          block: "start"
        });
      }
    }
  }, []);

  return {
    getTableOfContents: getTableOfContents,
    scrollIntoView: (id: string) => scrollIntoViewById(id),
    scrollToSearchResult: scrollToSearchResult,
    contentChange,
    flushOutboundSaves,
    selectionChange,
    titleChange,
    scroll,
    loading,
    setLoading,
    title,
    setTitle,
    titlePlaceholder,
    setTitlePlaceholder,
    openFilePicker,
    editHandwriting,
    openTemplatePicker,
    downloadAttachment,
    previewAttachment,
    content: htmlContentRef,
    openLink,
    onUpdate: onUpdate,
    countWords,
    copyToClipboard,
    getAttachmentData,
    getContentDiv,
    updateTab: () => {
      // When the tab is focused, we apply any updates to content that were recieved when
      // the tab was not focused.
      updateTabOnFocus.current = false;
      setTimeout(() => {
        if (!updateTabOnFocus.current) return;
        const editor = editors[tabRef.current.id];
        if (!editor) return;
        const { from, to } = editor.state.selection;
        editor?.commands.setContent(htmlContentRef.current, false, {
          preserveWhitespace: true
        });
        editor.commands.setTextSelection({
          from,
          to
        });
        countWords();
      }, 1);
    },
    passwordInputRef,
    focusPassInput: () => {
      passwordInputRef.current?.focus();
    },
    blurPassInput: () => {
      passwordInputRef.current?.blur();
    }
  };
}
