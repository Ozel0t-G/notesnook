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

import { afterEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@theme-ui/core";
import {
  showPopup,
  getPopupDismissToken,
  dismissPopupForOwner
} from "../../components/popup-presenter/index.js";
import { Popup } from "../components/popup.js";
import { useToolbarStore } from "../stores/toolbar-store.js";

vi.mock("@notesnook/theme", () => ({
  EmotionThemeProvider: ({ children }: any) => children
}));
vi.mock("@notesnook/intl", () => ({ strings: { cancel: () => "Cancel" } }));
vi.mock("@notesnook/ui", () => ({
  Icon: () => <svg aria-hidden="true" />,
  PopupPresenter: ({ children }: any) => <>{children}</>
}));
// The actual owner registry, React roots, DOM owner selection and Popup chrome
// run here. Responsive positioning/ReactModal is periphery; real QA proves it.
vi.mock("../../components/responsive/index.js", () => ({
  ResponsivePresenter: ({ children, onClose }: any) => (
    <div role="dialog">
      <button onClick={onClose}>Presenter cancel</button>
      {children}
    </div>
  )
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const hides: (() => void)[] = [];
const roots: Root[] = [];
afterEach(() => {
  act(() => {
    hides.splice(0).forEach((hide) => hide());
    roots.splice(0).forEach((root) => root.unmount());
  });
  document.body.innerHTML = "";
  useToolbarStore.setState({ isMobile: false, macCatalyst: false });
});
const owner = (active = true) => {
  const tab = document.createElement("section");
  tab.className = active ? "active" : "";
  const div = document.createElement("div");
  div.className = "dialogContainer";
  tab.appendChild(div);
  document.body.appendChild(tab);
  return { tab, div };
};
const open = (label: string, onClose = vi.fn()) => {
  let hide!: () => void;
  act(() => {
    hide = showPopup({ popup: () => <span>{label}</span>, onClose });
  });
  hides.push(hide);
  return { hide, onClose };
};
describe("owned Web popup Escape", () => {
  test("closes only the matching active owner, once, with request-close semantics", () => {
    const a = owner();
    const first = open("A");
    a.tab.classList.remove("active");
    const b = owner();
    const second = open("B");
    const token = getPopupDismissToken(b.div)!;
    act(() => {
      expect(dismissPopupForOwner(b.div, token)).toBe(true);
    });
    expect(second.onClose).toHaveBeenCalledTimes(1);
    expect(first.onClose).not.toHaveBeenCalled();
    expect(b.div.childElementCount).toBe(0);
    expect(a.div.textContent).toContain("A");
    expect(dismissPopupForOwner(b.div, token)).toBe(false);
  });
  test("an old token cannot dismiss a replacement or a later popup", () => {
    const a = owner();
    const first = open("first");
    const old = getPopupDismissToken(a.div)!;
    const second = open("second");
    const current = getPopupDismissToken(a.div)!;
    expect(current).not.toBe(old);
    expect(dismissPopupForOwner(a.div, old)).toBe(false);
    act(() => {
      expect(dismissPopupForOwner(a.div, current)).toBe(true);
    });
    expect(second.onClose).toHaveBeenCalledTimes(1);
    expect(first.onClose).not.toHaveBeenCalled();
    expect(getPopupDismissToken(a.div)).toBe(old);
  });
  test("manual close keeps its previous callback semantics and removes its owned root", () => {
    const a = owner();
    const item = open("manual");
    act(() => {
      item.hide();
      item.hide();
    });
    expect(item.onClose).not.toHaveBeenCalled();
    expect(getPopupDismissToken(a.div)).toBeUndefined();
    expect(a.div.childElementCount).toBe(0);
  });
  test("never registers the shared body fallback as a note owner", () => {
    const item = open("fallback");
    expect(getPopupDismissToken(document.body)).toBeUndefined();
    expect(dismissPopupForOwner(document.body, 1)).toBe(false);
    act(() => item.hide());
    expect(document.body.childElementCount).toBe(0);
  });
});
describe("Mac popup Cancel accessibility", () => {
  const render = (
    mobile: boolean,
    mac: boolean,
    title: string | undefined = "Insert link",
    action?: { title: string; onClick: () => void }
  ) => {
    useToolbarStore.setState({ isMobile: mobile, macCatalyst: mac });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    const close = vi.fn();
    act(() =>
      root.render(
        <ThemeProvider theme={{ colors: {}, buttons: {} }}>
          <Popup title={title} onClose={close} action={action}>
            <span>fields</span>
          </Popup>
        </ThemeProvider>
      )
    );
    return { host, close };
  };
  test("Mac retains mobile capabilities but renders labeled visible Cancel", () => {
    const { host, close } = render(true, true);
    const cancel = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Cancel"]'
    );
    expect(cancel?.textContent).toBe("Cancel");
    expect(host.textContent).toContain("Insert link");
    expect(useToolbarStore.getState().isMobile).toBe(true);
    act(() => cancel!.click());
    expect(close).toHaveBeenCalledTimes(1);
  });
  test("iPhone and iPad retain the previous mobile body without a desktop header", () => {
    const { host } = render(true, false);
    expect(host.querySelector('button[aria-label="Cancel"]')).toBeNull();
    expect(host.textContent).toBe("fields");
  });
  test("desktop web keeps its icon close with an accessible Cancel name", () => {
    const { host, close } = render(false, false);
    const cancel = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Cancel"]'
    );
    expect(cancel).not.toBeNull();
    act(() => cancel!.click());
    expect(close).toHaveBeenCalledTimes(1);
  });
  test("Mac retains primary actions even when the caller has no title", () => {
    const run = vi.fn();
    const { host } = render(true, true, "", { title: "Apply", onClick: run });
    const action = Array.from(host.querySelectorAll("button")).find(
      (item) => item.textContent === "Apply"
    );
    expect(action).toBeDefined();
    act(() => action!.click());
    expect(run).toHaveBeenCalledTimes(1);
  });
});
