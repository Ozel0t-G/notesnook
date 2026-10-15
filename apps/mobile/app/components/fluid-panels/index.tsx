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

import React, {
  forwardRef,
  RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from "react";
import { BackHandler, Platform, ViewProps } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  SharedValue,
  SnappySpringConfig,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  WithSpringConfig,
  withTiming
} from "react-native-reanimated";
import { eSendEvent } from "../../services/event-manager";
import { useSettingStore } from "../../stores/use-setting-store";
import { eClearEditor } from "../../utils/events";
import {
  IPadPaneMode,
  IPadPagerPage,
  ipadDrawerEnabled,
  ipadPagerMaxOffset,
  ipadPagerOffset,
  ipadPagingEnabled,
  ipadPanGestureEnabled,
  resolveIPadDrawerResize,
  resolveIPadDrawerSnap,
  resolveIPadGoToIndex
} from "../../utils/ipad-layout";
import { useSideBarDraggingStore } from "../side-menu/dragging-store";
import { rootNavigatorRef } from "../../utils/global-refs";

interface TabProps extends ViewProps {
  dimensions: { width: number; height: number };
  widths: { sidebar: number; list: number; editor: number };
  onChangeTab: (data: { i: number; from: number }) => void;
  onScroll: (offset: number) => void;
  enabled: boolean;
  /**
   * iPad keeps the sidebar pane and its swipe-to-open drawer. iPhone navigates
   * with the bottom bar instead, so the drawer is disabled there entirely.
   */
  drawerEnabled: boolean;
  /**
   * iPad only: the width-derived pane mode the workspace is showing (see
   * utils/ipad-layout.ts). Undefined on every other client, and undefined keeps
   * this component's behaviour exactly as it was.
   *
   * The mode decides where the pager rests and how far it may be dragged - wide
   * never moves (the panes are side by side), medium only drags the drawer
   * (whose width is the note list's left edge), narrow pages between the
   * full-width list and document like today - but the *logical* page is tracked
   * by `currentTab` in every mode. A width or mode change re-derives the
   * position of the page that is already current and never switches pages, so a
   * rotation cannot clear the editor, blur it or reset the selection.
   */
  paneMode?: IPadPaneMode;
  onDrawerStateChange: (state: boolean) => void;
  initialPage?: FluidTabPage;
}

export type FluidTabPage = "home" | "editor";

export interface TabsRef {
  goToPage: (page: FluidTabPage, animated?: boolean) => void;
  goToIndex: (index: number, animated?: boolean) => 0 | undefined;
  unlock: () => boolean;
  lock: () => boolean;
  openDrawer: (animated?: boolean) => void;
  closeDrawer: (animated?: boolean) => void;
  page: () => FluidTabPage;
  setScrollEnabled: () => true;
  isDrawerOpen: () => boolean;
  node: RefObject<Animated.View | null>;
  tabChangedFromSwipeAction: SharedValue<boolean>;
}

export const FluidPanels = forwardRef<TabsRef, TabProps>(function FluidTabs(
  {
    children,
    dimensions,
    widths,
    onChangeTab,
    onScroll,
    enabled,
    drawerEnabled,
    paneMode,
    onDrawerStateChange,
    initialPage
  }: TabProps,
  ref
) {
  const deviceMode = useSettingStore((state) => state.deviceMode);
  const fullscreen = useSettingStore((state) => state.fullscreen);
  const isIPadWorkspace = paneMode !== undefined;
  const editorStartPosition = widths.sidebar + widths.list;
  /**
   * Where a logical page lives for the current pane widths. On the iPad it is
   * the pane-mode contract (0 in wide, the drawer in medium, the existing
   * full-width pages in narrow); everywhere else it is the paging position this
   * pager has always used.
   */
  const offsetForPage = useCallback(
    (page: IPadPagerPage) =>
      paneMode
        ? ipadPagerOffset(paneMode, page, widths)
        : page === "editor"
        ? editorStartPosition
        : widths.sidebar,
    [paneMode, widths, editorStartPosition]
  );
  const translateX = useSharedValue(
    offsetForPage(initialPage === "editor" ? "editor" : "home")
  );
  const startX = useSharedValue(0);
  const currentTab = useSharedValue(
    initialPage === "editor" && (isIPadWorkspace || deviceMode !== "tablet")
      ? 2
      : 1
  );
  const previousTab = useSharedValue(1);
  const isDrawerOpen = useSharedValue(false);
  const gestureStartValue = useSharedValue({
    x: 0,
    y: 0
  });
  const locked = useSharedValue(false);
  const forcedLock = useSharedValue(false);
  const [disabled, setDisabled] = useState(false);
  const node = useRef<Animated.View>(null);
  const containerWidth = widths
    ? widths.sidebar + widths.list + widths.editor
    : dimensions.width;
  const drawerPosition = 0;
  const homePosition = paneMode
    ? ipadPagerOffset(paneMode, "home", widths)
    : widths.sidebar;
  const editorPosition = paneMode
    ? ipadPagerOffset(paneMode, "editor", widths)
    : widths.sidebar + widths.list;
  /**
   * The furthest the pager may be dragged/paged in this mode. On the iPad it is
   * the pane-mode contract (0 in wide, the drawer in medium, the document page
   * in narrow) so the gesture clamp and the resting offsets are derived from
   * the same helper; everywhere else it stays the legacy editor page.
   */
  const pagerMaxOffset = paneMode
    ? ipadPagerMaxOffset(paneMode, widths)
    : editorPosition;
  /**
   * Whether the source sidebar is a swipe-in drawer here. On iPhone/iPad this
   * is the prop; the iPad pane mode owns it (drawer only in medium), so wide
   * and narrow never fall into the legacy drawer handling.
   */
  const allowDrawer = paneMode ? ipadDrawerEnabled(paneMode) : drawerEnabled;
  /** Whether the pager pages between the list and the editor (narrow only). */
  const pagingEnabled = paneMode ? ipadPagingEnabled(paneMode) : true;
  const isSmallTab = deviceMode === "smallTablet";
  const isLoaded = useRef(false);
  const prevWidths = useRef(widths);
  const prevPaneMode = useRef(paneMode);
  const isIPhone = Platform.OS === "ios";
  const tabChangedFromSwipeAction = useSharedValue(false);
  /**
   * The root passes `onDrawerStateChange` as an inline arrow, so its identity
   * changes on every root render. Calling it from the width effect through the
   * prop directly would force the effect to depend on that unstable identity -
   * re-running (and re-deriving the pager) on every parent render. A ref keeps
   * the callback current without ever making the width effect re-run for it.
   */
  const onDrawerStateChangeRef = useRef(onDrawerStateChange);
  useEffect(() => {
    onDrawerStateChangeRef.current = onDrawerStateChange;
  }, [onDrawerStateChange]);

  useEffect(() => {
    if (paneMode) {
      /**
       * A width or mode change only re-derives where the page that is already
       * current lives at the new metrics. It never touches the logical page, so
       * it cannot clear the editor, blur it, notify a tab change or snap the
       * pager home (which is why wide's `translateX = 0` is not reused here).
       *
       * An already-open medium drawer is the one thing that does not rest on a
       * page offset: it is parked at the drawer's own offset, so a medium ->
       * medium resize keeps it exactly there instead of snapping it onto the
       * closed page offset while `isDrawerOpen` still says it is open. Leaving
       * medium ends the drawer, so the flag is cleared and the close reported.
       */
      const previousPaneMode = prevPaneMode.current;
      prevPaneMode.current = paneMode;
      const drawerResize = resolveIPadDrawerResize(
        previousPaneMode,
        paneMode,
        isDrawerOpen.value
      );
      if (drawerResize.keepDrawerOpen) {
        translateX.value = drawerPosition;
      } else {
        if (drawerResize.reportClose) {
          isDrawerOpen.value = false;
          onDrawerStateChangeRef.current(false);
        }
        translateX.value = offsetForPage(
          currentTab.value === 2 ? "editor" : "home"
        );
      }
    } else if (deviceMode === "tablet" || fullscreen) {
      translateX.value = 0;
    } else {
      if (prevWidths.current?.sidebar !== widths.sidebar) {
        translateX.value = widths.sidebar;
        if (translateX.value === editorPosition) {
          onChangeTab?.({ i: 2, from: 1 });
        }
      }
    }
    isLoaded.current = true;
    prevWidths.current = widths;
  }, [
    deviceMode,
    widths,
    fullscreen,
    translateX,
    editorPosition,
    onChangeTab,
    paneMode,
    offsetForPage,
    currentTab,
    isDrawerOpen,
    drawerPosition
  ]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (allowDrawer && isDrawerOpen.value && !forcedLock.value) {
        const routeNames = rootNavigatorRef.current?.getState().routes;
        if (routeNames) {
          const currentRoute = routeNames[routeNames.length - 1].name;
          if (currentRoute !== "FluidPanelsView") return false;
        }

        translateX.value = withTiming(homePosition);
        onDrawerStateChange(false);
        isDrawerOpen.value = false;
        return true;
      }
      return false;
    });
    return () => {
      sub && sub.remove();
    };
  }, [
    allowDrawer,
    forcedLock.value,
    homePosition,
    isDrawerOpen,
    onDrawerStateChange,
    translateX
  ]);

  useImperativeHandle(
    ref,
    (): TabsRef => ({
      goToPage: (page: FluidTabPage, animated = true) => {
        if (paneMode) {
          /**
           * The page contract, not the device mode: the pager rests where the
           * logical page lives in this mode (0 in wide, the drawer in medium,
           * the page itself in narrow), and - unlike the legacy tablet branch -
           * the logical page is still tracked, so `page()` stays truthful even
           * where the pager does not move.
           */
          const target = offsetForPage(page);
          translateX.value = animated ? withTiming(target) : target;
          currentTab.value = page === "home" ? 1 : 2;
          /**
           * Opening a page closes the drawer, and the close is only reported
           * when one was actually open: the root's handler re-writes its drawer
           * state and the sidebar-drag store on every `false`, so a needless
           * report is a needless render.
           */
          if (isDrawerOpen.value) {
            isDrawerOpen.value = false;
            onDrawerStateChange(false);
          }
          tabChangedFromSwipeAction.value = false;
          return;
        }
        if (deviceMode === "tablet") {
          translateX.value = animated ? withTiming(0) : 0;
          return;
        }
        if (page === "home") {
          onDrawerStateChange(false);
          translateX.value = !animated
            ? homePosition
            : withTiming(homePosition);
          currentTab.value = 1;
        } else if (page === "editor") {
          onDrawerStateChange(false);
          translateX.value = !animated
            ? editorPosition
            : withTiming(editorPosition);
          currentTab.value = 2;
        }
        tabChangedFromSwipeAction.value = false;
      },
      goToIndex: (index: number, animated = true) => {
        if (paneMode) {
          /**
           * Index 0 is the drawer and exists only in medium; indexes 1/2 are
           * the home/editor pages, which rest at the same offset in wide and
           * medium but still move the logical page. An index this pager does
           * not own - out of range, or the drawer where the mode has none - is
           * a no-op, so it cannot mutate the swipe state either.
           */
          const plan = resolveIPadGoToIndex(index, allowDrawer);
          if (plan.kind === "drawer") {
            translateX.value = animated
              ? withSpring(drawerPosition)
              : drawerPosition;
            isDrawerOpen.value = true;
            onDrawerStateChange(true);
            return drawerPosition;
          }
          if (plan.kind === "page") {
            const target = offsetForPage(plan.page);
            translateX.value = animated ? withTiming(target) : target;
            currentTab.value = plan.page === "home" ? 1 : 2;
            /**
             * Opening a page closes the drawer - the drawer is not a pager
             * page, and the resting offset above is the closed-drawer one - and
             * the close is reported once so the root's drawer state stays
             * truthful. There is nothing to report when no drawer was open.
             */
            if (isDrawerOpen.value) {
              isDrawerOpen.value = false;
              onDrawerStateChange(false);
            }
            tabChangedFromSwipeAction.value = false;
          }
          return;
        }
        if (deviceMode === "tablet") {
          translateX.value = animated ? withTiming(0) : 0;
          return;
        }
        if (index === 0) {
          if (!drawerEnabled) return;
          onDrawerStateChange(true);
          return (translateX.value = animated ? withSpring(0) : 0);
        }
        if (index === 1) {
          translateX.value = animated ? withTiming(homePosition) : homePosition;
          currentTab.value = 1;
        } else if (index === 2) {
          translateX.value = animated
            ? withTiming(editorPosition)
            : editorPosition;
          currentTab.value = 2;
        }
        tabChangedFromSwipeAction.value = false;
      },
      unlock: () => {
        forcedLock.value = false;
        return false;
      },
      lock: () => {
        forcedLock.value = true;
        return true;
      },
      isDrawerOpen: () => allowDrawer && isDrawerOpen.value,
      openDrawer: (animated = true) => {
        if (paneMode) {
          // The drawer is the medium-mode sidebar: wide keeps the sidebar in
          // the row and narrow has none, so neither may fall through to the
          // legacy tablet branch (which would spring the whole pager to 0).
          if (!allowDrawer) return;
          translateX.value = animated
            ? withSpring(drawerPosition, {
                mass: 0.5
              })
            : drawerPosition;
          isDrawerOpen.value = true;
          onDrawerStateChange(true);
          return;
        }
        if (!drawerEnabled) return;
        if (deviceMode === "tablet") {
          translateX.value = animated ? withTiming(0) : 0;
          return;
        }
        translateX.value = animated
          ? withSpring(drawerPosition, {
              mass: 0.5
            })
          : drawerPosition;
        isDrawerOpen.value = true;
        onDrawerStateChange(true);
      },
      closeDrawer: (animated = true) => {
        if (paneMode) {
          // Close back onto the current logical page, which in medium is the
          // drawer's width. The legacy non-animated 299/300 nudge exists to
          // force a reflow on the phone drawer and must not run on the iPad:
          // it would leave the pager 300 pt off its pane.
          // Nothing to end where the mode has no drawer (wide keeps the sidebar
          // in the row, narrow has none) or where it is already closed: a no-op
          // avoids a pointless pager move, drag-store write and root report.
          if (!allowDrawer || !isDrawerOpen.value) return;
          if (forcedLock.value) return;
          const target = offsetForPage(
            currentTab.value === 2 ? "editor" : "home"
          );
          translateX.value = animated ? withTiming(target) : target;
          useSideBarDraggingStore.setState({
            dragging: false
          });
          onDrawerStateChange(false);
          isDrawerOpen.value = false;
          return;
        }
        if (!drawerEnabled) return;
        if (forcedLock.value) return;
        if (deviceMode === "tablet") {
          translateX.value = animated ? withTiming(0) : 0;
          return;
        }
        translateX.value = animated ? withTiming(homePosition) : homePosition;
        if (!animated) {
          translateX.value = 299;
          translateX.value = 300;
        }
        useSideBarDraggingStore.setState({
          dragging: false
        });
        onDrawerStateChange(false);
        isDrawerOpen.value = false;
      },
      page: () => (currentTab.value === 1 ? "home" : "editor"),
      setScrollEnabled: () => true,
      node: node,
      tabChangedFromSwipeAction: tabChangedFromSwipeAction
    }),
    [
      currentTab,
      deviceMode,
      drawerEnabled,
      paneMode,
      allowDrawer,
      offsetForPage,
      translateX,
      onDrawerStateChange,
      homePosition,
      editorPosition,
      drawerPosition,
      forcedLock,
      isDrawerOpen,
      tabChangedFromSwipeAction
    ]
  );

  useAnimatedReaction(
    () => currentTab.value,
    (result) => {
      if (setDisabled) {
        if (paneMode && !pagingEnabled) {
          /**
           * Wide and medium never page between the panes, so a logical editor
           * page must not disable the pan: in medium the pan *is* the drawer,
           * and the drawer has to stay reachable while the editor is open.
           */
          runOnJS(setDisabled)(false);
        } else if (result === 2) {
          runOnJS(setDisabled)(!isIPhone);
        } else {
          runOnJS(setDisabled)(false);
        }
      }

      if (onChangeTab) {
        const previous = previousTab.value;
        /**
         * Recreating this reaction - which a pane mode or paging change does -
         * re-invokes it with the value that is already current. That is not a
         * tab change: delivering it would re-enter (i === 2) or exit the editor
         * for a page that never moved. So on the iPad an unchanged logical page
         * is silent, while an actual page change is still delivered exactly
         * once. Every other client keeps the original unconditional delivery.
         */
        if (paneMode && result === previous) return;
        previousTab.value = result;
        runOnJS(onChangeTab)({ i: result, from: previous });
      }
    },
    [paneMode, pagingEnabled]
  );

  useAnimatedReaction(
    () => translateX.value,
    (value) => {
      runOnJS(onScroll)(value);
    },
    []
  );

  const clearEditor = () => {
    setTimeout(() => {
      eSendEvent(eClearEditor);
    }, 300);
  };

  const gesture = Gesture.Pan()
    .maxPointers(1)
    .enabled(
      paneMode
        ? ipadPanGestureEnabled(paneMode) && !fullscreen
        : enabled && !disabled
    )
    .activeOffsetX([-5, 5])
    .failOffsetY([-10, 10])
    .onBegin((event) => {
      locked.value = false;
      gestureStartValue.value = {
        x: event.absoluteX,
        y: event.absoluteY
      };
    })
    .onStart((event) => {
      let vx = event.velocityX;
      let vy = event.velocityY;

      if (vx < 0) vx = vx * -1;
      if (vy < 0) vy = vy * -1;
      // if vy is greater than vx, user is swiping vertically. lock swiping.
      if (vy > vx) locked.value = true;
      // if dividend of vx/vy is less than 4, user is swiping diagonally. lock swiping
      if (vx / vy < 1.5) locked.value = true;
      startX.value = translateX.value;
    })
    .onChange((event) => {
      if (locked.value || forcedLock.value) return;
      const value = translateX.value + event.changeX * -1;
      if (paneMode) {
        /**
         * One clamp for every mode, derived from the same helper that owns the
         * resting offsets: wide never moves (0), medium is the drawer
         * (0..sidebar) and narrow pages between the two full-width panes
         * (0..width). The pager therefore cannot be dragged past a pane's edge
         * or left showing a blank strip, and the legacy device-mode heuristics
         * (small-tablet lock, Android editor lock) never apply on the iPad.
         */
        if (value < 0 || value > pagerMaxOffset) return;
        translateX.value = value;
        return;
      }
      if (
        value < 0 ||
        (currentTab.value === 2 && Platform.OS === "android") ||
        (currentTab.value === 2 &&
          gestureStartValue.value.x > 25 &&
          Platform.OS === "ios") ||
        (value >= homePosition && isSmallTab) ||
        value > editorPosition
      )
        return;
      translateX.value = value;
    })
    .onEnd((event) => {
      if (locked.value || forcedLock.value) return;
      const velocityX =
        event.velocityX < 0 ? event.velocityX * -1 : event.velocityX;
      const isSwipeLeft = startX.value > translateX.value;
      const finalValue = isSwipeLeft
        ? translateX.value - velocityX / 40.0
        : translateX.value + velocityX / 40.0;
      const velocity = velocityX / 5000;
      const animationConfig: WithSpringConfig = {
        velocity: velocity,
        ...SnappySpringConfig
      };

      if (paneMode === "medium") {
        /**
         * Medium is the drawer alone: the pan either opens it (0) or closes it
         * onto the drawer's width, and it never pages, never moves the logical
         * page and never clears the editor. Snapping to an endpoint means no
         * intermediate offset is ever left behind.
         */
        const target = resolveIPadDrawerSnap(
          translateX.value,
          event.velocityX,
          pagerMaxOffset
        );
        if (target === "open") {
          translateX.value = withSpring(0, animationConfig);
          isDrawerOpen.value = true;
          runOnJS(onDrawerStateChange)(true);
        } else {
          translateX.value = withSpring(pagerMaxOffset, animationConfig);
          isDrawerOpen.value = false;
          runOnJS(onDrawerStateChange)(false);
        }
        startX.value = 0;
        return;
      }

      if (currentTab.value === 2 && Platform.OS === "android") return;

      if (allowDrawer && finalValue < homePosition) {
        if (isSwipeLeft && finalValue < homePosition - 100) {
          translateX.value = withSpring(0, animationConfig);
          isDrawerOpen.value = true;
          currentTab.value = 1;
          runOnJS(onDrawerStateChange)(true);
          tabChangedFromSwipeAction.value = true;
          return;
        } else if (!isSwipeLeft && finalValue > 100) {
          translateX.value = withSpring(homePosition, animationConfig);
          isDrawerOpen.value = false;
          currentTab.value = 1;
          runOnJS(onDrawerStateChange)(false);
          tabChangedFromSwipeAction.value = true;
          return;
        } else if (!isSwipeLeft && finalValue < 100) {
          translateX.value = withSpring(0, animationConfig);
          isDrawerOpen.value = true;
          currentTab.value = 1;
          tabChangedFromSwipeAction.value = true;
          return;
        }
      }

      if (finalValue > homePosition && currentTab.value === 1) {
        const sizeOfEditorInView = finalValue - homePosition;
        if (!isSwipeLeft && sizeOfEditorInView > 150) {
          translateX.value = withSpring(editorPosition, animationConfig);
          currentTab.value = 2;
          isDrawerOpen.value = false;

          tabChangedFromSwipeAction.value = true;
          return;
        }
      }

      if (currentTab.value === 2) {
        if (finalValue < editorPosition - 100 && isSwipeLeft) {
          translateX.value = withSpring(homePosition, animationConfig);
          currentTab.value = 1;
          isDrawerOpen.value = false;
          runOnJS(clearEditor)();
        } else {
          translateX.value = withSpring(editorPosition, animationConfig);
          currentTab.value = 2;
        }

        tabChangedFromSwipeAction.value = true;
        return;
      }

      runOnJS(onDrawerStateChange)(false);
      translateX.value = withSpring(homePosition, animationConfig);
      currentTab.value = 1;
      isDrawerOpen.value = false;
      startX.value = 0;
    });

  const animatedStyles = useAnimatedStyle(() => {
    return {
      transform: [
        {
          translateX: translateX.value * -1
        }
      ]
    };
  }, []);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        ref={node}
        removeClippedSubviews={false}
        collapsable={false}
        style={[
          {
            flex: 1,
            width: containerWidth,
            flexDirection: "row"
          },
          animatedStyles
        ]}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
});
