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

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { expect as detoxExpect } from "detox";
import { expect as jestExpect } from "@jest/globals";
import { Tests } from "./utils";

// Live QA is opt-in and uses a disposable account in the authorized mailbox.
// Credentials and fresh MFA codes are supplied in private files outside Git.
const credentialPath = process.env.VEYRAN_QA_CREDENTIAL_FILE;
const mfaPath = process.env.VEYRAN_QA_MFA_CODE_FILE;
const live = credentialPath && mfaPath ? describe : describe.skip;
const credentials = credentialPath
  ? (JSON.parse(readFileSync(credentialPath, "utf8")) as {
      email: string;
      password: string;
    })
  : undefined;

async function freshLaunch() {
  await device.disableSynchronization();
  await device.uninstallApp();
  await device.installApp();
  await device.launchApp({
    newInstance: true,
    launchArgs: { detoxEnableSynchronization: 0 }
  });
  await device.disableSynchronization();
}

async function openCreateAccount(openLoginInstead = false) {
  try {
    await waitFor(element(by.text("Get started")))
      .toBeVisible()
      .withTimeout(3_000);
    await element(by.text("Get started")).tap();
    if (openLoginInstead) {
      await waitFor(element(by.text("Already have an account? Login")))
        .toBeVisible()
        .withTimeout(10_000);
      await Tests.sleep(2000);
      await element(by.text("Already have an account? Login")).tap();
    }
  } catch {
    // iOS retains the shared App Group when reinstalling this QA bundle.
    // The signed-out Library still offers the regular account entry.
    await waitFor(element(by.id("library-heading")))
      .toBeVisible()
      .withTimeout(30_000);
    await openSettings();
    await element(by.id("veyran-sign-in")).tap({ x: 70, y: 25 });
    await waitFor(element(by.id("input.email")))
      .toBeVisible()
      .withTimeout(10_000);
    await Tests.sleep(2000);
    if (openLoginInstead) return;
    await element(by.text("Login to your account")).tap();
    await Tests.sleep(750);
    await element(by.text("Don't have an account? Sign up")).tap();
  }
  if (openLoginInstead) {
    await waitFor(element(by.id("input.email")))
      .toBeVisible()
      .withTimeout(10_000);
    await Tests.sleep(2000);
    return;
  }
  await waitFor(element(by.text("Create account")))
    .toBeVisible()
    .withTimeout(10_000);
}

async function screenshot(name: string) {
  const path = await device.takeScreenshot(`account-lifecycle-${name}`);
  if (credentialPath)
    writeFileSync(
      `${credentialPath}.progress`,
      JSON.stringify({ phase: name, screenshot: path }),
      { mode: 0o600 }
    );
}

async function waitForMfa() {
  // A separate authorized mailbox reader writes only the fresh code. It is
  // never logged, embedded in screenshots, or included in test source.
  writeFileSync(`${mfaPath}.request`, String(Date.now()), { mode: 0o600 });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (existsSync(mfaPath!)) {
      const code = readFileSync(mfaPath!, "utf8").trim();
      if (/^\d{6}$/.test(code)) {
        unlinkSync(mfaPath!);
        unlinkSync(`${mfaPath}.request`);
        return code;
      }
    }
    await Tests.sleep(500);
  }
  throw new Error("The disposable QA account needs a fresh email MFA code.");
}

async function signIn(
  checkFailures = process.env.VEYRAN_QA_FAILURE_CHECKS === "1"
) {
  if (existsSync(mfaPath!)) unlinkSync(mfaPath!);
  await element(by.id("input.email")).replaceText(credentials!.email);
  await element(by.id("input.email")).tapReturnKey();
  let needsMfa = false;
  try {
    await waitFor(element(by.id("input.totp")))
      .toBeVisible()
      .withTimeout(10_000);
    needsMfa = true;
  } catch {
    await waitFor(element(by.id("input.password")))
      .toBeVisible()
      .withTimeout(10_000);
  }
  if (needsMfa) {
    const code = await waitForMfa();
    if (checkFailures) {
      await element(by.id("input.totp")).replaceText("000000");
      await element(by.text("Next")).tap();
      const error = element(by.id("account-mfa-error"));
      await waitFor(error).toBeVisible().withTimeout(10_000);
      jestExpect(JSON.stringify(await error.getAttributes())).toContain(
        "VeyraN could not verify this code. Check the code or request a new one, then try again."
      );
      await screenshot("invalid-mfa-recoverable");
    }
    await element(by.id("input.totp")).replaceText(code);
    await element(by.text("Next")).tap();
  }
  await waitFor(element(by.id("input.password")))
    .toBeVisible()
    .withTimeout(10_000);
  await Tests.sleep(750);
  if (checkFailures) {
    await element(by.id("input.password")).replaceText(
      "invalid-disposable-qa-password"
    );
    await element(by.id("input.password")).tapReturnKey();
    try {
      const error = element(by.id("input-error.password"));
      await waitFor(error).toBeVisible().withTimeout(10_000);
      jestExpect(JSON.stringify(await error.getAttributes())).toContain(
        "Email or password incorrect"
      );
    } catch {
      const error = element(by.id("account-login-error"));
      await waitFor(error).toBeVisible().withTimeout(10_000);
      jestExpect(JSON.stringify(await error.getAttributes())).toContain(
        "VeyraN could not complete sign in. Check your connection and try again."
      );
    }
    await screenshot("invalid-password-recoverable");
    try {
      await element(by.text("Change email")).tap();
      return await signIn(false);
    } catch {
      // A rejected local password keeps its proven password grant for retry.
    }
  }
  await element(by.id("input.password")).replaceText(credentials!.password);
  await element(by.id("input.password")).tapReturnKey();
  await waitFor(element(by.id("library-heading")))
    .toBeVisible()
    .withTimeout(60_000);
}

async function openSettings() {
  await Tests.navigate("Settings");
  await waitFor(element(by.id("settings-list")))
    .toBeVisible()
    .withTimeout(10_000);
  // Synchronization is disabled for the long-lived SSE connection. Wait for
  // the native screen transition before delivering touches to Settings rows.
  await Tests.sleep(2000);
}

async function verifyAccount() {
  await detoxExpect(element(by.text("VeyraN Account"))).toBeVisible();
  await detoxExpect(element(by.text(credentials!.email))).toBeVisible();
  await detoxExpect(element(by.text("Sign out"))).toBeVisible();
  await detoxExpect(element(by.text("Notesnook Free"))).not.toBeVisible();
  await detoxExpect(element(by.text("Upgrade plan"))).not.toBeVisible();
}

describe("ACCOUNT ENTRY", () => {
  it("offers create account and login from a fresh install", async () => {
    await freshLaunch();
    await openCreateAccount();
    await screenshot("create-account-entry");
    await element(by.text("Already have an account? Login")).tap();
    await waitFor(element(by.id("input.email")))
      .toBeVisible()
      .withTimeout(10_000);
    await screenshot("login-entry");
  });
});

live("LIVE DISPOSABLE ACCOUNT LIFECYCLE", () => {
  it("registers, persists a session, signs out and restores encrypted notes on login", async () => {
    await freshLaunch();
    if (process.env.VEYRAN_QA_RESUME_ACCOUNT !== "1") {
      await openCreateAccount(process.env.VEYRAN_QA_EXISTING_ACCOUNT === "1");
    }
    if (process.env.VEYRAN_QA_RESUME_ACCOUNT === "1") {
      await waitFor(element(by.id("library-heading")))
        .toBeVisible()
        .withTimeout(30_000);
    } else if (process.env.VEYRAN_QA_EXISTING_ACCOUNT === "1") {
      await signIn();
    } else {
      await screenshot("create-account-form");
      await element(by.id("input.email")).replaceText(credentials!.email);
      await element(by.id("input.password")).replaceText(credentials!.password);
      await element(by.id("input.confirmPassword")).replaceText(
        credentials!.password
      );
      await element(by.id("input.confirmPassword")).tapReturnKey();
      await screenshot("setup-progress");
      await waitFor(element(by.id("library-heading")))
        .toBeVisible()
        .withTimeout(90_000);
    }
    console.info("QA account application entry reached.");
    await screenshot("registered-library");
    const noteBody = `VEYRAN-TF-QA-account-note-${Date.now()}`;
    await Tests.createNote(undefined, noteBody);
    await element(by.id("note-item-0")).tap();
    await Tests.waitForEditor();
    jestExpect(
      await web().element(by.web.cssSelector(".active .ProseMirror")).getText()
    ).toContain(noteBody);
    await Tests.exitEditor();
    await openSettings();
    await verifyAccount();
    console.info("QA account identity verified.");
    await screenshot("authenticated-settings");
    await device.terminateApp();
    await device.launchApp({
      newInstance: true,
      launchArgs: { detoxEnableSynchronization: 0 }
    });
    await device.disableSynchronization();
    await waitFor(element(by.id("library-heading")))
      .toBeVisible()
      .withTimeout(30_000);
    await openSettings();
    await verifyAccount();
    console.info("QA account persisted across restart.");
    await screenshot("restart-settings");
    await waitFor(element(by.id("logout")))
      .toBeVisible()
      .withTimeout(10000);
    // The native Settings transition can leave visible rows briefly untappable.
    await Tests.sleep(2000);
    await element(by.id("logout")).tap({ x: 70, y: 25 });
    await waitFor(element(by.text("Back up and sign out")))
      .toBeVisible()
      .withTimeout(10_000);
    await screenshot("sign-out-confirmation");
    await element(by.text("Back up and sign out")).tap();
    await waitFor(element(by.id("input.email")))
      .toBeVisible()
      .withTimeout(60_000);
    console.info("QA account sign out completed.");
    await screenshot("signed-out-login");
    await signIn();
    console.info("QA account re-login completed.");
    await screenshot("relogin-library");
    await element(by.text("All Notes")).tap();
    // Sign out cleared the profile, so this verifies actual encrypted Sync
    // restoration, rather than merely reading the previous local cache.
    await waitFor(element(by.text(noteBody)))
      .toBeVisible()
      .withTimeout(60_000);
    await element(by.id("note-item-0")).tap();
    await Tests.waitForEditor();
    jestExpect(
      await web().element(by.web.cssSelector(".active .ProseMirror")).getText()
    ).toContain(noteBody);
    await Tests.exitEditor();
    await openSettings();
    await verifyAccount();
  }, 360_000);
});
