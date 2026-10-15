/* SPDX-License-Identifier: GPL-3.0-or-later */
import React, { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import StarterKit from "@tiptap/starter-kit";
import { Editor as TiptapEditor } from "@tiptap/core";
import { Toolbar } from "../../toolbar.js";
import { showMacInsertMenu } from "../block.js";
import { useToolbarStore } from "../../stores/toolbar-store.js";
import {
  getPopupDismissToken,
  dismissPopupForOwner
} from "../../../components/popup-presenter/index.js";
import type { Editor } from "../../../types.js";

// Production menu construction, editor commands, owned React roots and token
// registry are real. Only responsive menu chrome/positioning is a DOM seam;
// the actual Mac native entry and geometry require isolated runtime QA.
void Toolbar;
vi.mock("@notesnook/intl", () => ({
  strings: new Proxy({}, { get: (_, key) => () => String(key) })
}));
const seen = vi.hoisted(() => ({ items: [] as any[] }));
vi.mock("../../../components/responsive/index.js", () => ({
  ResponsivePresenter: function Presenter({
    isOpen,
    items = [],
    onClose
  }: any) {
    seen.items = items;
    const [nested, setNested] = React.useState<any[] | null>(null);
    return isOpen ? (
      <section role="menu" aria-label="Insert">
        <button onClick={onClose}>Cancel</button>
        {(nested || items)
          .filter((item: any) => !item.isHidden && item.type === "button")
          .map((item: any) => (
            <button
              key={item.key}
              data-action={item.key}
              disabled={item.isDisabled}
              onClick={() => {
                if (item.menu) setNested(item.menu.items);
                else {
                  item.onClick?.();
                  onClose();
                }
              }}
            >
              {item.title}
            </button>
          ))}
      </section>
    ) : null;
  },
  DesktopOnly: ({ children }: any) => children,
  MobileOnly: () => null,
  ResponsiveContainer: ({ desktop }: any) => desktop
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const editors: TiptapEditor[] = [];
afterEach(() => {
  act(() => editors.splice(0).forEach((editor) => editor.destroy()));
  document.body.innerHTML = "";
  useToolbarStore.setState({ macCatalyst: false, isMobile: false });
});
function setup() {
  const root = document.createElement("section");
  root.className = "active";
  const owner = document.createElement("div");
  owner.className = "dialogContainer";
  const mount = document.createElement("div");
  root.append(owner, mount);
  document.body.append(root);
  const editor = new TiptapEditor({
    element: mount,
    extensions: [StarterKit],
    content: "<p>Alpha Bravo</p>"
  });
  editors.push(editor);
  useToolbarStore.setState({ macCatalyst: true });
  editor.commands.setTextSelection({ from: 2, to: 6 });
  return {
    root,
    owner,
    editor,
    open: () => {
      let result = false;
      act(() => {
        result = showMacInsertMenu(editor as Editor);
      });
      return result;
    }
  };
}
describe("native Mac Insert menu rendering", () => {
  test("repeated native activation toggles one menu instead of stacking duplicates", () => {
    const { owner, open, editor } = setup();
    const before = editor.getHTML();
    expect(open()).toBe(true);
    expect(owner.childElementCount).toBe(1);
    expect(open()).toBe(true);
    expect(owner.childElementCount).toBe(0);
    expect(getPopupDismissToken(owner)).toBeUndefined();
    expect(editor.getHTML()).toBe(before);
    expect(open()).toBe(true);
    expect(owner.childElementCount).toBe(1);
  });
  test.each([true, false])(
    "uses the same camera capability rule as the existing toolbar (mobile=%s)",
    (mobile) => {
      const { owner, open } = setup();
      useToolbarStore.setState({ isMobile: mobile });
      open();
      act(() =>
        owner
          .querySelector<HTMLButtonElement>('button[data-action="image"]')!
          .click()
      );
      expect(!!owner.querySelector('button[data-action="camera"]')).toBe(
        mobile
      );
    }
  );
  test("nested attachment action stays reachable and ignores callbacks from a closed or changed menu", () => {
    const { editor, owner, open } = setup();
    const picker = vi.fn();
    editor.storage.openAttachmentPicker = picker;
    open();
    const image = seen.items.find((item) => item.key === "image");
    const oldAction = image.menu.items.find(
      (item: any) => item.key === "upload-from-disk"
    ).onClick;
    act(() =>
      owner
        .querySelector<HTMLButtonElement>('button[data-action="image"]')!
        .click()
    );
    act(() =>
      owner
        .querySelector<HTMLButtonElement>(
          'button[data-action="upload-from-disk"]'
        )!
        .click()
    );
    expect(picker).toHaveBeenCalledWith("image");
    oldAction();
    expect(picker).toHaveBeenCalledTimes(1);
    open();
    const currentImage = seen.items.find((item) => item.key === "image");
    const stale = currentImage.menu.items.find(
      (item: any) => item.key === "upload-from-disk"
    ).onClick;
    act(() => editor.commands.setTextSelection(8));
    stale();
    expect(picker).toHaveBeenCalledTimes(1);
  });
  test("renders existing reachable actions without altering the document or selection", () => {
    const { editor, owner, open } = setup();
    const before = editor.getHTML();
    expect(open()).toBe(true);
    expect(owner.querySelector('[role="menu"]')).not.toBeNull();
    expect(
      owner.querySelector('button[data-action="external-link"]')?.textContent
    ).toBe("insertLink");
    expect(
      owner.querySelector('button[data-action="table"]')?.textContent
    ).toBe("table");
    expect(editor.getHTML()).toBe(before);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.selection.to).toBe(6);
    const token = getPopupDismissToken(owner)!;
    act(() => {
      expect(dismissPopupForOwner(owner, token)).toBe(true);
    });
    expect(owner.childElementCount).toBe(0);
    expect(editor.getHTML()).toBe(before);
    expect(open()).toBe(true);
    expect(owner.childElementCount).toBe(1);
    expect(getPopupDismissToken(owner)).not.toBe(token);
    expect(getPopupDismissToken(owner)).toBeDefined();
    expect(open()).toBe(true);
    expect(owner.childElementCount).toBe(0);
  });
  test("a rendered action runs the original editor command and remains undoable", () => {
    const { editor, owner, open } = setup();
    const before = editor.getHTML();
    open();
    act(() =>
      owner
        .querySelector<HTMLButtonElement>('button[data-action="hr"]')!
        .click()
    );
    expect(editor.getHTML()).toContain("<hr");
    expect(owner.childElementCount).toBe(0);
    editor.commands.undo();
    expect(editor.getHTML()).toBe(before);
  });
  test("readonly, detached, destroyed and non-Mac editors never open a menu", () => {
    const { editor, root, owner, open } = setup();
    editor.setEditable(false);
    expect(open()).toBe(false);
    editor.setEditable(true);
    useToolbarStore.setState({ macCatalyst: false });
    expect(open()).toBe(false);
    useToolbarStore.setState({ macCatalyst: true });
    root.remove();
    expect(open()).toBe(false);
    editor.destroy();
    expect(open()).toBe(false);
    expect(owner.childElementCount).toBe(0);
  });
  test("selection or editability changes close the stale menu without mutating text", () => {
    const { editor, owner, open } = setup();
    const before = editor.getHTML();
    open();
    act(() => editor.commands.setTextSelection(8));
    expect(owner.childElementCount).toBe(0);
    open();
    act(() => editor.setEditable(false));
    expect(owner.childElementCount).toBe(0);
    expect(editor.getHTML()).toBe(before);
  });
});
