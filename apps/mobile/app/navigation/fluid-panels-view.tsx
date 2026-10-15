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

import { ScopedThemeProvider, useThemeColors } from "@notesnook/theme";
import {
  activateKeepAwake,
  deactivateKeepAwake
} from "@sayem314/react-native-keep-awake";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { LayoutChangeEvent, Platform, View } from "react-native";
import Orientation, {
  OrientationType,
  useDeviceOrientationChange
} from "react-native-orientation-locker";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from "react-native-reanimated";
import { notesnook } from "../../e2e/test.ids";
import { db } from "../common/database";
import { FluidPanels } from "../components/fluid-panels";
import { IPadWorkspaceProvider } from "../components/ipad-workspace-context";
import { MacScrollEdgeFade } from "../components/mac-scroll-edge-fade";
import { MacSidebar } from "../components/mac-sidebar";
import { useSideBarDraggingStore } from "../components/side-menu/dragging-store";
import useGlobalSafeAreaInsets from "../hooks/use-global-safe-area-insets";
import { hideAllTooltips } from "../hooks/use-tooltip";
import { useTabStore } from "../screens/editor/tiptap/use-tab-store";
import { editorController, editorState } from "../screens/editor/tiptap/utils";
import { DDS } from "../services/device-detection";
import {
  eSendEvent,
  eSubscribeEvent,
  eUnSubscribeEvent
} from "../services/event-manager";
import { useSettingStore } from "../stores/use-setting-store";
import {
  eCloseFullscreenEditor,
  eOnEnterEditor,
  eOnExitEditor,
  eOnLoadNote,
  eOpenFullscreenEditor,
  eUnlockNote
} from "../utils/events";
import { valueLimiter } from "../utils/functions";
import { fluidTabsRef } from "../utils/global-refs";
import { AppNavigationStack } from "./navigation-stack";
import type { PaneWidths } from "../screens/editor/wrapper";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { NavigationProps } from "../services/navigation";
import { useAppleNavigationStore } from "../stores/use-apple-navigation-store";
import { useMacSidebarVisible } from "../stores/use-mac-sidebar-store";
import { isMacCatalyst } from "../utils/constants";
import {
  MAC_SCROLL_EDGE_FADE_HEIGHT,
  macEditorWidth,
  macListWidth,
  macSidebarWidth,
  macToolbarInset
} from "../utils/mac-layout";
import {
  IPadPaneMode,
  ipadPaneWidths,
  resolveIPadPaneMode
} from "../utils/ipad-layout";

/**
 * iPhone has no drawer: the bottom bar owns top-level navigation, so the
 * sidebar pane collapses to zero width and is not mounted at all.
 * iPad keeps its sidebar pane, whose width is the width-derived pane mode's
 * (see `paneWidths` below); Android's large tablet keeps its `PANE_WIDTHS`
 * sidebar.
 */
const MOBILE_SIDEBAR_SIZE = Platform.OS === "ios" ? 0 : 0.85;

let SideMenu: any = null;
let EditorWrapper: any = null;

export const FluidPanelsView = React.memo(
  ({ route }: NavigationProps<"FluidPanelsView">) => {
    const { colors, isDark } = useThemeColors();
    const visual = getAppleVisualTokens(colors, isDark);
    const deviceMode = useSettingStore((state) => state.deviceMode);
    const setFullscreen = useSettingStore((state) => state.setFullscreen);
    const fullscreen = useSettingStore((state) => state.fullscreen);
    const setDeviceModeState = useSettingStore((state) => state.setDeviceMode);
    const dimensions = useSettingStore((state) => state.dimensions);
    const setDimensions = useSettingStore((state) => state.setDimensions);
    /**
     * The top-level section the app is showing. Mac's Tasks and Search are
     * screens of their own that cover this one (see MAC_SECTION_SCREEN_OPTIONS
     * in navigation-stack.tsx); the section is what tells this screen they are
     * up. On iPhone/iPad the floating bar keeps the same value and nothing here
     * reads it: those sections cover the panes the same way they always did.
     */
    const section = useAppleNavigationStore((state) => state.section);
    /**
     * The pager's logical page ("editor" while `i === 2`), the only page signal
     * this screen reads. It is written by the pager's own `onChangeTab`
     * (`handleChangeTab` below) and never here; on the narrow iPad it is what
     * says which of the two full-width pages - the note list or the document -
     * is the one on screen.
     */
    const editorVisible = useAppleNavigationStore(
      (state) => state.editorVisible
    );
    const macSection = isMacCatalyst() && section !== "library";
    /**
     * View > Toggle Sidebar's flag. Mac only: it decides whether the source
     * list pane is part of the layout (see PANE_WIDTHS below).
     */
    const macSidebarVisible = useMacSidebarVisible(dimensions.width);
    const insets = useGlobalSafeAreaInsets();
    const animatedOpacity = useSharedValue(0);
    const animatedTranslateY = useSharedValue(-9999);
    const overlayRef = useRef<Animated.View>(null);
    const [orientation, setOrientation] = useState<OrientationType>(
      Orientation.getInitialOrientation()
    );
    const appLoading = useSettingStore((state) => state.isAppLoading);
    const introCompleted = useSettingStore(
      (state) => state.settings.introCompleted
    );
    const [isLoading, setIsLoading] = useState(false);
    /**
     * A real iPad: `Platform.isPad` is true on iPad hardware and in the iPad
     * simulator and false on iPhone, while Mac Catalyst has historically
     * answered it too, so it is excluded explicitly. This is the only iPad
     * predicate in this screen and everything the iPad branch below does hangs
     * off it: on iPhone, Android and Mac Catalyst it is false, the pane mode
     * stays undefined and every width, pane and prop is exactly what it was
     * before.
     */
    const isIPad =
      Platform.OS === "ios" && Platform.isPad === true && !isMacCatalyst();

    /**
     * The pane mode is a function of the *measured* root width alone
     * (`onLayout` writes `dimensions` below, and `utils/ipad-layout.ts` owns the
     * boundaries). It is deliberately not derived from `deviceMode`: DDS answers
     * a hardware/orientation question that unrelated consumers keep reading
     * (`DDS.isTab`, the editor, the sheets), and a width/orientation change must
     * not have to rewrite that store to lay the panes out. Undefined on every
     * other client, which is what keeps their layout byte for byte the same.
     */
    const paneMode: IPadPaneMode | undefined = isIPad
      ? resolveIPadPaneMode(dimensions.width)
      : undefined;

    /**
     * Whether the iPad's source sidebar is actually on screen right now. This is
     * a presentation fact of this screen, not an availability question: the
     * pager reports the drawer through `onDrawerStateChange` (a swipe, the
     * back-gesture close, opening a page) and the width-derived mode says
     * whether the sidebar is a persistent column (wide), a drawer (medium) or
     * absent (narrow). It is what the workspace context publishes, so a consumer
     * never has to guess.
     */
    const [ipadDrawerOpen, setIpadDrawerOpen] = useState(false);

    /**
     * The drawer stays the iPad/Android affordance it was on the clients that
     * still lay out from `deviceMode`: iPhone (bottom bar only) and Mac
     * (sections in the list column) never mount the sidebar pane. On a real iPad
     * this prop is ignored - the pane mode owns the drawer (`ipadDrawerEnabled`)
     * - and the sidebar is rendered by the iPad branch below.
     */
    const drawerEnabled =
      !isMacCatalyst() && (Platform.OS !== "ios" || deviceMode !== "mobile");

    /**
     * Whether the pager has reported a logical page since this mount. It is
     * silent while it opens on the list page (an unchanged page is not a change,
     * see the pager's reaction), so `editorVisible` can still hold a value from a
     * previous mount; until the pager reports, the current page is the one
     * `initialPage` seeded - the same rule the pager itself uses - and from the
     * first report on the store is authoritative.
     *
     * The report is React state, not a ref: the first report can arrive when the
     * store already holds the value it reports (a stale `editorVisible` from a
     * previous mount), and Zustand then re-renders nothing - the render that
     * follows the report has to happen for the flags below to stop reading
     * `initialPage`.
     *
     * The wrapper's identity must stay stable: the pager's width effect depends
     * on `onChangeTab`, so an inline arrow (or a non-primitive dependency) would
     * make it re-run on every render. `isIPad` is a boolean primitive, and the
     * marker is only ever set on a real iPad, so the other clients never pay for
     * the report at all.
     */
    const [pagerReportedTab, setPagerReportedTab] = useState(false);
    const handleChangeTab = useCallback(
      (event: { i: number; from: number }) => {
        if (isIPad) setPagerReportedTab(true);
        onChangeTab(event);
      },
      [isIPad]
    );

    /**
     * The paging decision is read from refs, not from the render scope: the
     * `eOnLoadNote` subscription below is installed once (a stable handle and a
     * stable unsubscribe), while the mode, the measured width and fullscreen
     * change on every rotation. None of them is a *reason* to re-subscribe, and
     * keeping them out of the listener's identity is also what keeps a resize
     * from ever being conflated with a navigation.
     */
    const paneModeRef = useRef(paneMode);
    paneModeRef.current = paneMode;
    const isIPadRef = useRef(isIPad);
    isIPadRef.current = isIPad;
    const widthRef = useRef(dimensions.width);
    widthRef.current = dimensions.width;
    const fullscreenRef = useRef(fullscreen);
    fullscreenRef.current = fullscreen;

    /**
     * The latest *validated* user note-open intent that could not be turned into
     * a page change when it arrived, because the root had not been measured yet
     * (there was no width to page to) or the pager was not mounted. Those two are
     * about the layout settling, not about the user: the intent is legitimate and
     * is held here until the render that follows the measurement can deliver it.
     *
     * It is a ref, not state, on purpose: holding an intent must never re-render
     * (a render is not a navigation), and it must not outlive this mount - the
     * subscription's cleanup clears it - so a request can never replay onto a
     * later mount. Only a user-origin load is ever stored here; a background
     * refresh, a forced document reload, an editor-origin reload, another tab's
     * event, fullscreen and every non-iPad client are rejected at event time and
     * never reach it.
     */
    const pendingOpenRef = useRef<{
      item?: unknown;
      newNote?: boolean;
      tabId?: string;
    } | null>(null);

    /**
     * The iPad's *logical* page is the document whenever a note was explicitly
     * opened by the user. `openNote` cannot record that itself: it publishes
     * `eOnLoadNote` and then skips its own `goToPage("editor")` because
     * `DDS.isTab` is true on every iPad/tablet (see
     * `components/list-items/note/wrapper.tsx`), which is exactly why on the
     * narrow iPad the document loaded *behind* the list and the editor stayed
     * hidden. The width-derived pane mode is the only thing that knows these
     * panes are pages, so this screen supplies the page change the publisher
     * deliberately left out: a user-origin note load (an existing note, or the
     * "new note" action, both of which arrive with `item`/`newNote` and no
     * editor-origin marker) lands on the document page.
     *
     * This is not narrow-only. In wide and medium the pager's resting offset is
     * the same for both pages (see `ipadPagerOffset`), so the page change moves
     * nothing on screen - but the *logical* page is not decoration: it is what
     * the note list's and the document's accessibility/pointer flags read on the
     * narrow width, and a user who opened a note in a wide workspace and then
     * rotated or slid to narrow was looking at the writing surface the editor
     * must keep on screen. Without recording it here that user would have been
     * dropped onto the note list, with their note behind it.
     *
     * What this *never* does: it writes no note, no editor focus and no
     * navigation state, it is inert on every other client, in fullscreen and
     * while the width is unmeasured, and it is idempotent once the pager is
     * already on the document page. A resize, a rotation or a fullscreen toggle
     * alone cannot reach it - they only update the refs above.
     */
    useEffect(() => {
      const onLoadNote = (
        payload?:
          | {
              item?: unknown;
              newNote?: boolean;
              tabId?: string;
              loadedFromEditor?: boolean;
              refresh?: boolean;
              forced?: boolean;
            }
          | undefined
      ) => {
        if (!isIPadRef.current) return;
        // A silent refresh is not a user open: the vault unlock re-publishes the
        // note the editor already has (`refresh: true`, see
        // screens/editor/index.tsx) without the user having opened anything.
        if (payload?.refresh) return;
        // A *forced* reload is the other document-reload family the user did not
        // ask for: the merge-conflict resolution, the attachment removal and the
        // history restore all re-publish the note the editor is already showing
        // (`forced: true`) so its body is rebuilt - they never ask to *open* a
        // document page. Their former iPhone paths never paged either. Paging for
        // one would yank a user who had deliberately narrowed to the note list
        // back onto the document, so it is rejected here with the passive
        // refresh. It must also never touch the pending intent below: a
        // background reload is not the user changing their mind, and it cannot
        // cancel a real open they are still waiting on.
        if (payload?.forced) return;
        // Fullscreen presents the document alone; closing it restores the page
        // the user was on, so a load inside it is not a page change.
        if (fullscreenRef.current) return;
        // Only the two user-origin loads page the workspace; the editor's own
        // reload of the focused tab (`loadedFromEditor`, see the `tabFocused`
        // branch of use-editor-events) is not a navigation, and an event
        // addressed to another tab belongs to that tab.
        if (!payload || (!payload.item && !payload.newNote)) return;
        if (payload.loadedFromEditor) return;
        if (
          payload.tabId &&
          payload.tabId !== useTabStore.getState().currentTab
        )
          return;
        // The intent is a real user open. When the root has been measured and the
        // pager is mounted, page right now, exactly as before; a superseding
        // intent drops whatever was waiting. Only when the pane mode is resolved
        // from an *unmeasured* width - the panes are not laid out yet and there
        // is no page to move to - is the intent retained below instead of being
        // lost.
        if (
          paneModeRef.current !== undefined &&
          widthRef.current > 0 &&
          fluidTabsRef.current
        ) {
          pendingOpenRef.current = null;
          // A medium drawer can still hide the right side of this logical page.
          // A user open must close it even when the editor was already active.
          if (
            fluidTabsRef.current.page() === "editor" &&
            !fluidTabsRef.current.isDrawerOpen()
          )
            return;
          fluidTabsRef.current.goToPage("editor");
          return;
        }
        // A resize alone only updates the refs above and never reaches here, so
        // a pure width change can neither create nor deliver an intent.
        pendingOpenRef.current = {
          item: payload.item,
          newNote: payload.newNote,
          tabId: payload.tabId
        };
      };
      eSubscribeEvent(eOnLoadNote, onLoadNote);
      return () => {
        eUnSubscribeEvent(eOnLoadNote, onLoadNote);
        // A queued intent is the fallback for a width this mount never got; it
        // must not outlive the mount and replay onto a later one.
        pendingOpenRef.current = null;
      };
    }, []);

    const toggleView = useCallback(
      (show: boolean) => {
        animatedTranslateY.value = show ? 0 : -9999;
      },
      [animatedTranslateY]
    );

    useDeviceOrientationChange((o) => {
      if (
        o !== OrientationType.UNKNOWN &&
        o !== OrientationType["FACE-UP"] &&
        o !== OrientationType["FACE-DOWN"] &&
        o !== OrientationType["PORTRAIT-UPSIDEDOWN"]
      ) {
        setOrientation(o);
      }
    });
    React.useEffect(() => {
      const shortcut = useSettingStore.getState().pendingShortcut;

      if (shortcut?.type === "notesnook.action.newnote") {
        useSettingStore.setState({
          pendingShortcut: null
        });
      }
    }, []);

    useEffect(() => {
      if (!appLoading) {
        setTimeout(() => {
          setIsLoading(false);
        }, 200);
      }
    }, [appLoading]);

    const showFullScreenEditor = useCallback(() => {
      setFullscreen(true);
      /**
       * iPad: fullscreen is another presentation of the same width-derived
       * workspace (the sidebar and the note list keep their children mounted at
       * width 0), so there is no drawer to open for it. The legacy small-tablet
       * drawer call would open a drawer the fullscreen layout cannot show.
       */
      if (!isIPad && deviceMode === "smallTablet") {
        fluidTabsRef.current?.openDrawer(false);
      }
    }, [deviceMode, isIPad, setFullscreen]);

    const closeFullScreenEditor = useCallback(
      (current: string) => {
        const _deviceMode = current || deviceMode;
        /**
         * iPad: closing fullscreen restores the width-derived workspace it was
         * opened from, at the logical page the user was on - the pager
         * re-derives that page's offset at the restored pane widths by itself.
         * The legacy small-tablet/mobile calls below would instead force the
         * pager home (and re-close a drawer), which is why the iPad takes
         * neither of them.
         */
        if (!isIPad && _deviceMode === "smallTablet") {
          fluidTabsRef.current?.closeDrawer(false);
        }
        setFullscreen(false);
        editorController.current?.commands.updateSettings({
          fullscreen: false
        });
        if (!isIPad) {
          if (_deviceMode === "smallTablet") {
            fluidTabsRef.current?.goToIndex(1, false);
          }
          if (_deviceMode === "mobile") {
            fluidTabsRef.current?.goToIndex(2, false);
          }
        }
      },
      [deviceMode, isIPad, setFullscreen]
    );

    useEffect(() => {
      if (!fluidTabsRef.current?.isDrawerOpen()) toggleView(false);
      eSubscribeEvent(eOpenFullscreenEditor, showFullScreenEditor);
      eSubscribeEvent(eCloseFullscreenEditor, closeFullScreenEditor);

      return () => {
        eUnSubscribeEvent(eOpenFullscreenEditor, showFullScreenEditor);
        eUnSubscribeEvent(eCloseFullscreenEditor, closeFullScreenEditor);
      };
    }, [
      deviceMode,
      dimensions,
      colors,
      showFullScreenEditor,
      closeFullScreenEditor,
      toggleView
    ]);

    const setDeviceMode = React.useCallback(
      (current: string | null, size: { width: number; height: number }) => {
        setDeviceModeState(current);
        /**
         * iPad: this is only ever DDS's classification of the measured
         * size/orientation (see `checkDeviceType`), never a user action, and the
         * panes are laid out from the root width alone. So the normal store
         * classification above still happens for the consumers that read
         * `deviceMode`, but none of the legacy imperative pager actions may run:
         * `goToIndex(0)` would snap the pager home, `closeDrawer` would end a
         * drawer the width still wants, and the fullscreen-close would drop the
         * user out of a fullscreen editor on a mere rotation. A pure resize
         * therefore emits no `onChangeTab`, no editor clear, no blur and no
         * navigation - the pager re-derives the page it is already on. Explicit
         * user navigation (a swipe, a tap, fullscreen open/close) keeps its own
         * events.
         */
        if (isIPad) return;

        if (fullscreen && current === "mobile") {
          eSendEvent(eCloseFullscreenEditor, current);
        }

        setTimeout(() => {
          switch (current) {
            case "tablet":
              fluidTabsRef.current?.goToIndex(0, false);
              break;
            case "smallTablet":
              if (!fullscreen) {
                fluidTabsRef.current?.closeDrawer(false);
              }
              break;
            case "mobile":
              fluidTabsRef.current?.goToPage(
                fluidTabsRef.current?.page(),
                false
              );
              break;
          }
        }, 0);
      },
      [fullscreen, isIPad, setDeviceModeState]
    );

    const checkDeviceType = React.useCallback(
      (size: { width: number; height: number }) => {
        if (DDS.width === size.width && orientation === DDS.orientation) return;
        DDS.setSize(size, orientation);
        /**
         * Mac always lays out like the tablet: the three panes sit side by
         * side and the pager stays at x 0, so nothing can slide over the
         * editor or push it out of the window.
         */
        const nextDeviceMode = isMacCatalyst()
          ? "tablet"
          : DDS.isLargeTablet()
          ? "tablet"
          : DDS.isSmallTab
          ? "smallTablet"
          : "mobile";
        setDeviceMode(nextDeviceMode, size);
      },
      [orientation, setDeviceMode]
    );

    useEffect(() => {
      if (orientation !== "UNKNOWN") {
        checkDeviceType(dimensions);
      }
    }, [orientation, dimensions, checkDeviceType]);

    const _onLayout = React.useCallback(
      (event: LayoutChangeEvent) => {
        const size = event?.nativeEvent?.layout;
        setDimensions({
          width: size.width,
          height: size.height
        });
        if (size.width > size.height) {
          setOrientation(OrientationType["LANDSCAPE-RIGHT"]);
        } else {
          setOrientation(OrientationType["PORTRAIT"]);
        }
      },
      [setDimensions]
    );

    const PANE_WIDTHS: PaneWidths = useMemo(() => {
      const panes: PaneWidths = {
        mobile: {
          sidebar: dimensions.width * MOBILE_SIDEBAR_SIZE,
          list: dimensions.width,
          editor: dimensions.width
        },
        smallTablet: {
          sidebar: valueLimiter(dimensions.width * 0.3, 300, 350),
          list: valueLimiter(dimensions.width * 0.4, 300, 450),
          editor:
            dimensions.width - valueLimiter(dimensions.width * 0.4, 300, 450)
        },
        tablet: {
          // Android's large tablet keeps its 22% sidebar. The iPad used to
          // collapse that sidebar into this branch; a real iPad is now laid out
          // by the width-derived pane mode instead (see `paneWidths` below), so
          // these `tablet` widths are no longer read there. Mac overrides both
          // tablet branches below.
          sidebar: dimensions.width * 0.22,
          list: dimensions.width * 0.3,
          editor: dimensions.width * 0.48
        }
      };

      if (isMacCatalyst()) {
        /**
         * Mac lays out like macOS Notes: a persistent source-list sidebar, the
         * note list, and the editor taking exactly what is left of the window.
         * The three widths add up to the window width (see mac-layout.ts), which
         * is what keeps the editor's right edge - the "Add tag" button and the
         * header menu - inside the window; the clamped iPad widths overflowed it.
         *
         * With the sidebar hidden (View > Toggle Sidebar) its width is 0 and
         * the editor grows by that much, so the note list keeps its width and
         * the two remaining panes fill the window.
         */
        const macPanes = {
          sidebar: macSidebarWidth(dimensions.width, macSidebarVisible),
          list: macListWidth(dimensions.width),
          editor: macEditorWidth(dimensions.width, macSidebarVisible)
        };
        panes.smallTablet = macPanes;
        panes.tablet = macPanes;
      }

      return panes;
    }, [dimensions.width, macSidebarVisible]);

    /**
     * The iPad's three pane widths, from the measured root width alone (see
     * `ipadPaneWidths`): wide keeps a persistent 260 pt source sidebar and a
     * 320 pt note list with the document taking exactly what is left, medium
     * keeps the 300 pt list beside the drawer (30% of the root, clamped), and
     * narrow gives the note list and the document the full root width each, one
     * page at a time. Fullscreen is the one presentation the helper does not
     * model, so it is applied here: the document takes the whole window while
     * the sidebar and the note list keep their children mounted at width 0 - the
     * same nodes, so tab/scroll/selection survive the switch.
     */
    const ipadWidths = useMemo(() => {
      if (!isIPad || paneMode === undefined) return undefined;
      return fullscreen
        ? { sidebar: 0, list: 0, editor: dimensions.width }
        : ipadPaneWidths(dimensions.width, paneMode);
    }, [dimensions.width, fullscreen, isIPad, paneMode]);

    /**
     * The one set of pane widths this screen lays out with: the iPad's
     * width-derived widths where there is an iPad, `PANE_WIDTHS[deviceMode]`
     * (unchanged) everywhere else, and `undefined` on a client whose device mode
     * is not known yet - which is what the render guard below tests, exactly as
     * it tested `PANE_WIDTHS[deviceMode]` before.
     */
    const legacyWidths = deviceMode
      ? PANE_WIDTHS[deviceMode as keyof typeof PANE_WIDTHS]
      : undefined;
    const paneWidths = ipadWidths ?? legacyWidths;
    const pagerMounted = !!paneWidths;

    /**
     * Deliver a retained user open once it is deliverable. The `eOnLoadNote`
     * listener above runs at event time; a load that arrives before the root has
     * a measured width is held in `pendingOpenRef` and delivered here, exactly
     * once, by the render that follows the measurement.
     *
     * This is *not* a second navigation path. With no pending intent it does
     * nothing at all, so a pure resize - which re-runs it on every measured
     * width, the pager's mount included - still pages, focuses and navigates
     * nothing. When there is one, the intent is re-validated against the world as
     * it is *now*: a fullscreen toggle, a client change or an active-tab change
     * cancels it, while an unrelated background event never does. The intent is
     * cleared *before* the page change, so the pager's own report re-rendering
     * this screen cannot deliver it a second time.
     */
    useEffect(() => {
      const pending = pendingOpenRef.current;
      if (!pending) return;
      if (!isIPadRef.current || fullscreenRef.current) {
        // The workspace is no longer the one the note was opened in.
        pendingOpenRef.current = null;
        return;
      }
      if (paneModeRef.current === undefined || !(widthRef.current > 0)) {
        // Not deliverable yet: keep waiting for the measurement.
        return;
      }
      const pager = fluidTabsRef.current;
      if (!pager) return;
      if (
        pending.tabId &&
        pending.tabId !== useTabStore.getState().currentTab
      ) {
        // The active tab moved on while the intent waited.
        pendingOpenRef.current = null;
        return;
      }
      pendingOpenRef.current = null;
      if (pager.page() === "editor" && !pager.isDrawerOpen()) return;
      pager.goToPage("editor");
    }, [dimensions.width, paneMode, fullscreen, isIPad, pagerMounted]);

    /**
     * Whether the iPad sidebar is actually visible: the persistent column in
     * wide, the drawer only while it is open in medium, and never in narrow -
     * nor in fullscreen, where the sidebar is off the window whatever the mode
     * says. This is presentation state, derived from the mode and the pager's
     * own drawer reports; it never triggers a note/editor/navigation event.
     */
    const ipadSidebarVisible =
      isIPad &&
      !fullscreen &&
      (paneMode === "wide" || (paneMode === "medium" && ipadDrawerOpen));

    /**
     * The page the pager is actually on: its own report once it has given one,
     * the page `initialPage` seeded before that (see `pagerReportedTab`).
     */
    const editorPageActive = pagerReportedTab
      ? editorVisible
      : route.params?.initialPage === "editor";

    /**
     * Narrow is the only iPad mode that pages between two full-width panes: the
     * pager slides the off-screen one out of the window, but a mounted pane stays
     * reachable by VoiceOver and pointers unless it says otherwise. The current
     * page decides which pane is on screen, so the other one is hidden there;
     * wide and medium keep both panes in the row and hide neither, and fullscreen
     * keeps the width check the note list pane already had (its pane is 0 wide).
     */
    const ipadNarrow = isIPad && paneMode === "narrow";
    const ipadListPaneHidden =
      isIPad &&
      (paneWidths?.list === 0 ||
        (ipadNarrow && !fullscreen && editorPageActive));
    const ipadEditorPaneHidden = ipadNarrow && !fullscreen && !editorPageActive;

    /**
     * The workspace the iPad panes are laid out in, for the panes that must not
     * read (or write) `deviceMode` for it. Memoized so a root re-render does not
     * re-render every consumer, and `undefined` on every other client - the
     * provider publishes nothing there, so their consumers keep their existing
     * behaviour.
     */
    const ipadWorkspace = useMemo(
      () =>
        isIPad && paneMode
          ? { paneMode, sidebarVisible: ipadSidebarVisible }
          : undefined,
      [ipadSidebarVisible, isIPad, paneMode]
    );

    const onScroll = React.useCallback(
      (scrollOffset: number) => {
        if (!deviceMode) return;
        hideAllTooltips();
        if (Platform.OS === "ios" || deviceMode !== "mobile") return;
        const sidebarOffset = dimensions.width * MOBILE_SIDEBAR_SIZE;
        if (scrollOffset > sidebarOffset - 10) {
          animatedOpacity.value = 0;
          toggleView(false);
        } else {
          const o = scrollOffset / 300;
          const opacity = o < 0 ? 1 : 1 - o;
          animatedOpacity.value = opacity;
          toggleView(opacity >= 0.1);
        }
      },
      [animatedOpacity, deviceMode, dimensions.width, toggleView]
    );

    const animatedStyle = useAnimatedStyle(() => ({
      opacity: animatedOpacity.value,
      transform: [{ translateY: animatedTranslateY.value }]
    }));

    if (!isLoading && !SideMenu && !EditorWrapper) {
      SideMenu = require("../components/side-menu").SideMenu;
      EditorWrapper = require("../screens/editor/wrapper").EditorWrapper;
    }

    /**
     * The workspace itself: the mac section overlay and the panes, both under
     * this screen's root `View`. It is published through the iPad workspace
     * context below - stable, because the same node is only ever re-rendered,
     * never replaced - so the panes can read the width-derived mode and the
     * sidebar's actual visibility without touching `deviceMode`.
     */
    const workspace = (
      <View
        onLayout={_onLayout}
        testID={notesnook.ids.default.root}
        style={{
          height: "100%",
          width: "100%",
          // The root is opaque on every platform, Mac included: Catalyst does
          // not show the desktop through a clear UIWindow, so the Mac window is
          // opaque too (see SceneDelegate.m) and the glass sidebar needs a real
          // colour behind it, not a blank/light backdrop. `screenBackground` is
          // the shared window role of the resolved Apple surfaces: the neutral
          // window/toolbar tone (the theme's own authored colour for an
          // imported theme), the same colour the note list column and the band
          // behind the toolbar paint, so the strip between the floating glass
          // panel and the window edge matches the window instead of showing a
          // different corner. The list and editor panes still bring their own
          // opaque surfaces; only the sidebar pane stays transparent.
          backgroundColor: visual.screenBackground
        }}
      >
        {paneWidths ? (
          <FluidPanels
            ref={fluidTabsRef}
            dimensions={dimensions}
            widths={paneWidths}
            /**
             * iPad only: the width-derived pane mode. The pager then owns its
             * resting offset, its clamp, the drawer and the paging from
             * utils/ipad-layout.ts, and a width change re-derives the page it is
             * already on. Undefined on every other client, whose gesture enable
             * and legacy branches stay exactly as they were.
             */
            paneMode={paneMode}
            enabled={deviceMode !== "tablet" && !fullscreen}
            drawerEnabled={drawerEnabled}
            initialPage={route.params?.initialPage}
            onScroll={onScroll}
            onChangeTab={handleChangeTab}
            onDrawerStateChange={(state) => {
              /**
               * The pager's drawer reports are the only source of the iPad
               * sidebar's actual visibility (a swipe, the back-gesture close,
               * opening a page): they change this screen's presentation state,
               * never a note/editor/navigation event. On the iPad the drawer
               * flag tracks whether the sidebar is on screen at all; every
               * client keeps the existing dragging cleanup.
               */
              if (isIPad) setIpadDrawerOpen(state);
              if (!state) {
                useSideBarDraggingStore.setState({
                  dragging: false
                });
              }
            }}
          >
            {/* Mac's sidebar pane: a persistent source list (Library) at the
                left edge of the window, the leftmost of the three columns. It
                is not the side menu and has no drawer: selecting a row opens
                the note list in the middle column. The pane itself is
                transparent — the floating glass panel inside it is what paints
                the sidebar (see components/mac-sidebar.tsx) — so the opaque
                root below it (the app's window colour) shows through the
                material and through the 9 pt strip around the panel. */}
            {isMacCatalyst() ? (
              <View
                key="1"
                style={{
                  height: "100%",
                  // 0 both when the editor takes the whole window and when the
                  // sidebar is hidden (View > Toggle Sidebar, which makes
                  // PANE_WIDTHS.sidebar 0 as well).
                  width: fullscreen
                    ? 0
                    : PANE_WIDTHS[deviceMode as keyof typeof PANE_WIDTHS]
                        ?.sidebar,
                  // The floating glass panel draws its own rounded edge; a
                  // hairline here would cut across it, so the separator is
                  // gone with the opaque column.
                  borderRightWidth: 0,
                  // A zero-width pane keeps its children mounted (the source
                  // list keeps its scroll position), and iOS Views do not clip
                  // by default: without this the list would still paint over
                  // the note list.
                  overflow: macSidebarVisible ? "visible" : "hidden"
                }}
              >
                <ScopedThemeProvider value="list">
                  <MacSidebar />
                </ScopedThemeProvider>
              </View>
            ) : isIPad ? (
              /**
               * iPad's sidebar pane: the persistent source list in wide, the
               * swipe-in drawer in medium, and - in narrow - the same node at
               * width 0. It is mounted in every mode on purpose: the side menu
               * keeps its selected tab, its scroll position and its mounted
               * scenes across widths, and hiding it must never be a remount.
               *
               * That means "not visible" is the pane's own state, not its
               * absence, so when the sidebar is not actually visible (narrow, or
               * a closed medium drawer, or fullscreen) the pane takes no touches
               * and is hidden from VoiceOver on both platforms - `overflow:
               * hidden` is what keeps a 0-width pane's children from painting
               * over the note list, since iOS views do not clip by default.
               */
              <View
                key="1"
                pointerEvents={ipadSidebarVisible ? "auto" : "none"}
                accessibilityElementsHidden={!ipadSidebarVisible}
                importantForAccessibility={
                  ipadSidebarVisible ? "auto" : "no-hide-descendants"
                }
                style={{
                  height: "100%",
                  // The pane mode's width: 260 pt in wide, the drawer's own
                  // clamped width in medium, 0 in narrow and in fullscreen. The
                  // pager parks the closed drawer off the window's left edge, so
                  // a wide-open drawer is at x 0 and the note list starts at
                  // this width.
                  width: paneWidths.sidebar,
                  // The separator between the source sidebar and the note list,
                  // for the source list's right edge only while it is on screen
                  // (the closed drawer's edge is off the window).
                  borderRightWidth: ipadSidebarVisible ? 0.5 : 0,
                  borderRightColor: visual.separator,
                  overflow: ipadSidebarVisible ? "visible" : "hidden"
                }}
              >
                <ScopedThemeProvider value="navigationMenu">
                  {isLoading ? null : <SideMenu />}
                </ScopedThemeProvider>
              </View>
            ) : drawerEnabled ? (
              <View
                key="1"
                style={{
                  height: "100%",
                  width: fullscreen
                    ? 0
                    : PANE_WIDTHS[deviceMode as keyof typeof PANE_WIDTHS]
                        ?.sidebar,
                  borderRightWidth:
                    visual.ios && deviceMode === "tablet" ? 0.5 : 0,
                  borderRightColor: visual.separator
                }}
              >
                <ScopedThemeProvider value="navigationMenu">
                  {isLoading ? null : <SideMenu />}
                </ScopedThemeProvider>
              </View>
            ) : null}

            {/* The note list column (see components/list and the Library's own
                navigation stack inside it). It stays mounted, but where it is
                not the page on screen - the narrow iPad with the document
                active, or fullscreen, where its width is zero - it must take no
                touches and be hidden from VoiceOver, exactly like a hidden
                sidebar; everywhere else both props stay the defaults they
                had. */}
            <View
              key="2"
              pointerEvents={ipadListPaneHidden ? "none" : "auto"}
              accessibilityElementsHidden={ipadListPaneHidden}
              importantForAccessibility={
                ipadListPaneHidden ? "no-hide-descendants" : "auto"
              }
              style={{
                height: "100%",
                width: fullscreen ? 0 : paneWidths.list,
                // A zero-width list pane must not paint its (non-clipping)
                // children over the fullscreen document.
                overflow:
                  isIPad && paneWidths.list === 0 ? "hidden" : undefined,
                // The note list column paints the shared *list* role of the
                // resolved Apple surfaces, on Mac Catalyst and iPad alike
                // (`visual.listSurface`): a neutral surface of its own, one
                // step away from the window chrome behind the source list and
                // from the reading canvas, with no accent mixed in. Only Apple
                // clients take that role; Android and other clients keep the
                // screen background they have always painted here. Opaque on
                // purpose (F5): the sidebar's glass panel is the only
                // translucent surface, and it sits on the opaque root (the
                // app's window colour), never on this column.
                backgroundColor: visual.ios
                  ? visual.listSurface
                  : visual.screenBackground,
                // The separator between the list and the editor on Mac is the
                // 1 px line below, not a border on this column: it must start
                // at the toolbar's bottom edge, not run under the toolbar.
                borderRightWidth: isMacCatalyst()
                  ? 0
                  : visual.ios && deviceMode === "tablet"
                  ? 0.5
                  : 0,
                borderRightColor: visual.separator
              }}
            >
              <ScopedThemeProvider value="list">
                {Platform.OS !== "ios" && deviceMode === "mobile" ? (
                  <Animated.View
                    onTouchEnd={() => {
                      if (useSideBarDraggingStore.getState().dragging) {
                        useSideBarDraggingStore.setState({ dragging: false });
                        return;
                      }
                      fluidTabsRef.current?.closeDrawer();
                      animatedOpacity.value = withTiming(0);
                      animatedTranslateY.value = withTiming(-9999);
                    }}
                    style={[
                      {
                        position: "absolute",
                        width: "100%",
                        height: "100%",
                        zIndex: 999,
                        backgroundColor: colors.primary.backdrop
                      },
                      animatedStyle
                    ]}
                    ref={overlayRef}
                  />
                ) : null}
                <View
                  style={{
                    flex: 1,
                    // Mac: no band for the toolbar here. The list's own scroll
                    // content pads itself by `macToolbarInset` (components/
                    // list/index.tsx), so it starts below the borderless
                    // toolbar but still slides under it; the fade overlay below
                    // dissolves whatever reaches the top. iPhone/iPad keep the
                    // safe-area padding that puts the list below their opaque
                    // nav bar.
                    paddingTop: isMacCatalyst() ? 0 : insets.top,
                    // On iOS the bottom bar is laid out below this pane and
                    // already covers the home indicator; padding here as well
                    // would leave a dead strip above the bar.
                    paddingBottom: Platform.OS === "ios" ? 0 : insets.bottom
                  }}
                >
                  <AppNavigationStack />
                </View>
                {/* Mac's scroll-edge fade: the note list's background at the
                    top, transparent 56 pt down, over the scrolling content and
                    under the transparent toolbar. Not touchable, so the list
                    underneath keeps every scroll and press. Its opaque end
                    matches the list column above pixel for pixel, because both
                    paint the same resolved list surface. */}
                {isMacCatalyst() ? (
                  <MacScrollEdgeFade
                    color={visual.listSurface}
                    height={MAC_SCROLL_EDGE_FADE_HEIGHT}
                  />
                ) : null}
              </ScopedThemeProvider>
              {/* Mac's list/editor separation: a 1 px hairline at the list
                  column's right edge, from the toolbar's bottom edge to the
                  window bottom. It stops under the toolbar band so the title
                  row stays clean, and both sides keep the same neutral
                  surfaces. The hairline is the resolved separator role, so it
                  is the standard neutral separator (`#D9D9DE` light /
                  `#36363A` dark) rather than the theme border, which used to be
                  drawn at 60% opacity on top of it. */}
              {isMacCatalyst() && !fullscreen ? (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: macToolbarInset(insets.top),
                    bottom: 0,
                    right: 0,
                    width: 1,
                    backgroundColor: visual.separator
                  }}
                />
              ) : null}
            </View>

            <ScopedThemeProvider value="editor">
              {/* The document pane takes exactly what the iPad's pane mode
                  leaves (the sidebar and the note list are its fixed or drawer
                  widths), so its right edge - the editor's own toolbar - stays
                  inside the window. `editorWidth` is supplied on the iPad only;
                  every other client keeps resolving its width from
                  `PANE_WIDTHS[deviceMode]` in the wrapper. */}
              {isLoading ? null : (
                <EditorWrapper
                  widths={PANE_WIDTHS}
                  editorWidth={isIPad ? paneWidths.editor : undefined}
                  /* iPad only: narrow's other page is the note list, so the
                     document pane is the one parked off the window (and out of
                     VoiceOver/pointer reach) while the list is the page. */
                  paneHidden={isIPad ? ipadEditorPaneHidden : undefined}
                />
              )}
            </ScopedThemeProvider>
          </FluidPanels>
        ) : null}

        {/*
          Mac: while Tasks or Search owns the content area, the sidebar pane
          stays where it is and the section's screen fills everything to its
          right (the section routes bring their own source-list pane, see
          components/mac-section-layout.tsx). This covers the Library's note
          list and editor columns - whose own surfaces are painted on top of
          each other - with the screen background the section screens use, so
          none of the Library layout can show through the section. It starts at
          the sidebar's right edge, so it never covers the source list; with the
          sidebar hidden that edge is 0 and it covers the whole window.

          It is not touchable - the section's screen is above this one - and the
          panes stay mounted underneath, so the editor keeps its state and the
          three-column layout comes back exactly as it was when the Library
          section returns.
        */}
        {macSection ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: macSidebarWidth(dimensions.width, macSidebarVisible),
              right: 0,
              bottom: 0,
              backgroundColor: visual.screenBackground
            }}
          />
        ) : null}
      </View>
    );

    return (
      <IPadWorkspaceProvider value={ipadWorkspace}>
        {workspace}
      </IPadWorkspaceProvider>
    );
  },
  () => true
);
FluidPanelsView.displayName = "FluidPanelsView";

export default FluidPanelsView;

const onChangeTab = async (event: { i: number; from: number }) => {
  useAppleNavigationStore.getState().setEditorVisible(event.i === 2);
  if (event.i === 2) {
    editorState().movedAway = false;
    editorState().isFocused = true;
    if (useSettingStore.getState().settings.keepScreenOn) {
      activateKeepAwake();
    }
    eSendEvent(eOnEnterEditor);

    if (
      useTabStore.getState().getTab(useTabStore.getState().currentTab)?.session
        ?.locked
    ) {
      eSendEvent(eUnlockNote);
    }

    if (
      fluidTabsRef.current?.tabChangedFromSwipeAction.value &&
      !useTabStore.getState().getNoteIdForTab(useTabStore.getState().currentTab)
    ) {
      editorController?.current?.commands?.focus(
        useTabStore.getState().currentTab
      );
    }
  } else {
    if (event.from === 2) {
      deactivateKeepAwake();
      editorState().movedAway = true;
      editorState().isFocused = false;
      eSendEvent(eOnExitEditor);

      // Lock all tabs with locked notes...
      for (const tab of useTabStore.getState().tabs) {
        const noteId = useTabStore.getState().getTab(tab.id)?.session?.noteId;
        if (!noteId) continue;
        const note = await db.notes.note(noteId);
        const locked = note && (await db.vaults.itemExists(note));
        if (locked) {
          useTabStore.getState().updateTab(tab.id, {
            session: {
              locked: true
            }
          });
        }
      }
    }
  }
};
