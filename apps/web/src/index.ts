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

import "./polyfills";
import "./app.css";
import { AppEventManager, AppEvents } from "./common/app-events";
import { register } from "./service-worker-registration";
import { getServiceWorkerVersion } from "./utils/version";
import { register as registerStreamSaver } from "./utils/stream-saver/mitm";
import {
  ThemeVeyranDark,
  ThemeVeyranLight,
  themeToCSS
} from "@notesnook/theme";
import Config from "./utils/config";
import { setI18nGlobal, Messages } from "@notesnook/intl";
import { i18n } from "@lingui/core";

// Fresh installs (no persisted `colorScheme` yet) paint using the live OS
// preference instead of hardcoding light, so System appearance doesn't
// flash the wrong scheme on first launch. This mirrors the same OS check
// `ThemeStore`'s field initializers make in `stores/theme-store.ts`.
const prefersDarkOS =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;
const colorScheme = JSON.parse(
  window.localStorage.getItem("colorScheme") ||
    JSON.stringify(prefersDarkOS ? "dark" : "light")
);
const root = document.querySelector("html");
if (root) root.setAttribute("data-theme", colorScheme);

// A persisted theme whose `id` is still the shipped old default (i.e. never
// customized, or explicitly re-picked the old default) paints as its VeyraN
// equivalent here too, so the one-time migration in `ThemeStore.init()`
// doesn't cause a flash of the old theme on the upgrade's first load. Any
// other persisted theme id (a marketplace or custom theme) paints as-is.
const rawTheme =
  colorScheme === "dark"
    ? Config.get("theme:dark", ThemeVeyranDark)
    : Config.get("theme:light", ThemeVeyranLight);
const theme =
  rawTheme.id === "default-dark"
    ? ThemeVeyranDark
    : rawTheme.id === "default-light"
    ? ThemeVeyranLight
    : rawTheme;
const stylesheet = document.getElementById("theme-colors");
if (theme) {
  const css = themeToCSS(theme);
  if (stylesheet) stylesheet.innerHTML = css;
} else stylesheet?.remove();

const locale = import.meta.env.DEV
  ? import("@notesnook/intl/locales/$pseudo-LOCALE.json")
  : import("@notesnook/intl/locales/$en.json");
locale.then(({ default: locale }) => {
  i18n.load({
    en: locale.messages as unknown as Messages
  });
  i18n.activate("en");

  performance.mark("import:root");
  import("./root").then(({ startApp }) => {
    performance.mark("start:app");
    startApp();
  });
});
setI18nGlobal(i18n);

if (!IS_DESKTOP_APP) {
  //   logger.info("Initializing service worker...");

  // If you want your app to work offline and load faster, you can change
  // unregister() to register() below. Note this comes with some pitfalls.
  // Learn more about service workers: https://bit.ly/CRA-PWA
  register({
    onUpdate: async (registration: ServiceWorkerRegistration) => {
      if (!registration.waiting) return;
      const { formatted } = await getServiceWorkerVersion(registration.waiting);
      AppEventManager.publish(AppEvents.updateDownloadCompleted, {
        version: formatted
      });
    },
    onSuccess() {
      registerStreamSaver();
    }
  });

  // window.addEventListener("beforeinstallprompt", () => showInstallNotice());
}
