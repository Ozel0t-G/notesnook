# Generated Icon Composer previews

`Preview_Default.png`, `Preview_Dark.png`, and `Preview_Tinted.png` are 1024-pixel preview exports supplied alongside the canonical `apps/mobile/ios/Notesnook/AppIcon.icon/` document. They are derivative renderings for consumers that cannot read `.icon`; edit the `.icon` document, not these files.

On a Mac with release Xcode 27, export the three previews again from Icon Composer after changing the master, place the exports here, then run `node scripts/generate-veyran-icons.mjs` from the repository root. The script uses Xcode's `actool` to generate Electron's ICNS directly from `.icon`, and resizes the preview exports for Electron, web, Widget, and splash consumers. Review the resulting images at 1× and high DPI before shipping.
