/*
 * FENCED: this private Electron Mac App Store config is retired for the VeyraN
 * record. It produced "VeyraN-<build>-arm64.pkg" for App Store Connect record
 * 6813860928 (bundle id com.ozel0t.note.notesnookpencil), which must now ship the
 * native Mac Catalyst VeyraN UI instead of Electron.
 *
 * Intentionally unusable: there is no override flag or environment variable. If
 * electron-builder loads this file it fails immediately, so no Electron package
 * can be recreated or uploaded for that record. The normal desktop configs
 * (electron-builder.config.js) are untouched.
 *
 * Canonical Mac release path:
 *   scripts/build-pencil-testflight.sh --mac --upload
 */
throw new Error(
  "electron-builder.testflight.config.js is disabled: App Store Connect record " +
    "6813860928 (com.ozel0t.note.notesnookpencil) must ship the native Mac " +
    "Catalyst VeyraN UI, not Electron. Use scripts/build-pencil-testflight.sh " +
    "--mac --upload."
);
