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
 * The VeyraN Assistant sidebar (Slice 1 reads + Slice 2 actions) and its shared
 * panel.
 *
 * Every control performs a real action through the headless controller; there
 * is no fake or inert button. Inference happens **only** on an explicit Send.
 * Not signed in, no explicit login; no Send before the exact saved-note snapshot
 * is previewed. The answer draft is RAM-only and editable.
 *
 * The three write actions (new note / append to the reviewed note / real task)
 * are each a separate, explicit press and are *disabled* whenever there is no
 * complete, current, authorized review context: a truncated snapshot, a stale
 * context or a revoked grant offers no action. A saved confirmation is rendered
 * only from the adapter-confirmed `lastSaved` state, never from a mere request.
 *
 * The provider host lifecycle stays with the app-level `startSIWCHost`; this
 * component only installs the assistant's owned handlers via `mountAssistantHost`
 * (and only for the process-wide controller — an injected controller, used by
 * tests, never touches the provider).
 */

import { useThemeColors } from "@notesnook/theme";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore
} from "react";
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleProp,
  TextInput,
  View,
  ViewStyle
} from "react-native";
import { Pressable } from "./ui/pressable";
import Paragraph from "./ui/typography/paragraph";
import {
  ASSISTANT_BLOCKED_RECOVERY_NOTE,
  ASSISTANT_BLOCK_REASON_TEXT,
  ASSISTANT_CREDITS_NOTICE,
  ASSISTANT_KINDS,
  ASSISTANT_MANAGE_USAGE_URL,
  ASSISTANT_VEYRAN_SIGN_IN_LABEL,
  assistantController,
  mountAssistantHost,
  offersVeyranSignIn,
  onAssistantLifecycleChange,
  type AssistantKind,
  type AssistantSavedResult,
  type AssistantState,
  type VeyranAssistantController
} from "../services/veyran-assistant";
import { toReadablePreviewText } from "../services/veyran-assistant/preview-text";
import { useUserStore } from "../stores/use-user-store";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { DefaultAppStyles } from "../utils/styles";

/** The bounded sidebar width; the editor flexes beside it. */
export const ASSISTANT_SIDEBAR_WIDTH = 340;

const KIND_LABELS: Record<AssistantKind, string> = {
  summary: "Zusammenfassen",
  rephrase: "Umformulieren",
  question: "Frage"
};

type Visual = ReturnType<typeof getAppleVisualTokens>;

export function useAssistantState(
  controller: VeyranAssistantController
): AssistantState {
  return useSyncExternalStore(controller.subscribe, controller.getState);
}

/** The bounded editor-adjacent sidebar. The editor pane flexes beside it. */
export function VeyranAssistantSidebar({
  controller,
  style
}: {
  /**
   * Test seam only: an injected controller never touches the provider host or
   * the real transport. Production renders the process-wide controller.
   */
  controller?: VeyranAssistantController;
  /** Inspector geometry only; the panel and controller stay mounted. */
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  return (
    <View
      testID="veyran-assistant-sidebar"
      style={[
        {
          width: ASSISTANT_SIDEBAR_WIDTH,
          height: "100%",
          backgroundColor: visual.secondarySurface,
          borderLeftWidth: 0.5,
          borderLeftColor: visual.separator
        },
        style
      ]}
    >
      <AssistantPanel controller={controller} />
    </View>
  );
}

/**
 * The full assistant panel, shared by the editor sidebar and the settings
 * screen so both expose the identical, real controls.
 */
export function AssistantPanel({
  controller,
  header
}: {
  controller?: VeyranAssistantController;
  /** Optional intro content rendered at the top of the panel's own scroll. */
  header?: React.ReactNode;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const activeController = controller ?? assistantController;
  const state = useAssistantState(activeController);

  // Real lifecycle binding: a change of the persisted account or an app lock
  // invalidates in-flight work, drops the model selection/preview and clears the
  // RAM-only draft (the controller re-reads status after the seam).
  const userId = useUserStore((store) => store.user?.id);
  const appLocked = useUserStore((store) => store.appLocked);
  useEffect(() => {
    if (!controller) onAssistantLifecycleChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, userId, appLocked]);

  useEffect(() => {
    if (controller) {
      controller.mount();
      return () => controller.unmount();
    }
    return mountAssistantHost();
  }, [controller, activeController]);

  const openUsage = useCallback(() => {
    void Linking.openURL(ASSISTANT_MANAGE_USAGE_URL).catch(() => {});
  }, []);

  if (!state.platformSupported) {
    return (
      <View
        testID="veyran-assistant-unsupported"
        style={{ padding: visual.pagePadding, width: "100%" }}
      >
        {header}
        <View style={cardStyle(visual)}>
          <View style={rowStyle(visual, true)}>
            <Paragraph color={visual.primaryText} style={{ flex: 1 }}>
              {state.info}
            </Paragraph>
          </View>
        </View>
      </View>
    );
  }

  const summary = state.status;
  const signedIn = summary?.signedIn === true;
  const canInvoke =
    !!summary &&
    signedIn &&
    summary.status === "ready" &&
    summary.hasDirectScopes === true;
  const canSend = activeController.canSend();

  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: visual.pagePadding,
        paddingVertical: visual.pagePadding,
        paddingBottom: 40
      }}
      keyboardShouldPersistTaps="handled"
    >
      {header}
      <Header text="VeyraN Assistant" visual={visual} />
      <ConnectionCard
        state={state}
        controller={activeController}
        visual={visual}
        accent={colors.primary.accent}
      />

      <Header text="Modell" visual={visual} />
      <View style={cardStyle(visual)}>
        {canInvoke ? (
          <>
            {state.modelsLoading ? (
              <View style={rowStyle(visual, false)}>
                <Paragraph
                  testID="veyran-assistant-models-loading"
                  color={visual.secondaryText}
                  style={{ flex: 1 }}
                >
                  Modelle werden geladen…
                </Paragraph>
                <ActivityIndicator size="small" color={colors.primary.accent} />
              </View>
            ) : state.modelsError ? (
              <View style={rowStyle(visual, state.models.length === 0)}>
                <Paragraph
                  testID="veyran-assistant-models-error"
                  color={colors.error.paragraph}
                  style={{ flex: 1 }}
                >
                  {state.modelsError.message}
                </Paragraph>
              </View>
            ) : state.models.length === 0 ? (
              <View style={rowStyle(visual, false)}>
                <Paragraph
                  testID="veyran-assistant-models-empty"
                  color={visual.secondaryText}
                  style={{ flex: 1 }}
                >
                  Kein Modell-Katalog verfügbar.
                </Paragraph>
              </View>
            ) : (
              state.models.map((model) => (
                <Row
                  key={model.slug}
                  selected={state.selectedModel === model.slug}
                  isLast={false}
                  visual={visual}
                  accent={colors.primary.accent}
                  label={model.displayName}
                  onPress={() => activeController.selectModel(model.slug)}
                />
              ))
            )}
            {/**
             * The explicit, read-only retry control. It re-reads the catalog and
             * never starts inference; it is disabled while a read is in flight,
             * so repeated presses cannot fan out into multiple requests.
             */}
            <View style={rowStyle(visual, false)}>
              <ActionButton
                testID="veyran-assistant-models-reload"
                label="Modelle neu laden"
                disabled={state.modelsLoading}
                accent={colors.primary.accent}
                onPress={() => void activeController.reloadModels()}
              />
            </View>
          </>
        ) : (
          <View style={rowStyle(visual, true)}>
            <Paragraph color={visual.secondaryText}>
              Melde dich an, um die verfügbaren Modelle zu laden.
            </Paragraph>
          </View>
        )}
        <View style={rowStyle(visual, true)}>
          <Paragraph color={visual.secondaryText} style={{ flex: 1 }}>
            {ASSISTANT_CREDITS_NOTICE}
          </Paragraph>
        </View>
        <View style={rowStyle(visual, true)}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Manage usage"
            noborder
            customColor="transparent"
            onPress={openUsage}
          >
            <Paragraph color={colors.primary.accent}>
              {ASSISTANT_MANAGE_USAGE_URL}
            </Paragraph>
          </Pressable>
        </View>
      </View>

      <Header text="Gespeicherte Notiz" visual={visual} />
      <PreviewCard
        state={state}
        controller={activeController}
        visual={visual}
        accent={colors.primary.accent}
      />

      <Header text="Anfrage" visual={visual} />
      <View style={cardStyle(visual)}>
        {ASSISTANT_KINDS.map((kind, index) => (
          <Row
            key={kind}
            selected={state.kind === kind}
            isLast={index === ASSISTANT_KINDS.length - 1}
            visual={visual}
            accent={colors.primary.accent}
            label={KIND_LABELS[kind]}
            onPress={() => activeController.setKind(kind)}
          />
        ))}
      </View>

      {state.kind === "question" ? (
        <TextInput
          testID="veyran-assistant-question"
          value={state.question}
          onChangeText={(text) => activeController.setQuestion(text)}
          placeholder="Deine Frage zur Notiz"
          placeholderTextColor={visual.tertiaryText}
          multiline
          style={{
            minHeight: 60,
            padding: 10,
            marginBottom: DefaultAppStyles.GAP_VERTICAL,
            color: visual.primaryText,
            backgroundColor: visual.contentSurface,
            borderRadius: visual.controlRadius,
            borderWidth: 0.5,
            borderColor: visual.separator
          }}
        />
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <ActionButton
          label="Senden"
          disabled={!canSend}
          accent={colors.primary.accent}
          onPress={() => void activeController.send()}
        />
        {state.streaming ? (
          <>
            <ActionButton
              label="Abbrechen"
              disabled={false}
              accent={colors.error.paragraph}
              onPress={() => void activeController.cancel()}
            />
            <ActivityIndicator size="small" color={colors.primary.accent} />
          </>
        ) : null}
      </View>

      {state.error ? (
        <View style={cardStyle(visual)}>
          <View style={rowStyle(visual, true)}>
            <Paragraph color={colors.error.paragraph} style={{ flex: 1 }}>
              {state.error.message}
            </Paragraph>
          </View>
          {state.error.link ? (
            <View style={rowStyle(visual, true)}>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="Manage usage"
                noborder
                customColor="transparent"
                onPress={openUsage}
              >
                <Paragraph color={colors.primary.accent}>
                  {state.error.link}
                </Paragraph>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}

      <Header text="Antwort (nur im Arbeitsspeicher)" visual={visual} />
      <TextInput
        testID="veyran-assistant-draft"
        value={state.draft}
        onChangeText={(text) => activeController.setDraft(text)}
        multiline
        editable
        placeholder="Die Antwort erscheint hier, sobald du sie sendest."
        placeholderTextColor={visual.tertiaryText}
        style={{
          minHeight: 140,
          padding: 10,
          color: visual.primaryText,
          backgroundColor: visual.contentSurface,
          borderRadius: visual.controlRadius,
          borderWidth: 0.5,
          borderColor: visual.separator
        }}
      />

      {/**
       * The explicit write actions. Each is a separate, human-confirmed press
       * that runs through the shared Core adapter; the assistant never writes on
       * its own and never reports saved without the adapter's persistence state.
       */}
      <Header text="Aktionen (mit Bestätigung)" visual={visual} />
      <View style={cardStyle(visual)}>
        <View style={rowStyle(visual, false)}>
          <ActionButton
            testID="veyran-assistant-action-create-note"
            label="Als neue Notiz speichern"
            disabled={!activeController.canSaveAsNewNote()}
            accent={colors.primary.accent}
            onPress={() => void activeController.saveAsNewNote()}
          />
        </View>
        <View style={rowStyle(visual, false)}>
          <ActionButton
            testID="veyran-assistant-action-append"
            label="An die Notiz anhängen"
            disabled={!activeController.canAppendToReviewedNote()}
            accent={colors.primary.accent}
            onPress={() => void activeController.appendToReviewedNote()}
          />
        </View>
        <View style={rowStyle(visual, true)}>
          <ActionButton
            testID="veyran-assistant-action-create-task"
            label="Als Task erstellen"
            disabled={!activeController.canCreateTaskFromDraft()}
            accent={colors.primary.accent}
            onPress={() => void activeController.createTaskFromDraft()}
          />
        </View>
      </View>

      {state.actionError ? (
        <View style={cardStyle(visual)}>
          <View style={rowStyle(visual, true)}>
            <Paragraph
              testID="veyran-assistant-action-error"
              color={colors.error.paragraph}
              style={{ flex: 1 }}
            >
              {state.actionError.message}
            </Paragraph>
          </View>
        </View>
      ) : null}

      {state.lastSaved ? (
        <View style={cardStyle(visual)}>
          <View style={rowStyle(visual, true)}>
            <Paragraph
              testID="veyran-assistant-last-saved"
              color={visual.primaryText}
              style={{ flex: 1 }}
            >
              {savedLabel(state.lastSaved)}
            </Paragraph>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

/** The truthful, past-tense label for one adapter-confirmed write. */
function savedLabel(saved: AssistantSavedResult): string {
  switch (saved.action) {
    case "create_note":
      return "Neue Notiz gespeichert.";
    case "append_to_note":
      return "An die Notiz angehängt.";
    case "create_task":
      return "Task erstellt.";
  }
}

// ----------------------------------------------------------------- internals

function ConnectionCard({
  state,
  controller,
  visual,
  accent
}: {
  state: AssistantState;
  controller: VeyranAssistantController;
  visual: Visual;
  accent: string;
}) {
  const summary = state.status;
  const signedIn = summary?.signedIn === true;
  const authenticating =
    state.authStarting || summary?.status === "authenticating";
  const missingPermission = summary?.status === "missingpermission";
  // A blocked host has no usable provider status: provider auth controls are
  // disabled (never left enabled and inert). Exactly the two local-account
  // reasons offer the ordinary VeyraN sign-in as the user-initiated recovery.
  const blocked = state.blockedReason;
  const providerDisabled = blocked !== undefined;
  const showVeyranSignIn = offersVeyranSignIn(blocked);

  return (
    <View style={cardStyle(visual)}>
      <View style={rowStyle(visual, false)}>
        <Paragraph
          testID="veyran-assistant-connection-status"
          color={visual.primaryText}
          style={{ flex: 1 }}
        >
          {statusText(state)}
        </Paragraph>
      </View>

      {/**
       * The account card shows only the factual connection state ("Verbundenes
       * ChatGPT-Konto" / the exact status copy). The verified `subject` and
       * issued `clientId` are internal ownership values: they are never printed
       * as user-facing connection info, and no e-mail/identity is invented.
       */}
      {authenticating ? (
        <View style={rowStyle(visual, blocked ? false : true)}>
          <ActionButton
            testID="veyran-assistant-auth-cancel"
            label="Anmeldung abbrechen"
            disabled={false}
            accent={accent}
            onPress={() => void controller.cancelAuth()}
          />
        </View>
      ) : (
        <View style={rowStyle(visual, showVeyranSignIn ? false : true)}>
          {!signedIn ? (
            <>
              <ActionButton
                testID="veyran-assistant-provider-signin"
                label="Anmelden"
                disabled={providerDisabled}
                accent={accent}
                onPress={() => void controller.beginAuth("returning")}
              />
              <ActionButton
                testID="veyran-assistant-provider-refresh"
                label="Neu anmelden"
                disabled={providerDisabled}
                accent={accent}
                onPress={() => void controller.beginAuth("fresh")}
              />
            </>
          ) : null}
          {missingPermission ? (
            <ActionButton
              testID="veyran-assistant-consent"
              label="ChatGPT-Nutzung freigeben"
              disabled={providerDisabled}
              accent={accent}
              onPress={() => void controller.beginAuth("consent")}
            />
          ) : null}
          {signedIn && !blocked ? (
            <ActionButton
              testID="veyran-assistant-logout"
              label="Abmelden"
              disabled={false}
              accent={accent}
              onPress={() => void controller.logout()}
            />
          ) : null}
        </View>
      )}

      {showVeyranSignIn ? (
        <>
          <View style={rowStyle(visual, true)}>
            <ActionButton
              testID="veyran-assistant-standard-signin"
              label={ASSISTANT_VEYRAN_SIGN_IN_LABEL}
              disabled={false}
              accent={accent}
              onPress={() => controller.openVeyranSignIn()}
            />
          </View>
          <View style={rowStyle(visual, true)}>
            <Paragraph
              testID="veyran-assistant-blocked-recovery-note"
              color={visual.secondaryText}
              style={{ flex: 1 }}
            >
              {ASSISTANT_BLOCKED_RECOVERY_NOTE}
            </Paragraph>
          </View>
        </>
      ) : null}
    </View>
  );
}

function PreviewCard({
  state,
  controller,
  visual,
  accent
}: {
  state: AssistantState;
  controller: VeyranAssistantController;
  visual: Visual;
  accent: string;
}) {
  // The saved snapshot is Tiptap HTML. It is rendered **only** as bounded,
  // readable plain text (shared `html-to-text` engine, no WebView, no HTML
  // execution, no raw tags). The exact `content` string is untouched in the
  // controller state and is what the model receives as data.
  const content = state.preview?.content ?? "";
  const readable = useMemo(() => toReadablePreviewText(content), [content]);

  return (
    <View style={cardStyle(visual)}>
      <View style={rowStyle(visual, state.preview ? false : true)}>
        <ActionButton
          label="Aktuelle Notiz laden"
          disabled={state.streaming || state.actionBusy}
          accent={accent}
          onPress={() => void controller.loadPreview()}
        />
      </View>
      {state.preview ? (
        <>
          <View style={rowStyle(visual, false)}>
            <Paragraph
              testID="veyran-assistant-preview-title"
              color={visual.primaryText}
              style={{ flex: 1 }}
            >
              {state.preview.title}
            </Paragraph>
          </View>
          <View style={rowStyle(visual, true)}>
            <Paragraph
              testID="veyran-assistant-preview-content"
              color={visual.secondaryText}
              style={{ flex: 1 }}
            >
              {readable.text}
            </Paragraph>
          </View>
          {state.preview.truncated ? (
            <View style={rowStyle(visual, true)}>
              <Paragraph color={visual.tertiaryText}>
                Die gespeicherte Notiz ist gekürzt.
              </Paragraph>
            </View>
          ) : null}
          {readable.clipped ? (
            <View style={rowStyle(visual, true)}>
              <Paragraph
                testID="veyran-assistant-preview-clipped"
                color={visual.tertiaryText}
              >
                Die Vorschau ist für die Anzeige gekürzt.
              </Paragraph>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function statusText(state: AssistantState): string {
  // A terminal host denial is always surfaced as its exact bounded reason; it
  // is never left as an indefinite "checking" state.
  if (state.blockedReason)
    return ASSISTANT_BLOCK_REASON_TEXT[state.blockedReason];
  if (state.authStarting) return "Anmeldung wird gestartet…";
  const summary = state.status;
  if (!summary) return "Status wird geprüft…";
  switch (summary.status) {
    case "ready":
      return "Verbundenes ChatGPT-Konto";
    case "authenticating":
      return "Anmeldung läuft";
    case "missingpermission":
      return "ChatGPT-Nutzung muss freigegeben werden";
    case "refreshing":
      return "Anmeldung wird erneuert";
    case "limited":
      return "Nutzung eingeschränkt";
    case "failed":
      return "Fehlgeschlagen";
    case "canceled":
      return "Abgebrochen";
    default:
      return "Nicht angemeldet";
  }
}

function cardStyle(visual: Visual): ViewStyle {
  return {
    backgroundColor: visual.contentSurface,
    borderRadius: visual.controlRadius,
    overflow: "hidden",
    marginBottom: DefaultAppStyles.GAP_VERTICAL
  };
}

function rowStyle(visual: Visual, isLast: boolean): ViewStyle {
  return {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: DefaultAppStyles.GAP,
    width: "100%",
    minHeight: 40,
    paddingLeft: 12,
    paddingRight: 12,
    paddingVertical: 8,
    ...(isLast
      ? {}
      : { borderBottomWidth: 0.5, borderBottomColor: visual.separator })
  };
}

function Header({ text, visual }: { text: string; visual: Visual }) {
  return (
    <Paragraph
      color={visual.secondaryText}
      style={{
        fontSize: 12,
        marginLeft: 4,
        marginTop: DefaultAppStyles.GAP_VERTICAL,
        marginBottom: 6,
        textTransform: "uppercase"
      }}
    >
      {text}
    </Paragraph>
  );
}

function Row({
  label,
  selected,
  isLast,
  visual,
  accent,
  onPress
}: {
  label: string;
  selected: boolean;
  isLast: boolean;
  visual: Visual;
  accent: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      noborder
      customColor="transparent"
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={rowStyle(visual, isLast)}
    >
      <Paragraph color={visual.primaryText} style={{ flex: 1 }}>
        {label}
      </Paragraph>
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          borderWidth: 1.5,
          borderColor: selected ? accent : visual.tertiaryText,
          backgroundColor: selected ? accent : "transparent"
        }}
      />
    </Pressable>
  );
}

function ActionButton({
  label,
  disabled,
  accent,
  onPress,
  testID
}: {
  label: string;
  disabled: boolean;
  accent: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      disabled={disabled}
      noborder
      customColor="transparent"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={{ paddingVertical: 6, paddingRight: 12 }}
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

export default VeyranAssistantSidebar;
