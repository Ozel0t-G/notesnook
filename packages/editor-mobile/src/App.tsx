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

import "./polyfill";
import {
  getPopupDismissToken,
  dismissPopupForOwner,
  showMacInsertMenu,
  showMacFormattingMenu
} from "@notesnook/editor";
import { registerEditorPopupCommands } from "./utils/commands";
import { Global, css } from "@emotion/react";
import {
  getThemeScope,
  resolveAppleSurfaces,
  ScopedThemeProvider,
  ThemeDefinition,
  themeToCSS,
  useThemeEngineStore
} from "@notesnook/theme";
import React, { useEffect, useMemo } from "react";
import { Freeze } from "react-freeze";
import "./App.css";
import Tiptap from "./components/editor";
import { TabContext, useTabStore } from "./hooks/useTabStore";
import { EmotionEditorTheme } from "./theme-factory";
import { getTheme } from "./utils";
import { injectCss, transform } from "./utils/css";
import { ReadonlyEditorProvider } from "./components/readonly-editor";

// App is required by loadApp after locale/Buffer setup. Share these exact ESM
// callbacks with the early command entry; never load a second CJS editor.
registerEditorPopupCommands({
  getPopupDismissToken,
  dismissPopupForOwner,
  showMacInsertMenu,
  showMacFormattingMenu
});

/**
 * The theme the native app is showing right now, injected into the WebView
 * before this bundle runs (see `apps/mobile/app/screens/editor/index.tsx`).
 * It follows the system appearance, so it is newer than the copy the webview
 * cached in a previous session. Without it the first frame would paint the
 * previous session's theme: the CSS custom properties (`--nn_*`) the editor's
 * sticky header reads are only injected by each tab's controller, i.e. in an
 * effect *after* the first paint.
 */
const currentTheme = globalThis.DEFAULT_THEME || getTheme();
if (currentTheme) {
  useThemeEngineStore.getState().setTheme(currentTheme);
  // Paint the custom properties before React renders anything so the first
  // frame - the editor header in particular - already uses the current theme.
  injectCss(transform(getThemeScope("editor", currentTheme).colors));
}

/**
 * The editor page's surface: the *document* role of the resolved Apple surfaces
 * (`theme-engine/apple-surfaces.ts` in `@notesnook/theme`), which is also what
 * the native editor pane, its wrapper and the KeyboardAvoidingView behind it
 * paint. One resolver, so the page inside the WebView and the native pane
 * cannot drift apart.
 *
 * The page is neutral: on the bundled VeyraN appearances it is the standard
 * document tone (`#FFFFFF` light / `#18181B` dark) and no accent is mixed into
 * it, while an imported/custom theme keeps its own authored background. The
 * role is exposed to `index.css` as `--nn_document_surface`; the old
 * `--nn_mac_window_background` name is still written for a page/CSS pair that
 * was cached from before the rename.
 *
 * Called once at module load for the first paint and again whenever the
 * runtime theme changes (see `GlobalStyles`).
 */
function applyEditorDocumentSurface(theme: ThemeDefinition | undefined) {
  const surfaces = resolveAppleSurfaces({
    theme,
    colors: theme ? getThemeScope("editor", theme).colors : undefined,
    isDark: theme?.colorScheme === "dark"
  });
  const root = document.documentElement.style;
  root.setProperty("--nn_document_surface", surfaces.documentSurface);
  root.setProperty("--nn_mac_window_background", surfaces.documentSurface);
}

/**
 * Whether the WebView is embedded in an Apple client (iPhone, iPad or Mac
 * Catalyst). `__PLATFORM__` is injected by the native app before the bundle
 * runs (apps/mobile/app/screens/editor/index.tsx); Mac Catalyst is an iOS
 * build, so it reports `"ios"` too. `isMacCatalyst` is the pre-existing signal
 * and is kept as a belt-and-braces fallback for any cached injected page.
 * Android and every other host are not Apple.
 */
const isApplePlatform =
  globalThis.__PLATFORM__ === "ios" || globalThis.isMacCatalyst === true;

/**
 * Apple: mark the page so `index.css` paints the WebView's html/body with the
 * resolved document surface, matching the native editor pane it fills. The
 * class is added on every Apple client, not just the Mac (it keeps its old
 * `mac-catalyst` name for pages cached before this change), so iPad and iPhone
 * receive the same document role the Mac does. Android and every other host
 * never get the class, so their page stays transparent and the native wrapper's
 * own surface keeps showing through.
 */
if (isApplePlatform) {
  document.documentElement.classList.add("mac-catalyst");
  applyEditorDocumentSurface(currentTheme);
}

class ExceptionHandler extends React.Component<{
  children: React.ReactNode;
  component: string;
}> {
  state: {
    error: Error | null;
    hasError: boolean;
  } = {
    hasError: false,
    error: null
  };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error };
  }

  componentDidCatch(_error: Error) {
    // A custom error logging function
    post("editorError", {
      message: "Editor crashed: " + _error.message,
      stack: _error.stack
    });
  }

  render() {
    return this.state.hasError ? (
      <div
        style={{
          color: "red",
          fontSize: 18,
          width: "100%",
          display: "flex",
          padding: "50px 25px",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 10
        }}
      >
        <h3
          style={{
            marginBottom: 0
          }}
        >
          An error occurred.
        </h3>

        <button
          style={{
            borderRadius: 5,
            boxSizing: "border-box",
            border: "none",
            backgroundColor: "red",
            width: 300,
            fontSize: "0.9em",
            height: 45,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            columnGap: 5,
            userSelect: "none"
          }}
          onClick={() => {
            if (!this.state.error) return;
            post("editorError", {
              message: "Editor crashed: " + this.state.error.message,
              stack: this.state.error.stack
            });
          }}
        >
          <p
            style={{
              userSelect: "none",
              color: "white"
            }}
          >
            Report error
          </p>
        </button>

        <button
          style={{
            borderRadius: 5,
            boxSizing: "border-box",
            border: "none",
            backgroundColor: "red",
            width: 300,
            fontSize: "0.9em",
            height: 45,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            columnGap: 5,
            userSelect: "none"
          }}
          onClick={() => {
            window.location.reload();
          }}
        >
          <p
            style={{
              userSelect: "none",
              color: "white"
            }}
          >
            Reload editor
          </p>
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}

function App(): JSX.Element {
  const tabs = useTabStore((state) => state.tabs);
  const currentTab = useTabStore((state) => state.currentTab);

  return (
    <ScopedThemeProvider value="base">
      <EmotionEditorTheme>
        <GlobalStyles />

        {globalThis["readonlyEditor"] ? (
          <ReadonlyEditorProvider />
        ) : (
          tabs.map((tab) => (
            <TabContext.Provider key={tab.id} value={tab}>
              <Freeze freeze={currentTab !== tab.id}>
                <Tiptap />
              </Freeze>
            </TabContext.Provider>
          ))
        )}
      </EmotionEditorTheme>
    </ScopedThemeProvider>
  );
}

export const withErrorBoundry = (Element: React.ElementType, name: string) => {
  return function ErrorBoundary() {
    return (
      <ExceptionHandler component={name}>
        <Element />
      </ExceptionHandler>
    );
  };
};

export default withErrorBoundry(App, "Editor");

function GlobalStyles() {
  const theme = useThemeEngineStore((store) => store.theme);
  useEffect(() => {
    // Every Apple client repaints the page when the runtime theme (or
    // appearance) changes, not just the Mac.
    if (isApplePlatform) applyEditorDocumentSurface(theme);
  }, [theme]);
  const cssTheme = useMemo(() => themeToCSS(theme), [theme]);
  return (
    <>
      <Global
        styles={css`
          ${cssTheme}
        `}
      />
    </>
  );
}
