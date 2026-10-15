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
 * Settings screen for the VeyraN Connect client host.
 *
 * Every control performs a real action against the native client; nothing here
 * simulates success or offers an inert button. Off Mac Catalyst the screen is
 * honest about the platform being unsupported and disables only pairing and
 * session start — the shared Core data still syncs normally.
 */

import type { Notebook, TaskList } from "@notesnook/core";
import { useThemeColors } from "@notesnook/theme";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  Switch,
  Text,
  View,
  ViewStyle
} from "react-native";
import { DatabaseLogger, db } from "../common/database";
import { Pressable } from "./ui/pressable";
import Paragraph from "./ui/typography/paragraph";
import {
  ConnectCapabilities,
  EMPTY_CAPABILITIES,
  disconnect,
  isConnectPlatformSupported,
  nativeStatus,
  normalizeCapabilities,
  onHostAccountReady,
  pickPairingFile,
  readLocalRecord,
  startSession,
  stopSession,
  writeLocalRecord,
  type ConnectNativeStatus
} from "../services/veyran-connect";
import { useUserStore } from "../stores/use-user-store";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { isMacCatalyst } from "../utils/constants";
import { DefaultAppStyles } from "../utils/styles";

export const VeyranConnectSettings = () => {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const supported = isConnectPlatformSupported();
  const isMac = isMacCatalyst();
  const user = useUserStore((state) => state.user);

  const [status, setStatus] = useState<ConnectNativeStatus | undefined>(
    undefined
  );
  const [capabilities, setCapabilities] = useState<ConnectCapabilities>(() => ({
    ...EMPTY_CAPABILITIES
  }));
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [taskLists, setTaskLists] = useState<TaskList[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  // Serializes edits: a toggle that arrives while a durable write is in flight
  // is ignored rather than racing the pending record/install.
  const busyRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    const next = await nativeStatus();
    if (mounted.current) setStatus(next);
    return next;
  }, []);

  // Load the device-local record and enumerate the choices, but only on the one
  // supported platform. The account/unlock state is captured before the reads
  // and rechecked after every await, so a result from account A can never land
  // in account B's UI.
  useEffect(() => {
    if (!isMac) return;
    const accountId = useUserStore.getState().user?.id ?? null;
    const record = readLocalRecord();
    setCapabilities(
      record && record.accountId === accountId
        ? normalizeCapabilities(record.capabilities)
        : { ...EMPTY_CAPABILITIES }
    );
    (async () => {
      try {
        const [allNotebooks, allLists] = await Promise.all([
          db.notebooks.all.items(),
          db.taskLists.list()
        ]);
        if (!mounted.current) return;
        if ((useUserStore.getState().user?.id ?? null) !== accountId) return;
        setNotebooks(allNotebooks);
        setTaskLists(allLists);
      } catch (e) {
        DatabaseLogger.error(e as Error, "VeyranConnectSettings.load");
      }
      if (mounted.current) await refreshStatus();
    })();
  }, [isMac, refreshStatus, user?.id]);

  const persist = useCallback(
    async (next: ConnectCapabilities) => {
      const accountId = useUserStore.getState().user?.id;
      if (!accountId || !accountEditable(accountId)) return;
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(undefined);
      try {
        // Fail closed first: stop any running session and fence the epoch before
        // new rights are written, so nothing runs against stale grants. The
        // adapter is re-unlocked inside `onHostAccountReady` after the write.
        await stopSession();
        if (!accountEditable(accountId)) return;
        const written = await writeLocalRecord({
          v: 1,
          accountId,
          capabilities: normalizeCapabilities(next)
        });
        if (!written) {
          setError("The device-local grants record could not be saved.");
          return;
        }
        // Re-check *after* the awaited durable write: an App Lock / logout /
        // account switch that landed while the write was in flight must never
        // be followed by an unlock, which would resurrect rights for a locked
        // (or different) account. `onHostAccountReady` re-proves this too.
        if (!accountEditable(accountId)) {
          setError("The app is locked or the account changed.");
          return;
        }
        const generation = await onHostAccountReady(accountId, next);
        if (generation === undefined) {
          setError("The permissions could not be applied.");
          return;
        }
        if (mounted.current) setCapabilities(normalizeCapabilities(next));
      } finally {
        busyRef.current = false;
        if (mounted.current) {
          setBusy(false);
          await refreshStatus();
        }
      }
    },
    [refreshStatus]
  );

  const toggleFlag = useCallback(
    (key: "canRead" | "canCreate" | "canChange" | "canTask", value: boolean) => {
      void persist({ ...capabilities, [key]: value });
    },
    [capabilities, persist]
  );

  const toggleId = useCallback(
    (key: "notebookIds" | "listIds" | "noteIds", id: string, value: boolean) => {
      const current = new Set(capabilities[key]);
      if (value) current.add(id);
      else current.delete(id);
      void persist({ ...capabilities, [key]: [...current] });
    },
    [capabilities, persist]
  );

  const onPair = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await pickPairingFile();
      if (result.stale) {
        // The app state changed while the picker was open (lock, disconnect,
        // unmount, account switch or a parallel pick). Do not claim *what* was
        // persisted: the native side may have committed the credential before
        // the JS-side epoch fence observed the change, and the native
        // disconnect owns the final state. Both a stored-and-deleted and a
        // never-stored outcome are possible, so the truthful report is that the
        // connection was stopped and the pairing must be re-checked.
        setError(
          "The app state changed while importing; the connection was stopped. Check the pairing before trying again."
        );
      } else if (!result.paired && !result.cancelled) {
        setError("The pairing file was not accepted.");
      }
      await refreshStatus();
    } catch (e) {
      DatabaseLogger.error(e as Error, "VeyranConnectSettings.pair");
      setError("The pairing file was not accepted.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [refreshStatus]);

  const onStart = useCallback(async () => {
    const accountId = useUserStore.getState().user?.id;
    if (!accountId) {
      setError("Sign in before starting the connection.");
      return;
    }
    // A session starts only from the saved, account-bound record: say so
    // instead of reporting a generic failure when none exists yet.
    const record = readLocalRecord();
    if (!record || record.accountId !== accountId) {
      setError(
        "Choose the permissions to grant first; they are saved for this account before the connection can start."
      );
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      // `startSession` reinstalls the persisted grants for this account before
      // the broker session opens, so a grant set before pairing is not lost.
      const started = await startSession(accountId);
      if (!started) setError("The connection could not be started.");
      await refreshStatus();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [refreshStatus]);

  const onStop = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await stopSession();
      await refreshStatus();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [refreshStatus]);

  const onDisconnect = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const disconnected = await disconnect();
      if (mounted.current) {
        setCapabilities({ ...EMPTY_CAPABILITIES });
        // Report a failed durable clear honestly instead of claiming success.
        setError(
          disconnected
            ? undefined
            : "The connection was fenced, but the saved permissions could not be removed."
        );
      }
      await refreshStatus();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [refreshStatus]);

  const rowStyle = (isLast: boolean): ViewStyle => ({
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: DefaultAppStyles.GAP,
    width: "100%",
    minHeight: 48,
    paddingLeft: 16,
    paddingRight: 16,
    paddingVertical: 9,
    ...(isLast
      ? {}
      : { borderBottomWidth: 0.5, borderBottomColor: visual.separator })
  });

  const cardStyle: ViewStyle = {
    backgroundColor: visual.contentSurface,
    borderRadius: visual.controlRadius,
    overflow: "hidden",
    marginBottom: DefaultAppStyles.GAP_VERTICAL
  };

  const paired = status?.paired === true;
  const sessionActive = status?.sessionActive === true;
  const canStart = supported && paired && sessionActive === false && !!user?.id;

  if (!isMac) {
    return (
      <View style={{ padding: visual.pagePadding, width: "100%" }}>
        <View style={cardStyle}>
          <View style={rowStyle(true)}>
            <Paragraph color={visual.primaryText} style={{ flex: 1 }}>
              VeyraN Connect is available on Mac only. On this device it is
              unavailable; your Notes and Tasks still sync normally.
            </Paragraph>
          </View>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: visual.pagePadding,
        paddingVertical: visual.pagePadding,
        paddingBottom: 50,
        width: "100%"
      }}
    >
      <ConnectionCard
        status={status}
        paired={paired}
        sessionActive={sessionActive}
        busy={busy}
        supported={supported}
        canStart={canStart}
        onPair={onPair}
        onStart={onStart}
        onStop={onStop}
        onDisconnect={onDisconnect}
        visual={visual}
        cardStyle={cardStyle}
        rowStyle={rowStyle}
        accent={colors.primary.accent}
      />

      {status === undefined ? (
        <ActivityIndicator size="small" color={colors.primary.accent} />
      ) : null}

      {error ? (
        <View style={cardStyle}>
          <View style={rowStyle(true)}>
            <Paragraph color={colors.error.paragraph} style={{ flex: 1 }}>
              {error}
            </Paragraph>
          </View>
        </View>
      ) : null}

      <Text
        accessibilityRole="header"
        style={{
          color: visual.secondaryText,
          fontSize: 13,
          marginLeft: 16,
          marginBottom: 7,
          textTransform: "uppercase"
        }}
      >
        Permissions
      </Text>
      <View style={cardStyle}>
        <SwitchRow
          label="Read notes and notebooks"
          value={capabilities.canRead}
          disabled={busy || !paired}
          accent={colors.primary.accent}
          rowStyle={rowStyle}
          visual={visual}
          onToggle={(value) => toggleFlag("canRead", value)}
        />
        <SwitchRow
          label="Create notes"
          value={capabilities.canCreate}
          disabled={busy || !paired || !capabilities.defaultNotebookId}
          accent={colors.primary.accent}
          rowStyle={rowStyle}
          visual={visual}
          onToggle={(value) => toggleFlag("canCreate", value)}
        />
        <SwitchRow
          label="Change notes"
          value={capabilities.canChange}
          disabled={busy || !paired}
          accent={colors.primary.accent}
          rowStyle={rowStyle}
          visual={visual}
          onToggle={(value) => toggleFlag("canChange", value)}
        />
        <SwitchRow
          label="Tasks"
          value={capabilities.canTask}
          disabled={busy || !paired}
          accent={colors.primary.accent}
          rowStyle={rowStyle}
          visual={visual}
          isLast
          onToggle={(value) => toggleFlag("canTask", value)}
        />
      </View>

      <SectionLabel text="Default notebook for new notes" visual={visual} />
      <View style={cardStyle}>
        {notebooks.length === 0 ? (
          <View style={rowStyle(true)}>
            <Paragraph color={visual.secondaryText}>
              No notebooks yet.
            </Paragraph>
          </View>
        ) : (
          notebooks.map((notebook, index) => {
            const selected =
              capabilities.defaultNotebookId === notebook.id ||
              capabilities.notebookIds.includes(notebook.id);
            return (
              <SelectRow
                key={notebook.id}
                label={notebook.title}
                value={selected}
                disabled={busy || !paired}
                accent={colors.primary.accent}
                isLast={index === notebooks.length - 1}
                rowStyle={rowStyle}
                visual={visual}
                onToggle={(value) => {
                  void persist({
                    ...capabilities,
                    notebookIds: value
                      ? [...new Set([...capabilities.notebookIds, notebook.id])]
                      : capabilities.notebookIds.filter(
                          (id) => id !== notebook.id
                        ),
                    defaultNotebookId: value
                      ? notebook.id
                      : capabilities.defaultNotebookId === notebook.id
                      ? undefined
                      : capabilities.defaultNotebookId
                  });
                }}
              />
            );
          })
        )}
      </View>

      <SectionLabel text="Task lists" visual={visual} />
      <View style={cardStyle}>
        {taskLists.length === 0 ? (
          <View style={rowStyle(true)}>
            <Paragraph color={visual.secondaryText}>No task lists yet.</Paragraph>
          </View>
        ) : (
          taskLists.map((list, index) => (
            <SelectRow
              key={list.id}
              label={list.name}
              value={capabilities.listIds.includes(list.id)}
              disabled={busy || !paired}
              accent={colors.primary.accent}
              isLast={index === taskLists.length - 1}
              rowStyle={rowStyle}
              visual={visual}
              onToggle={(value) =>
                toggleId("listIds", list.id, value)
              }
            />
          ))
        )}
      </View>
    </ScrollView>
  );
};

/**
 * A permission control may only write/apply while *this exact* account is still
 * signed in, unlocked and not logging out or in account (re)setup. Read fresh on
 * every call so a lock that races a pending durable write is observed.
 */
function accountEditable(accountId: string): boolean {
  const state = useUserStore.getState();
  return (
    (state.user?.id ?? null) === accountId &&
    !state.appLocked &&
    !state.isLoggingOut &&
    !state.accountSetupRequired
  );
}

type Visual = ReturnType<typeof getAppleVisualTokens>;

function SectionLabel({ text, visual }: { text: string; visual: Visual }) {
  return (
    <Text
      accessibilityRole="header"
      style={{
        color: visual.secondaryText,
        fontSize: 13,
        marginLeft: 16,
        marginTop: DefaultAppStyles.GAP_VERTICAL,
        marginBottom: 7,
        textTransform: "uppercase"
      }}
    >
      {text}
    </Text>
  );
}

function SwitchRow({
  label,
  value,
  disabled,
  accent,
  rowStyle,
  visual,
  isLast,
  onToggle
}: {
  label: string;
  value: boolean;
  disabled: boolean;
  accent: string;
  rowStyle: (isLast: boolean) => ViewStyle;
  visual: Visual;
  isLast?: boolean;
  onToggle: (value: boolean) => void;
}) {
  return (
    <View style={rowStyle(isLast === true)}>
      <Paragraph
        style={{ flex: 1 }}
        color={visual.primaryText}
        numberOfLines={2}
      >
        {label}
      </Paragraph>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onToggle}
        trackColor={{ true: accent }}
        accessibilityLabel={label}
        accessibilityState={{ checked: value, disabled }}
      />
    </View>
  );
}

function SelectRow({
  label,
  value,
  disabled,
  accent,
  isLast,
  rowStyle,
  visual,
  onToggle
}: {
  label: string;
  value: boolean;
  disabled: boolean;
  accent: string;
  isLast: boolean;
  rowStyle: (isLast: boolean) => ViewStyle;
  visual: Visual;
  onToggle: (value: boolean) => void;
}) {
  return (
    <Pressable
      disabled={disabled}
      noborder
      customColor="transparent"
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      onPress={() => onToggle(!value)}
      style={rowStyle(isLast)}
    >
      <Paragraph
        style={{ flex: 1 }}
        color={visual.primaryText}
        numberOfLines={1}
        accessible={false}
      >
        {label}
      </Paragraph>
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          borderWidth: 1.5,
          borderColor: value ? accent : visual.tertiaryText,
          backgroundColor: value ? accent : "transparent"
        }}
      />
    </Pressable>
  );
}

function ConnectionCard({
  status,
  paired,
  sessionActive,
  busy,
  supported,
  canStart,
  onPair,
  onStart,
  onStop,
  onDisconnect,
  visual,
  cardStyle,
  rowStyle,
  accent
}: {
  status: ConnectNativeStatus | undefined;
  paired: boolean;
  sessionActive: boolean;
  busy: boolean;
  supported: boolean;
  canStart: boolean;
  onPair: () => void;
  onStart: () => void;
  onStop: () => void;
  onDisconnect: () => void;
  visual: Visual;
  cardStyle: ViewStyle;
  rowStyle: (isLast: boolean) => ViewStyle;
  accent: string;
}) {
  const detail = !supported
    ? "Unavailable on this platform."
    : !paired
    ? "No broker paired."
    : `${status?.brokerId ?? ""}:${status?.port ?? ""}${
        sessionActive ? " — connected" : " — paired, not connected"
      }`;
  return (
    <>
      <SectionLabel text="Connection" visual={visual} />
      <View style={cardStyle}>
        <View style={rowStyle(false)}>
          <Paragraph color={visual.primaryText} style={{ flex: 1 }}>
            {detail}
          </Paragraph>
        </View>
        <View style={rowStyle(false)}>
          <ActionButton
            label="Import pairing file"
            disabled={busy || !supported}
            accent={accent}
            onPress={onPair}
          />
        </View>
        <View style={rowStyle(false)}>
          <ActionButton
            label="Start"
            disabled={busy || !canStart}
            accent={accent}
            onPress={onStart}
          />
          <ActionButton
            label="Stop"
            disabled={busy || !sessionActive}
            accent={accent}
            onPress={onStop}
          />
        </View>
        <View style={rowStyle(true)}>
          <ActionButton
            label="Disconnect"
            disabled={busy || !paired}
            accent={accent}
            onPress={onDisconnect}
          />
        </View>
      </View>
    </>
  );
}

function ActionButton({
  label,
  disabled,
  accent,
  onPress
}: {
  label: string;
  disabled: boolean;
  accent: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled}
      noborder
      customColor="transparent"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={{ paddingVertical: 6, paddingRight: 16 }}
    >
      <Paragraph
        style={{ opacity: disabled ? 0.4 : 1, fontWeight: "600" }}
        color={accent}
      >
        {label}
      </Paragraph>
    </Pressable>
  );
}

export default VeyranConnectSettings;
