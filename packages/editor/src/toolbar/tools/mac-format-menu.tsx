/* SPDX-License-Identifier: GPL-3.0-or-later */
import { Editor } from "../../types.js";
import { Flex, Text } from "@theme-ui/components";
import { strings } from "@notesnook/intl";
import { showPopup } from "../../components/popup-presenter/index.js";
import { Button } from "../../components/button.js";
import {
  getPopupAncestry,
  PopupIdScopeContext,
  PopupParentContext,
  useToolbarStore
} from "../stores/toolbar-store.js";
import { getEditorDOM } from "../utils/dom.js";
import { showLinkPopup } from "../popups/link-popup.js";
import { AdvancedFormattingSections } from "./mac-format.js";

let nextHost = 0;
let active: { editor: Editor; close: () => void } | undefined;

/** One native Aa host for the current editable document. True means handled. */
export function showMacFormattingMenu(
  editor: Editor,
  ownerScope?: {
    isCurrent: () => boolean;
    subscribe: (changed: () => void) => () => void;
  }
): boolean {
  if (
    ownerScope?.isCurrent() === false ||
    !useToolbarStore.getState().macCatalyst ||
    editor.isDestroyed ||
    !editor.isEditable ||
    !editor.view.dom.isConnected ||
    getEditorDOM() !== editor.view.dom
  )
    return false;
  const root = editor.view.dom.closest<HTMLElement>(".active");
  const owner = root?.querySelector<HTMLElement>(".dialogContainer");
  if (!root || !owner || owner === document.body) return false;
  if (active?.editor === editor) {
    active.close();
    return true;
  }
  active?.close();

  const id = `mac-native-format-${++nextHost}`;
  let closed = false;
  let hide = () => {};
  let unsubscribe = () => {};
  let unsubscribeOwner = () => {};
  const current = () =>
    !closed &&
    ownerScope?.isCurrent() !== false &&
    !editor.isDestroyed &&
    editor.isEditable &&
    owner.isConnected &&
    root.classList.contains("active") &&
    getEditorDOM() === editor.view.dom;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    unsubscribeOwner();
    observer.disconnect();
    editor.off("transaction", changed);
    editor.off("destroy", close);
    useToolbarStore.getState().closePopup(id);
    if (active?.close === close) active = undefined;
  };
  const close = () => {
    cleanup();
    hide();
  };
  const changed = () => {
    if (!current()) close();
  };
  const observer = new MutationObserver(changed);
  const beforeDismiss = () => {
    const store = useToolbarStore.getState();
    const children = Object.values(store.openedPopups).filter(
      (popup) =>
        popup &&
        popup.id !== id &&
        getPopupAncestry(store.openedPopups, popup.parent).includes(id)
    );
    // Deepest first, including a pinned child belonging to this host only.
    children.sort(
      (a, b) =>
        getPopupAncestry(store.openedPopups, b ? b.id : undefined).length -
        getPopupAncestry(store.openedPopups, a ? a.id : undefined).length
    );
    const child = children[0];
    if (child) {
      store.closePopup(child.id);
      return false;
    }
    return true;
  };
  editor.commands.focus(undefined, { scrollIntoView: false });
  useToolbarStore.getState().openPopup({ id, group: id });
  hide = showPopup({
    mobile: "popup",
    desktop: "popup",
    container: owner,
    beforeDismiss,
    closeDescendantsOnHide: true,
    onClose: cleanup,
    position: {
      target: root,
      isTargetAbsolute: true,
      location: "top",
      align: "center",
      yOffset: -8
    },
    sx: {
      width: "min(360px, 95vw)",
      maxHeight: "70vh",
      overflowY: "auto",
      bg: "background",
      border: "1px solid",
      borderColor: "border",
      borderRadius: "dialog",
      boxShadow: "menu",
      boxSizing: "border-box",
      minWidth: 0
    },
    popup: () => (
      <PopupIdScopeContext.Provider value={`${id}:`}>
        <PopupParentContext.Provider value={id}>
          <Flex
            role="group"
            aria-label={strings.formatting()}
            data-test-id="mac-advanced-formatting"
            onClickCapture={(event) => {
              if (!current()) {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
            sx={{
              flexDirection: "column",
              gap: 2,
              p: 2,
              minWidth: 0,
              fontSize: "body"
            }}
          >
            <Flex
              sx={{
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 1,
                pb: 1,
                borderBottom: "1px solid",
                borderColor: "border",
                position: "sticky",
                top: 0,
                bg: "background",
                zIndex: 1
              }}
            >
              <Text
                sx={{
                  fontSize: "title",
                  fontWeight: "bold",
                  color: "heading",
                  minWidth: 0,
                  overflowWrap: "anywhere"
                }}
              >
                {strings.formatting()}
              </Text>
              <Button
                variant="secondary"
                aria-label={strings.close()}
                onClick={close}
                sx={{ minHeight: 28, px: 2, fontSize: "body", flexShrink: 0 }}
              >
                {strings.close()}
              </Button>
            </Flex>
            <AdvancedFormattingSections
              editor={editor}
              groupId={id}
              presentation="mac"
              onExternalLink={() => {
                if (current()) void showLinkPopup(editor);
              }}
            />
          </Flex>
        </PopupParentContext.Provider>
      </PopupIdScopeContext.Provider>
    )
  });
  if (closed) return true;
  active = { editor, close };
  unsubscribe = useToolbarStore.subscribe((state) => {
    if (!state.openedPopups[id]) close();
  });
  unsubscribeOwner = ownerScope?.subscribe(changed) ?? (() => {});
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  observer.observe(editor.view.dom, {
    attributes: true,
    attributeFilter: ["contenteditable"]
  });
  if (root.parentElement)
    observer.observe(root.parentElement, { childList: true });
  editor.on("transaction", changed);
  editor.on("destroy", close);
  return true;
}
