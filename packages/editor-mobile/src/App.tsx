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

/** How much of `primary.accent` the native dark Mac window blends in. */
const MAC_DARK_WINDOW_ACCENT_TINT = 0.06;

/** The fixed soft off-white the light Mac window uses (accent ignored). */
const MAC_LIGHT_WINDOW_BACKGROUND = "#F3F3F5";

/** `#RGB`/`#RGBA`/`#RRGGBB`/`#RRGGBBAA` -> three 0-255 channels, else undefined. */
function parseHexChannels(color: string): [number, number, number] | undefined {
  if (typeof color !== "string") return undefined;
  const hex = color.trim().replace(/^#/, "");
  if (!/^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return undefined;
  const expanded =
    hex.length <= 4
      ? hex
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex;
  return [
    parseInt(expanded.slice(0, 2), 16),
    parseInt(expanded.slice(2, 4), 16),
    parseInt(expanded.slice(4, 6), 16)
  ];
}

/**
 * Blends `amount` (0..1) of `over` into `base`, returning an opaque uppercase
 * `#RRGGBB`. Any alpha is dropped; an unparseable colour returns `base`
 * unchanged. This mirrors `mixHex` in the native app's
 * `apps/mobile/app/utils/mac-layout.ts` byte-for-byte: the editor WebView and
 * the native window must compute the same surface colour, and the two packages
 * share no importable helper.
 */
function mixHex(base: string, over: string, amount: number): string {
  const from = parseHexChannels(base);
  const to = parseHexChannels(over);
  if (!from || !to) return base;
  const ratio = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  const channel = (index: number) =>
    Math.round(from[index] + (to[index] - from[index]) * ratio)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`.toUpperCase();
}

/**
 * The Mac window surface: the native window paints dark as the editor scope's
 * `primary.background` tinted with `primary.accent` at
 * `MAC_DARK_WINDOW_ACCENT_TINT` (see `macWindowBackground` in the native app's
 * utils/mac-layout.ts), and light as the fixed soft off-white
 * `MAC_LIGHT_WINDOW_BACKGROUND` instead of the theme's pure white. `index.css`
 * paints the page with this variable; an absent/unparseable accent falls back
 * to the plain primary background, matching native.
 *
 * Called once at module load for the first paint and again whenever the
 * runtime theme changes (see `GlobalStyles`).
 */
function applyMacWindowBackground(theme: ThemeDefinition | undefined) {
  let macWindowBackground = MAC_LIGHT_WINDOW_BACKGROUND;
  if (theme?.colorScheme === "dark") {
    const { background, accent } = getThemeScope("editor", theme).colors
      .primary;
    macWindowBackground = accent
      ? mixHex(background, accent, MAC_DARK_WINDOW_ACCENT_TINT)
      : background;
  }
  document.documentElement.style.setProperty(
    "--nn_mac_window_background",
    macWindowBackground
  );
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
  applyMacWindowBackground(currentTheme);
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
    if (globalThis.isMacCatalyst) applyMacWindowBackground(theme);
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
