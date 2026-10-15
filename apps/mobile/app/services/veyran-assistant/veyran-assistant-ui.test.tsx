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

// Rendered React Native fixture for the assistant sidebar.
//
// The sidebar is rendered with an *injected* controller (a synthetic transport
// and a synthetic note), so no provider traffic, no real SIWC module and no
// database are involved. The fixture proves the sidebar: (a) shows only the
// informational state — reading nothing — on an unsupported platform, and
// (b) renders the exact saved-note snapshot and the credits notice once ready,
// without starting a stream.

import React, { act } from "react";
import TestRenderer, { type ReactTestRenderer } from "react-test-renderer";

// React 19 requires the act environment flag to be set explicitly for
// `await act(async () => ...)` around a test renderer.
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
      mount: () => {},
      unmount: () => {}
    },
    mountAssistantHost: () => () => {},
    onAssistantLifecycleChange: () => {}
  };
});

import { VeyranAssistantController } from "./controller";
import type { AssistantDeps, AssistantModelCatalog } from "./types";
import { VeyranAssistantSidebar } from "../../components/veyran-assistant-sidebar";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function makeDeps(options: {
  supported: boolean;
  withNote: boolean;
  truncated?: boolean;
  /** The exact saved-note HTML body the snapshot returns. */
  content?: string;
  /**
   * The catalog outcome (or a deferred producer for it). A function lets a test
   * gate/supersede a read; the default is one usable model.
   */
  models?: AssistantModelCatalog | (() => Promise<AssistantModelCatalog>);
}) {
  const calls = { stream: 0, read: 0, status: 0, noteId: 0, models: 0 };
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
      return {
        signedIn: true,
        status: "ready",
        subject: "chatgpt-user",
        clientId: "issued-client",
        hasDirectScopes: true
      };
    },
    models: async () => {
      calls.models += 1;
      const value = options.models;
      if (typeof value === "function") return value();
      return (
        value ?? {
          ok: true,
          models: [{ slug: "gpt-5", displayName: "GPT-5" }]
        }
      );
    },
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
    makeOperationId: () => "op-1",
    createNote: async () => ({ ok: false, code: "NOT_AUTHORIZED" }),
    appendToNote: async () => ({ ok: false, code: "NOT_AUTHORIZED" }),
    createTask: async () => ({ ok: false, code: "NOT_AUTHORIZED" }),
    mobileUnavailableCopy: () => "unsupported-copy",
    currentNoteId: () => {
      calls.noteId += 1;
      return options.withNote ? "note-1" : undefined;
    },
    readNote: async () => {
      calls.read += 1;
      return options.withNote
        ? {
            noteId: "note-1",
            title: "Mein Titel",
            content: options.content ?? "<p>Exakter Inhalt</p>",
            revision: "rev-1",
            truncated: options.truncated === true
          }
        : undefined;
    }
  };
  return { deps, calls };
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
  await act(async () => {
    await tick();
  });
  return tree;
}

describe("VeyraN Assistant sidebar — rendered fixture", () => {
  it("shows only the informational state and reads nothing when unsupported", async () => {
    const { deps, calls } = makeDeps({ supported: false, withNote: false });
    const controller = new VeyranAssistantController(deps);
    const tree = await render(controller);
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("unsupported-copy");
    expect(calls.status).toBe(0);
    expect(calls.read).toBe(0);
    expect(calls.noteId).toBe(0);
    expect(calls.stream).toBe(0);
  });

  it("renders the exact saved snapshot and credits notice without a stream", async () => {
    const { deps, calls } = makeDeps({ supported: true, withNote: true });
    const controller = new VeyranAssistantController(deps);
    // Drive the read/preview exactly as an explicit user action would.
    controller.mount();
    await tick();
    await controller.loadPreview();
    controller.selectModel("gpt-5");

    const tree = await render(controller);
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("Mein Titel");
    // The saved Tiptap HTML is rendered only as plain, readable text — never as
    // raw markup (the exact `content` string is what the model receives).
    expect(json).toContain("Exakter Inhalt");
    expect(json).not.toContain("<p>");
    expect(json).not.toContain("</p>");
    expect(json).toContain("Reine Abo-Nutzung ist nicht garantiert.");
    expect(json).toContain("https://chatgpt.com/settings/usage");
    // Rendering never starts inference.
    expect(calls.stream).toBe(0);
  });

  it("disables Send and shows the truncated notice for a partial snapshot", async () => {
    const { deps, calls } = makeDeps({
      supported: true,
      withNote: true,
      truncated: true
    });
    const controller = new VeyranAssistantController(deps);
    controller.mount();
    await tick();
    await controller.loadPreview();
    controller.selectModel("gpt-5");
    // A partial snapshot is never sendable.
    expect(controller.canSend()).toBe(false);

    const tree = await render(controller);
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("Die gespeicherte Notiz ist gekürzt.");
    expect(json).toContain('"disabled":true');
    expect(calls.stream).toBe(0);
  });

  it("renders the loading state and denies Send while the catalog read is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { deps, calls } = makeDeps({
      supported: true,
      withNote: true,
      models: () =>
        gate.then(
          (): AssistantModelCatalog => ({
            ok: true,
            models: [{ slug: "gpt-5", displayName: "GPT-5" }]
          })
        )
    });
    const controller = new VeyranAssistantController(deps);
    controller.mount();
    await tick();
    // The status has settled but the catalog read is still gated.
    expect(controller.getState().modelsLoading).toBe(true);
    await controller.loadPreview();
    expect(controller.canSend()).toBe(false);

    const tree = await render(controller);
    let json = JSON.stringify(tree.toJSON());
    expect(json).toContain("veyran-assistant-models-loading");
    expect(json).toContain("Modelle werden geladen");
    expect(json).not.toContain("veyran-assistant-models-error");

    await act(async () => {
      release();
      await tick();
      await tick();
    });
    json = JSON.stringify(tree.toJSON());
    expect(json).not.toContain("veyran-assistant-models-loading");
    expect(calls.models).toBeGreaterThanOrEqual(1);
    // With the catalog settled and a model selected, Send becomes available
    // again without ever having started a stream.
    await act(async () => {
      controller.selectModel("gpt-5");
      await tick();
    });
    expect(controller.canSend()).toBe(true);
    expect(calls.stream).toBe(0);
  });

  it("distinguishes an empty catalog from a failure and offers an actionable reload", async () => {
    let outcome: AssistantModelCatalog = { ok: true, models: [] };
    const { deps, calls } = makeDeps({
      supported: true,
      withNote: true,
      models: () => Promise.resolve(outcome)
    });
    const controller = new VeyranAssistantController(deps);
    controller.mount();
    await tick();
    const tree = await render(controller);

    let json = JSON.stringify(tree.toJSON());
    // An authenticated empty catalog is a truthful empty state, never an error.
    expect(json).toContain("veyran-assistant-models-empty");
    expect(json).toContain("Kein Modell-Katalog");
    expect(json).not.toContain("veyran-assistant-models-error");

    // A failed read surfaces only the bounded static notice (never the raw
    // injected message) and keeps the explicit reload control.
    outcome = {
      ok: false,
      error: {
        code: "catalog_unavailable",
        message: "RAW-LEAK-Bearer-999",
        retryable: true
      }
    };
    await act(async () => {
      await controller.reloadModels();
      await tick();
    });
    json = JSON.stringify(tree.toJSON());
    expect(json).toContain("veyran-assistant-models-error");
    expect(json).toContain("Der Modell-Katalog konnte nicht geladen werden");
    expect(json).not.toContain("RAW-LEAK-Bearer-999");
    expect(json).toContain("veyran-assistant-models-reload");

    // The reload is actionable: it re-reads and clears the failure.
    outcome = {
      ok: true,
      models: [{ slug: "gpt-5", displayName: "GPT-5" }]
    };
    await act(async () => {
      await controller.reloadModels();
      await tick();
    });
    json = JSON.stringify(tree.toJSON());
    expect(json).not.toContain("veyran-assistant-models-error");
    expect(json).toContain("GPT-5");
    // One catalog read at mount, at least one from the explicit reloads.
    expect(calls.models).toBeGreaterThanOrEqual(3);
    expect(calls.stream).toBe(0);
  });

  it("preserves the reviewed draft and preview across a metadata failure", async () => {
    let outcome: AssistantModelCatalog = {
      ok: true,
      models: [{ slug: "gpt-5", displayName: "GPT-5" }]
    };
    const { deps } = makeDeps({
      supported: true,
      withNote: true,
      models: () => Promise.resolve(outcome)
    });
    const controller = new VeyranAssistantController(deps);
    controller.mount();
    await tick();
    await controller.loadPreview();
    controller.selectModel("gpt-5");
    controller.setDraft("Mein Entwurf");

    outcome = {
      ok: false,
      error: {
        code: "usage_unavailable",
        message: "RAW-SECRET-999",
        retryable: true
      }
    };
    await controller.reloadModels();
    expect(controller.getState().modelsError?.code).toBe("usage_unavailable");
    // The RAM-only draft and the exact reviewed preview survive.
    expect(controller.getState().draft).toBe("Mein Entwurf");
    expect(controller.getState().preview?.title).toBe("Mein Titel");
    // A failed catalog blocks inference until it is reloaded successfully.
    expect(controller.canSend()).toBe(false);

    const tree = await render(controller);
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("Mein Entwurf");
    expect(json).toContain("Mein Titel");
    expect(json).toContain("Die ChatGPT-Nutzung ist vorübergehend nicht verfügbar");
    expect(json).not.toContain("RAW-SECRET-999");
  });

  it("renders exact saved HTML as plain text and flags display clipping", async () => {
    const rawContent = "<p>" + "a".repeat(25_000) + "</p>";
    const { deps } = makeDeps({
      supported: true,
      withNote: true,
      content: rawContent
    });
    const controller = new VeyranAssistantController(deps);
    controller.mount();
    await tick();
    await controller.loadPreview();
    controller.selectModel("gpt-5");

    const tree = await render(controller);
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("veyran-assistant-preview-clipped");
    expect(json).toContain("Die Vorschau ist");
    // No raw markup is rendered, and the exact raw `content` stays untouched in
    // controller state — it is what the model receives as bounded data.
    expect(json).not.toContain("<p>");
    expect(controller.getState().preview?.content).toBe(rawContent);
  });
});
