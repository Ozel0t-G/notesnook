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

// Rendered fixture for the assistant write actions.
//
// The sidebar renders with an *injected* controller and synthetic write deps,
// so no provider, database or real adapter is involved. The fixture proves the
// rendered rule: no action is available for a truncated snapshot, a stale
// context or an unauthorized account, and an explicit press performs exactly one
// write and only renders the saved state the adapter confirmed.

import React, { act } from "react";
import TestRenderer, { type ReactTestRenderer } from "react-test-renderer";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native", () => {
  const React = require("react");
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: unknown }) =>
      React.createElement(name, props, children);
  return {
    Platform: {
      OS: "ios",
      isMacCatalyst: true,
      select: (options: Record<string, unknown>) => options.ios
    },
    View: host("View"),
    ScrollView: host("ScrollView"),
    ActivityIndicator: host("ActivityIndicator"),
    TextInput: (props: Record<string, unknown>) =>
      React.createElement("TextInput", props),
    Linking: { openURL: jest.fn(async () => {}) },
    StyleSheet: { create: (styles: unknown) => styles, flatten: (s: unknown) => s }
  };
});

jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: {
      primary: { accent: "#0a84ff", background: "#fff" },
      secondary: { background: "#f2f2f7" },
      error: { paragraph: "#ff3b30" }
    },
    isDark: false
  })
}));

jest.mock("../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    secondarySurface: "#f2f2f7",
    contentSurface: "#ffffff",
    separator: "#c6c6c8",
    controlRadius: 8,
    pagePadding: 16,
    primaryText: "#000",
    secondaryText: "#3c3c43",
    tertiaryText: "#8e8e93"
  })
}));

jest.mock("../../utils/styles", () => ({
  DefaultAppStyles: { GAP: 16, GAP_VERTICAL: 10 }
}));

jest.mock("../../components/ui/pressable", () => {
  const React = require("react");
  return {
    Pressable: ({
      children,
      ...props
    }: {
      children?: unknown;
      onPress?: () => void;
    }) => React.createElement("Pressable", props, children)
  };
});

jest.mock("../../components/ui/typography/paragraph", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: ({ children, ...props }: { children?: unknown }) =>
      React.createElement("Paragraph", props, children)
  };
});

jest.mock("../../stores/use-user-store", () => ({
  useUserStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: "account-A" }, appLocked: false })
}));

jest.mock("./index", () => {
  // The fixed constants live in the pure `types` module (no React Native, no
  // provider import), so the fixture can use the real values.
  const constants = jest.requireActual("./types");
  return {
    ...constants,
    assistantController: {
      subscribe: () => () => {},
      getState: () => ({}),
      canSend: () => false,
      canSaveAsNewNote: () => false,
      canAppendToReviewedNote: () => false,
      canCreateTaskFromDraft: () => false,
      mount: () => {},
      unmount: () => {}
    },
    mountAssistantHost: () => () => {},
    onAssistantLifecycleChange: () => {}
  };
});

import { VeyranAssistantController } from "./controller";
import type { AssistantDeps } from "./types";
import type { SIWCStatusSummary } from "../veyran-siwc/types";
import { VeyranAssistantSidebar } from "../../components/veyran-assistant-sidebar";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function makeDeps(options: {
  supported: boolean;
  withNote: boolean;
  truncated?: boolean;
  summary?: SIWCStatusSummary;
  appendOutcome?: { ok: false; code: string } | { ok: true; revision: string };
}) {
  const calls = { stream: 0, read: 0, status: 0, createNote: 0, append: 0, createTask: 0 };
  const last: { append?: { noteId: string; expectedRevision: string } } = {};
  const deps: AssistantDeps = {
    isPlatformSupported: () => options.supported,
    eligibility: () => ({ eligible: true, accountId: "account-A" }),
    hostIdentity: () => ({ hostUUID: "host-1", epoch: 1 }),
    isHostIdentityCurrent: () => true,
    canInvoke: (s) =>
      !!s &&
      s.signedIn === true &&
      s.status === "ready" &&
      s.hasDirectScopes === true,
    status: async () => {
      calls.status += 1;
      return (
        options.summary ?? {
          signedIn: true,
          status: "ready",
          subject: "chatgpt-user",
          clientId: "issued-client",
          hasDirectScopes: true
        }
      );
    },
    models: async () => ({
      ok: true,
      models: [{ slug: "gpt-5", displayName: "GPT-5" }]
    }),
    stream: async () => {
      calls.stream += 1;
      return { completed: true, text: "answer" };
    },
    cancelStream: async () => {},
    beginAuth: async () => ({ started: true }),
    openVeyranSignIn: () => {},
    cancelAuth: async () => {},
    logout: async () => ({
      cleared: true,
      revocationConfirmed: false,
      noActiveConnection: true
    }),
    mobileUnavailableCopy: () => "unsupported-copy",
    currentNoteId: () => (options.withNote ? "note-1" : undefined),
    readNote: async () => {
      calls.read += 1;
      return options.withNote
        ? {
            noteId: "note-1",
            title: "Mein Titel",
            content: "<p>Exakter Inhalt</p>",
            revision: "rev-1",
            truncated: options.truncated === true
          }
        : undefined;
    },
    makeOperationId: () => "op-1",
    createNote: async () => {
      calls.createNote += 1;
      return { ok: true, noteId: "created-note", revision: "rev-created" };
    },
    appendToNote: async (_acc, noteId, _content, expectedRevision) => {
      calls.append += 1;
      last.append = { noteId, expectedRevision };
      return (
        options.appendOutcome ?? {
          ok: true,
          noteId,
          revision: "rev-appended"
        }
      );
    },
    createTask: async () => {
      calls.createTask += 1;
      return { ok: true, taskId: "created-task", revision: "rev-task" };
    }
  };
  return { deps, calls, last };
}

async function render(
  controller: VeyranAssistantController
): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <VeyranAssistantSidebar controller={controller} />
    );
  });
  return tree;
}

/** The rendered widget node for a testID (the Pressable host element). */
function widget(tree: ReactTestRenderer, testID: string) {
  const nodes = tree.root.findAll(
    (node) =>
      node.props?.testID === testID && typeof node.props?.onPress === "function"
  );
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0];
}

function isDisabled(tree: ReactTestRenderer, testID: string): boolean {
  const node = widget(tree, testID);
  return node.props.disabled === true || node.props.accessibilityState?.disabled === true;
}

async function press(
  tree: ReactTestRenderer,
  testID: string
): Promise<void> {
  const node = widget(tree, testID);
  await act(async () => {
    node.props.onPress();
    await tick();
    await tick();
  });
}

async function ready(draft: string) {
  const { deps, calls, last } = makeDeps({ supported: true, withNote: true });
  const controller = new VeyranAssistantController(deps);
  controller.mount();
  await tick();
  await controller.loadPreview();
  controller.selectModel("gpt-5");
  controller.setDraft(draft);
  return { controller, calls, last };
}

describe("VeyraN Assistant actions — rendered availability", () => {
  it("offers no action and no draft write for a truncated snapshot", async () => {
    const { deps, calls } = makeDeps({
      supported: true,
      withNote: true,
      truncated: true
    });
    const controller = new VeyranAssistantController(deps);
    controller.mount();
    await tick();
    await controller.loadPreview();
    controller.setDraft("Entwurf");
    const tree = await render(controller);

    expect(isDisabled(tree, "veyran-assistant-action-create-note")).toBe(true);
    expect(isDisabled(tree, "veyran-assistant-action-append")).toBe(true);
    expect(isDisabled(tree, "veyran-assistant-action-create-task")).toBe(true);
    await press(tree, "veyran-assistant-action-create-note");
    await press(tree, "veyran-assistant-action-append");
    await press(tree, "veyran-assistant-action-create-task");
    expect(calls.createNote).toBe(0);
    expect(calls.append).toBe(0);
    expect(calls.createTask).toBe(0);
  });

  it("offers no action while the account is unauthorized", async () => {
    const { deps, calls } = makeDeps({
      supported: true,
      withNote: true,
      summary: {
        signedIn: true,
        status: "missingpermission",
        subject: "chatgpt-user",
        clientId: "issued-client",
        hasDirectScopes: false
      }
    });
    const controller = new VeyranAssistantController(deps);
    controller.mount();
    await tick();
    controller.setDraft("Entwurf");
    const tree = await render(controller);

    expect(isDisabled(tree, "veyran-assistant-action-create-note")).toBe(true);
    expect(isDisabled(tree, "veyran-assistant-action-append")).toBe(true);
    expect(isDisabled(tree, "veyran-assistant-action-create-task")).toBe(true);
    await press(tree, "veyran-assistant-action-create-note");
    expect(calls.createNote).toBe(0);
  });

  it("enables the actions only once a complete snapshot and draft are ready", async () => {
    const { controller, calls } = await ready("Entwurf");
    const tree = await render(controller);
    expect(isDisabled(tree, "veyran-assistant-action-create-note")).toBe(false);
    expect(isDisabled(tree, "veyran-assistant-action-append")).toBe(false);
    expect(isDisabled(tree, "veyran-assistant-action-create-task")).toBe(false);
    expect(calls.stream).toBe(0);

    // An explicit press performs exactly one write and renders the truthful
    // saved state the adapter confirmed.
    await press(tree, "veyran-assistant-action-create-note");
    expect(calls.createNote).toBe(1);
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("Neue Notiz gespeichert.");
  });

  it("append passes the exact reviewed note id and revision", async () => {
    const { controller, last } = await ready("Anhang");
    const tree = await render(controller);
    await press(tree, "veyran-assistant-action-append");
    expect(last.append).toEqual({ noteId: "note-1", expectedRevision: "rev-1" });
    expect(JSON.stringify(tree.toJSON())).toContain("An die Notiz angehängt.");
  });

  it("renders the truthful conflict error and keeps the draft", async () => {
    const { deps } = makeDeps({
      supported: true,
      withNote: true,
      appendOutcome: { ok: false, code: "REVISION_CONFLICT" }
    });
    const controller = new VeyranAssistantController(deps);
    controller.mount();
    await tick();
    await controller.loadPreview();
    controller.selectModel("gpt-5");
    controller.setDraft("Anhang");
    const tree = await render(controller);
    await press(tree, "veyran-assistant-action-append");

    const json = JSON.stringify(tree.toJSON());
    expect(json.toLowerCase()).toContain("entwurf bleibt erhalten");
    expect(json).not.toContain("Neue Notiz gespeichert.");
    expect(json).not.toContain("An die Notiz angehängt.");
    expect(controller.getState().draft).toBe("Anhang");
  });

  it("shows the task confirmation for a real Task record write", async () => {
    const { controller, calls } = await ready("Aufgabe");
    const tree = await render(controller);
    await press(tree, "veyran-assistant-action-create-task");
    expect(calls.createTask).toBe(1);
    expect(JSON.stringify(tree.toJSON())).toContain("Task erstellt.");
  });
});
