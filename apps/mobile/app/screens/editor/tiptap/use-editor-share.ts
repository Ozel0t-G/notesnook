// SPDX-License-Identifier: GPL-3.0-or-later
import { isDeleted, isTrashItem } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useCallback, useEffect, useRef } from "react";
import Share from "react-native-share";
import { db } from "../../../common/database";
import {
  openVault,
  ToastManager,
  VaultRequestType
} from "../../../services/event-manager";
import { useSettingStore } from "../../../stores/use-setting-store";
import {
  convertNoteToText,
  isNoteLockedForExport
} from "../../../utils/note-to-text";
import type { EditorMessage, useEditorType } from "./types";
import { useTabStore } from "./use-tab-store";

type ShareMessage = EditorMessage<{ logicalSessionId?: string }>;
type Intent = {
  tabId: string;
  noteId: string;
  sessionId: string;
  logicalSessionId?: string;
  activity: number;
  input: number;
  saveRevision?: number;
  finished: boolean;
};

/** Native half of the primary Share action; ordinary saves keep their own path. */
export function useEditorShare(editor: useEditorType) {
  const liveEditor = useRef(editor);
  liveEditor.current = editor;
  const mounted = useRef(true);
  const activity = useRef(0);
  const input = useRef(0);
  const active = useRef<Intent | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useTabStore.subscribe((next, previous) => {
      const a = previous.tabs.find((tab) => tab.id === previous.currentTab);
      const b = next.tabs.find((tab) => tab.id === next.currentTab);
      if (
        previous.currentTab !== next.currentTab ||
        a?.session?.noteId !== b?.session?.noteId ||
        a?.session?.id !== b?.session?.id ||
        !!a !== !!b
      ) {
        activity.current++;
      }
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      if (active.current) active.current.finished = true;
      active.current = undefined;
    };
  }, []);

  const onInput = useCallback((message: EditorMessage<unknown>) => {
    const state = useTabStore.getState();
    if (
      message.tabId === state.currentTab &&
      (!message.noteId ||
        message.noteId === state.getNoteIdForTab(message.tabId))
    ) {
      input.current++;
    }
  }, []);

  const handle = useCallback(async (message: ShareMessage) => {
    const current = liveEditor.current;
    if (
      current.editorId !== "" ||
      typeof message.tabId !== "string" ||
      !message.tabId ||
      typeof message.noteId !== "string" ||
      !message.noteId ||
      typeof message.value?.logicalSessionId !== "string" ||
      !message.value.logicalSessionId ||
      message.sessionId !== current.sessionId.current
    ) {
      return;
    }
    if (active.current) {
      ToastManager.show({
        message: strings.pleaseWait() + "...",
        context: "global"
      });
      return;
    }

    const state = useTabStore.getState();
    const tab = state.getTab(message.tabId);
    if (
      !tab ||
      state.currentTab !== message.tabId ||
      tab.session?.noteId !== message.noteId ||
      state.getNoteIdForTab(message.tabId) !== message.noteId ||
      message.value?.logicalSessionId !== tab.session?.id
    ) {
      return;
    }
    const intent: Intent = {
      tabId: message.tabId,
      noteId: message.noteId,
      sessionId: message.sessionId,
      logicalSessionId: tab.session?.id,
      activity: activity.current,
      input: input.current,
      finished: false
    };
    active.current = intent;
    const finish = () => {
      intent.finished = true;
      if (active.current === intent) active.current = undefined;
    };
    const ownsSender = () => {
      const host = liveEditor.current;
      const now = useTabStore.getState();
      const sender = now.getTab(intent.tabId);
      return (
        mounted.current &&
        !intent.finished &&
        active.current === intent &&
        activity.current === intent.activity &&
        input.current === intent.input &&
        host.editorId === "" &&
        host.sessionId.current === intent.sessionId &&
        now.currentTab === intent.tabId &&
        sender?.session?.noteId === intent.noteId &&
        sender.session.id === intent.logicalSessionId &&
        now.getNoteIdForTab(intent.tabId) === intent.noteId &&
        !host.loading &&
        host.currentLoadingNoteId.current !== intent.noteId &&
        !useSettingStore.getState().isAppLoading
      );
    };
    const guard = (candidateNoteId: string) =>
      candidateNoteId === intent.noteId &&
      ownsSender() &&
      intent.saveRevision !== undefined &&
      !liveEditor.current.isSavePending(intent.tabId, intent.noteId) &&
      liveEditor.current.getSaveRevision(intent.tabId, intent.noteId) ===
        intent.saveRevision;
    const fail = () => {
      if (!ownsSender()) return;
      ToastManager.show({
        message: strings.somethingWentWrong(),
        type: "error",
        context: "global"
      });
    };
    let vaultOwnsCompletion = false;
    try {
      if (!ownsSender()) return;
      const saved = await current.flushSaves(intent.tabId, intent.noteId);
      if (!ownsSender()) return;
      if (
        saved.status !== "nothing-pending" &&
        (saved.status !== "saved" ||
          saved.id !== intent.noteId ||
          saved.pendingAfter)
      ) {
        fail();
        return;
      }
      intent.saveRevision = liveEditor.current.getSaveRevision(
        intent.tabId,
        intent.noteId
      );
      if (!guard(intent.noteId)) return;
      const note = await db.notes.note(intent.noteId);
      if (!guard(intent.noteId)) return;
      if (
        !note ||
        note.id !== intent.noteId ||
        isDeleted(note) ||
        isTrashItem(note)
      ) {
        return;
      }
      const locked = await isNoteLockedForExport(note, guard);
      if (locked === undefined || !guard(intent.noteId)) return;
      if (locked) {
        vaultOwnsCompletion = true;
        openVault({
          requestType: VaultRequestType.ShareNote,
          item: note,
          title: strings.shareNote(),
          buttonTitle: strings.share(),
          shareGuard: guard,
          onShareComplete: finish
        });
        return;
      }
      const text = await convertNoteToText(note, undefined, guard);
      if (!guard(intent.noteId)) return;
      if (typeof text !== "string") {
        if (text === false) fail();
        return;
      }
      await Share.open({
        title: note.title,
        message: text,
        failOnCancel: false
      });
    } catch {
      vaultOwnsCompletion = false;
      fail();
    } finally {
      if (!vaultOwnsCompletion) finish();
    }
  }, []);

  return { handle, onInput };
}
