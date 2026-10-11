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
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ScopedThemeProvider, useThemeEngineStore } from "@notesnook/theme";
import React, { PropsWithChildren, useEffect, useState } from "react";
import { Appearance, I18nManager, Linking, StatusBar } from "react-native";
import "react-native-gesture-handler";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import DialogProvider from "./components/dialog-provider";
import { MacNoteCommands } from "./components/mac-note-commands";
import { withErrorBoundry } from "./components/exception-handler";
import GlobalSafeAreaProvider from "./components/globalsafearea";
import { Toast } from "./components/toast";
import { useAppEvents } from "./hooks/use-app-events";
import { useMacMenuCommands } from "./hooks/use-mac-menu-commands";
import { useMacSystemState } from "./hooks/use-mac-system-state";
import { useMacWindowTitle } from "./hooks/use-mac-window-title";
import { NotePreviewConfigure } from "./screens/note-preview-configure";
import { RootNavigation } from "./navigation/navigation-stack";
import Notifications from "./services/notifications";
import SettingsService from "./services/settings";
import { TipManager } from "./services/tip-manager";
import {
  changeSystemBarColors,
  getEffectiveTheme,
  useThemeStore
} from "./stores/use-theme-store";
import { useUserStore } from "./stores/use-user-store";
import { syncMacWindowAppearance } from "./utils/mac-window-appearance";
import RNBootSplash from "react-native-bootsplash";
import AppLocked from "./components/app-lock";
import { useSettingStore } from "./stores/use-setting-store";
import {
  initShortcutListener,
  launchNewNoteTab,
  registerAppShortcuts
} from "./hooks/use-shortcut-manager";
import Shortcuts from "react-native-actions-shortcuts";
I18nManager.allowRTL(false);
I18nManager.forceRTL(false);
I18nManager.swapLeftAndRightInRTL(false);

const { appLockEnabled, appLockMode } = SettingsService.get();
if (appLockEnabled || appLockMode !== "none") {
  useUserStore.getState().lockApp(true);
}

const App = (props: { configureMode: "note-preview" }) => {
  useAppEvents();
  useMacMenuCommands();
  // W4: the window's title/subtitle (section, focused list, open note) follows
  // the same chrome the menu commands drive. Inert off Mac Catalyst.
  useMacWindowTitle();
  // F1/N4/S1: the system accent and key-window state the Mac selection
  // highlights follow. Inert off Mac Catalyst.
  useMacSystemState();
  //@ts-ignore
  globalThis["IS_MAIN_APP_RUNNING"] = true;
  const introCompleted = useSettingStore(
    (state) => state.settings.introCompleted
  );

  useEffect(() => {
    if (introCompleted) {
      registerAppShortcuts();
    }
  }, [introCompleted]);

  useEffect(() => {
    RNBootSplash.hide({ fade: true });
    SettingsService.onFirstLaunch();
    changeSystemBarColors();
    SettingsService.setPrivacyScreen(
      SettingsService.getProperty("privacyScreen")
    );
    setTimeout(async () => {
      await Notifications.get();
      if (SettingsService.get().notifNotes) {
        Notifications.pinQuickNote();
      }
      TipManager.init();
    }, 100);
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar translucent={true} backgroundColor="transparent" />
      <GestureHandlerRootView
        style={{
          height: "100%",
          width: "100%"
        }}
      >
        <GlobalSafeAreaProvider />
        {props.configureMode === "note-preview" ? (
          <NotePreviewConfigure />
        ) : (
          <RootNavigation />
        )}
        {/* The Mac menu bar's "Note" menu (Pin / Add to Favorites / Move to
            Trash) runs the open note's item actions; this publishes them.
            Renders nothing, and only mounts a host while a note is open. */}
        <MacNoteCommands />
        <ScopedThemeProvider value="dialog">
          <Toast />
        </ScopedThemeProvider>
        <DialogProvider />
        <AppLocked />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
};

// The engine renders the *effective* theme: the user's theme with the accent
// palette applied. That is what recolors the entire app, not just the settings
// preview.
let currTheme = getEffectiveTheme(useThemeStore.getState());
useThemeEngineStore.getState().setTheme(currTheme);

export const withTheme = (
  Element: (props: PropsWithChildren) => JSX.Element
) => {
  return function AppWithThemeProvider(props: PropsWithChildren) {
    const [colorScheme, darkTheme, lightTheme] = useThemeStore((state) => [
      state.colorScheme,
      state.darkTheme,
      state.lightTheme
    ]);
    const useSystemTheme = useSettingStore(
      (state) => state.settings.useSystemTheme
    );

    useEffect(() => {
      const listener = Appearance.addChangeListener(({ colorScheme }) => {
        if (colorScheme && SettingsService.getProperty("useSystemTheme")) {
          useThemeStore.setState({
            colorScheme: colorScheme as "light" | "dark"
          });
          changeSystemBarColors();
        }
      });
      return () => {
        listener.remove();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      // The Mac window chrome (toolbar, search field, traffic lights) has to
      // follow the *app's* theme, not the system's, so it is synced here
      // whenever the app theme or the "use system theme" mode changes.
      // Everything but Mac Catalyst treats it as a no-op.
      syncMacWindowAppearance(!!useSystemTheme, colorScheme);
      const nextTheme = colorScheme === "dark" ? darkTheme : lightTheme;
      if (JSON.stringify(nextTheme) !== JSON.stringify(currTheme)) {
        useThemeEngineStore
          .getState()
          .setTheme(colorScheme === "dark" ? darkTheme : lightTheme);
        currTheme = nextTheme;
      }
    }, [colorScheme, darkTheme, lightTheme, useSystemTheme]);

    return (
      <I18nProvider i18n={i18n}>
        <Element {...props} />
      </I18nProvider>
    );
  };
};

export const withStartupBoundry = (
  Element: (props: PropsWithChildren) => JSX.Element
) => {
  return function AppWithStartupBoundary(props: PropsWithChildren) {
    const [ready, setReady] = useState(false);

    useEffect(() => {
      async function init() {
        try {
          const [url, shortcut] = await Promise.all([
            Linking.getInitialURL(),
            Shortcuts.getInitialShortcut()
          ]);
          console.log(url, shortcut);
          if (shortcut?.type === "notesnook.action.newnote") {
            launchNewNoteTab();
          }
          useSettingStore.setState({
            initialUrl: url,
            pendingShortcut: shortcut ?? null
          });

          initShortcutListener();
        } finally {
          setReady(true);
        }
      }

      init();
    }, []);

    if (!ready) return null;

    return <Element {...props} />;
  };
};

export default withStartupBoundry(withTheme(withErrorBoundry(App, "App")));
