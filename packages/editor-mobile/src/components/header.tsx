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

import { ControlledMenu, MenuItem as MenuItemInner } from "@szhsin/react-menu";
import ArrowBackIcon from "mdi-react/ArrowBackIcon";
import ArrowTopIcon from "mdi-react/ArrowTopIcon";
import ArrowDownIcon from "mdi-react/ArrowDownIcon";
import ArrowForwardIcon from "mdi-react/ArrowForwardIcon";
import ArrowULeftTopIcon from "mdi-react/ArrowULeftTopIcon";
import ArrowURightTopIcon from "mdi-react/ArrowURightTopIcon";
import DotsHorizontalIcon from "mdi-react/DotsHorizontalIcon";
import DotsVerticalIcon from "mdi-react/DotsVerticalIcon";
import FullscreenIcon from "mdi-react/FullscreenIcon";
import MagnifyIcon from "mdi-react/MagnifyIcon";
import PlusIcon from "mdi-react/PlusIcon";

import PencilLockIcon from "mdi-react/PencilLockIcon";
import TableOfContentsIcon from "mdi-react/TableOfContentsIcon";
import React, { useEffect, useRef, useState } from "react";
import { useThemeColors } from "@notesnook/theme";
import { useSafeArea } from "../hooks/useSafeArea";
import { useTabContext, useTabStore } from "../hooks/useTabStore";
import { Settings } from "../utils";
import { EditorEvents } from "../utils/editor-events";
import styles from "./styles.module.css";
import { strings } from "@notesnook/intl";

const menuClassName = ({ state }: any) =>
  state === "opening"
    ? styles.menuOpening
    : state === "closing"
    ? styles.menuClosing
    : styles.menu;

const menuItemClassName = ({ hover, disabled }: any) =>
  disabled
    ? styles.menuItemDisabled
    : hover
    ? styles.menuItemHover
    : styles.menuItem;

const MenuItem = (props: any) => (
  <MenuItemInner {...props} className={menuItemClassName} />
);

const iconButtonStyle: React.CSSProperties = {
  borderWidth: 0,
  borderRadius: 100,
  color: "var(--nn_primary_icon)",
  width: 39,
  height: 39,
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  position: "relative"
};

/**
 * Minimum comfortable touch target, the platform's own 44 pt metric the
 * native app uses for its controls. The iOS document chrome uses it for its
 * few primary controls instead of the (smaller) legacy icon buttons.
 */
const IOS_TOUCH_TARGET = 44;

function IconButton({
  onPress,
  children,
  fwdRef,
  style = {},
  preventDefault = false,
  disabled = false,
  label
}: {
  onPress?: () => void;
  children: React.ReactNode;
  fwdRef?: any;
  style?: React.CSSProperties;
  preventDefault?: boolean;
  disabled?: boolean;
  /**
   * Accessible name of the button. Icon-only buttons have none otherwise:
   * the icon is an `svg` and screen readers announce an unlabelled "button".
   */
  label?: string;
}) {
  return (
    <Button
      onPress={onPress}
      fwdRef={fwdRef}
      preventDefault={preventDefault}
      label={label}
      disabled={disabled}
      style={{ ...iconButtonStyle, ...style }}
    >
      {children}
    </Button>
  );
}

const Button = ({
  onPress,
  children,
  style,
  preventDefault = true,
  fwdRef,
  onClick,
  disabled = false,
  label
}: {
  onPress?: () => void;
  onClick?: (event: any) => void;
  children: React.ReactNode;
  style: React.CSSProperties;
  preventDefault?: boolean;
  fwdRef?: any;
  label?: string;
  disabled?: boolean;
}) => {
  return (
    <button
      ref={fwdRef}
      className={styles.btn_header}
      style={style}
      disabled={disabled}
      aria-label={label}
      title={label}
      onMouseDown={(e) => {
        // The press registers on `mousedown`, before the browser moves focus or
        // collapses the selection - which is why the default is prevented.
        if (disabled) return;
        if (preventDefault) e.preventDefault();
        onPress?.();
        onClick?.(e);
      }}
      onClick={(e) => {
        /**
         * A keyboard (Enter/Space) or assistive-technology activation of the
         * focused button dispatches a `click` with `detail === 0` and no
         * `mousedown`, so the same action has to be reachable that way too. A
         * real pointer click carries `detail >= 1` and already ran in
         * `onMouseDown`, so the detail check is what keeps one press from
         * activating twice.
         */
        if (!disabled && e.detail === 0) onPress?.();
      }}
    >
      {children}
    </button>
  );
};

/**
 * The macOS/iOS document chrome's default style for a *text* primary button
 * ("Edit"/"Done"): the accent tint, comfortable touch target, no background.
 */
const textButtonStyle: React.CSSProperties = {
  width: "auto",
  minWidth: IOS_TOUCH_TARGET,
  height: IOS_TOUCH_TARGET,
  paddingLeft: 10,
  paddingRight: 10,
  borderRadius: IOS_TOUCH_TARGET / 2
};

/** Keep the user's own sender alive across the outbound save receipt. */
function usePrimaryShare(tab: ReturnType<typeof useTabContext>) {
  const mounted = useRef(true);
  const activity = useRef(0);
  const pending = useRef(false);
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useTabStore.subscribe((next, previous) => {
      const a = previous.tabs.find((item) => item.id === previous.currentTab);
      const b = next.tabs.find((item) => item.id === next.currentTab);
      if (
        previous.currentTab !== next.currentTab ||
        a?.session?.noteId !== b?.session?.noteId ||
        a?.session?.id !== b?.session?.id ||
        !!a !== !!b
      )
        activity.current++;
    });
    return () => {
      mounted.current = false;
      activity.current++;
      unsubscribe();
    };
  }, []);

  const share = async () => {
    const noteId = tab.session?.noteId;
    const logicalSessionId = tab.session?.id;
    const transportSessionId = globalThis.sessionId;
    const flush = editorControllers[tab.id]?.flushOutboundSaves;
    if (
      pending.current ||
      !noteId ||
      !logicalSessionId ||
      !transportSessionId ||
      !flush
    )
      return;
    // Capture before the first await; an A -> B -> A transition stays stale.
    const epoch = activity.current;
    const owns = () => {
      const state = useTabStore.getState();
      const current = state.tabs.find((item) => item.id === tab.id);
      return (
        mounted.current &&
        activity.current === epoch &&
        state.currentTab === tab.id &&
        current?.session?.noteId === noteId &&
        current.session.id === logicalSessionId &&
        globalThis.sessionId === transportSessionId &&
        editorControllers[tab.id]?.flushOutboundSaves === flush &&
        !editorControllers[tab.id]?.loading
      );
    };
    if (!owns()) return;
    pending.current = true;
    setSharing(true);
    const positive = (result: Awaited<ReturnType<typeof flush>>) =>
      (result.status === "delivered" || result.status === "nothing-pending") &&
      result.snapshot?.tabId === tab.id &&
      result.snapshot?.noteId === noteId &&
      result.snapshot?.sessionId === transportSessionId;
    try {
      const first = await flush();
      if (!owns() || !positive(first)) return;
      // One bounded confirmation catches edits accepted after the first receipt.
      const confirmed = await flush();
      if (
        !owns() ||
        !positive(confirmed) ||
        confirmed.revision !== first.revision
      )
        return;
      post(EditorEvents.shareNote, { logicalSessionId }, tab.id, noteId);
    } catch {
      // The ordinary save pipeline owns its error/retry presentation.
    } finally {
      pending.current = false;
      if (mounted.current) setSharing(false);
    }
  };
  return { share, sharing };
}

function Header({
  noHeader,
  loading = false,
  settings,
  hasUndo,
  hasRedo,
  writing = true,
  detailsOpen = true,
  collectionInHeader = false,
  surface,
  onEdit,
  onDone,
  onToggleDetails
}: {
  noHeader: boolean;
  loading?: boolean;
  settings: Settings;
  hasUndo: boolean;
  hasRedo: boolean;
  /**
   * iOS document chrome only. `false` while the note is shown in the calm
   * reading presentation, so the primary action is the labelled "Edit";
   * `true` while the user is writing, so it is the labelled "Done". The
   * legacy header of the other clients ignores it (`undefined` keeps their
   * behaviour backwards compatible).
   */
  writing?: boolean;
  /**
   * iOS document chrome only: whether the details (word count + tags) row is
   * disclosed. The row itself lives in the editor pane (see `editor.tsx`); the
   * header only carries the toggle. `undefined` keeps the legacy behaviour.
   */
  detailsOpen?: boolean;
  /** iPad two/three-pane context; phone and paged editors keep it above title. */
  collectionInHeader?: boolean;
  /**
   * iOS document chrome only: the resolved *document* surface (from the shared
   * `resolveAppleSurfaces` resolver in the parent), so the bar is painted the
   * same tone as the note pane instead of the theme's chrome background.
   */
  surface?: string;
  /** iOS document chrome only: the primary "Edit" action (enter writing). */
  onEdit?: () => void;
  /** iOS document chrome only: the primary "Done" action (exit writing). */
  onDone?: () => void;
  /** iOS document chrome only: toggle the details (word count + tags) row. */
  onToggleDetails?: () => void;
}): JSX.Element | null {
  const tab = useTabContext();
  const editor = editors[tab.id];
  const tableOfContents = editorControllers[tab.id]?.getTableOfContents?.();
  const insets = useSafeArea();
  const { colors } = useThemeColors("editor");
  const openedTabsCount = useTabStore((state) => state.tabs.length);
  const [isOpen, setOpen] = useState(false);
  const btnRef = useRef(null);
  const primaryShare = usePrimaryShare(tab);
  const [canGoBack, canGoForward] = useTabStore((state) => [
    state.canGoBack,
    state.canGoForward
  ]);

  /**
   * Mac Catalyst: the editor has no header of its own. The window's native
   * NSToolbar carries the editor actions (share, note info, ⋮), so rendering
   * nothing here removes both the row and every bit of layout space it used to
   * reserve: the formatting toolbar and the note content start at the very top
   * of the pane (see `utils/mac.ts` and `tiptap.tsx`).
   */
  if (settings.isMacCatalyst) return null;

  /**
   * The calm document chrome is iOS (iPhone/iPad) only. `__PLATFORM__` is
   * injected by the native app before the bundle runs; Android and any other
   * host keep the legacy header below exactly as it was. Mac Catalyst has
   * already returned above (it has no web header at all).
   */
  const isIOSDocChrome = globalThis.__PLATFORM__ === "ios";
  /**
   * Where the editor is a page the user navigated *into*: iPhone
   * (`deviceMode === "mobile"`) and, with `pagedPresentation`, the narrow iPad
   * pager. Fullscreen keeps it too (it is the close control of a fullscreen
   * editor). Unchanged from the previous header; the iOS chrome only moves it
   * into the restrained primary row.
   */
  const showBack =
    settings.deviceMode === "mobile" ||
    settings.fullscreen ||
    !!settings.pagedPresentation;

  /**
   * Whether the *primary* iOS control may invite writing at all. A locked
   * session is not writable until it is unlocked (its pane is the password
   * overlay), and a globally read-only editor (`settings.readonly`) cannot be
   * written to anywhere - neither may offer a functional "Edit"/"Done". This
   * outranks a session-level `readonly`, whose existing "disable read-only
   * mode" affordance stays the way back into writing for a note that is
   * genuinely editable (`!canWrite` => nothing is rendered; no control that
   * looks like it writes is left behind).
   */
  const canWriteNote = !(tab.session?.locked || settings.readonly);

  const topInset = insets.top;
  const headerHeight = 50;

  /**
   * The overflow menu, shared by both headers. The iOS chrome prepends the
   * labelled entries the noisy primary row used to carry (Details, Undo, Redo,
   * Tabs, Fullscreen); every other entry - search, table of contents, new note,
   * scroll, navigation history and the real Properties sheet - is the existing
   * one, unchanged.
   */
  const menu = (
    <ControlledMenu
      align="end"
      anchorPoint={{
        x: window.innerWidth - 10,
        y: 70
      }}
      state={isOpen ? "open" : "closed"}
      menuClassName={menuClassName}
      onClose={() => {
        setOpen(false);
      }}
      autoFocus={false}
      onItemClick={(e) => {
        switch (e.value) {
          case "details":
            /**
             * Local disclosure only: the word count + tags row lives in this
             * WebView (see `editor.tsx`). No native detail/info bridge is
             * opened, so nothing new is sent over the message channel.
             */
            onToggleDetails?.();
            break;
          case "undo":
            editor?.commands.undo();
            break;
          case "redo":
            editor?.commands.redo();
            break;
          case "tabs":
            post(EditorEvents.showTabs, undefined, tab.id, tab.session?.noteId);
            break;
          case "fullscreen":
            post(
              EditorEvents.fullscreen,
              undefined,
              tab.id,
              tab.session?.noteId
            );
            break;
          case "toc":
            post(
              EditorEvents.toc,
              editorControllers[tab.id]?.getTableOfContents(),
              tab.id,
              tab.session?.noteId
            );
            break;
          case "search":
            editor?.commands.startSearch();
            break;
          case "newNote":
            post(EditorEvents.newNote, undefined, tab.id, tab.session?.noteId);
            break;
          case "scroll-top":
            {
              const element = document.getElementById(
                "editor-container-scroller"
              );
              element?.scrollTo({
                top: 0,
                left: 0,
                behavior: "smooth"
              });
            }
            break;
          case "scroll-bottom":
            {
              const element = document.getElementById(
                "editor-container-scroller"
              );
              element?.scrollTo({
                top: element?.scrollHeight,
                left: 0,
                behavior: "smooth"
              });
            }
            break;
          case "properties":
            post(
              EditorEvents.properties,
              undefined,
              tab.id,
              tab.session?.noteId
            );
            break;
          default:
            break;
        }
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexDirection: "row",
          justifyContent: "center",
          flex: 1,
          paddingTop: 5
        }}
      >
        <IconButton
          onPress={() => {
            post(EditorEvents.goBack, undefined, tab.id, tab.session?.noteId);
            setOpen(false);
          }}
        >
          <ArrowBackIcon
            color={
              !canGoBack
                ? "var(--nn_secondary_border)"
                : "var(--nn_primary_icon)"
            }
            size={25 * settings.fontScale}
            style={{ position: "absolute" }}
          />
        </IconButton>

        <IconButton
          onPress={() => {
            post(
              EditorEvents.goForward,
              undefined,
              tab.id,
              tab.session?.noteId
            );
            setOpen(false);
          }}
        >
          <ArrowForwardIcon
            color={
              !canGoForward
                ? "var(--nn_secondary_border)"
                : "var(--nn_primary_icon)"
            }
            size={25 * settings.fontScale}
            style={{ position: "absolute" }}
          />
        </IconButton>

        <IconButton
          onPress={() => {
            editor?.commands.startSearch();
            setOpen(false);
          }}
        >
          <MagnifyIcon
            size={25 * settings.fontScale}
            style={{ position: "absolute" }}
            color="var(--nn_primary_icon)"
          />
        </IconButton>
      </div>

      {isIOSDocChrome ? (
        <>
          <MenuItem
            value="details"
            aria-expanded={detailsOpen}
            aria-controls="editor-details"
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center"
            }}
          >
            <span
              style={{
                color: "var(--nn_primary_paragraph)"
              }}
            >
              {strings.details()}
            </span>
          </MenuItem>

          <MenuItem
            value="undo"
            disabled={!hasUndo}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center"
            }}
          >
            <ArrowULeftTopIcon
              size={20 * settings.fontScale}
              color="var(--nn_primary_icon)"
            />
            <span
              style={{
                color: "var(--nn_primary_paragraph)"
              }}
            >
              {strings.undo()}
            </span>
          </MenuItem>

          <MenuItem
            value="redo"
            disabled={!hasRedo}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center"
            }}
          >
            <ArrowURightTopIcon
              size={20 * settings.fontScale}
              color="var(--nn_primary_icon)"
            />
            <span
              style={{
                color: "var(--nn_primary_paragraph)"
              }}
            >
              {strings.redo()}
            </span>
          </MenuItem>

          <MenuItem
            value="tabs"
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center"
            }}
          >
            <div
              style={{
                border: "2px solid var(--nn_primary_icon)",
                width: 17 * settings.fontScale,
                height: 17 * settings.fontScale,
                minWidth: 17 * settings.fontScale,
                borderRadius: 5,
                display: "flex",
                justifyContent: "center",
                alignItems: "center"
              }}
            >
              <p
                style={{
                  fontSize:
                    openedTabsCount > 100
                      ? 10 * settings.fontScale
                      : 12 * settings.fontScale,
                  margin: 0
                }}
              >
                {openedTabsCount}
              </p>
            </div>
            <span
              style={{
                color: "var(--nn_primary_paragraph)"
              }}
            >
              {strings.tabs()}
            </span>
          </MenuItem>

          {settings.deviceMode !== "mobile" && !settings.fullscreen ? (
            <MenuItem
              value="fullscreen"
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center"
              }}
            >
              <FullscreenIcon
                size={20 * settings.fontScale}
                color="var(--nn_primary_icon)"
              />
              <span
                style={{
                  color: "var(--nn_primary_paragraph)"
                }}
              >
                {strings.fullscreen()}
              </span>
            </MenuItem>
          ) : null}
        </>
      ) : null}

      <MenuItem
        value="newNote"
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center"
        }}
      >
        <PlusIcon
          size={20 * settings.fontScale}
          color="var(--nn_primary_icon)"
        />
        <span
          style={{
            color: "var(--nn_primary_paragraph)"
          }}
        >
          New note
        </span>
      </MenuItem>

      {tableOfContents?.length ? (
        <MenuItem
          value="toc"
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center"
          }}
        >
          <TableOfContentsIcon
            size={20 * settings.fontScale}
            color="var(--nn_primary_icon)"
          />
          <span
            style={{
              color: "var(--nn_primary_paragraph)"
            }}
          >
            {strings.toc()}
          </span>
        </MenuItem>
      ) : null}

      <MenuItem
        value="scroll-top"
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center"
        }}
      >
        <ArrowTopIcon
          size={20 * settings.fontScale}
          color="var(--nn_primary_icon)"
        />
        <span
          style={{
            color: "var(--nn_primary_paragraph)"
          }}
        >
          {strings.scrollToTop()}
        </span>
      </MenuItem>

      <MenuItem
        value="scroll-bottom"
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center"
        }}
      >
        <ArrowDownIcon
          size={20 * settings.fontScale}
          color="var(--nn_primary_icon)"
        />
        <span
          style={{
            color: "var(--nn_primary_paragraph)"
          }}
        >
          {strings.scrollToBottom()}
        </span>
      </MenuItem>
      <MenuItem
        value="properties"
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center"
        }}
      >
        <DotsHorizontalIcon
          size={20 * settings.fontScale}
          color="var(--nn_primary_icon)"
        />
        <span
          style={{
            color: "var(--nn_primary_paragraph)"
          }}
        >
          {strings.properties()}
        </span>
      </MenuItem>
    </ControlledMenu>
  );

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: noHeader ? `${topInset}px` : `${headerHeight + topInset}px`,
        /**
         * The theme's colours are used directly instead of their
         * `--nn_*` custom properties: a sticky element whose background came
         * from a variable was left painted in the previous theme in WKWebView
         * when the theme changed (a grey band across the top of a dark
         * editor until the theme was toggled again). Reading them here makes
         * the theme change a normal React re-render of this element.
         *
         * The iOS document chrome paints the *document* surface the parent
         * resolved (`resolveAppleSurfaces`), so the bar is the same calm tone
         * as the note pane; the other clients keep the theme background.
         */
        backgroundColor:
          isIOSDocChrome && surface ? surface : colors.primary.background,
        position: "sticky",
        width: "100vw",
        zIndex: 999,
        borderBottom: `0.5px solid ${colors.primary.border}`
      }}
    >
      {noHeader ? null : (
        <div
          style={{
            display: "flex",
            width: "100%",
            justifyContent: "space-between",
            flexDirection: "row",
            paddingTop: topInset,
            height: headerHeight,
            alignItems: "center",
            gap: 8,
            paddingLeft: 12,
            paddingRight: 16
          }}
          id="header"
        >
          {!showBack ? (
            isIOSDocChrome &&
            collectionInHeader &&
            !tab.session?.locked &&
            tab.session?.origin?.title ? (
              <span
                id="editor-collection-caption"
                title={tab.session.origin.title}
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: colors.primary.accent,
                  fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif"
                }}
              >
                {tab.session.origin.title}
              </span>
            ) : (
              <div />
            )
          ) : (
            /**
             * The way back exists exactly where the editor is a page the user
             * navigated *into*: iPhone (`deviceMode === "mobile"`) and, with
             * `pagedPresentation`, the narrow iPad, where the pager pages
             * between the document and the note list. Fullscreen and every
             * other client keep the previous conditions. The button is labelled
             * for screen readers - it is the only affordance returning from a
             * paged editor.
             */
            <IconButton
              onPress={() => {
                post(EditorEvents.back, undefined, tab.id, tab.session?.noteId);
              }}
              label={strings.back()}
              style={{ width: 40, height: 40 }}
            >
              <ArrowBackIcon
                size={25 * settings.fontScale}
                style={{ position: "absolute" }}
                color="var(--nn_primary_icon)"
              />
            </IconButton>
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexDirection: "row",
              gap: 8,
              flexShrink: 0
            }}
          >
            {isIOSDocChrome ? (
              /**
               * The restrained iOS primary row: a circular "More" and the
               * labelled Edit/Done. The noisy controls (fullscreen, undo/redo,
               * the tab count) have moved into the labelled More entries above;
               * the back affordance stays where the C1 condition requires it.
               */
              <>
                <IconButton
                  onPress={() => {
                    void primaryShare.share();
                  }}
                  label={strings.share()}
                  preventDefault
                  disabled={
                    loading ||
                    !tab.session?.noteId ||
                    primaryShare.sharing ||
                    !!editorControllers[tab.id]?.loading
                  }
                  style={{
                    width: IOS_TOUCH_TARGET,
                    height: IOS_TOUCH_TARGET,
                    color: colors.primary.accent
                  }}
                >
                  <svg
                    aria-hidden="true"
                    width="23"
                    height="25"
                    viewBox="0 0 24 26"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 17V2m-5 5 5-5 5 5M6 11H4v13h16V11h-2" />
                  </svg>
                </IconButton>
                <IconButton
                  onPress={() => {
                    if (tab.session?.locked) {
                      post(
                        EditorEvents.properties,
                        undefined,
                        tab.id,
                        tab.session?.noteId
                      );
                    } else {
                      setOpen(!isOpen);
                    }
                  }}
                  fwdRef={btnRef}
                  label={strings.more()}
                  preventDefault
                  style={{
                    width: IOS_TOUCH_TARGET,
                    height: IOS_TOUCH_TARGET,
                    borderRadius: IOS_TOUCH_TARGET / 2,
                    backgroundColor: "var(--nn_secondary_background)"
                  }}
                >
                  <DotsHorizontalIcon
                    size={25 * settings.fontScale}
                    style={{ position: "absolute" }}
                    color="var(--nn_primary_icon)"
                  />
                </IconButton>

                {!canWriteNote ? null : tab.session?.readonly ? (
                  /**
                   * A read-only note cannot be edited here; the existing
                   * "disable read-only mode" affordance is preserved (it is the
                   * only way back to writing on such a note). It is shown only
                   * while the note is genuinely writable: a locked session or a
                   * globally read-only editor has no path back to editing, so
                   * the affordance is not offered there (`canWriteNote`).
                   */
                  <IconButton
                    onPress={() => {
                      post(
                        "editor-events:disable-readonly-mode",
                        tab.session?.noteId
                      );
                    }}
                    fwdRef={btnRef}
                    label={strings.edit()}
                    preventDefault
                    style={textButtonStyle}
                  >
                    <PencilLockIcon
                      size={25 * settings.fontScale}
                      style={{ position: "absolute" }}
                      color="var(--nn_primary_accent)"
                    />
                  </IconButton>
                ) : (
                  <IconButton
                    onPress={() => {
                      if (writing) onDone?.();
                      else onEdit?.();
                    }}
                    label={writing ? strings.done() : strings.edit()}
                    preventDefault
                    style={textButtonStyle}
                  >
                    <span
                      style={{
                        color: "var(--nn_primary_accent)",
                        fontSize: 17 * settings.fontScale,
                        fontWeight: 600,
                        userSelect: "none"
                      }}
                    >
                      {writing ? strings.done() : strings.edit()}
                    </span>
                  </IconButton>
                )}

                {menu}
              </>
            ) : (
              /**
               * The legacy header of Android and every other host: unchanged.
               */
              <>
                {settings.deviceMode !== "mobile" && !settings.fullscreen ? (
                  <IconButton
                    onPress={() => {
                      post(
                        EditorEvents.fullscreen,
                        undefined,
                        tab.id,
                        tab.session?.noteId
                      );
                    }}
                  >
                    <FullscreenIcon
                      size={25 * settings.fontScale}
                      style={{ position: "absolute" }}
                      color="var(--nn_primary_icon)"
                    />
                  </IconButton>
                ) : null}

                {tab.session?.readonly ? (
                  <IconButton
                    onPress={() => {
                      post(
                        "editor-events:disable-readonly-mode",
                        tab.session?.noteId
                      );
                    }}
                    fwdRef={btnRef}
                    style={{ color: "var(--nn_primary_accent)" }}
                  >
                    <PencilLockIcon
                      size={25 * settings.fontScale}
                      style={{ position: "absolute" }}
                      color="var(--nn_primary_accent)"
                    />
                  </IconButton>
                ) : null}

                <IconButton
                  onPress={() => {
                    editor?.commands.undo();
                  }}
                >
                  <ArrowULeftTopIcon
                    color={
                      !hasUndo
                        ? "var(--nn_secondary_border)"
                        : "var(--nn_primary_icon)"
                    }
                    size={25 * settings.fontScale}
                    style={{ position: "absolute" }}
                  />
                </IconButton>

                <IconButton
                  onPress={() => {
                    editor?.commands.redo();
                  }}
                >
                  <ArrowURightTopIcon
                    color={
                      !hasRedo
                        ? "var(--nn_secondary_border)"
                        : "var(--nn_primary_icon)"
                    }
                    size={25 * settings.fontScale}
                    style={{ position: "absolute" }}
                  />
                </IconButton>

                <IconButton
                  onPress={() => {
                    post(
                      EditorEvents.showTabs,
                      undefined,
                      tab.id,
                      tab.session?.noteId
                    );
                  }}
                >
                  <div
                    style={{
                      border: "2px solid var(--nn_primary_icon)",
                      width: 17 * settings.fontScale,
                      height: 17 * settings.fontScale,
                      minWidth: 17 * settings.fontScale,
                      borderRadius: 5,
                      display: "flex",
                      justifyContent: "center",
                      alignItems: "center"
                    }}
                  >
                    <p
                      style={{
                        fontSize:
                          openedTabsCount > 100
                            ? 10 * settings.fontScale
                            : 12 * settings.fontScale
                      }}
                    >
                      {openedTabsCount}
                    </p>
                  </div>
                </IconButton>

                <IconButton
                  fwdRef={btnRef}
                  onPress={() => {
                    if (tab.session?.locked) {
                      post(
                        EditorEvents.properties,
                        undefined,
                        tab.id,
                        tab.session?.noteId
                      );
                    } else {
                      setOpen(!isOpen);
                    }
                  }}
                >
                  {tab.session?.locked ? (
                    <DotsHorizontalIcon
                      size={25 * settings.fontScale}
                      style={{ position: "absolute" }}
                      color="var(--nn_primary_icon)"
                    />
                  ) : (
                    <DotsVerticalIcon
                      size={25 * settings.fontScale}
                      style={{ position: "absolute" }}
                      color="var(--nn_primary_icon)"
                    />
                  )}
                </IconButton>

                {menu}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default React.memo(Header, (prev, next) => {
  if (
    prev.settings.deviceMode !== next.settings.deviceMode ||
    prev.settings.fullscreen !== next.settings.fullscreen ||
    /**
     * The paged presentation decides whether the Back affordance is there, and
     * it changes when the iPad root is resized (wide -> narrow). Without it
     * here the memoized header would keep rendering the affordance of the
     * previous width.
     */
    prev.settings.pagedPresentation !== next.settings.pagedPresentation ||
    /**
     * Mac Catalyst decides whether the header renders at all (the native
     * NSToolbar carries its actions), so a payload that turns it on/off must
     * re-render.
     */
    prev.settings.isMacCatalyst !== next.settings.isMacCatalyst ||
    prev.settings.premium !== next.settings.premium ||
    prev.settings.fontScale !== next.settings.fontScale ||
    /**
     * The iOS primary control is suppressed for a globally read-only editor
     * (`canWriteNote` reads `settings.readonly`), so the memoized header must
     * re-render when that setting flips - otherwise a read-only -> editable
     * transition would keep rendering no Edit control.
     */
    prev.settings.readonly !== next.settings.readonly ||
    prev.noHeader !== next.noHeader ||
    prev.loading !== next.loading ||
    prev.hasRedo !== next.hasRedo ||
    prev.hasUndo !== next.hasUndo ||
    /**
     * iOS document chrome: the reading/writing presentation (the primary
     * Edit/Done label), the details disclosure, the resolved document surface
     * and the three actions the parent hands down. All are compared, so no
     * stale width/theme/writing state can survive a re-render.
     */
    prev.writing !== next.writing ||
    prev.detailsOpen !== next.detailsOpen ||
    prev.collectionInHeader !== next.collectionInHeader ||
    prev.surface !== next.surface ||
    prev.onEdit !== next.onEdit ||
    prev.onDone !== next.onDone ||
    prev.onToggleDetails !== next.onToggleDetails
  )
    return false;

  return true;
});
