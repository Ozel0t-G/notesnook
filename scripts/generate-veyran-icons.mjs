// Regenerate format-specific assets from the canonical Icon Composer document.
// The Preview_*.png files are Icon Composer exports, never editable masters.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const icon = path.join(root, "apps/mobile/ios/Notesnook/AppIcon.icon");
const previews = path.join(root, "resources/branding/veyran");
const output = path.join(root, "build/veyran-icon-export");
const desktop = path.join(root, "apps/desktop/assets/icons");
const web = path.join(root, "apps/web/public");
const splash = path.join(
  root,
  "apps/mobile/ios/Notesnook/Images.xcassets/BootSplashLogo.imageset"
);
const developerDir =
  process.env.DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer";

mkdirSync(output, { recursive: true });
execFileSync(
  "/usr/bin/xcrun",
  [
    "actool",
    "--compile",
    output,
    "--platform",
    "macosx",
    "--minimum-deployment-target",
    "15.0",
    "--target-device",
    "mac",
    "--app-icon",
    "AppIcon",
    "--output-partial-info-plist",
    path.join(output, "icon-info.plist"),
    icon
  ],
  { env: { ...process.env, DEVELOPER_DIR: developerDir }, stdio: "pipe" }
);
copyFileSync(path.join(output, "AppIcon.icns"), path.join(desktop, "app.icns"));

function render(preview, size, destination) {
  execFileSync(
    "/usr/bin/sips",
    [
      "-z",
      String(size),
      String(size),
      path.join(previews, preview),
      "--out",
      destination
    ],
    { stdio: "pipe" }
  );
}

for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  render("Preview_Default.png", size, path.join(desktop, `${size}x${size}.png`));
}

// ICO supports embedded PNG images; include the sizes consumed by Windows.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = icoSizes.map((size) =>
  readFileSync(path.join(desktop, `${size}x${size}.png`))
);
const header = Buffer.alloc(6 + icoSizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);
let offset = header.length;
for (const [index, size] of icoSizes.entries()) {
  const entry = 6 + index * 16;
  header.writeUInt8(size === 256 ? 0 : size, entry);
  header.writeUInt8(size === 256 ? 0 : size, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(pngs[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += pngs[index].length;
}
writeFileSync(path.join(desktop, "app.ico"), Buffer.concat([header, ...pngs]));

copyFileSync(path.join(desktop, "512x512.png"), path.join(root, "resources/icon.png"));
copyFileSync(
  path.join(desktop, "128x128.png"),
  path.join(root, "apps/mobile/app/assets/images/veyran-icon.png")
);
copyFileSync(path.join(desktop, "512x512.png"), path.join(web, "brand-icon.png"));
render("Preview_Default.png", 48, path.join(web, "favicon.png"));
render("Preview_Default.png", 180, path.join(web, "apple-touch-icon.png"));
for (const size of [192, 512]) {
  render(
    "Preview_Default.png",
    size,
    path.join(web, `android-chrome-${size}x${size}.png`)
  );
  render(
    "Preview_Default.png",
    size,
    path.join(web, `android-chrome-maskable-${size}x${size}.png`)
  );
}
for (const [size, suffix] of [
  [200, ""],
  [400, "@2x"],
  [600, "@3x"]
]) {
  render("Preview_Default.png", size, path.join(splash, `bootsplash_logo${suffix}.png`));
  render("Preview_Dark.png", size, path.join(splash, `bootsplash_logo${suffix}-1.png`));
}

console.log("Generated VeyraN derivatives from Icon Composer sources.");
