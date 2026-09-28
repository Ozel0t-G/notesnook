/** @type {Detox.DetoxConfig} */
const accountLifecycleQa =
  process.env.VEYRAN_QA_ACCOUNT_ENTRY === "1" ||
  (!!process.env.VEYRAN_QA_CREDENTIAL_FILE &&
    !!process.env.VEYRAN_QA_MFA_CODE_FILE);
const explicitAccountQa =
  accountLifecycleQa ||
  process.env.VEYRAN_QA_RETAINED_ACCOUNT_FEATURES === "true" ||
  ["baseline", "verify"].includes(process.env.VEYRAN_QA_UPGRADE_PHASE || "") ||
  process.env.VEYRAN_QA_AUTH_UPGRADE === "1";
if (explicitAccountQa) {
  const id = process.env.VEYRAN_QA_DEVICE_ID;
  if (
    !id ||
    !/^[A-F0-9-]{36}$/.test(id) ||
    !["true", "1"].includes(process.env.DETOX_REUSE || "")
  )
    throw new Error(
      "Account QA requires an explicit disposable device and reuse"
    );
  if (
    accountLifecycleQa &&
    ![
      "5A8198CC-A75C-4933-8BB8-42A1C3F883F4",
      "8BBC91D9-3520-467C-AC13-677C41096EE0"
    ].includes(id)
  )
    throw new Error(
      "Account lifecycle QA may only use its disposable fixtures"
    );
  const { execFileSync } = require("node:child_process");
  const { realpathSync, readFileSync, lstatSync } = require("node:fs");
  const { homedir } = require("node:os");
  const { join, relative, isAbsolute } = require("node:path");
  const root = join(
    homedir(),
    "Library/Developer/CoreSimulator/Devices",
    id,
    "data"
  );
  if (["76CA", "7F25", "443F", "DF19"].some((prefix) => id.startsWith(prefix)))
    throw new Error(
      "Protected original account profiles may not be used for QA"
    );
  if (process.env.VEYRAN_QA_AUTH_UPGRADE === "1") {
    const receiptPath = process.env.VEYRAN_QA_AUTH_UPGRADE_RECEIPT;
    const qaRoot = join(homedir(), "Notesnook/qa");
    if (!receiptPath || !isAbsolute(receiptPath))
      throw new Error(
        "Authenticated upgrade requires its native creation receipt"
      );
    const receiptSuffix = relative(qaRoot, realpathSync(receiptPath));
    if (
      receiptSuffix.startsWith("../") ||
      isAbsolute(receiptSuffix) ||
      lstatSync(receiptPath).isSymbolicLink() ||
      lstatSync(receiptPath).mode & 0o077
    )
      throw new Error(
        "Authenticated upgrade requires a private external receipt"
      );
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (
      receipt.schema !== 1 ||
      receipt.creationMethod !== "simctl-create" ||
      receipt.deviceId !== id ||
      receipt.deviceRoot !== join(root, "..") ||
      !Array.isArray(receipt.preexistingDeviceIds) ||
      !receipt.preexistingDeviceIds.length ||
      receipt.preexistingDeviceIds.includes(id) ||
      !receipt.deviceName?.startsWith("VEYRAN-AUTH-UPGRADE-")
    )
      throw new Error("Authenticated upgrade requires its new native device");
    const inventory = JSON.parse(
      execFileSync("xcrun", ["simctl", "list", "devices", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
    );
    const entry = Object.values(inventory.devices)
      .flat()
      .find((item) => item.udid === id);
    if (!entry || entry.name !== receipt.deviceName)
      throw new Error(
        "Authenticated upgrade receipt does not match native metadata"
      );
  }
  for (const kind of ["app", "data", "group.com.ozel0t.note.notesnookpencil"]) {
    const path = execFileSync(
      "xcrun",
      [
        "simctl",
        "get_app_container",
        id,
        "com.ozel0t.note.notesnookpencil",
        kind
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
    const suffix = relative(root, realpathSync(path));
    if (
      realpathSync(path) !== path ||
      suffix.startsWith("../") ||
      isAbsolute(suffix)
    )
      throw new Error(
        "Account QA container is not owned by its disposable device"
      );
  }
}

module.exports = {
  testRunner: {
    args: {
      $0: "jest",
      config: "e2e/jest.config.js"
    },
    jest: {
      setupTimeout: 120000
    }
  },
  apps: {
    "ios.debug": {
      type: "ios.app",
      binaryPath:
        "ios/build/Build/Products/Debug-iphonesimulator/Notesnook.app",
      build:
        "xcodebuild -workspace ios/Notesnook.xcworkspace -scheme YOUR_APP -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build"
    },
    "ios.release": {
      type: "ios.app",
      binaryPath:
        process.env.VEYRAN_QA_APP_PATH ||
        "ios/build/Build/Products/Release-iphonesimulator/Notesnook.app",
      build:
        "xcodebuild -workspace ios/Notesnook.xcworkspace -scheme NotesnookRelease -configuration Release -sdk iphonesimulator ARCHS=arm64 -derivedDataPath ios/build CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-"
    },
    "android.debug": {
      type: "android.apk",
      binaryPath: "android/app/build/outputs/apk/debug/app-arm64-v8a-debug.apk",
      testBinaryPath:
        "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
      build:
        "cd android ; ENVFILE=.env.test ./gradlew assembleDebug assembleAndroidTest -DtestBuildType=debug -PreactNativeArchitectures=arm64-v8a && cd ..",
      reversePorts: [8081]
    },
    "android.release": {
      type: "android.apk",
      binaryPath:
        "android/app/build/outputs/apk/release/app-arm64-v8a-release.apk",
      testBinaryPath:
        "android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk",
      build:
        "cd android ; ENVFILE=.env.test ./gradlew assembleRelease assembleAndroidTest -DtestBuildType=release ; cd .."
    }
  },
  devices: {
    simulator: {
      type: "ios.simulator",
      device: {
        ...(process.env.VEYRAN_QA_DEVICE_ID
          ? { id: process.env.VEYRAN_QA_DEVICE_ID }
          : { type: "iPhone 17 Pro Max" })
      }
    },
    attached: {
      type: "android.attached",
      device: {
        adbName: ".*"
      }
    },
    emulator: {
      type: "android.emulator",
      device: {
        avdName: "Pixel_5_API_36"
      }
    }
  },
  configurations: {
    "ios.sim.debug": {
      device: "simulator",
      app: "ios.debug"
    },
    "ios.sim.release": {
      device: "simulator",
      app: "ios.release"
    },
    "android.att.debug": {
      device: "attached",
      app: "android.debug"
    },
    "android.att.release": {
      device: "attached",
      app: "android.release"
    },
    "android.emu.debug": {
      device: "emulator",
      app: "android.debug"
    },
    "android.emu.release": {
      device: "emulator",
      app: "android.release"
    }
  }
};
