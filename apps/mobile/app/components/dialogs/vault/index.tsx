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

import Clipboard from "@react-native-clipboard/clipboard";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { InteractionManager, View, TextInput } from "react-native";
import Share from "react-native-share";
import { notesnook } from "../../../../e2e/test.ids";
import { db } from "../../../common/database";
import BiometricService from "../../../services/biometrics";
import { DDS } from "../../../services/device-detection";
import {
  ToastManager,
  Vault,
  VaultRequestType,
  eSendEvent,
  eSubscribeEvent,
  eUnSubscribeEvent
} from "../../../services/event-manager";
import Navigation from "../../../services/navigation";
import { getElevationStyle } from "../../../utils/elevation";
import {
  eCloseActionSheet,
  eCloseVaultDialog,
  eOnLoadNote,
  eOpenVaultDialog,
  eUpdateNoteInEditor
} from "../../../utils/events";
import { deleteItems } from "../../../utils/functions";
import { fluidTabsRef } from "../../../utils/global-refs";
import { convertNoteToText } from "../../../utils/note-to-text";
import type { NoteSenderGuard } from "../../../utils/note-to-text";
import { sleep } from "../../../utils/time";
import BaseDialog from "../../dialog/base-dialog";
import DialogButtons from "../../dialog/dialog-buttons";
import DialogHeader from "../../dialog/dialog-header";
import { Toast } from "../../toast";
import { Button } from "../../ui/button";
import FormInput, {
  createFormRef,
  validators
} from "../../ui/input/form-input";
import Seperator from "../../ui/seperator";
import Paragraph from "../../ui/typography/paragraph";
import { strings } from "@notesnook/intl";
import { DefaultAppStyles } from "../../../utils/styles";
import {
  isEncryptedContent,
  Note,
  NoteContent,
  VAULT_ERRORS
} from "@notesnook/core";
import { useThemeColors } from "@notesnook/theme";
import { useUserStore } from "../../../stores/use-user-store";
import { AppFontSize } from "../../../utils/size";
import { Pressable } from "../../ui/pressable";
import AppIcon from "../../ui/AppIcon";

/**
 * One inbound `eOpenVaultDialog` request.
 *
 * A monotonic `token` is allocated synchronously for *every* incoming request
 * (legacy ones included) so that an older, slower async operation can never
 * install refs, dispatch a result, or close/mutate a newer request's dialog.
 * `onShareComplete` is the request's own captured callback: it is fired at most
 * once, even after `close()` clears the dialog refs, and never touches a newer
 * request's intent.
 */
type VaultRequest = {
  token: number;
  noteId?: string;
  shareGuard?: NoteSenderGuard;
  onShareComplete?: () => void;
  completed: boolean;
  /** Only accept controls after this request's note and action refs are installed. */
  ready: boolean;
  /**
   * Set right before this request's own dialog is closed and the OS share
   * sheet is launched: completion then waits for the share's own
   * resolve/reject instead of firing on the close itself.
   */
  shareDispatched: boolean;
};

export const VaultDialog: React.FC = () => {
  const { colors } = useThemeColors();

  // UI State
  const [visible, setVisible] = useState(false);
  const isUserLoggedIn = useUserStore((state) => !!state.user);
  const [loading, setLoading] = useState(false);
  const [deleteAll, setDeleteAll] = useState(false);
  const [biometricUnlock, setBiometricUnlock] = useState(false);
  const [isBiometryAvailable, setIsBiometryAvailable] = useState(false);
  const [isBiometryEnrolled, setIsBiometryEnrolled] = useState(false);

  // Refs for non-UI state
  const requestTypeRef = useRef<VaultRequestType | null>(null);
  const noteRef = useRef<Note | undefined>(undefined);
  const titleRef = useRef<string>(strings.goToEditor());
  const descriptionRef = useRef<string | null>(null);
  const paragraphRef = useRef<string | null>(null);
  const buttonTitleRef = useRef<string | null>(null);
  const positiveButtonTypeRef = useRef<"errorShade" | "transparent" | "accent">(
    "transparent"
  );
  const customActionTitleRef = useRef<string | null>(null);
  const customActionParagraphRef = useRef<string | null>(null);
  const noteLockedRef = useRef(false);
  const onUnlockRef = useRef<
    | ((
        item: Note & {
          content?: NoteContent<false>;
        },
        password: string
      ) => void)
    | undefined
  >(undefined);

  // Request tracking: the current inbound request's token and the request that
  // still owns this dialog instance's pending completion.
  const requestTokenRef = useRef(0);
  const activeRequestRef = useRef<VaultRequest | null>(null);
  const mountedRef = useRef(true);

  /**
   * Fires a request's captured `onShareComplete` exactly once and detaches it
   * when it is still the active request. It never clears or calls into a newer
   * request's intent.
   */
  const finishRequest = useCallback((request: VaultRequest) => {
    if (request.completed) return;
    request.completed = true;
    if (activeRequestRef.current === request) {
      activeRequestRef.current = null;
    }
    request.onShareComplete?.();
  }, []);

  // Form ref
  const formRef = useRef(
    createFormRef({
      password: "",
      confirmPassword: "",
      newPassword: ""
    })
  );

  // Input refs
  const passInputRef = useRef<TextInput>(null);
  const confirmPassRef = useRef<TextInput>(null);
  const newPassInputRef = useRef<TextInput>(null);

  const ownsRequest = useCallback((request: VaultRequest | null) => {
    return (
      mountedRef.current &&
      !!request &&
      !request.completed &&
      request.token === requestTokenRef.current &&
      activeRequestRef.current === request
    );
  }, []);

  const closeOwned = useCallback(
    (owner: VaultRequest | null) => {
      if (!mountedRef.current || owner !== activeRequestRef.current)
        return false;
      if (owner && !ownsRequest(owner)) return false;
      if (loading) {
        ToastManager.show({
          heading: titleRef.current,
          message: strings.pleaseWait() + "...",
          type: "success",
          context: "local"
        });
        return false;
      }

      Navigation.queueRoutesForUpdate();

      // Reset form values and errors
      formRef.current.setValue("password", "");
      formRef.current.setValue("confirmPassword", "");
      formRef.current.setValue("newPassword", "");
      formRef.current.clearErrors();

      // Reset refs
      requestTypeRef.current = null;
      noteRef.current = undefined;
      titleRef.current = strings.goToEditor();
      descriptionRef.current = null;
      paragraphRef.current = null;
      buttonTitleRef.current = null;
      positiveButtonTypeRef.current = "transparent";
      customActionTitleRef.current = null;
      customActionParagraphRef.current = null;
      noteLockedRef.current = false;
      onUnlockRef.current = undefined;

      // The request that owned this dialog can no longer complete here. A request
      // whose share sheet was already launched keeps ownership of its own
      // completion until the sheet settles.
      const request = owner;
      if (request && !request.shareDispatched) {
        finishRequest(request);
      }

      // Reset UI state
      setVisible(false);
      setLoading(false);
      setDeleteAll(false);
      setBiometricUnlock(false);
      setIsBiometryAvailable(false);
      setIsBiometryEnrolled(false);
      return true;
    },
    [loading, finishRequest, ownsRequest]
  );

  const close = useCallback(
    () => closeOwned(activeRequestRef.current),
    [closeOwned]
  );

  const deleteVault = useCallback(async () => {
    const owner = activeRequestRef.current;
    setLoading(true);
    try {
      const { password } = formRef.current.getValues();
      let verified = true;
      if (await db.user.getUser()) {
        verified = await db.user.verifyPassword(password);
      }
      if (verified) {
        let noteIds: string[] = [];
        if (deleteAll) {
          const vault = await db.vaults.default();
          const relations = await db.relations
            .from(
              {
                type: "vault",
                id: vault!.id
              },
              "note"
            )
            .get();
          noteIds = relations.map((item) => item.toId);
        }
        await db.vault.delete(deleteAll);
        await BiometricService.resetCredentials();

        if (deleteAll) {
          noteIds.forEach((id) => {
            eSendEvent(
              eUpdateNoteInEditor,
              {
                id: id,
                deleted: true
              },
              true
            );
          });
        }
        eSendEvent("vaultUpdated");
        if (!ownsRequest(owner)) return;
        setLoading(false);
        closeOwned(owner);
        ToastManager.show({
          message: strings.vaultDeleted(),
          type: "success",
          context: "global"
        });
      } else {
        if (!ownsRequest(owner)) return;
        setLoading(false);
        formRef.current.setError("password", strings.passwordIncorrect());
      }
    } catch (e) {
      console.error(e);
      if (ownsRequest(owner)) setLoading(false);
    }
  }, [deleteAll, closeOwned, ownsRequest]);

  const clearVault = useCallback(async () => {
    const owner = activeRequestRef.current;
    setLoading(true);
    try {
      const { password } = formRef.current.getValues();
      const vault = await db.vaults.default();
      const relations = await db.relations.from(vault!, "note").get();
      const noteIds = relations.map((item) => item.toId);

      await db.vault.clear(password);

      noteIds.forEach((id) => {
        eSendEvent(
          eUpdateNoteInEditor,
          {
            id: id,
            deleted: true
          },
          true
        );
      });
      eSendEvent("vaultUpdated");
      if (!ownsRequest(owner)) return;
      setLoading(false);
      closeOwned(owner);
      ToastManager.show({
        message: strings.vaultCleared(),
        type: "success"
      });
    } catch (e) {
      if (ownsRequest(owner)) {
        formRef.current.setError("password", strings.passwordIncorrect());
      }
    }
    if (ownsRequest(owner)) setLoading(false);
  }, [closeOwned, ownsRequest]);

  const enrollFingerprint = useCallback(
    async (
      password: string,
      closeAfter = true,
      owner = activeRequestRef.current
    ) => {
      if (!ownsRequest(owner)) return;
      setLoading(true);
      try {
        await db.vault.unlock(password);
        if (!ownsRequest(owner)) return;
        await BiometricService.storeCredentials(password);
        eSendEvent("vaultUpdated");
        if (!ownsRequest(owner)) return;
        setLoading(false);
        ToastManager.show({
          heading: strings.biometricUnlockEnabled(),
          type: "success",
          context: "global"
        });
        if (closeAfter) closeOwned(owner);
      } catch (e) {
        if (!ownsRequest(owner)) return;
        formRef.current.setError("password", strings.passwordIncorrect());
        setLoading(false);
      }
    },
    [closeOwned, ownsRequest]
  );

  const takeErrorAction = useCallback(() => {
    formRef.current.setError("password", strings.passwordIncorrect());
    setVisible(true);
  }, []);

  const lockNote = useCallback(
    async (owner = activeRequestRef.current, item = noteRef.current) => {
      if (!item || !ownsRequest(owner)) return;
      const { password } = formRef.current.getValues();
      if (!password || password.trim() === "") {
        formRef.current.setError("password", strings.passwordIncorrect());
        return;
      } else {
        await db.vault.add(item.id);

        eSendEvent(eUpdateNoteInEditor, item, true);

        if (!ownsRequest(owner)) return;
        closeOwned(owner);
        ToastManager.show({
          message: strings.noteLocked(),
          type: "error",
          context: "local"
        });
        setLoading(false);
      }
    },
    [closeOwned, ownsRequest]
  );

  const permanantUnlock = useCallback(() => {
    const owner = activeRequestRef.current;
    const item = noteRef.current;
    if (!item || !ownsRequest(owner)) return;
    const { password } = formRef.current.getValues();
    db.vault
      .remove(item.id, password)
      .then(async () => {
        eSendEvent(eUpdateNoteInEditor, item, true);
        if (!ownsRequest(owner)) return;
        ToastManager.show({
          heading: strings.noteUnlocked(),
          type: "success",
          context: "global"
        });
        if (biometricUnlock && !isBiometryEnrolled) {
          await enrollFingerprint(password, false, owner);
        }
        closeOwned(owner);
      })
      .catch((e) => {
        if (ownsRequest(owner)) takeErrorAction();
      });
  }, [
    biometricUnlock,
    isBiometryEnrolled,
    closeOwned,
    ownsRequest,
    enrollFingerprint,
    takeErrorAction
  ]);

  const openInEditor = useCallback(
    (note: Note & { content?: NoteContent<false> }) => {
      const owner = activeRequestRef.current;
      const token = requestTokenRef.current;
      if (!closeOwned(owner)) return;
      InteractionManager.runAfterInteractions(async () => {
        if (!mountedRef.current || requestTokenRef.current !== token) return;
        eSendEvent(eOnLoadNote, {
          item: note
        });
        if (!DDS.isTab) {
          fluidTabsRef.current?.goToPage("editor");
        }
      });
    },
    [closeOwned]
  );

  const copyNote = useCallback(
    async (note: Note & { content?: NoteContent<false> }) => {
      const owner = activeRequestRef.current;
      const text = await convertNoteToText(note, true);
      if (!ownsRequest(owner)) return;
      Clipboard.setString(text || "");
      ToastManager.show({
        heading: strings.noteCopied(),
        type: "success",
        context: "global"
      });
      closeOwned(owner);
    },
    [closeOwned, ownsRequest]
  );

  const shareNote = useCallback(
    async (
      note: Note & { content?: NoteContent<false> },
      request: VaultRequest | null,
      token: number
    ) => {
      const isCurrent = () =>
        mountedRef.current &&
        requestTokenRef.current === token &&
        !request?.completed;
      const senderGuard = request?.shareGuard;

      // Legacy unguarded path: unchanged behavior. No guard means no
      // `undefined` outcome and the exact pre-existing Share options survive.
      if (!senderGuard) {
        closeOwned(request);
        try {
          await Share.open({
            title: note.title,
            failOnCancel: false,
            message: (await convertNoteToText(note)) || ""
          });
        } catch (e) {
          console.error(e);
        }
        return;
      }

      // Guarded primary Share path. The fence only ever confirms this exact
      // request (mounted + token + note id) and then defers to the caller's
      // captured guard, so a stale sender or a stale request yields
      // `undefined` from the converter.
      const fence: NoteSenderGuard = (candidateNoteId: string) => {
        if (!mountedRef.current) return false;
        if (requestTokenRef.current !== token) return false;
        if (request?.completed) return false;
        if (request?.noteId !== candidateNoteId) return false;
        return senderGuard(candidateNoteId);
      };

      let converted: string | false | undefined;
      try {
        converted = await convertNoteToText(note, undefined, fence);
      } catch (e) {
        // A stale failure must not close or error onto a newer dialog.
        if (!isCurrent()) return;
        // Close our own dialog (whose own guard releases this request's
        // captured completion exactly once) and report the failure.
        closeOwned(request);
        ToastManager.show({
          message: strings.somethingWentWrong(),
          type: "error",
          context: "global"
        });
        return;
      }

      if (typeof converted !== "string") {
        if (!isCurrent()) {
          // Stale/unconfirmed sender, or a request a newer one already
          // replaced: release our own captured completion once and never touch
          // the newer request's dialog.
          if (request) finishRequest(request);
          return;
        }
        // Our own, still-current request: close it so no completed request is
        // left visible; `close()` releases the captured completion once. The
        // current-request verdict is read here, *before* the close marks the
        // request completed (which `isCurrent()` would otherwise see as stale
        // and suppress the error forever). Only a real `false` refusal
        // surfaces the generic error; a stale `undefined` stays silent.
        closeOwned(request);
        if (converted === false) {
          ToastManager.show({
            message: strings.somethingWentWrong(),
            type: "error",
            context: "global"
          });
        }
        return;
      }

      // Revalidate our own request and the captured guard immediately before
      // closing our own dialog. The close below must not invalidate this
      // export.
      if (!isCurrent() || senderGuard(note.id) !== true) {
        if (isCurrent()) closeOwned(request);
        else if (request) finishRequest(request);
        return;
      }

      if (request) request.shareDispatched = true;
      closeOwned(request);
      try {
        await Share.open({
          title: note.title,
          failOnCancel: false,
          message: converted
        });
      } catch (e) {
        console.error(e);
      } finally {
        if (request) finishRequest(request);
      }
    },
    [closeOwned, finishRequest]
  );

  const deleteNote = useCallback(async () => {
    const owner = activeRequestRef.current;
    const item = noteRef.current;
    if (!item || !ownsRequest(owner)) return;
    const { password } = formRef.current.getValues();
    try {
      await db.vault.remove(item.id, password);
      await deleteItems("note", [item.id]);
      closeOwned(owner);
    } catch (e) {
      if (ownsRequest(owner)) takeErrorAction();
    }
  }, [closeOwned, ownsRequest, takeErrorAction]);

  const openNote = useCallback(async () => {
    const { password } = formRef.current.getValues();
    const token = requestTokenRef.current;
    // Snapshot the owning intent before any await: an old result must be
    // dispatched under the request it started for, never the newer one whose
    // refs replaced these. A request that `close()` already completed (cancel)
    // is no longer current either.
    const item = noteRef.current;
    const requestType = requestTypeRef.current;
    const request = activeRequestRef.current;
    const onUnlock = onUnlockRef.current;
    if (!request?.ready || request.noteId !== item?.id) return;
    const isCurrent = () =>
      mountedRef.current &&
      requestTokenRef.current === token &&
      !request?.completed;
    // The supplied sender fence must still confirm before and after every await
    // of the unlock. A supplied but non-callable guard fails closed; `undefined`
    // (legacy callers) is inert and never calls anything.
    const senderGuard = request?.shareGuard;
    const guardConfirmed = () =>
      senderGuard === undefined
        ? true
        : typeof senderGuard === "function" &&
          senderGuard(item?.id as string) === true;
    // Abandon an in-flight unlock whose sender fence no longer confirms: close
    // our own dialog (releasing the captured completion once through `close()`)
    // so no completed request is left visible, and never touch a newer request.
    const abortUnconfirmedSender = () => {
      if (isCurrent()) {
        closeOwned(request);
      } else if (request) {
        finishRequest(request);
      }
    };

    try {
      if (!item || !password) throw new Error("Invalid password");

      // Revalidate the fence before the unlock: a sender that already changed
      // must abort with no database access at all.
      if (!guardConfirmed()) {
        abortUnconfirmedSender();
        return;
      }

      const note = await db.vault.open(item.id, password);
      if (!isCurrent()) return;

      // A stale sender after the unlock finishes this request's own completion
      // once and shares nothing.
      if (!guardConfirmed()) {
        abortUnconfirmedSender();
        return;
      }

      if (!note) throw new Error("Failed to unlock note.");
      if (biometricUnlock && !isBiometryEnrolled) {
        await enrollFingerprint(password, false, request);
        if (!isCurrent()) return;
        if (!guardConfirmed()) {
          abortUnconfirmedSender();
          return;
        }
      }

      if (requestType === VaultRequestType.GoToEditor) {
        openInEditor(note);
      } else if (requestType === VaultRequestType.ShareNote) {
        await shareNote(note, request, token);
      } else if (requestType === VaultRequestType.DeleteNote) {
        await deleteNote();
      } else if (requestType === VaultRequestType.CopyNote) {
        await copyNote(note);
      } else if (requestType === VaultRequestType.CustomAction && onUnlock) {
        // Legacy custom action: `close()` completes this request but the
        // captured `onUnlock` must still run after the post-close delay, so it
        // is deliberately not gated on `isCurrent()`.
        closeOwned(request);
        await sleep(500);
        if (mountedRef.current && requestTokenRef.current === token) {
          onUnlock(note, password);
        }
      }
    } catch (e) {
      // A stale failure must not close or error onto a newer dialog.
      if (!isCurrent()) return;
      takeErrorAction();
    }
  }, [
    biometricUnlock,
    isBiometryEnrolled,
    enrollFingerprint,
    openInEditor,
    shareNote,
    deleteNote,
    copyNote,
    closeOwned,
    takeErrorAction,
    finishRequest
  ]);

  const unlockNote = useCallback(async () => {
    const { password } = formRef.current.getValues();
    if (!password || password.trim() === "") {
      formRef.current.setError("password", strings.passwordIncorrect());
      return;
    }
    if (requestTypeRef.current === VaultRequestType.PermanentUnlock) {
      permanantUnlock();
    } else {
      await openNote();
    }
  }, [permanantUnlock, openNote]);

  const createVault = useCallback(async () => {
    const owner = activeRequestRef.current;
    const item = noteRef.current;
    if (!ownsRequest(owner)) return;
    const { password } = formRef.current.getValues();
    await db.vault.create(password);
    if (!ownsRequest(owner)) return;

    if (biometricUnlock) {
      await enrollFingerprint(password, false, owner);
    }
    if (!ownsRequest(owner)) return;
    if (item?.id) {
      await db.vault.add(item.id);
      eSendEvent(eUpdateNoteInEditor, item, true);
      if (!ownsRequest(owner)) return;
      setLoading(false);
      ToastManager.show({
        heading: strings.noteLocked(),
        type: "success",
        context: "global"
      });
      closeOwned(owner);
    } else {
      ToastManager.show({
        heading: strings.vaultCreated(),
        type: "success",
        context: "global"
      });
      closeOwned(owner);
    }
    eSendEvent("vaultUpdated");
  }, [biometricUnlock, enrollFingerprint, closeOwned, ownsRequest]);

  const revokeFingerprintAccess = useCallback(async () => {
    const owner = activeRequestRef.current;
    try {
      await BiometricService.resetCredentials();
      eSendEvent("vaultUpdated");
      if (!ownsRequest(owner)) return;
      ToastManager.show({
        heading: strings.biometricUnlockDisabled(),
        type: "success",
        context: "global"
      });
    } catch (e: any) {
      if (!ownsRequest(owner)) return;
      ToastManager.show({
        heading: e.message,
        type: "success",
        context: "global"
      });
    }
  }, [ownsRequest]);

  const onPress = useCallback(async () => {
    const request = activeRequestRef.current;
    if (!request?.ready || request.completed) return;
    const requestType = requestTypeRef.current;
    const item = noteRef.current;

    if (requestType === VaultRequestType.RevokeFingerprint) {
      await revokeFingerprintAccess();
      closeOwned(request);
      return;
    }

    if (loading) return;

    if (!formRef.current.validate()) return;

    const { password, newPassword } = formRef.current.getValues();

    if (requestType === VaultRequestType.DeleteVault && !isUserLoggedIn) {
      setLoading(true);
      await deleteVault();
      if (ownsRequest(request)) setLoading(false);
      return;
    }

    if (requestType === VaultRequestType.CreateVault) {
      createVault();
    } else if (requestType === VaultRequestType.ChangePassword) {
      setLoading(true);

      db.vault
        .changePassword(password, newPassword)
        .then(async () => {
          if (!ownsRequest(request)) return;
          setLoading(false);
          if (biometricUnlock) {
            await enrollFingerprint(newPassword, false, request);
          } else {
            await BiometricService.resetCredentials();
          }
          if (!ownsRequest(request)) return;
          ToastManager.show({
            heading: strings.passwordUpdated(),
            type: "success",
            context: "global"
          });
          closeOwned(request);
        })
        .catch((e) => {
          if (!ownsRequest(request)) return;
          setLoading(false);
          if (e.message === VAULT_ERRORS.wrongPassword) {
            formRef.current.setError("password", strings.passwordIncorrect());
          } else {
            console.error(e);
          }
        });
    } else if (requestType === VaultRequestType.LockNote) {
      db.vault
        .unlock(password)
        .then(async (unlocked) => {
          if (!ownsRequest(request)) return;
          if (unlocked) {
            await lockNote(request, item);
          } else {
            formRef.current.setError("password", strings.passwordIncorrect());
          }
        })
        .catch((e) => {
          if (!ownsRequest(request)) return;
          formRef.current.setError("password", strings.passwordIncorrect());
        });
    } else if (
      requestType === VaultRequestType.UnlockNote ||
      requestType === VaultRequestType.PermanentUnlock ||
      requestType === VaultRequestType.GoToEditor ||
      requestType === VaultRequestType.ShareNote ||
      requestType === VaultRequestType.CopyNote ||
      requestType === VaultRequestType.DeleteNote ||
      requestType === VaultRequestType.CustomAction
    ) {
      if (noteLockedRef.current) {
        await unlockNote();
      } else {
        console.log("Error: Note should be locked for this operation");
      }
    } else if (requestType === VaultRequestType.EnableFingerprint) {
      enrollFingerprint(password);
    } else if (requestType === VaultRequestType.ClearVault) {
      await clearVault();
    } else if (requestType === VaultRequestType.DeleteVault) {
      await deleteVault();
    }
  }, [
    loading,
    isUserLoggedIn,
    biometricUnlock,
    revokeFingerprintAccess,
    closeOwned,
    ownsRequest,
    createVault,
    enrollFingerprint,
    unlockNote,
    lockNote,
    clearVault,
    deleteVault
  ]);

  const onPressFingerprintAuth = useCallback(
    async (title?: string, description?: string) => {
      const token = requestTokenRef.current;
      const request = activeRequestRef.current;
      if (!request?.ready) return;
      const isCurrent = () =>
        mountedRef.current &&
        requestTokenRef.current === token &&
        !request?.completed;
      // The supplied fence must still confirm after the credential prompt (and
      // after the sheet-closing delay) before this request may write a password
      // or show its dialog. `undefined` is inert.
      const senderGuard = request?.shareGuard;
      const guardConfirmed = () =>
        senderGuard === undefined
          ? true
          : typeof senderGuard === "function" &&
            senderGuard(request?.noteId as string) === true;
      const abortIfStaleSender = () => {
        if (guardConfirmed()) return false;
        if (request) finishRequest(request);
        return true;
      };
      try {
        const credentials = await BiometricService.getCredentials(
          title || titleRef.current,
          description || descriptionRef.current || ""
        );

        // Never write a password or trigger a press for a request that was
        // replaced while the credential prompt was open.
        if (!isCurrent()) return;
        if (abortIfStaleSender()) return;

        if (!credentials) throw new Error("Failed to get user credentials");

        if (credentials?.password) {
          formRef.current.setValue("password", credentials.password);
          onPress();
        } else {
          eSendEvent(eCloseActionSheet);
          await sleep(300);
          if (!isCurrent()) return;
          if (abortIfStaleSender()) return;
          setVisible(true);
        }
      } catch (e) {
        console.error(e);
      }
    },
    [onPress, finishRequest]
  );

  const open = useCallback(
    async (data: Vault) => {
      // A token is allocated synchronously for every inbound request, legacy
      // ones included, before any await. Only the latest one may install refs,
      // show the dialog or dispatch a result. A request that `close()` already
      // completed (cancel) is no longer current either, so a superseded chain
      // resuming from an await can never re-install refs or re-show a dialog.
      const token = ++requestTokenRef.current;

      // This request supersedes any still-pending previous request: complete
      // the previous request once with *its own* captured callback.
      const previous = activeRequestRef.current;
      const request: VaultRequest = {
        token,
        noteId: data.item?.id,
        shareGuard: data.shareGuard,
        onShareComplete: data.onShareComplete,
        completed: false,
        ready: false,
        shareDispatched: false
      };
      activeRequestRef.current = request;
      // Install before completion: a callback may synchronously open a newer request.
      if (previous) finishRequest(previous);

      const isCurrent = () =>
        mountedRef.current &&
        requestTokenRef.current === token &&
        !request.completed;

      try {
        // Strict, fail-closed sender fence for the guarded ("new primary") path.
        // A supplied but non-callable guard is a caller error: abort with no
        // database access at all, never degrading to the legacy path. A supplied
        // guard that does not confirm the captured note id aborts before every
        // await. `undefined` (legacy callers) is inert and changes nothing.
        const senderGuard = data.shareGuard;
        const noteId = data.item?.id;
        const guardConfirmed = () =>
          senderGuard === undefined
            ? true
            : typeof senderGuard === "function" &&
              senderGuard(noteId as string) === true;

        if (!guardConfirmed()) {
          finishRequest(request);
          return;
        }

        const biometry = await BiometricService.isBiometryAvailable();
        if (!isCurrent() || !guardConfirmed()) {
          finishRequest(request);
          return;
        }
        const available = !!biometry;
        const fingerprint = await BiometricService.hasInternetCredentials();
        if (!isCurrent() || !guardConfirmed()) {
          finishRequest(request);
          return;
        }

        if (data.item) {
          const locked = await db.vaults.itemExists(data.item);
          if (!isCurrent() || !guardConfirmed()) {
            finishRequest(request);
            return;
          }
          noteLockedRef.current = locked;
          if (!locked) {
            const content = await db.content.findByNoteId(data.item.id);
            if (!isCurrent() || !guardConfirmed()) {
              finishRequest(request);
              return;
            }
            if (content && isEncryptedContent(content)) {
              noteLockedRef.current = true;
            }
          }
        }

        // Set refs (only a current request may)
        noteRef.current = data.item;
        titleRef.current = data.title || strings.goToEditor();
        descriptionRef.current = data.description || null;
        paragraphRef.current = data.paragraph || null;
        buttonTitleRef.current = data.buttonTitle || null;
        positiveButtonTypeRef.current =
          data.positiveButtonType || "transparent";
        customActionTitleRef.current = data.customActionTitle || null;
        customActionParagraphRef.current = data.customActionParagraph || null;
        onUnlockRef.current = data.onUnlock;
        requestTypeRef.current = data.requestType;
        request.ready = true;

        // Set UI state
        setIsBiometryAvailable(available);
        setIsBiometryEnrolled(fingerprint);
        setBiometricUnlock(fingerprint);
        setDeleteAll(false);
        setLoading(false);

        // Auto-unlock with fingerprint if applicable
        const canAutoUnlock =
          fingerprint &&
          available &&
          data.requestType !== VaultRequestType.EnableFingerprint &&
          data.requestType !== VaultRequestType.RevokeFingerprint &&
          data.requestType !== VaultRequestType.ChangePassword &&
          data.requestType !== VaultRequestType.ClearVault &&
          data.requestType !== VaultRequestType.DeleteVault &&
          data.requestType !== VaultRequestType.CustomAction &&
          data.requestType !== VaultRequestType.PermanentUnlock &&
          data.requestType !== VaultRequestType.CreateVault;

        if (canAutoUnlock && available) {
          try {
            await onPressFingerprintAuth(data.title, data.description);
          } catch (e) {
            if (isCurrent()) setVisible(true);
          }
        } else {
          setVisible(true);
        }
      } catch {
        // Preflight failure must release the captured native Share flight.
        if (isCurrent()) {
          setVisible(false);
          setLoading(false);
        }
        finishRequest(request);
      }
    },
    [onPressFingerprintAuth, finishRequest]
  );

  // Mount fence: an unmount completes the pending request exactly once, using
  // its captured callback, without launching a share or mutating UI state. Its
  // own identity is stable, so this cleanup runs only on real unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const request = activeRequestRef.current;
      if (request) finishRequest(request);
    };
  }, [finishRequest]);

  useEffect(() => {
    eSubscribeEvent(eOpenVaultDialog, open);
    eSubscribeEvent(eCloseVaultDialog, close);

    return () => {
      eUnSubscribeEvent(eOpenVaultDialog, open);
      eUnSubscribeEvent(eCloseVaultDialog, close);
    };
  }, [open, close]);

  if (!visible) return null;

  const requestType = requestTypeRef.current;
  const isCreateVault = requestType === VaultRequestType.CreateVault;
  const isChangePassword = requestType === VaultRequestType.ChangePassword;
  const isClearVault = requestType === VaultRequestType.ClearVault;
  const isDeleteVault = requestType === VaultRequestType.DeleteVault;
  const isRevokeFingerprint =
    requestType === VaultRequestType.RevokeFingerprint;
  const isEnableFingerprint =
    requestType === VaultRequestType.EnableFingerprint;
  const isCustomAction = requestType === VaultRequestType.CustomAction;
  const isDeleteNote = requestType === VaultRequestType.DeleteNote;
  const isShareNote = requestType === VaultRequestType.ShareNote;
  const isGoToEditor = requestType === VaultRequestType.GoToEditor;

  return (
    <BaseDialog
      onShow={async () => {
        await sleep(100);
        passInputRef.current?.focus();
      }}
      statusBarTranslucent={false}
      onRequestClose={close}
      visible={true}
    >
      <View
        style={{
          ...getElevationStyle(5),
          width: DDS.isTab ? 350 : "85%",
          borderRadius: 10,
          backgroundColor: colors.primary.background,
          paddingTop: 12,
          overflow: "hidden"
        }}
      >
        <DialogHeader
          title={titleRef.current}
          paragraph={
            paragraphRef.current || customActionParagraphRef.current || ""
          }
          icon="shield"
          padding={12}
        />

        <View
          style={{
            paddingHorizontal: DefaultAppStyles.GAP
          }}
        >
          {(isChangePassword ||
            isClearVault ||
            requestType === VaultRequestType.LockNote ||
            requestType === VaultRequestType.UnlockNote ||
            requestType === VaultRequestType.PermanentUnlock ||
            isGoToEditor ||
            isShareNote ||
            isDeleteNote ||
            isEnableFingerprint ||
            (isDeleteVault && isUserLoggedIn) ||
            isCustomAction) &&
          !isRevokeFingerprint ? (
            <>
              <FormInput
                name="password"
                formRef={formRef}
                fwdRef={passInputRef}
                editable={!loading}
                autoCapitalize="none"
                testID={notesnook.ids.dialogs.vault.pwd}
                autoComplete="password"
                marginBottom={
                  !biometricUnlock ||
                  !isBiometryEnrolled ||
                  isCreateVault ||
                  isChangePassword ||
                  isCustomAction
                    ? 0
                    : 10
                }
                onSubmitEditing={() => {
                  if (isChangePassword) {
                    newPassInputRef.current?.focus();
                  } else {
                    onPress();
                  }
                }}
                returnKeyLabel={
                  isChangePassword ? strings.next() : titleRef.current
                }
                returnKeyType={isChangePassword ? "next" : "done"}
                secureTextEntry
                placeholder={
                  isChangePassword
                    ? strings.currentPassword()
                    : strings.password()
                }
                validators={[validators.required(strings.passwordRequired())]}
              />

              {!biometricUnlock ||
              !isBiometryEnrolled ||
              !isBiometryAvailable ||
              isCreateVault ||
              isChangePassword ||
              isCustomAction ||
              isDeleteVault ? null : (
                <Button
                  onPress={() =>
                    onPressFingerprintAuth(strings.unlockNote(), "")
                  }
                  icon="fingerprint"
                  width="100%"
                  title={strings.unlockWithBiometrics()}
                  type="transparent"
                />
              )}
            </>
          ) : null}

          {isDeleteVault && (
            <Pressable
              onPress={() => setDeleteAll(!deleteAll)}
              style={{
                paddingVertical: 0,
                flexDirection: "row",
                gap: DefaultAppStyles.GAP_SMALL,
                marginTop: isUserLoggedIn
                  ? DefaultAppStyles.GAP_VERTICAL_SMALL
                  : 0,
                justifyContent: "flex-start"
              }}
            >
              <AppIcon
                name={
                  deleteAll
                    ? "check-circle-outline"
                    : "checkbox-blank-circle-outline"
                }
                color={colors.error.accent}
                size={AppFontSize.md}
              />

              <Paragraph color={colors.error.accent} size={AppFontSize.sm}>
                {strings.deleteAllNotes()}
              </Paragraph>
            </Pressable>
          )}

          {isChangePassword ? (
            <>
              <Seperator half />
              <FormInput
                name="newPassword"
                formRef={formRef}
                fwdRef={newPassInputRef}
                editable={!loading}
                testID={notesnook.ids.dialogs.vault.changePwd}
                autoCapitalize="none"
                autoComplete="password"
                onSubmitEditing={() => {
                  onPress();
                }}
                returnKeyLabel="Change"
                returnKeyType="done"
                secureTextEntry
                placeholder={strings.newPassword()}
                validators={[validators.required(strings.passwordRequired())]}
              />
            </>
          ) : null}

          {isCreateVault ? (
            <View>
              <FormInput
                name="password"
                formRef={formRef}
                fwdRef={passInputRef}
                autoCapitalize="none"
                testID={notesnook.ids.dialogs.vault.pwd}
                autoComplete="password"
                returnKeyLabel={strings.next()}
                returnKeyType="next"
                secureTextEntry
                onSubmitEditing={() => {
                  confirmPassRef.current?.focus();
                }}
                placeholder={strings.password()}
                validators={[validators.required(strings.passwordRequired())]}
              />

              <FormInput
                name="confirmPassword"
                formRef={formRef}
                fwdRef={confirmPassRef}
                autoCapitalize="none"
                testID={notesnook.ids.dialogs.vault.pwdAlt}
                secureTextEntry
                autoComplete="password"
                returnKeyLabel="Create"
                returnKeyType="done"
                marginBottom={0}
                onSubmitEditing={() => {
                  onPress();
                }}
                placeholder={strings.confirmPassword()}
                validators={[
                  validators.required(strings.confirmPasswordRequired()),
                  validators.matchField(
                    "password",
                    strings.passwordNotMatched()
                  )
                ]}
              />
            </View>
          ) : null}

          {biometricUnlock && !isBiometryEnrolled && !isCreateVault ? (
            <Paragraph>{strings.vaultEnableBiometrics()}</Paragraph>
          ) : null}

          {!biometricUnlock &&
          !isBiometryEnrolled &&
          isBiometryAvailable &&
          (requestType === VaultRequestType.CopyNote ||
            requestType === VaultRequestType.DeleteNote ||
            requestType === VaultRequestType.ShareNote ||
            requestType === VaultRequestType.CustomAction ||
            requestType === VaultRequestType.GoToEditor ||
            requestType === VaultRequestType.PermanentUnlock ||
            requestType === VaultRequestType.LockNote) ? (
            <Button
              onPress={() => {
                setBiometricUnlock(!biometricUnlock);
              }}
              style={{
                marginTop: DefaultAppStyles.GAP_VERTICAL
              }}
              icon="fingerprint"
              width="100%"
              title={strings.unlockWithBiometrics()}
              iconColor={
                biometricUnlock ? colors.selected.accent : colors.primary.icon
              }
              type={biometricUnlock ? "transparent" : "plain"}
            />
          ) : null}
        </View>

        <DialogButtons
          onPressNegative={close}
          onPressPositive={onPress}
          loading={loading}
          positiveType={positiveButtonTypeRef.current}
          positiveTitle={buttonTitleRef.current || strings.unlock()}
        />
      </View>
      <Toast context="local" />
    </BaseDialog>
  );
};
