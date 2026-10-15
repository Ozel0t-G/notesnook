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

import { resolveToolbarGroups } from "@notesnook/editor";
import { useEffect, useState } from "react";
import { Settings } from "../utils";

const settingsJson = localStorage.getItem("editorSettings");
// Set before the bundle runs (see `apps/mobile/app/screens/editor/index.tsx`);
// false on iPhone and iPad. Read once, from the same host global the settings
// controller uses below, so the first frame and every later update agree.
const isMacCatalyst = globalThis.isMacCatalyst ?? false;
/**
 * The host's compact iPhone/iPad toolbar opt-in. `__PLATFORM__` is injected by
 * the native app before this bundle runs and is `"ios"` for iPhone, iPad and
 * Mac Catalyst; Mac Catalyst is normalized off (the Mac format bar always
 * wins), and every other or unknown host stays `false`.
 */
const isIosHost = globalThis.__PLATFORM__ === "ios" && !isMacCatalyst;
const initialState: Partial<Settings> = {
  fullscreen: false,
  deviceMode: "mobile",
  isMacCatalyst,
  premium: false,
  /**
   * A session without any cached `editorSettings` starts from the explicit
   * `default` preset and the *host* default groups, so the very first frame
   * already lays out the right toolbar (Mac Catalyst gets the Notes-style
   * format bar, the iOS host the compact iPhone/iPad bar). A cached payload
   * keeps whatever it stored: a legacy payload without `toolbarPreset` is
   * honored by exact groups, never guessed into a preset by comparing arrays.
   */
  toolbarPreset: "default",
  tools: resolveToolbarGroups({
    toolbarPreset: "default",
    macCatalyst: isMacCatalyst,
    ios: isIosHost
  }),
  noToolbar: globalThis.noToolbar,
  noHeader: globalThis.noHeader,
  readonly: globalThis.readonly,
  doubleSpacedLines: true,
  fontFamily: "sans-serif",
  fontSize: 16,
  timeFormat: "12-hour",
  dateFormat: "DD-MM-YYYY",
  loggedIn: false,
  defaultLineHeight: 1.2
};

global.settingsController = {
  update: (settings) => {
    const nextSettings = {
      ...settings,
      // Mac Catalyst's editor chrome (see `utils/mac.ts`) is a property of the
      // window, so a settings object cached by an older session cannot turn it
      // off. `??` keeps the value boolean (the global is absent in WebViews
      // that do not inject it).
      isMacCatalyst: globalThis.isMacCatalyst ?? settings.isMacCatalyst,
      noToolbar: globalThis.noToolbar || settings.noToolbar,
      noHeader: globalThis.noHeader || settings.noHeader,
      readonly: globalThis.readonly || settings.readonly
    };
    if (
      JSON.stringify(nextSettings) ===
      JSON.stringify(global.settingsController.previous)
    ) {
      return;
    }
    if (global.settingsController.set)
      global.settingsController.set(nextSettings);
    if (settings) {
      localStorage.setItem("editorSettings", JSON.stringify(nextSettings));
    } else {
      localStorage.removeItem("editorSettings");
    }
    settingsController.previous = { ...nextSettings };
  },
  previous: settingsJson ? JSON.parse(settingsJson) : { ...initialState }
};
global.settingsController.previous.noHeader = globalThis.noHeader;
global.settingsController.previous.noToolbar = globalThis.noToolbar;
global.settingsController.previous.readonly = globalThis.readonly;
// The cached settings of a session that predates the Mac editor chrome would
// otherwise lay the first frame out for iPhone/iPad.
global.settingsController.previous.isMacCatalyst =
  globalThis.isMacCatalyst ?? global.settingsController.previous.isMacCatalyst;

export const useSettings = (): Settings => {
  const [settings, setSettings] = useState({
    ...global.settingsController.previous
  });
  global.settingsController.set = setSettings;

  useEffect(() => {
    setSettings((current) =>
      JSON.stringify(current) ===
      JSON.stringify(global.settingsController.previous)
        ? current
        : { ...global.settingsController.previous }
    );
  }, []);

  return settings;
};
