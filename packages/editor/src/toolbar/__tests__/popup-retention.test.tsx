// SPDX-License-Identifier: GPL-3.0-or-later
/** Real PopupWrapper -> real UI PopupPresenter -> real react-modal portal.
 * Theme scope and layout observation are peripheral seams; no pixel claim. */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@theme-ui/core";
import { afterEach, expect, test, vi } from "vitest";
import { PopupWrapper } from "../../components/popup-presenter/index.js";
import { usePopupManager, useToolbarStore } from "../stores/toolbar-store.js";
vi.mock("@notesnook/theme", async () => {
  const actual = await vi.importActual<typeof import("@notesnook/theme")>(
    "@notesnook/theme"
  );
  return {
    ...actual,
    EmotionThemeProvider: ({ children }: { children: React.ReactNode }) =>
      children
  };
});
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const oldObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;
let openRow: () => void;
let openAa: () => void;
function PopupPair() {
  const first = usePopupManager({ id: "row-more", group: "mobile" });
  const second = usePopupManager({ id: "aa-more", group: "mobile" });
  openRow = first.open;
  openAa = second.open;
  return (
    <>
      <PopupWrapper
        id="row-more"
        group="mobile"
        position={{ target: host!, location: "below" }}
      >
        <button id="tool-shared-color">Row color</button>
      </PopupWrapper>
      <PopupWrapper
        id="aa-more"
        group="mobile"
        position={{ target: host!, location: "below" }}
      >
        <button id="tool-shared-color">Aa color</button>
      </PopupWrapper>
    </>
  );
}
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  globalThis.ResizeObserver = oldObserver;
  useToolbarStore.setState({ openedPopups: {} });
});
test("a closed actual portal unmounts its tool before a sibling popup becomes active", async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  useToolbarStore.setState({ isMobile: true, openedPopups: {} });
  await act(async () => {
    root!.render(
      <ThemeProvider theme={{}}>
        <PopupPair />
      </ThemeProvider>
    );
  });
  expect(document.querySelectorAll("#tool-shared-color")).toHaveLength(0);
  await act(async () => {
    openRow();
  });
  expect(document.querySelectorAll("#tool-shared-color")).toHaveLength(1);
  expect(document.querySelector("#tool-shared-color")?.textContent).toBe(
    "Row color"
  );
  await act(async () => {
    openAa();
  });
  expect(document.querySelectorAll("#tool-shared-color")).toHaveLength(1);
  expect(document.querySelector("#tool-shared-color")?.textContent).toBe(
    "Aa color"
  );
  await act(async () => {
    useToolbarStore.getState().closePopup("aa-more");
  });
  expect(document.querySelectorAll("#tool-shared-color")).toHaveLength(0);
});
