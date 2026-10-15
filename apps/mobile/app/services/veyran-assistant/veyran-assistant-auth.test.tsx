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

// Regression fixture for the assistant's *provider sign-in* seam and its
// blocked-host UI. Every dependency is injected (no provider, no navigation, no
// database) and the sidebar renders with the injected controller, so the real
// headless rules run: one flow per press, a bounded static failed-start outcome,
// stale attempts dropped, and a blocked host that offers only the ordinary,
// non-destructive VeyraN sign-in (never a sign-out/reset).

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
    Pressable: ({ children, ...props }: { children?: unknown }) =>
      React.createElement("Pressable", props, children)
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
import { assistantLifecycleChanged, type AssistantLifecycleSnapshot } from "./helpers";
import {
  ASSISTANT_BLOCKED_RECOVERY_NOTE,
  ASSISTANT_BLOCK_REASON_TEXT,
  offersVeyranSignIn,
  type AssistantDeps
} from "./types";
import type { SIWCStatusSummary } from "../veyran-siwc/types";
import type { SIWCBeginAuthError, SIWCHostBlockReason } from "../veyran-siwc/types";
import { VeyranAssistantSidebar } from "../../components/veyran-assistant-sidebar";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeAuthHarness() {
  const calls = {
    status: 0,
    models: 0,
    stream: 0,
    read: 0,
    cancelStream: 0,
    beginAuth: 0,
    cancelAuth: 0,
    logout: 0,
    openVeyranSignIn: 0
  };
  const gates: { beginAuth?: Promise<void>; cancelAuth?: Promise<void> } = {};
  let eligible = true;
  let accountId: string | null = "account-A";
  let reason: SIWCHostBlockReason | undefined;
  let beginAuthResult: { started: boolean; error?: SIWCBeginAuthError } = {
    started: true
  };
  let beginAuthReject: unknown;
  let summary: SIWCStatusSummary = {
    signedIn: true,
    status: "ready",
    subject: "chatgpt-user",
    clientId: "issued-client",
    hasDirectScopes: true
  };
  const modes: string[] = [];

  const deps: AssistantDeps = {
    isPlatformSupported: () => true,
    eligibility: () => {
      return eligible
        ? { eligible: true, accountId }
        : { eligible: false, accountId: null, reason };
    },
    hostIdentity: () => ({ hostUUID: "host-1", epoch: 1 }),
    isHostIdentityCurrent: () => true,
    canInvoke: (s) =>
      !!s && s.signedIn === true && s.status === "ready" && s.hasDirectScopes === true,
    status: async () => {
      calls.status += 1;
      return { ...summary };
    },
    models: async () => {
      calls.models += 1;
      return { ok: true, models: [{ slug: "gpt-5", displayName: "GPT-5" }] };
    },
    stream: async () => {
      calls.stream += 1;
      return { completed: true, text: "answer" };
    },
    cancelStream: async () => {
      calls.cancelStream += 1;
    },
    beginAuth: async (mode) => {
      calls.beginAuth += 1;
      modes.push(mode);
      if (gates.beginAuth) await gates.beginAuth;
      if (beginAuthReject) throw beginAuthReject;
      return { ...beginAuthResult };
    },
    cancelAuth: async () => {
      calls.cancelAuth += 1;
      if (gates.cancelAuth) await gates.cancelAuth;
    },
    openVeyranSignIn: () => {
      calls.openVeyranSignIn += 1;
    },
    logout: async () => {
      calls.logout += 1;
      return {
        cleared: true,
        revocationConfirmed: false,
        noActiveConnection: true
      };
    },
    makeOperationId: () => "op-1",
    createNote: async () => ({ ok: false, code: "NOT_AUTHORIZED" }),
    appendToNote: async () => ({ ok: false, code: "NOT_AUTHORIZED" }),
    createTask: async () => ({ ok: false, code: "NOT_AUTHORIZED" }),
    mobileUnavailableCopy: () => "unsupported-copy",
    currentNoteId: () => "note-1",
    readNote: async () => {
      calls.read += 1;
      return {
        noteId: "note-1",
        title: "Titel",
        content: "<p>Inhalt</p>",
        revision: "rev-1",
        truncated: false
      };
    }
  };

  return {
    deps,
    calls,
    gates,
    modes,
    setEligible: (value: boolean, blockReason?: SIWCHostBlockReason) => {
      eligible = value;
      reason = blockReason;
    },
    setAccount: (value: string | null) => (accountId = value),
    setSummary: (value: SIWCStatusSummary) => (summary = value),
    setBeginAuthResult: (value: { started: boolean; error?: SIWCBeginAuthError }) =>
      (beginAuthResult = value),
    setBeginAuthReject: (value: unknown) => (beginAuthReject = value)
  };
}

async function render(controller: VeyranAssistantController) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<VeyranAssistantSidebar controller={controller} />);
  });
  await act(async () => {
    await tick();
  });
  return tree;
}

describe("VeyraN Assistant provider sign-in — controller rules", () => {
  it("starts exactly one flow for two presses while a start is pending", async () => {
    const h = makeAuthHarness();
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    const gate = deferred();
    h.gates.beginAuth = gate.promise;
    const first = controller.beginAuth("returning");
    const second = controller.beginAuth("returning");
    expect(h.calls.beginAuth).toBe(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(h.calls.beginAuth).toBe(1);
    expect(h.modes).toEqual(["returning"]);
    expect(controller.getState().status?.status).toBe("authenticating");
  });

  it("surfaces a bounded static failed-start outcome for a resolved false", async () => {
    const h = makeAuthHarness();
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    h.setBeginAuthResult({ started: false, error: "host_blocked" });
    await controller.beginAuth("returning");
    expect(controller.getState().error?.code).toBe("host_blocked");
    expect(controller.getState().status?.status).not.toBe("authenticating");

    h.setBeginAuthResult({ started: false });
    await controller.beginAuth("fresh");
    expect(controller.getState().error?.code).toBe("start_failed");
  });

  it("surfaces a bounded static error for an injected rejection without raw text", async () => {
    const h = makeAuthHarness();
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    h.setBeginAuthReject(new Error("token=SECRET provider body"));
    await controller.beginAuth("returning");
    const error = controller.getState().error;
    expect(error?.code).toBe("start_failed");
    expect(JSON.stringify(controller.getState())).not.toContain("SECRET");
    expect(controller.getState().status?.status).not.toBe("authenticating");
  });

  it("answers a blocked host with the truthful reason and zero provider work", async () => {
    const h = makeAuthHarness();
    h.setEligible(false, "setup_required");
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    await controller.beginAuth("returning");
    expect(h.calls.beginAuth).toBe(0);
    expect(h.calls.logout).toBe(0);
    expect(controller.getState().blockedReason).toBe("setup_required");
  });

  it("clamps an unexpected failed-start code before showing it", async () => {
    const h = makeAuthHarness();
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    h.setBeginAuthResult({
      started: false,
      error: "token=SECRET" as SIWCBeginAuthError
    });
    await controller.beginAuth();
    expect(controller.getState().error?.code).toBe("start_failed");
    expect(JSON.stringify(controller.getState())).not.toContain("SECRET");
  });

  it("only cancels existing streams while the host is blocked", async () => {
    for (const reason of [
      "db_uninitialized", "app_loading", "app_locked", "logging_out",
      "setup_required", "no_account", "unknown"
    ] as SIWCHostBlockReason[]) {
      const h = makeAuthHarness();
      h.setEligible(false, reason);
      const controller = new VeyranAssistantController(h.deps);
      controller.mount();
      await tick();
      await controller.beginAuth();
      await tick();
      expect(h.calls.cancelStream).toBeGreaterThan(0);
      expect(h.calls.status).toBe(0);
      expect(h.calls.models).toBe(0);
      expect(h.calls.stream).toBe(0);
      expect(h.calls.read).toBe(0);
      expect(h.calls.beginAuth).toBe(0);
      expect(h.calls.logout).toBe(0);
      controller.unmount();
    }
  });

  it("drops a late start after an explicit cancel and releases the guard", async () => {
    const h = makeAuthHarness();
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    const gate = deferred();
    h.gates.beginAuth = gate.promise;
    const pending = controller.beginAuth("returning");
    expect(h.calls.beginAuth).toBe(1);
    await controller.cancelAuth();
    expect(h.calls.cancelAuth).toBe(1);
    gate.resolve();
    await pending;
    // The canceled attempt must never show "Anmeldung läuft".
    expect(controller.getState().status?.status).not.toBe("authenticating");
    // The single-flight guard was released for the next explicit press.
    h.gates.beginAuth = undefined;
    await controller.beginAuth("fresh");
    expect(h.calls.beginAuth).toBe(2);
    expect(controller.getState().status?.status).toBe("authenticating");
  });

  it("keeps the newer start guarded when an older canceled start finishes", async () => {
    const h = makeAuthHarness();
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    const oldGate = deferred();
    h.gates.beginAuth = oldGate.promise;
    const oldStart = controller.beginAuth();
    await controller.cancelAuth();
    const newGate = deferred();
    h.gates.beginAuth = newGate.promise;
    const newStart = controller.beginAuth("fresh");
    expect(h.calls.beginAuth).toBe(2);
    oldGate.resolve();
    await oldStart;
    expect(controller.getState().authStarting).toBe(true);
    await controller.beginAuth();
    expect(h.calls.beginAuth).toBe(2);
    newGate.resolve();
    await newStart;
    expect(controller.getState().status?.status).toBe("authenticating");
    expect(controller.getState().authStarting).toBe(false);
  });

  it("waits for the global native cancel before starting the next flow", async () => {
    const h = makeAuthHarness();
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    const oldGate = deferred();
    h.gates.beginAuth = oldGate.promise;
    const oldStart = controller.beginAuth();
    const cancelGate = deferred();
    h.gates.cancelAuth = cancelGate.promise;
    const cancel = controller.cancelAuth();
    await tick();
    h.gates.beginAuth = undefined;
    const next = controller.beginAuth("fresh");
    await tick();
    expect(h.calls.beginAuth).toBe(1);
    expect(controller.getState().authStarting).toBe(true);
    cancelGate.resolve();
    await Promise.all([cancel, next]);
    expect(h.calls.beginAuth).toBe(2);
    oldGate.resolve();
    await oldStart;
    expect(controller.getState().status?.status).toBe("authenticating");
  });

  it("revalidates a recovery click if the app locks after rendering", async () => {
    const h = makeAuthHarness();
    h.setEligible(false, "setup_required");
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    h.setEligible(false, "app_locked");
    controller.openVeyranSignIn();
    expect(h.calls.openVeyranSignIn).toBe(0);
    expect(controller.getState().blockedReason).toBe("app_locked");
    expect(h.calls.beginAuth).toBe(0);
    expect(h.calls.logout).toBe(0);
  });

  it("refreshes a stale recovery control after account setup has finished", async () => {
    const h = makeAuthHarness();
    h.setEligible(false, "setup_required");
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    h.setEligible(true);
    controller.openVeyranSignIn();
    await tick();
    expect(h.calls.openVeyranSignIn).toBe(0);
    expect(h.calls.logout).toBe(0);
    expect(controller.getState().blockedReason).toBeUndefined();
    expect(controller.getState().status?.status).toBe("ready");
  });

  it("drops a late start after a lifecycle seam", async () => {
    const h = makeAuthHarness();
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    const gate = deferred();
    h.gates.beginAuth = gate.promise;
    const pending = controller.beginAuth("returning");
    controller.onLifecycleChange();
    gate.resolve();
    await pending;
    expect(controller.getState().status?.status).not.toBe("authenticating");
  });

  it("re-reads status on the account-setup true -> false transition", async () => {
    const h = makeAuthHarness();
    h.setEligible(false, "setup_required");
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    expect(controller.getState().blockedReason).toBe("setup_required");
    expect(controller.getState().status).toBeUndefined();

    // Setup completes: the host becomes eligible again without a restart.
    h.setEligible(true);
    const before = h.calls.status;
    controller.onLifecycleChange();
    await tick();
    expect(h.calls.status).toBeGreaterThan(before);
    expect(controller.getState().blockedReason).toBeUndefined();
    expect(controller.getState().status?.status).toBe("ready");
  });

  it("ends the pending state after an expired browser login without signing out", async () => {
    const h = makeAuthHarness();
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    await controller.beginAuth();
    controller.onAuthEvent({ type: "authError", code: "flow_expired" });
    expect(controller.getState().status?.status).toBe("failed");
    expect(controller.getState().error?.code).toBe("flow_expired");
    expect(controller.getState().authStarting).toBe(false);
    expect(h.calls.logout).toBe(0);
  });

  it("redacts unknown native auth-event errors", async () => {
    const h = makeAuthHarness();
    const controller = new VeyranAssistantController(h.deps);
    controller.mount();
    await tick();
    controller.onAuthEvent({ type: "authError", code: "token=SECRET" });
    expect(controller.getState().status?.status).toBe("failed");
    expect(controller.getState().error?.code).toBe("start_failed");
    expect(JSON.stringify(controller.getState())).not.toContain("SECRET");
  });
});

describe("VeyraN Assistant — blocked UI and VeyraN recovery action", () => {
  it("offers the ordinary sign-in for a local-account block with no logout/reset", async () => {
    const h = makeAuthHarness();
    h.setEligible(false, "setup_required");
    const controller = new VeyranAssistantController(h.deps);
    const tree = await render(controller);

    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain(ASSISTANT_BLOCK_REASON_TEXT["setup_required"]);
    // The recovery note is present and promises nothing.
    expect(json).toContain(ASSISTANT_BLOCKED_RECOVERY_NOTE);
    expect(ASSISTANT_BLOCKED_RECOVERY_NOTE.toLowerCase()).not.toContain("garantiert");
    expect(ASSISTANT_BLOCKED_RECOVERY_NOTE.toLowerCase()).not.toContain("erfolgreich");

    // Provider auth controls are rendered disabled (never enabled and inert).
    expect(
      tree.root.findByProps({ testID: "veyran-assistant-provider-signin" }).props.disabled
    ).toBe(true);
    expect(
      tree.root.findByProps({ testID: "veyran-assistant-provider-refresh" }).props.disabled
    ).toBe(true);

    const recovery = tree.root.findByProps({
      testID: "veyran-assistant-standard-signin"
    });
    expect(recovery.props.disabled).toBe(false);
    await act(async () => {
      recovery.props.onPress();
    });
    expect(h.calls.openVeyranSignIn).toBe(1);
    // Zero provider/login work and zero destructive work.
    expect(h.calls.beginAuth).toBe(0);
    expect(h.calls.logout).toBe(0);
    expect(h.calls.cancelAuth).toBe(0);
    expect(h.calls.stream).toBe(0);

    act(() => tree.unmount());
  });

  it("shows the truthful reason for every blocked state", async () => {
    const reasons: Array<SIWCHostBlockReason | "unsupported_platform"> = [
      "db_uninitialized",
      "app_loading",
      "app_locked",
      "logging_out",
      "setup_required",
      "no_account",
      "unknown"
    ];
    for (const reason of reasons) {
      const h = makeAuthHarness();
      h.setEligible(false, reason as SIWCHostBlockReason);
      const controller = new VeyranAssistantController(h.deps);
      const tree = await render(controller);
      const json = JSON.stringify(tree.toJSON());
      expect(json).toContain(ASSISTANT_BLOCK_REASON_TEXT[reason]);
      act(() => tree.unmount());
    }
  });

  it("offers no VeyraN sign-in action for lock/loading/logout/unknown/db blocks", async () => {
    for (const reason of [
      "db_uninitialized",
      "app_loading",
      "app_locked",
      "logging_out",
      "unknown"
    ] as SIWCHostBlockReason[]) {
      expect(offersVeyranSignIn(reason)).toBe(false);
      const h = makeAuthHarness();
      h.setEligible(false, reason);
      const controller = new VeyranAssistantController(h.deps);
      const tree = await render(controller);
      expect(
        tree.root.findAllByProps({ testID: "veyran-assistant-standard-signin" }).length
      ).toBe(0);
      expect(
        tree.root.findAllByProps({
          testID: "veyran-assistant-blocked-recovery-note"
        }).length
      ).toBe(0);
      expect(h.calls.openVeyranSignIn).toBe(0);
      act(() => tree.unmount());
    }
    expect(offersVeyranSignIn("setup_required")).toBe(true);
    expect(offersVeyranSignIn("no_account")).toBe(true);
    expect(offersVeyranSignIn(undefined)).toBe(false);
  });
});

describe("VeyraN Assistant — lifecycle edge predicate", () => {
  const base: AssistantLifecycleSnapshot = {
    accountId: "account-A",
    appLocked: false,
    isLoggingOut: false,
    accountSetupRequired: false
  };

  it("treats account setup true -> false as a real seam and false -> false as none", () => {
    expect(
      assistantLifecycleChanged(base, { ...base, accountSetupRequired: true })
    ).toBe(true);
    expect(
      assistantLifecycleChanged(
        { ...base, accountSetupRequired: true },
        { ...base, accountSetupRequired: false }
      )
    ).toBe(true);
    expect(
      assistantLifecycleChanged(
        { ...base, accountSetupRequired: false },
        { ...base, accountSetupRequired: false }
      )
    ).toBe(false);
    expect(assistantLifecycleChanged(base, base)).toBe(false);
  });

  it("treats account, lock, logout and unlock edges as seams", () => {
    expect(assistantLifecycleChanged(base, { ...base, accountId: "account-B" })).toBe(true);
    expect(assistantLifecycleChanged(base, { ...base, accountId: null })).toBe(true);
    expect(assistantLifecycleChanged(base, { ...base, appLocked: true })).toBe(true);
    expect(
      assistantLifecycleChanged({ ...base, appLocked: true }, { ...base, appLocked: false })
    ).toBe(true);
    expect(assistantLifecycleChanged(base, { ...base, isLoggingOut: true })).toBe(true);
    expect(
      assistantLifecycleChanged(
        { ...base, isLoggingOut: true },
        { ...base, isLoggingOut: false }
      )
    ).toBe(false);
  });
});
