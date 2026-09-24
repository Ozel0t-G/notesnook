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

import { Suspense, useEffect, useRef } from "react";
import { Box, Flex } from "@theme-ui/components";
import { ScopedThemeProvider } from "./components/theme-provider";
import useMobile from "./hooks/use-mobile";
import useTablet from "./hooks/use-tablet";
import { useStore } from "./stores/app-store";
import { useStore as useSettingStore } from "./stores/setting-store";
import { Toaster } from "react-hot-toast";
import NavigationMenu from "./components/navigation-menu";
import StatusBar from "./components/status-bar";
import { FlexScrollContainer } from "./components/scroll-container";
import CachedRouter from "./components/cached-router";
import { WebExtensionRelay } from "./utils/web-extension-relay";
import {
  Pane,
  SplitPane,
  SplitPaneImperativeHandle
} from "./components/split-pane";
import GlobalMenuWrapper from "./components/global-menu-wrapper";
import AppEffects from "./app-effects";
import HashRouter from "./components/hash-router";
import { useWindowFocus } from "./hooks/use-window-focus";
import { Global } from "@emotion/react";
import { isMac } from "./utils/platform";
import useSlider from "./hooks/use-slider";
import { AppEventManager, AppEvents } from "./common/app-events";
import { getFontSizes } from "@notesnook/theme/theme/font/fontsize.js";
import { useWindowControls } from "./hooks/use-window-controls";
import { STATUS_BAR_HEIGHT } from "./common/constants";
import { NavigationEvents } from "./navigation";
import { getCurrentPath, hashNavigate, navigate } from "./navigation";
import useLocation from "./hooks/use-location";
import { CREATE_BUTTON_MAP } from "./common";
import { useStore as useSearchStore } from "./stores/search-store";
import "./styles/veyran-mac-shell.css";

new WebExtensionRelay();

function App() {
  const isMobile = useMobile();
  const isFocusMode = useStore((store) => store.isFocusMode);
  const { isFocused } = useWindowFocus();
  const { isFullscreen } = useWindowControls();
  const hasNativeTitlebar =
    useSettingStore.getState().desktopIntegrationSettings?.nativeTitlebar;
  const isMacDesktop = IS_DESKTOP_APP && isMac();
  console.timeEnd("loading app");

  useEffect(() => {
    if (isMobile) {
      useStore.setState({
        isNavPaneCollapsed: false
      });
    }
  }, [isMobile]);

  return (
    <>
      {!isMacDesktop && !isFocused ? (
        <Global
          styles={`
          .nav-pane {
            opacity: 0.7;
          }
        `}
        />
      ) : null}
      {isMacDesktop && !isFullscreen && !hasNativeTitlebar ? (
        <Global
          // These styles to make sure the app content doesn't overlap with the traffic lights.
          styles={`
            .editor-pane:first-of-type .editor-action-bar,
            .mobile-editor-pane.pane-active .editor-action-bar,
            .mobile-list-pane.pane-active .route-container-header {
                padding-left: 80px;
            }
            .editor-action-bar {
              border-bottom: none;
            }
            .route-container-header .routeHeader {
              font-size: ${getFontSizes().title};
            }
          `}
        />
      ) : null}

      <Suspense fallback={<div style={{ display: "none" }} />}>
        <div id="menu-wrapper">
          <GlobalMenuWrapper />
        </div>
      </Suspense>
      <AppEffects />

      <Flex
        id="app"
        bg="background"
        className={[
          isFocusMode ? "app-focus-mode" : "",
          isMacDesktop ? "veyran-mac" : "",
          isMacDesktop && !isFocused ? "veyran-mac-inactive" : ""
        ]
          .filter(Boolean)
          .join(" ")}
        sx={{
          overflow: "hidden",
          flexDirection: "column",
          height: "100%"
        }}
      >
        {isMobile ? <MobileAppContents /> : <DesktopAppContents />}
        <Toaster
          containerClassName="toasts-container"
          containerStyle={{ bottom: STATUS_BAR_HEIGHT + 10 }}
        />
      </Flex>
    </>
  );
}

export default App;

function DesktopAppContents() {
  const isFocusMode = useStore((store) => store.isFocusMode);
  const isListPaneVisible = useStore((store) => store.isListPaneVisible);
  const isTablet = useTablet();
  const isMacDesktop = IS_DESKTOP_APP && isMac();
  const navPane = useRef<SplitPaneImperativeHandle>(null);
  const autoCollapsedSidebar = useRef(false);
  const pendingNewNote = useRef(false);
  const [location] = useLocation();
  const isMacTasks = isMacDesktop && location.startsWith("/tasks");

  useEffect(() => {
    // CachedRouter publishes onNavigate after the destination route has mounted.
    if (!pendingNewNote.current || !location.startsWith("/notes")) return;
    pendingNewNote.current = false;
    CREATE_BUTTON_MAP.notes.onClick();
  }, [location]);

  useEffect(() => {
    if (!isMacDesktop) return;
    const onMenuCommand = (command: string) => {
      switch (command) {
        case "toggle-sidebar":
          autoCollapsedSidebar.current = false;
          window.localStorage.removeItem("veyran:mac:auto-sidebar-collapsed");
          if (navPane.current?.isCollapsed(0)) navPane.current?.reset(0);
          else navPane.current?.collapse(0);
          break;
        case "new-note":
          if (getCurrentPath().startsWith("/tasks")) {
            pendingNewNote.current = true;
            navigate("/notes", { notify: true });
          } else {
            CREATE_BUTTON_MAP.notes.onClick();
          }
          break;
        case "new-task":
          hashNavigate("/tasks/create");
          break;
        case "show-notes":
          navigate("/notes", { notify: true });
          break;
        case "show-tasks":
          navigate("/tasks", { notify: true });
          break;
        case "search":
          if (getCurrentPath().startsWith("/tasks")) {
            document.getElementById("veyran-task-search")?.focus();
          } else {
            useSearchStore.setState({ isSearching: true, searchType: "notes" });
          }
          break;
      }
    };
    return window.veyranMenu?.onCommand(onMenuCommand);
  }, [isMacDesktop]);

  useEffect(() => {
    if (!isMacDesktop) return;
    autoCollapsedSidebar.current =
      window.localStorage.getItem("veyran:mac:auto-sidebar-collapsed") ===
      "true";
    const adaptToWindow = () => {
      const pane = navPane.current;
      if (!pane) return;
      if (window.innerWidth < 1060 && !pane.isCollapsed(0)) {
        autoCollapsedSidebar.current = true;
        window.localStorage.setItem("veyran:mac:auto-sidebar-collapsed", "true");
        pane.collapse(0);
      } else if (window.innerWidth >= 1060 && autoCollapsedSidebar.current) {
        autoCollapsedSidebar.current = false;
        window.localStorage.removeItem("veyran:mac:auto-sidebar-collapsed");
        pane.expand(0);
      }
    };
    const frame = requestAnimationFrame(adaptToWindow);
    window.addEventListener("resize", adaptToWindow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", adaptToWindow);
    };
  }, [isMacDesktop]);

  useEffect(() => {
    if (isMacDesktop) return;
    if (isTablet) navPane.current?.collapse(0);
    else if (navPane.current?.isCollapsed(0)) navPane.current?.expand(0);
  }, [isMacDesktop, isTablet]);

  useEffect(() => {
    const event = AppEventManager.subscribe(
      AppEvents.revealItemInList,
      async (id?: string) => {
        if (!useStore.getState().isListPaneVisible) {
          useStore.getState().toggleListPane(true);
          setTimeout(() => {
            AppEventManager.publish(AppEvents.revealItemInList, id);
          }, 500);
        }
      }
    );

    const navEvent = NavigationEvents.subscribe("onNavigate", (_route, path) => {
      if (IS_DESKTOP_APP && isMac() && String(path).startsWith("/tasks"))
        return;
      useStore.getState().toggleListPane(true);
    });
    return () => {
      navEvent.unsubscribe();
      event.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (isListPaneVisible) {
      if (navPane.current?.hasExpandedSize(1)) {
        navPane.current?.expand(1);
      } else {
        navPane.current?.reset(1);
      }
    } else {
      navPane.current?.collapse(1);
    }
  }, [isListPaneVisible]);

  return (
    <>
      <Flex
        variant="rowFill"
        className="veyran-mac-main"
        sx={{
          overflow: "hidden"
        }}
      >
        <SplitPane
          className={`global-split-pane${isMacTasks ? " veyran-mac-task-workspace" : ""}`}
          ref={navPane}
          autoSaveId="global-panel-group"
          direction="vertical"
          onChange={(sizes) => {
            useStore.setState({
              isNavPaneCollapsed: sizes[0] <= 70,
              isListPaneVisible: sizes[1] > 5 // we keep a 5px margin just to be safe
            });
          }}
        >
          {isFocusMode && !isMacDesktop ? null : (
            <Pane
              id="nav-pane"
              initialSize={isTablet && !isMacDesktop ? 0 : 250}
              className={`nav-pane`}
              snapSize={150}
              minSize={50}
              maxSize={isTablet && !isMacDesktop ? 0 : 500}
              style={{
                overflow: "initial",
                zIndex: 3
              }}
            >
              <NavigationMenu
                onExpand={() => navPane.current?.reset(0)}
                onCollapse={
                  isMacDesktop
                    ? () => navPane.current?.collapse(0)
                    : undefined
                }
                canExpand={isMacDesktop || !isTablet}
              />
            </Pane>
          )}
          {isFocusMode && !isMacDesktop ? null : (
            <Pane
              id="list-pane"
              initialSize={380}
              style={{ flex: 1, display: "flex" }}
              snapSize={120}
              maxSize={1000}
              className="list-pane"
            >
              <ScopedThemeProvider
                className="listMenu"
                scope="list"
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  flex: 1,
                  bg: "background",
                  borderRight: "1px solid var(--separator)"
                }}
              >
                <CachedRouter />
              </ScopedThemeProvider>
            </Pane>
          )}
          <Pane
            id="editor-pane"
            className="editor-pane"
            style={{
              flex: 1,
              display: "flex",
              backgroundColor: "var(--background)",
              overflow: "hidden",
              flexDirection: "column"
            }}
          >
            {<HashRouter />}
          </Pane>
        </SplitPane>
      </Flex>
      {isMacTasks ? null : <StatusBar />}
    </>
  );
}

function MobileAppContents() {
  const { ref, slideToIndex } = useSlider({
    onSliding: (_e, { position }) => {
      const offset = 70;
      const width = 300;

      const percent = offset - (position / width) * offset;
      const overlay = document.getElementById("overlay");
      if (!overlay) return;
      if (percent > 0) {
        overlay.style.opacity = `${percent}%`;
        overlay.style.pointerEvents = "all";
      } else {
        overlay.style.opacity = "0%";
        overlay.style.pointerEvents = "none";
      }
    },
    onChange: (e, { slide, lastSlide }) => {
      slide.node.classList.add("pane-active");
      lastSlide?.node.classList.remove("pane-active");
    }
  });

  useEffect(() => {
    const toggleSideMenuEvent = AppEventManager.subscribe(
      AppEvents.toggleSideMenu,
      (state) => slideToIndex(state ? 0 : 1)
    );
    const toggleEditorEvent = AppEventManager.subscribe(
      AppEvents.toggleEditor,
      (state) => slideToIndex(state ? 2 : 1)
    );
    return () => {
      toggleSideMenuEvent.unsubscribe();
      toggleEditorEvent.unsubscribe();
    };
  }, [slideToIndex]);

  return (
    <FlexScrollContainer
      scrollRef={ref}
      id="slider"
      suppressScrollX
      style={{
        display: "flex",
        flexDirection: "row",
        overflowY: "hidden",
        scrollSnapType: "x mandatory",
        scrollBehavior: "smooth",
        WebkitOverflowScrolling: "touch",
        scrollSnapStop: "always",
        overscrollBehavior: "contain",
        overflowX: "auto",
        flex: 1
      }}
    >
      <Flex
        className="mobile-nav-pane"
        sx={{
          scrollSnapAlign: "start",
          scrollSnapStop: "always",
          width: 300,
          flexShrink: 0
        }}
      >
        <NavigationMenu canExpand={false} />
      </Flex>
      <Flex
        className="mobile-list-pane"
        variant="columnFill"
        sx={{
          position: "relative",
          scrollSnapAlign: "start",
          scrollSnapStop: "always",
          flexShrink: 0,
          width: "100vw"
        }}
      >
        <CachedRouter />
        <Box
          id="overlay"
          onClick={() => slideToIndex(1)}
          sx={{
            position: "absolute",
            width: "100%",
            height: "100%",
            top: 0,
            left: 0,
            zIndex: 999,
            opacity: 0,
            visibility: "visible",
            pointerEvents: "none"
          }}
          bg="black"
        />
      </Flex>
      <Flex
        className="mobile-editor-pane"
        sx={{
          scrollSnapAlign: "start",
          scrollSnapStop: "always",
          flexDirection: "column",
          flexShrink: 0,
          width: "100vw"
        }}
      >
        <HashRouter />
      </Flex>
    </FlexScrollContainer>
  );
}
