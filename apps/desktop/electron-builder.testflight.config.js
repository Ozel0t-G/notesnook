/* Private VeyraN macOS TestFlight distribution. Do not use the upstream app ID. */
const base = require("./electron-builder.config.js");

// Apple requires a shared bundle ID for iOS and macOS in one app record.
const appId = "com.ozel0t.note.notesnookpencil";
const teamId = "QXCNJY73A8";
const bundleVersion = process.env.VEYRAN_MAC_BUILD_NUMBER;
const provisioningProfile = process.env.VEYRAN_MAC_PROVISIONING_PROFILE;

if (
  !bundleVersion ||
  !/^[1-9]\d{0,9}$/.test(bundleVersion) ||
  Number(bundleVersion) > 4294967295
) {
  throw new Error("VEYRAN_MAC_BUILD_NUMBER must be a positive 32-bit integer");
}
if (!provisioningProfile) {
  throw new Error("VEYRAN_MAC_PROVISIONING_PROFILE must point to the Mac App Store profile");
}

module.exports = {
  ...base,
  appId,
  productName: "VeyraN",
  forceCodeSigning: true,
  artifactName: `VeyraN-${bundleVersion}-\${arch}.\${ext}`,
  mac: {
    ...base.mac,
    target: [{ target: "mas", arch: ["arm64"] }],
    minimumSystemVersion: "13.0",
    bundleVersion,
    provisioningProfile,
    notarize: false,
    extendInfo: {
      ElectronTeamID: teamId,
      NSHumanReadableCopyright: `Copyright © ${new Date().getFullYear()} Streetwriters (Private) Limited and VeyraN contributors`,
      ITSAppUsesNonExemptEncryption: false
    }
  },
  mas: {
    ...base.mas,
    preAutoEntitlements: false,
    entitlements: "assets/entitlements.mas.testflight.plist",
    entitlementsInherit: "assets/entitlements.mas.testflight.inherit.plist",
    entitlementsLoginHelper: "assets/entitlements.mas.loginhelper.plist"
  },
  directories: {
    ...base.directories,
    output: "output/testflight-macos"
  },
  extraMetadata: {
    ...base.extraMetadata,
    appAppleId: "6813860928"
  },
  publish: []
};
