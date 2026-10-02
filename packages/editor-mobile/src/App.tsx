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
import { Global, css } from "@emotion/react";
import {
  getThemeScope,
  ScopedThemeProvider,
  themeToCSS,
  useThemeEngineStore
} from "@notesnook/theme";
import React, { useMemo } from "react";
import { Freeze } from "react-freeze";
import "./App.css";
import Tiptap from "./components/editor";
import { TabContext, useTabStore } from "./hooks/useTabStore";
import { EmotionEditorTheme } from "./theme-factory";
import { getTheme } from "./utils";
import { injectCss, transform } from "./utils/css";
import { ReadonlyEditorProvider } from "./components/readonly-editor";

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
 * Mac: mark the page so `index.css` paints the WebView's html/body with
 * `--nn_primary_background` (the editor scope's primary background, injected
 * into `:root` just above), matching the native editor wrapper and the note
 * list. `globalThis.isMacCatalyst` is injected by the native app before the
 * bundle runs (apps/mobile/app/screens/editor/index.tsx). iPhone, iPad and
 * Android never get the class, so their page stays transparent and the native
 * wrapper's own surface keeps showing through.
 */
if (globalThis.isMacCatalyst) {
  document.documentElement.classList.add("mac-catalyst");
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
