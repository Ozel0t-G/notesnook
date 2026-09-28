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

import { expect as jestExpect } from "@jest/globals";
import { expect as detoxExpect } from "detox";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { Tests } from "./utils";

// The host runner validates the receipt BEFORE Detox setup launches the app.
// Use --reuse with capture/log/video artifacts disabled and umask 077. This
// suite permits one new native-created simulator, never an existing profile.
const enabled = process.env.VEYRAN_QA_AUTH_UPGRADE === "1";
const upgrade = enabled ? describe : describe.skip;
const bundle = "com.ozel0t.note.notesnookpencil";
const group = `group.${bundle}`;
const qaRoot = "/Users/ozel0t/Notesnook/qa";
const oldApp = `${qaRoot}/account-upgrade-old17-group-iphone.app`;
const candidateApp = `${qaRoot}/account-upgrade-linked-candidate.app`;
const credentialFile = `${qaRoot}/account-lifecycle-private.json`;
const mfaFile = `${qaRoot}/account-authenticated-upgrade-mfa-code`;
const forbiddenPrefixes = ["76CA", "7F25", "443F", "DF19"];

type Receipt = {
  schema: 1;
  creationMethod: "simctl-create";
  deviceId: string;
  deviceName: string;
  createdAt: string;
  hostHome: string;
  preexistingDeviceIds: string[];
  deviceRoot: string;
  artifactRoot: string;
  oldBundleHashes: Record<string, string>;
  candidateBundleHashes: Record<string, string>;
  authenticatedResumeOfReceipt?: string;
  candidateVerificationOfReceipt?: string;
  candidateSemanticResumeOfReceipt?: string;
};
type Containers = {
  app: string;
  data: string;
  group: string;
  keychain: string;
};
type FileEntry = { path: string; size: number; sha256: string };
type Snapshot = {
  schema: 1;
  deviceId: string;
  capturedAt: string;
  containers: Containers;
  files: Record<"data" | "group" | "keychain", FileEntry[]>;
};

let receipt: Receipt;
let credentials: { email: string; password: string };
let artifacts: string;
let old17UiStage = "onboarding";
let noteStage = "not-started";
let lastEditorProof:
  | {
      textReturned: boolean;
      nonEmpty: boolean;
      matchesExpectedBody: boolean;
    }
  | undefined;

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function privateFile(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
    throw new Error("Authenticated upgrade requires private regular files");
}

function privateJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx"
  });
}

function inside(root: string, path: string) {
  const suffix = relative(root, path);
  if (!suffix || suffix.startsWith("../") || isAbsolute(suffix))
    throw new Error("Authenticated upgrade path escapes its disposable root");
}

function native(args: string[]) {
  // Native errors can include paths/environment. Preserve only a safe stage.
  try {
    return execFileSync("xcrun", ["simctl", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      env: {
        ...process.env,
        DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer"
      }
    }).trim();
  } catch {
    throw new Error(`Authenticated upgrade native ${args[0]} failed`);
  }
}

function assertBundleHashes(app: string, expected: Record<string, string>) {
  if (realpathSync(app) !== app || Object.keys(expected).length < 3)
    throw new Error("Authenticated upgrade requires pinned immutable bundles");
  for (const [name, digest] of Object.entries(expected)) {
    const path = resolve(app, name);
    inside(app, path);
    if (hash(readFileSync(path)) !== digest)
      throw new Error("Authenticated upgrade bundle changed after preparation");
  }
}

function assertReceipt() {
  const path = process.env.VEYRAN_QA_AUTH_UPGRADE_RECEIPT;
  if (!path || !isAbsolute(path))
    throw new Error("Fresh-device receipt required");
  inside(qaRoot, realpathSync(path));
  privateFile(path);
  receipt = JSON.parse(readFileSync(path, "utf8")) as Receipt;
  if (
    receipt.schema !== 1 ||
    receipt.creationMethod !== "simctl-create" ||
    !/^[A-F0-9-]{36}$/.test(receipt.deviceId) ||
    forbiddenPrefixes.some((prefix) => receipt.deviceId.startsWith(prefix)) ||
    receipt.preexistingDeviceIds.includes(receipt.deviceId) ||
    !receipt.preexistingDeviceIds.length ||
    receipt.hostHome !== homedir() ||
    device.getPlatform() !== "ios" ||
    receipt.deviceId !== device.id ||
    process.env.VEYRAN_QA_DEVICE_ID !== receipt.deviceId ||
    !/^(1|true)$/.test(process.env.DETOX_REUSE || "") ||
    process.env.VEYRAN_QA_PRIVATE_ARTIFACTS !== "1"
  )
    throw new Error(
      "Authenticated upgrade requires its fresh native QA device"
    );
  const expectedRoot = join(
    homedir(),
    "Library/Developer/CoreSimulator/Devices",
    receipt.deviceId
  );
  if (
    receipt.deviceRoot !== expectedRoot ||
    realpathSync(expectedRoot) !== expectedRoot ||
    lstatSync(expectedRoot).isSymbolicLink() ||
    lstatSync(join(expectedRoot, "data")).isSymbolicLink() ||
    realpathSync(join(expectedRoot, "data")) !== join(expectedRoot, "data")
  )
    throw new Error("Disposable simulator root is aliased");
  const inventory = JSON.parse(native(["list", "devices", "--json"])) as {
    devices: Record<string, { udid: string; name: string }[]>;
  };
  const current = Object.values(inventory.devices)
    .flat()
    .find((entry) => entry.udid === receipt.deviceId);
  if (!current || current.name !== receipt.deviceName)
    throw new Error("Fresh-device receipt does not match simulator metadata");
  artifacts = realpathSync(receipt.artifactRoot);
  inside(qaRoot, artifacts);
  if (lstatSync(artifacts).mode & 0o077)
    throw new Error("Upgrade artifacts require a private external directory");
  assertBundleHashes(oldApp, receipt.oldBundleHashes);
  assertBundleHashes(candidateApp, receipt.candidateBundleHashes);
}

function containers(requireLiveProcess: boolean): Containers {
  const dataRoot = join(receipt.deviceRoot, "data");
  const paths = {} as Containers;
  for (const [key, kind, prefix] of [
    ["app", "app", "Containers/Bundle/Application"],
    ["data", "data", "Containers/Data/Application"],
    ["group", group, "Containers/Shared/AppGroup"]
  ] as const) {
    const path = native(["get_app_container", device.id, bundle, kind]);
    if (realpathSync(path) !== path || lstatSync(path).isSymbolicLink())
      throw new Error("Disposable account container is aliased");
    inside(join(dataRoot, prefix), path);
    paths[key] = path;
  }
  paths.keychain = join(dataRoot, "Library/Keychains");
  if (
    !existsSync(paths.keychain) ||
    realpathSync(paths.keychain) !== paths.keychain ||
    lstatSync(paths.keychain).isSymbolicLink()
  )
    throw new Error("Disposable Keychain directory is missing or aliased");
  if (!requireLiveProcess) return paths;
  const processes = execFileSync("ps", ["-axo", "pid=,comm="], {
    encoding: "utf8"
  });
  const pid = processes
    .split("\n")
    .find((line) => line.trim().endsWith(`${paths.app}/Notesnook`))
    ?.trim()
    .match(/^[0-9]+/)?.[0];
  if (!pid) throw new Error("Fresh disposable app process was not found");
  const info = native(["spawn", device.id, "launchctl", "procinfo", pid]);
  // procinfo includes bootstrap domains as well as the process environment.
  // Their repeated HOME values may point at this same simulator's data root.
  // Every recorded home and UUID still must belong to this fresh device.
  const homes = Array.from(
    info.matchAll(
      /^\s*(?:HOME|CFFIXED_USER_HOME|_DYLD_CLOSURE_HOME) => (.*)$/gm
    ),
    (match) => match[1].trim()
  );
  if (!homes.length) throw new Error("Live disposable process HOME is missing");
  for (const home of homes) {
    const suffix = relative(dataRoot, realpathSync(home));
    if (suffix.startsWith("../") || isAbsolute(suffix))
      throw new Error("Live disposable process HOME is not isolated");
  }
  const ids = Array.from(
    info.matchAll(/^\s*SIMULATOR_UDID => (.*)$/gm),
    (match) => match[1]
  );
  if (!ids.length || ids.some((id) => id.trim() !== receipt.deviceId))
    throw new Error("Live process simulator UUID does not match receipt");
  // ps eww returns only this verified native binary PID's actual environment.
  // Read it in memory; never log or persist the environment or its values.
  const actualEnvironment = execFileSync(
    "ps",
    ["eww", "-p", pid, "-o", "command="],
    { encoding: "utf8" }
  );
  if (!actualEnvironment.trim().startsWith(`${paths.app}/Notesnook`))
    throw new Error("Live process no longer matches the disposable app binary");
  const environmentValues = (key: string) =>
    Array.from(
      actualEnvironment.matchAll(new RegExp(`(?:^|\\s)${key}=([^\\s]*)`, "g")),
      (match) => match[1]
    );
  const actualHomes = environmentValues("HOME");
  if (
    !actualHomes.length ||
    [...actualHomes, ...environmentValues("CFFIXED_USER_HOME")].some(
      (home) => realpathSync(home) !== paths.data
    )
  )
    throw new Error("Actual process HOME does not match its own AppData");
  const actualIds = environmentValues("SIMULATOR_UDID");
  if (!actualIds.length || actualIds.some((id) => id !== receipt.deviceId))
    throw new Error(
      "Actual process UUID does not match its fresh-device receipt"
    );
  return paths;
}

function copyTree(source: string, destination: string): FileEntry[] {
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  const entries: FileEntry[] = [];
  function visit(path: string, subpath: string) {
    for (const name of readdirSync(path).sort()) {
      const current = join(path, name);
      const child = join(subpath, name);
      const info = lstatSync(current);
      if (info.isSymbolicLink())
        throw new Error("Raw disposable snapshots may not follow symlinks");
      if (info.isDirectory()) {
        mkdirSync(join(destination, child), { mode: 0o700 });
        visit(current, child);
      } else if (info.isFile()) {
        const output = join(destination, child);
        copyFileSync(current, output);
        chmodSync(output, 0o600);
        entries.push({
          path: child,
          size: info.size,
          sha256: hash(readFileSync(output))
        });
      }
    }
  }
  visit(source, "");
  return entries;
}

function snapshot(name: string): Snapshot {
  const paths = containers(false);
  const root = join(artifacts, name);
  mkdirSync(root, { mode: 0o700 });
  const result: Snapshot = {
    schema: 1,
    deviceId: device.id,
    capturedAt: new Date().toISOString(),
    containers: paths,
    files: {
      data: copyTree(paths.data, join(root, "app-data")),
      group: copyTree(paths.group, join(root, "app-group")),
      keychain: copyTree(paths.keychain, join(root, "keychain"))
    }
  };
  if (!result.files.group.length || !result.files.keychain.length)
    throw new Error(
      "Raw account snapshot requires App Group and Keychain data"
    );
  privateJson(join(root, "manifest.json"), result);
  return result;
}

function protectedEntries(
  kind: "data" | "group" | "keychain",
  files: FileEntry[]
) {
  return files.filter(({ path }) => {
    if (path === ".com.apple.mobile_container_manager.metadata.plist")
      return false;
    if (kind === "keychain") return true;
    // UIKit invalidates cached launch-screen images on an in-place upgrade.
    // Keep their raw snapshot evidence, while protecting all user storage.
    if (
      kind === "data" &&
      path.startsWith("Library/SplashBoard/Snapshots/") &&
      path.endsWith(".ktx")
    )
      return false;
    return !/^(?:tmp|Library\/Caches)(?:\/|$)/.test(path);
  });
}

function assertRetained(before: Snapshot, after: Snapshot) {
  for (const kind of ["data", "group", "keychain"] as const) {
    // Native installation may move AppData to another registered container
    // within this same guarded device. Its protected bytes still must match.
    if (kind !== "data")
      jestExpect(after.containers[kind] === before.containers[kind]).toBe(true);
    const retained = new Map(
      after.files[kind].map((file) => [file.path, file])
    );
    for (const file of protectedEntries(kind, before.files[kind])) {
      const current = retained.get(file.path);
      // Never include secret filenames or file bytes in assertion diagnostics.
      jestExpect(
        current?.sha256 === file.sha256 && current.size === file.size
      ).toBe(true);
    }
  }
}

async function visible(item: Detox.NativeElement, timeout = 750) {
  try {
    await waitFor(item).toBeVisible().withTimeout(timeout);
    return true;
  } catch {
    return false;
  }
}

async function secretAction<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(
      `Disposable account credential action failed (${nativeErrorCategory(
        error
      )})`
    );
  }
}

function nativeErrorCategory(error: unknown) {
  // Native errors can embed the view hierarchy and its credential fields.
  // Inspect only in memory and retain a fixed category, never the payload.
  const message =
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "";
  if (/not.?visible|visibility|outside.*screen/i.test(message))
    return "visibility";
  if (/hittable|interactab|cannot.*tap|failed.*tap/i.test(message))
    return "not-hittable";
  if (/multiple|ambiguous|more than one/i.test(message))
    return "multiple-match";
  if (/no.*match|cannot find|failed.*find|no.*element/i.test(message))
    return "missing-match";
  if (/timed? ?out|timeout/i.test(message)) return "native-timeout";
  if (/credential action/i.test(message)) return "credential-action";
  return "unknown";
}

async function waitForMfa(requestedAt: number) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (existsSync(mfaFile)) {
      privateFile(mfaFile);
      const value = readFileSync(mfaFile, "utf8").trim();
      if (
        /^\d{6}$/.test(value) &&
        lstatSync(mfaFile).mtimeMs >= requestedAt - 15_000
      ) {
        unlinkSync(mfaFile);
        return value;
      }
    }
    await Tests.sleep(500);
  }
  throw new Error("A fresh disposable-account email code was not supplied");
}

async function loginOld17() {
  const paths = containers(true);
  assertBundleHashes(paths.app, receipt.oldBundleHashes);
  await waitFor(element(by.text("Get started")))
    .toBeVisible()
    .withTimeout(30_000);
  // Enter Login directly from Welcome. Signup shares both input IDs, and its
  // Return keys only advance focus, so those IDs alone cannot prove Login mode.
  await waitFor(element(by.text("I already have an account")))
    .toBeVisible()
    .withTimeout(10_000);
  await element(by.text("I already have an account")).tap();
  old17UiStage = "unproven-login-mode";
  await waitFor(element(by.text("Login to your account")))
    .toBeVisible()
    .withTimeout(10_000);
  await detoxExpect(element(by.id("input.confirmPassword"))).not.toExist();
  await Tests.sleep(1000);
  privateJson(join(artifacts, "old17-login-mode-proof.json"), {
    deviceId: device.id,
    exactLoginHeadingVisible: true,
    confirmationFieldAbsent: true,
    entry: "welcome-existing-account-button",
    credentialEntryStarted: false
  });
  old17UiStage = "email-entry";
  await waitFor(element(by.id("input.email")))
    .toBeVisible()
    .withTimeout(10_000);
  await Tests.sleep(1000);
  if (existsSync(mfaFile)) unlinkSync(mfaFile);
  if (existsSync(`${mfaFile}.request`))
    throw new Error("Another private MFA request is still active");
  const requestedAt = Date.now();
  writeFileSync(`${mfaFile}.request`, String(requestedAt), {
    mode: 0o600,
    flag: "wx"
  });
  await secretAction(() =>
    element(by.id("input.email")).replaceText(credentials.email)
  );
  await Tests.sleep(750);
  await element(by.text("Continue")).tap();
  old17UiStage = "email-challenge";
  // The pinned old17 bundle enters its password step only after MFA succeeds.
  // Require the challenge rather than treating a shared password ID as proof.
  await waitFor(element(by.id("input.totp")))
    .toBeVisible()
    .withTimeout(20_000);
  old17UiStage = "email-code-entry";
  const code = await waitForMfa(requestedAt);
  await secretAction(() => element(by.id("input.totp")).replaceText(code));
  await Tests.sleep(750);
  await element(by.text("Next")).tap();
  if (existsSync(`${mfaFile}.request`)) unlinkSync(`${mfaFile}.request`);
  await waitFor(element(by.id("input.password")))
    .toBeVisible()
    .withTimeout(15_000);
  old17UiStage = "password-focus";
  await Tests.sleep(750);
  await element(by.id("input.password")).tap();
  old17UiStage = "password-entry";
  await secretAction(() =>
    element(by.id("input.password")).replaceText(credentials.password)
  );
  old17UiStage = "password-value-entered";
  await Tests.sleep(750);
  // The exact Login heading and absence of Signup's confirmation input were
  // proved above. This old Login Return handler invokes onContinue directly.
  await element(by.id("input.password")).tapReturnKey();
  old17UiStage = "after-password-submit";
  const reachedLibrary = await visible(
    element(by.id("library-heading")),
    90_000
  );
  privateJson(join(artifacts, "old17-login-ui.json"), {
    deviceId: device.id,
    baselineLibraryReached: reachedLibrary,
    emailSha256: hash(credentials.email.toLowerCase()),
    observedStage: reachedLibrary ? "library" : "after-password-submit",
    setupSpinnerVisible: await visible(
      element(by.text("Setting up your account..."))
    ),
    accountRowsRequired: false
  });
  if (!reachedLibrary) {
    throw new Error(
      "Old17 did not reach Library after password submission; authenticated upgrade gate remains incomplete"
    );
  }
}

async function assertActiveQaBody(expectedBody: string) {
  await waitFor(element(by.id("editor.id")))
    .toBeVisible()
    .withTimeout(10_000);
  await Tests.waitForEditor();
  for (let attempt = 0; attempt < 30; attempt++) {
    let value: unknown;
    try {
      value = await web()
        .element(by.web.cssSelector(".active .ProseMirror"))
        .getText();
    } catch {
      // An active native editor can expose its WebView before hydration.
    }
    lastEditorProof = {
      textReturned: typeof value === "string",
      nonEmpty: typeof value === "string" && !!value.trim(),
      matchesExpectedBody:
        typeof value === "string" && hash(value.trim()) === hash(expectedBody)
    };
    if (lastEditorProof.matchesExpectedBody) return;
    await Tests.sleep(500);
  }
  throw new Error("The active native editor did not load the expected QA body");
}

async function createUniqueNote(body: string) {
  noteStage = "note-compose";
  await Tests.tapNewNote();
  noteStage = "new-native-editor";
  await waitFor(element(by.id("editor.id")))
    .toBeVisible()
    .withTimeout(10_000);
  await Tests.waitForEditor();
  await Tests.sleep(1500);
  const editor = web().element(by.web.cssSelector(".active .ProseMirror"));
  await editor.focus();
  noteStage = "note-body-entry";
  await editor.typeText(body, true);
  noteStage = "new-body-proof";
  await assertActiveQaBody(body);
  await Tests.sleep(1500);
  noteStage = "new-editor-exit";
  await Tests.exitEditor();
}

async function readUniqueNote(expectedBody: string) {
  noteStage = "note-navigation";
  try {
    await Tests.navigate("Notes");
  } catch (error) {
    privateJson(join(artifacts, `note-navigation-probe-${Date.now()}.json`), {
      deviceId: device.id,
      libraryHeadingVisible: await visible(element(by.id("library-heading"))),
      allNotesVisible: await visible(element(by.text("All Notes"))),
      scopedAllNotesVisible: await visible(
        element(by.text("All Notes").withAncestor(by.id("library-scroll")))
      ),
      libraryScrollVisible: await visible(element(by.id("library-scroll"))),
      errorCategory: nativeErrorCategory(error)
    });
    // Explicit QA screenshot only after leaving credential entry; stays private.
    const capture = await device.takeScreenshot(
      "authenticated-upgrade-note-navigation"
    );
    copyFileSync(capture, join(artifacts, "note-navigation-private.png"));
    chmodSync(join(artifacts, "note-navigation-private.png"), 0o600);
    throw error;
  }
  noteStage = "note-row";
  await waitFor(element(by.text(expectedBody)))
    .toBeVisible()
    .withTimeout(30_000);
  await element(by.text(expectedBody)).tap();
  noteStage = "editor-open";
  noteStage = "editor-body-read";
  await assertActiveQaBody(expectedBody);
  noteStage = "note-decrypted";
  await Tests.exitEditor();
}

async function verifyNormalSync() {
  await Tests.navigate("Notes");
  const list = element(by.id("list.id"));
  await waitFor(list).toBeVisible().withTimeout(10_000);
  const requestedAt = Date.now();
  await list.swipe("down", "slow", 0.85);
  const logPath = join(containers(false).group, "notesnook-logs");
  const deadline = Date.now() + 90_000;
  let proof: Record<string, boolean> = {};
  while (Date.now() < deadline) {
    try {
      // Read only fixed sync markers from plaintext diagnostic SQLite. Never
      // retrieve token, key, identity or note payloads from the account DB.
      proof = JSON.parse(
        execFileSync(
          "python3",
          [
            "-c",
            `
import json,re,sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=0.2)
rows=c.execute('select message from logs where timestamp>=?',(int(sys.argv[2]),)).fetchall()
messages=[r[0] for r in rows]
send=[re.fullmatch(r'Sync send completed[.] Sent (\\d+) out of (\\d+) items[.]',m) for m in messages]
print(json.dumps({'started':'Starting sync' in messages,'fetched':'Data fetched' in messages,'completeSend':any(m and m[1]==m[2] for m in send),'stopped':'Stopping sync' in messages,'clientFailure':'[Client] Failed to sync' in messages}))
c.close()
`,
            logPath,
            String(requestedAt)
          ],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 2000
          }
        )
      );
      if (proof.started && proof.fetched && proof.completeSend && proof.stopped)
        break;
    } catch {
      // The logger flushes every ten seconds; a short read can overlap it.
    }
    await Tests.sleep(1000);
  }
  privateJson(join(artifacts, "candidate18-normal-sync-proof.json"), {
    deviceId: device.id,
    ordinaryPullToRefreshRequested: true,
    ...proof
  });
  jestExpect(
    !!proof.started &&
      !!proof.fetched &&
      !!proof.completeSend &&
      !!proof.stopped &&
      !proof.clientFailure
  ).toBe(true);
}

async function observeOld17Restart() {
  const reachedLibrary = await visible(
    element(by.id("library-heading")),
    60_000
  );
  const proof = {
    deviceId: device.id,
    credentialEntryRetried: false,
    libraryVisible: reachedLibrary,
    emailInputVisible: await visible(element(by.id("input.email"))),
    passwordInputVisible: await visible(element(by.id("input.password"))),
    welcomeVisible: await visible(element(by.text("Get started"))),
    setupSpinnerVisible: await visible(
      element(by.text("Setting up your account..."))
    ),
    passwordValidationVisible: await visible(
      element(by.id("input-error.password"))
    ),
    cachedIdentityVisible: false,
    logoutVisible: false
  };
  if (reachedLibrary) {
    await Tests.navigate("Settings");
    await Tests.sleep(1500);
    proof.cachedIdentityVisible = await visible(
      element(by.text(credentials.email))
    );
    proof.logoutVisible = await visible(element(by.id("logout")));
  }
  privateJson(join(artifacts, "old17-restart-observation.json"), proof);
  if (!proof.cachedIdentityVisible) {
    await device.terminateApp();
    snapshot("old17-restart-observation-raw");
    throw new Error(
      "Old17 restart did not prove a cached authenticated identity"
    );
  }
}

async function verifyCandidateAccount() {
  await Tests.navigate("Settings");
  await waitFor(element(by.id("settings-list")))
    .toBeVisible()
    .withTimeout(10_000);
  await Tests.sleep(2000);
  const identity = element(by.id("veyran-account-identity"));
  await waitFor(identity).toBeVisible().withTimeout(10_000);
  let attributes = JSON.stringify(await identity.getAttributes()).toLowerCase();
  if (!attributes.includes(credentials.email.toLowerCase())) {
    // This Detox version accepts literal text only. Catch its error before
    // reporting it, with native logs, screenshots and hierarchy disabled.
    attributes = JSON.stringify(
      await secretAction(() =>
        element(by.text(credentials.email)).getAttributes()
      )
    ).toLowerCase();
  }
  // eslint-disable-next-line jest/prefer-to-contain -- Keep the address out of failure diagnostics.
  jestExpect(attributes.includes(credentials.email.toLowerCase())).toBe(true);
  await detoxExpect(element(by.id("veyran-account-session"))).toBeVisible();
  await detoxExpect(element(by.text("Signed in to VeyraN"))).toBeVisible();
  await detoxExpect(element(by.id("logout"))).toBeVisible();
  await detoxExpect(element(by.text("Notesnook Free"))).not.toBeVisible();
  await detoxExpect(element(by.text("Upgrade plan"))).not.toBeVisible();
  await detoxExpect(element(by.id("veyran-sign-in"))).not.toBeVisible();
}

async function verifyInstalledCandidate(updateStage: (stage: string) => void) {
  const original = receipt.candidateVerificationOfReceipt;
  if (!original)
    throw new Error("Candidate verification requires its preserved receipt");
  privateFile(original);
  const priorArtifacts = dirname(original);
  inside(qaRoot, realpathSync(priorArtifacts));
  const beforePath = join(priorArtifacts, "old17-preinstall-raw/manifest.json");
  const afterPath = join(
    priorArtifacts,
    "candidate18-immediate-postinstall-raw/manifest.json"
  );
  const baselinePath = join(
    priorArtifacts,
    "old17-authenticated-baseline.json"
  );
  for (const path of [beforePath, afterPath, baselinePath]) privateFile(path);
  const before = JSON.parse(readFileSync(beforePath, "utf8")) as Snapshot;
  const after = JSON.parse(readFileSync(afterPath, "utf8")) as Snapshot;
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
    deviceId: string;
    baselineLibraryReached: boolean;
    decryptedUniqueNote: boolean;
  };
  if (
    before.deviceId !== device.id ||
    after.deviceId !== device.id ||
    baseline.deviceId !== device.id ||
    !baseline.baselineLibraryReached ||
    !baseline.decryptedUniqueNote
  )
    throw new Error("Preserved authenticated baseline is incomplete");
  assertRetained(before, after);
  const paths = containers(true);
  assertBundleHashes(paths.app, receipt.candidateBundleHashes);
  privateJson(join(artifacts, "candidate18-prelaunch-retention.json"), {
    deviceId: device.id,
    protectedPathsRetained: true,
    protectedHashesRetained: true,
    prelaunchManifestsValidatedByHostBeforeDetox: true,
    excludedOnlyAdditionalOsLaunchScreenCache: true
  });
  const body = `VEYRAN-TF-QA authenticated upgrade note ${receipt.deviceId}`;
  updateStage("candidate18-first-launch-identity-and-decrypt");
  await waitFor(element(by.id("library-heading")))
    .toBeVisible()
    .withTimeout(60_000);
  updateStage("candidate18-first-launch-settings-identity");
  await verifyCandidateAccount();
  updateStage("candidate18-first-launch-note-decrypt");
  await readUniqueNote(body);
  privateJson(join(artifacts, "candidate18-first-launch-proof.json"), {
    deviceId: device.id,
    identityMatched: true,
    exactNoteDecrypted: true
  });
  updateStage("candidate18-restart-terminate");
  await device.terminateApp();
  updateStage("candidate18-restart-launch");
  await device.launchApp({
    newInstance: true,
    launchArgs: { detoxEnableSynchronization: 0 }
  });
  await device.disableSynchronization();
  updateStage("candidate18-restart-live-process-guard");
  containers(true);
  updateStage("candidate18-restart-library");
  await waitFor(element(by.id("library-heading")))
    .toBeVisible()
    .withTimeout(60_000);
  updateStage("candidate18-restart-settings-identity");
  await verifyCandidateAccount();
  updateStage("candidate18-restart-note-decrypt");
  await readUniqueNote(body);
  privateJson(join(artifacts, "candidate18-restart-proof.json"), {
    deviceId: device.id,
    identityMatched: true,
    exactNoteDecrypted: true,
    credentialEntryRetried: false
  });
  updateStage("candidate18-normal-sync-after-restart");
  await verifyNormalSync();
  await verifyCandidateAccount();
  await readUniqueNote(body);
  privateJson(join(artifacts, "authenticated-upgrade-result.json"), {
    schema: 1,
    deviceId: device.id,
    baselineLibraryReached: true,
    old17DecryptedUniqueNote: true,
    protectedPrelaunchRetention: true,
    candidateIdentityMatched: true,
    candidateSessionVisible: true,
    candidateDecryptedUniqueNote: true,
    persistedAcrossRestart: true,
    manualRelogin: false,
    copiedBackProfile: false,
    normalSyncContinued: true,
    candidateVerificationResumedAfterOsCacheClassification: true
  });
}

upgrade("AUTHENTICATED OLD17 IN-PLACE UPGRADE (FRESH NATIVE QA DEVICE)", () => {
  beforeAll(() => {
    assertReceipt();
    privateFile(credentialFile);
    credentials = JSON.parse(readFileSync(credentialFile, "utf8"));
    if (!credentials.email || !credentials.password)
      throw new Error("Disposable account credentials are incomplete");
    containers(true);
  });

  it("retains the old session, encrypted unique Note and Keychain through install and restart", async () => {
    let stage = "old17-login";
    try {
      await device.disableSynchronization();
      if (process.env.VEYRAN_QA_CANDIDATE_VERIFY_ONLY === "1") {
        stage = "candidate18-retention-reconciliation";
        await verifyInstalledCandidate((value) => {
          stage = value;
          privateJson(join(artifacts, `${value}-stage.json`), {
            deviceId: device.id,
            stage: value
          });
        });
        return;
      }
      if (process.env.VEYRAN_QA_OLD17_RESUME_NOTE === "1") {
        if (!receipt.authenticatedResumeOfReceipt)
          throw new Error(
            "Authenticated resume requires its preserved receipt"
          );
        await waitFor(element(by.id("library-heading")))
          .toBeVisible()
          .withTimeout(60_000);
        old17UiStage = "authenticated-session-resumed";
      } else if (process.env.VEYRAN_QA_OLD17_OBSERVE_RESTART === "1")
        await observeOld17Restart();
      else await loginOld17();
      stage = "old17-note-create-and-decrypt";
      const body = `VEYRAN-TF-QA authenticated upgrade note ${receipt.deviceId}`;
      let reusedExistingQaNote = false;
      if (process.env.VEYRAN_QA_OLD17_RESUME_NOTE === "1") {
        noteStage = "existing-qa-note-probe";
        await Tests.navigate("Notes");
        reusedExistingQaNote = await visible(element(by.text(body)), 5000);
      }
      if (!reusedExistingQaNote) await createUniqueNote(body);
      await readUniqueNote(body);
      containers(true);
      await device.terminateApp();
      stage = "old17-private-preinstall-snapshot";
      const before = snapshot("old17-preinstall-raw");
      privateJson(join(artifacts, "old17-authenticated-baseline.json"), {
        schema: 1,
        deviceId: device.id,
        baselineLibraryReached: true,
        decryptedUniqueNote: true,
        noteBodySha256: hash(body),
        emailSha256: hash(credentials.email.toLowerCase()),
        accountRowsRequired: false,
        reusedExistingQaNote,
        authenticatedStateResumed: !!receipt.authenticatedResumeOfReceipt
      });
      assertBundleHashes(candidateApp, receipt.candidateBundleHashes);
      stage = "candidate18-native-in-place-install";
      // No uninstall, erase, reset, restore, copy-back or intervening launch.
      native(["install", device.id, candidateApp]);
      const immediate = snapshot("candidate18-immediate-postinstall-raw");
      assertBundleHashes(
        immediate.containers.app,
        receipt.candidateBundleHashes
      );
      stage = "candidate18-protected-prelaunch-retention";
      assertRetained(before, immediate);
      privateJson(join(artifacts, "candidate18-prelaunch-retention.json"), {
        deviceId: device.id,
        protectedPathsRetained: true,
        protectedHashesRetained: true,
        candidateLaunched: false
      });
      await device.launchApp({
        newInstance: true,
        launchArgs: { detoxEnableSynchronization: 0 }
      });
      await device.disableSynchronization();
      stage = "candidate18-launch-identity-and-decrypt";
      containers(true);
      await waitFor(element(by.id("library-heading")))
        .toBeVisible()
        .withTimeout(60_000);
      await verifyCandidateAccount();
      await readUniqueNote(body);
      await device.terminateApp();
      stage = "candidate18-restart-session-and-decrypt";
      await device.launchApp({
        newInstance: true,
        launchArgs: { detoxEnableSynchronization: 0 }
      });
      await device.disableSynchronization();
      containers(true);
      await waitFor(element(by.id("library-heading")))
        .toBeVisible()
        .withTimeout(60_000);
      await verifyCandidateAccount();
      await readUniqueNote(body);
      stage = "candidate18-normal-sync-after-restart";
      await verifyNormalSync();
      await verifyCandidateAccount();
      await readUniqueNote(body);
      privateJson(join(artifacts, "authenticated-upgrade-result.json"), {
        schema: 1,
        deviceId: device.id,
        baselineLibraryReached: true,
        old17DecryptedUniqueNote: true,
        protectedPrelaunchRetention: true,
        candidateIdentityMatched: true,
        candidateSessionVisible: true,
        candidateDecryptedUniqueNote: true,
        persistedAcrossRestart: true,
        manualRelogin: false,
        copiedBackProfile: false,
        normalSyncContinued: true
      });
    } catch (error) {
      if (stage.startsWith("candidate18")) {
        privateJson(join(artifacts, "candidate18-failure-control-proof.json"), {
          deviceId: device.id,
          stage,
          noteStage,
          lastEditorProof,
          errorCategory: nativeErrorCategory(error),
          libraryVisible: await visible(element(by.id("library-heading"))),
          settingsVisible: await visible(element(by.id("settings-list"))),
          identityVisible: await visible(
            element(by.id("veyran-account-identity"))
          ),
          sessionVisible: await visible(
            element(by.id("veyran-account-session"))
          ),
          nativeEditorVisible: await visible(element(by.id("editor.id"))),
          loginInputVisible: await visible(element(by.id("input.email"))),
          setupSpinnerVisible: await visible(
            element(by.text("Setting up your account..."))
          )
        });
      }
      if (stage.startsWith("old17")) {
        privateJson(join(artifacts, "old17-failure-control-proof.json"), {
          deviceId: device.id,
          observedStage: old17UiStage,
          noteStage,
          lastEditorProof,
          errorCategory: nativeErrorCategory(error),
          positiveLoginModePreviouslyProved: existsSync(
            join(artifacts, "old17-login-mode-proof.json")
          ),
          loginHeadingVisible: await visible(
            element(by.text("Login to your account"))
          ),
          signupHeadingVisible: await visible(
            element(by.text("Create account"))
          ),
          passwordInputVisible: await visible(element(by.id("input.password"))),
          confirmationInputVisible: await visible(
            element(by.id("input.confirmPassword"))
          ),
          continueVisible: await visible(element(by.text("Continue"))),
          mfaInputVisible: await visible(element(by.id("input.totp"))),
          syncProgressVisible: await visible(
            element(by.text("Syncing your data"))
          ),
          nativeEditorVisible: await visible(element(by.id("editor.id"))),
          libraryVisible: await visible(element(by.id("library-heading"))),
          passwordValidationVisible: await visible(
            element(by.id("input-error.password"))
          )
        });
        if (existsSync(`${mfaFile}.request`)) unlinkSync(`${mfaFile}.request`);
        if (existsSync(mfaFile)) unlinkSync(mfaFile);
        // Keep the failed baseline intact for a separately authorized recovery
        // observation. Snapshot only this guarded fresh device, never copy back.
        try {
          await device.terminateApp();
          if (!existsSync(join(artifacts, "old17-login-incomplete-raw")))
            snapshot("old17-failure-raw");
        } catch {
          // An incomplete snapshot cannot be promoted to retention evidence.
        }
      }
      privateJson(join(artifacts, "authenticated-upgrade-failure.json"), {
        deviceId: device.id,
        stage,
        old17UiStage,
        coreStageObserved: false,
        passed: false,
        candidateOnlyRecoveryRequiresAuthorization: stage.startsWith("old17")
      });
      // Detox/native error payloads can contain a screen's identity fields.
      // Keep only a safe stage in Jest's output; no screenshot or hierarchy.
      throw new Error(`Authenticated upgrade failed at ${stage}`);
    }
  }, 480_000);
});
