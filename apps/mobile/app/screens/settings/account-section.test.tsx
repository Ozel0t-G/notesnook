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

import React from "react";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import type { User } from "@notesnook/core";

let mockSessionExpired = false;
let mockAccountSetupRequired = false;
let mockUser: Partial<User> | null = null;
const mockStrings: Record<string, string> = {
  account: "Account",
  veyranAccount: "VeyraN Account",
  veyranAccountSession: "Signed in to VeyraN",
  signOut: "Sign out",
  signOutLocalDataWarning: "Signing out removes local data",
  signInToVeyran: "Sign in to VeyraN",
  signInToVeyranDesc: "Restore encrypted notes with VeyraN",
  sessionExpired: "Session expired",
  reloginToYourAccount: "Sign in again",
  data: "Data",
  deleteLocalData: "Delete local data",
  deleteLocalDataDesc: "Deletes local notes only; back up unsynced changes",
  accountSetupNeedsAttention: "Account setup needs attention",
  accountSetupIncomplete: "Sign in again to finish setup"
};

jest.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: (_, key) => () => mockStrings[String(key)] })
}));
jest.mock("../../stores/use-user-store", () => ({
  useUserStore: (selector: (state: unknown) => unknown) =>
    selector({ user: mockUser, accountSetupRequired: mockAccountSetupRequired })
}));
jest.mock("../../stores/use-setting-store", () => ({
  useSettingStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { sessionExpired: mockSessionExpired } })
}));
jest.mock("react-native", () => ({ View: "View" }));
jest.mock("@notesnook/theme", () => ({
  useThemeColors: () => ({
    colors: { primary: { accent: "blue" } },
    isDark: false
  })
}));
jest.mock("../../components/ui/typography/heading", () => ({
  __esModule: true,
  default: "Heading"
}));
jest.mock("../../utils/size", () => ({ AppFontSize: { xs: 12 } }));
jest.mock("../../utils/styles", () => ({ DefaultAppStyles: { GAP: 12 } }));
jest.mock("../../utils/apple-visual-tokens", () => ({
  getAppleVisualTokens: () => ({
    ios: true,
    sectionSpacing: 20,
    rowPadding: 12
  })
}));
jest.mock("./section-item", () => ({
  SectionItem: ({
    item
  }: {
    item: {
      id: string;
      name: string | ((current: unknown) => string);
      description?: string | ((current: unknown) => string);
      useHook?: () => unknown;
      modifer?: () => void;
    };
  }) => {
    const current = item.useHook?.();
    return React.createElement("SettingRow", {
      testID: item.id,
      name: typeof item.name === "function" ? item.name(current) : item.name,
      description:
        typeof item.description === "function"
          ? item.description(current)
          : item.description,
      sessionState: item.id === "veyran-account-session" ? current : undefined,
      onPress: item.modifer
    });
  }
}));

import {
  createAccountSection,
  createLocalDataSection,
  createSignedOutAccountSection
} from "./account-section";
import { SectionGroup } from "./section-group";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("VeyraN Account Settings rendering", () => {
  let tree: ReactTestRenderer;
  beforeEach(() => {
    mockUser = null;
    mockSessionExpired = false;
    mockAccountSetupRequired = false;
  });
  afterEach(() => {
    if (tree) act(() => tree.unmount());
  });

  it("shows signed-in identity and top-level sign out without subscription metadata", async () => {
    mockUser = { id: "account-one", email: "qa@example.test" };
    const signOut = jest.fn(async () => true);
    const section = createAccountSection(
      [{ id: "sync-settings", name: "Sync Settings" }],
      signOut
    );
    act(() => {
      tree = create(<SectionGroup item={section} />);
    });
    const rows = tree.root.findAllByType("SettingRow" as never);
    expect(rows.map((row) => row.props.testID)).toEqual([
      "veyran-account-identity",
      "veyran-account-session",
      "sync-settings",
      "logout"
    ]);
    expect(rows[0].props).toMatchObject({
      name: "VeyraN Account",
      description: "qa@example.test"
    });
    expect(rows[1].props.name).toBe("Signed in to VeyraN");
    await rows[3].props.onPress();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(section.featureId).toBeUndefined();
  });

  it("keeps a useful ACCOUNT sign-in action visible for a local profile", () => {
    const signIn = jest.fn();
    act(() => {
      tree = create(
        <SectionGroup item={createSignedOutAccountSection(signIn)} />
      );
    });
    const row = tree.root.findByType("SettingRow" as never);
    expect(row.props).toMatchObject({
      testID: "veyran-sign-in",
      name: "Sign in to VeyraN"
    });
    row.props.onPress();
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("retains the session snapshot through unrelated renders and updates either status flag", () => {
    mockUser = { id: "retained-account" };
    const section = createAccountSection([], async () => true);
    const render = (parentVersion: number) => (
      <React.Fragment>
        <SectionGroup item={section} />
        {React.createElement("UnrelatedParentValue", {
          version: parentVersion
        })}
      </React.Fragment>
    );
    act(() => {
      tree = create(render(0));
    });
    const sessionRow = () =>
      tree.root.findByProps({ testID: "veyran-account-session" });
    const initial = sessionRow().props.sessionState;
    expect(initial).toEqual({ expired: false, setupRequired: false });
    expect(sessionRow().props.name).toBe("Signed in to VeyraN");

    act(() => {
      tree.update(render(1));
    });
    expect(sessionRow().props.sessionState).toBe(initial);

    mockSessionExpired = true;
    act(() => {
      tree.update(render(2));
    });
    const expired = sessionRow().props.sessionState;
    expect(expired).not.toBe(initial);
    expect(expired).toEqual({ expired: true, setupRequired: false });
    expect(sessionRow().props).toMatchObject({
      name: "Session expired",
      description: "Sign in again"
    });
    act(() => {
      tree.update(render(3));
    });
    expect(sessionRow().props.sessionState).toBe(expired);

    mockAccountSetupRequired = true;
    act(() => {
      tree.update(render(4));
    });
    const incomplete = sessionRow().props.sessionState;
    expect(incomplete).not.toBe(expired);
    expect(incomplete).toEqual({ expired: true, setupRequired: true });
    expect(sessionRow().props).toMatchObject({
      name: "Account setup needs attention",
      description: "Sign in again to finish setup"
    });
    act(() => {
      tree.update(render(5));
    });
    expect(sessionRow().props.sessionState).toBe(incomplete);

    mockSessionExpired = false;
    mockAccountSetupRequired = false;
    act(() => {
      tree.update(render(6));
    });
    expect(sessionRow().props.sessionState).not.toBe(incomplete);
    expect(sessionRow().props.sessionState).toEqual({
      expired: false,
      setupRequired: false
    });
    expect(sessionRow().props.name).toBe("Signed in to VeyraN");
  });

  it("updates visibility and identity when account state hydrates or signs out", () => {
    const section = createAccountSection([], async () => true);
    act(() => {
      tree = create(<SectionGroup item={section} />);
    });
    expect(tree.toJSON()).toBeNull();
    mockUser = { id: "account-two", email: "second@example.test" };
    act(() => {
      tree.update(<SectionGroup item={section} />);
    });
    expect(
      tree.root.findAllByType("SettingRow" as never)[0].props.description
    ).toBe("second@example.test");
    mockUser = null;
    act(() => {
      tree.update(<SectionGroup item={section} />);
    });
    expect(tree.toJSON()).toBeNull();
  });

  it("makes an expired cached session understandable without hiding the account identity", () => {
    mockUser = { id: "expired-account", email: "expired@example.test" };
    mockSessionExpired = true;
    act(() => {
      tree = create(
        <SectionGroup item={createAccountSection([], async () => true)} />
      );
    });
    const rows = tree.root.findAllByType("SettingRow" as never);
    expect(rows[0].props.description).toBe("expired@example.test");
    expect(rows[1].props).toMatchObject({
      name: "Session expired",
      description: "Sign in again"
    });
  });

  it("reports incomplete setup instead of claiming the cached profile is ready", () => {
    mockUser = { id: "pending-account", email: "pending@example.test" };
    mockAccountSetupRequired = true;
    act(() => {
      tree = create(
        <SectionGroup item={createAccountSection([], async () => true)} />
      );
    });
    const rows = tree.root.findAllByType("SettingRow" as never);
    expect(rows[1].props).toMatchObject({
      name: "Account setup needs attention",
      description: "Sign in again to finish setup"
    });
  });

  it("separates destructive local-data management into DATA and retains local-only visibility", () => {
    const deleteData = jest.fn();
    const section = createLocalDataSection(deleteData);
    expect(section.name).toBe("Data");
    act(() => {
      tree = create(<SectionGroup item={section} />);
    });
    const row = tree.root.findByType("SettingRow" as never);
    expect(row.props).toMatchObject({
      testID: "delete-data",
      name: "Delete local data"
    });
    expect(row.props.description).toContain("unsynced");
    row.props.onPress();
    expect(deleteData).toHaveBeenCalledTimes(1);
    mockUser = { id: "account", email: "qa@example.test" };
    act(() => {
      tree.update(<SectionGroup item={section} />);
    });
    expect(tree.toJSON()).toBeNull();
  });

  it("hides the signed-out action for any authenticated user model", () => {
    mockUser = { id: "account-three", email: "third@example.test" };
    act(() => {
      tree = create(
        <SectionGroup item={createSignedOutAccountSection(jest.fn())} />
      );
    });
    expect(tree.toJSON()).toBeNull();
  });
});
