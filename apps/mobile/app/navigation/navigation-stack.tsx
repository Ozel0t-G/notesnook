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
import { useThemeColors } from "@notesnook/theme";
import { NavigationContainer } from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions
} from "@react-navigation/native-stack";
import * as React from "react";
import { Keyboard, Platform, View } from "react-native";
import { hideAllTooltips } from "../hooks/use-tooltip";
import SettingsService from "../services/settings";
import useNavigationStore, {
  RouteParams
} from "../stores/use-navigation-store";
import { useSelectionStore } from "../stores/use-selection-store";
import { useSettingStore } from "../stores/use-setting-store";
import { fluidTabsRef, rootNavigatorRef } from "../utils/global-refs";
import Navigation from "../services/navigation";
import { isFeatureAvailable } from "@notesnook/common";
import { isInternalLink, parseInternalLink } from "@notesnook/core";
import { eSendEvent, eSubscribeEvent } from "../services/event-manager";
import { editorState } from "../screens/editor/tiptap/utils";
import {
  eCloseFullscreenEditor,
  eOnExitEditor,
  eOnLoadNote,
  eOpenFullscreenEditor
} from "../utils/events";
import { launchNewNoteTab } from "../hooks/use-shortcut-manager";
import { parseReminderWidgetLink } from "../services/reminder-widget-links";
import { AppleTabBar, isTopTabBar } from "../components/apple-tab-bar";
import { isMacCatalyst } from "../utils/constants";
import { macToolbarInset } from "../utils/mac-layout";
import {
  SafeAreaInsetsContext,
  useSafeAreaInsets
} from "react-native-safe-area-context";
import {
  AppleTabBarSelection,
  useAppleNavigationStore
} from "../stores/use-apple-navigation-store";
import { openEditor, setOnFirstSaveUnassigned } from "../screens/notes/common";
import { DDS } from "../services/device-detection";
import { setMacListNavigation } from "../services/mac-list-navigation";

const RootStack = createNativeStackNavigator();

/**
 * Mac's sidebar (components/mac-sidebar.tsx) is a pane next to, not inside, the
 * note-list stack, so it cannot reach that stack's `navigation` object with
 * `useNavigation()`. Every screen the stack can show publishes its own
 * `navigation` object instead: any of them drives the same stack, so the
 * sidebar keeps working no matter which list the middle column is rooted at
 * (the default Library, a custom homepage or a deep link).
 *
 * On iPhone/iPad this is a no-op wrapper.
 */
function withMacListNavigation<P extends { navigation: any }>(
  Screen: React.ComponentType<P>
): React.ComponentType<P> {
  function MacListNavigationBridge(props: P) {
    React.useEffect(() => {
      if (!isMacCatalyst()) return;
      setMacListNavigation(props.navigation);
    }, [props.navigation]);
    return <Screen {...props} />;
  }
  return MacListNavigationBridge as React.ComponentType<P>;
}

/**
 * Where a compose action launched from Tasks or Search returns to once the
 * editor is dismissed. Module scope so the section handler below can be shared
 * between the native tab bar and Mac's section control.
 */
const composeReturnSection: { current: "tasks" | "search" | null } = {
  current: null
};

/**
 * Switches the top-level section. This is the handler the floating tab bar
 * calls on iPhone/iPad and the one Mac's section control calls, so all three
 * sections behave identically on both.
 */
export const selectAppleSection = (selection: AppleTabBarSelection) => {
  if (selection === "compose") {
    // An action, not a section: the previously selected tab stays selected
    // and is what the user returns to once the editor is dismissed.
    const currentRoot = rootNavigatorRef.current?.getCurrentRoute()?.name;
    if (currentRoot === "Tasks" || currentRoot === "GlobalSearch") {
      composeReturnSection.current =
        currentRoot === "Tasks" ? "tasks" : "search";
      // Neither is a note context. Drop any first-save hook a notebook list
      // left behind so the note is created unassigned.
      setOnFirstSaveUnassigned();
    } else if (useNavigationStore.getState().currentRoute !== "Notebook") {
      // Library root, All Notes, and Inbox create unassigned notes.
      setOnFirstSaveUnassigned();
    }
    if (currentRoot !== "FluidPanelsView") {
      rootNavigatorRef.current?.navigate("FluidPanelsView" as any);
    }
    if (DDS.isTab) {
      // The split editor is persistently visible on iPad and has no close
      // control. A global compose action needs a dismissible editor so the
      // previous top-level destination can be restored.
      setTimeout(() => eSendEvent(eOpenFullscreenEditor), 100);
    }
    openEditor();
    return;
  }

  useAppleNavigationStore.getState().setSection(selection);
  if (selection === "tasks") {
    rootNavigatorRef.current?.navigate("Tasks" as any);
  } else if (selection === "search") {
    rootNavigatorRef.current?.navigate("GlobalSearch" as any);
  } else {
    fluidTabsRef.current?.goToPage("home", true);
    rootNavigatorRef.current?.navigate(
      "FluidPanelsView" as any,
      {
        screen: "Library"
      } as any
    );
  }
};

/**
 * Task details are a sheet (Reminders pattern), not a pushed full screen:
 * Cancel / Done in the sheet header, swipe-down blocked while there are
 * unsaved changes (the screen toggles `gestureEnabled`).
 */
/** Settings is a sheet with "Done" (iOS Settings-in-app pattern). */
const SETTINGS_SHEET_OPTIONS = {
  presentation: (Platform.OS === "ios" ? "modal" : "card") as
    | "modal"
    | "card"
};

/**
 * Task detail is a centered form sheet on the wide-screen layouts (iPad and
 * Mac's Mac interface) and a full-screen modal on iPhone. Mac is included by
 * name: `Platform.isPad` stopped being true there when the app switched to the
 * Mac interface, but a full-bleed sheet would be wrong in a Mac window.
 */
const TASK_SHEET_OPTIONS = {
  presentation: (Platform.OS === "ios" && (Platform.isPad || isMacCatalyst())
    ? "formSheet"
    : "modal") as "formSheet" | "modal"
};

/**
 * How Mac presents the two section routes, Tasks and Search.
 *
 * They are sections, not steps of the Library stack: each one takes over the
 * whole content area under the window's toolbar, and the three-column Library
 * layout comes back when the Library section returns (see the section handler
 * `selectAppleSection`).
 *
 * Mac pushes them without a transition. On Mac Catalyst the push animation left
 * them mid-slide - the outgoing three-column screen stayed visible along the
 * left edge, moved by its own sidebar width, with the section's content drawn
 * offset to the right of it - and a section switch has nothing to animate
 * anyway: the toolbar's segmented control already shows the state. Landing the
 * screen on its final frame instead of animating it is what makes the section
 * fill the content area (x 0...W), under the toolbar, with no leftover column
 * and no seam between the two backgrounds. iPhone and iPad keep the animated
 * push. `animation: "none"` is the app's existing idiom for this (see the
 * Library stack below and the Settings stack).
 */
const MAC_SECTION_SCREEN_OPTIONS: NativeStackNavigationOptions =
  isMacCatalyst() ? { animation: "none" } : {};

const AppStack = createNativeStackNavigator();
const DEFAULT_HOME: {
  name: string;
  params: any;
} = {
  name: Platform.OS === "ios" ? "Library" : "Notes",
  params: undefined
};

let Notes: any = null;
let Notebook: any = null;
let Search: any = null;
let Favorites: any = null;
let Trash: any = null;
let Monographs: any = null;
let TaggedNotes: any = null;
let ColoredNotes: any = null;
let Archive: any = null;
let Library: any = null;
/**
 * Everything the content pane can show now hangs off the Library section.
 * The internal "Notes" route is kept for links and legacy entry points; it is
 * presented as Library > All Notes.
 */
const LIBRARY_ROUTES = new Set([
  "Library",
  "Notes",
  "Notebook",
  "TaggedNotes",
  "ColoredNotes",
  "Favorites",
  "Archive",
  "Trash",
  "Monographs",
  "Search"
]);

const LegacyRemindersRedirect = ({ navigation }: { navigation: any }) => {
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const redirect = () => {
      if (!rootNavigatorRef.current?.isReady()) {
        timer = setTimeout(redirect, 100);
        return;
      }
      navigation.replace(Platform.OS === "ios" ? "Library" : "Notes");
      rootNavigatorRef.current.navigate("Tasks" as any);
    };
    redirect();
    return () => clearTimeout(timer);
  }, [navigation]);
  return null;
};

const LegacyNotesRedirect = ({ navigation }: { navigation: any }) => {
  React.useEffect(() => {
    navigation.replace("Library", { initialCollection: "all-notes" });
  }, [navigation]);
  return null;
};

const AppNavigation = React.memo(
  () => {
    const { colors } = useThemeColors();
    const homepageV2 = useSettingStore((state) => state.settings.homepageV2);
    const loading = useSettingStore((state) => state.isAppLoading);
    const [home, setHome] = React.useState<
      { name: string; params: any } | undefined
    >(undefined);

    React.useEffect(() => {
      if (!home) {
        const url = useSettingStore.getState().initialUrl;
        if (url) {
          if (parseReminderWidgetLink(url)) {
            setHome(DEFAULT_HOME);
            return;
          }
          const parsedLink = isInternalLink(url)
            ? parseInternalLink(url)
            : undefined;

          if (
            parsedLink?.type === "notebook" ||
            url?.startsWith("https://app.notesnook.com/open_notebook?")
          ) {
            const id = parsedLink?.id || new URL(url).searchParams.get("id");
            if (id) {
              setHome({
                name: "Notebook",
                params: {
                  id: id
                }
              });
              return;
            }
          } else if (
            parsedLink?.type === "tag" ||
            url?.startsWith("https://app.notesnook.com/open_tag?")
          ) {
            const id = parsedLink?.id || new URL(url).searchParams.get("id");
            if (id) {
              setHome({
                name: "TaggedNotes",
                params: {
                  type: "tag",
                  id: id
                }
              });
              return;
            }
          } else if (
            parsedLink?.type === "color" ||
            url?.startsWith("https://app.notesnook.com/open_color?")
          ) {
            const id = parsedLink?.id || new URL(url).searchParams.get("id");
            if (id) {
              setHome({
                name: "ColoredNotes",
                params: {
                  type: "color",
                  id: id
                }
              });
              return;
            }
          }
        }

        if (homepageV2) {
          switch (homepageV2.type) {
            case "notebook": {
              setHome({
                name: "Notebook",
                params: {
                  id: homepageV2.id
                }
              });
              return;
            }
            case "color": {
              setHome({
                name: "ColoredNotes",
                params: {
                  type: "color",
                  id: homepageV2.id
                }
              });
              return;
            }
            case "tag": {
              setHome({
                name: "TaggedNotes",
                params: {
                  type: "tag",
                  id: homepageV2.id
                }
              });
              return;
            }
            case "default":
              setHome({
                name: homepageV2.id,
                params: undefined
              });
              return;
          }
        } else {
          setHome(DEFAULT_HOME);
        }
      }
    }, []);

    React.useEffect(() => {
      if (!homepageV2 || loading) return;
      isFeatureAvailable("customHomepage").then((value) => {
        if (!value.isAllowed) {
          SettingsService.setProperty("homepageV2", undefined);
        }
      });
    }, [homepageV2, loading]);

    React.useEffect(() => {
      if (!home) return;
      useNavigationStore.getState().update(home?.name as keyof RouteParams);
      /**
       * Mac's Library route is the note list column, and it opens on the All
       * Notes collection (`MAC_DEFAULT_COLLECTION` in screens/library), whose
       * `NoteCollection` reports "AllNotes" as the focused route. Effects run
       * child-first, so this effect runs *after* the one in `NoteCollection`:
       * seeding "Library" here would overwrite the id that marks the row the
       * middle column is showing, and Mac's sidebar would have nothing
       * highlighted until the user picked a row by hand.
       */
      const focusedRouteId =
        isMacCatalyst() && home?.name === "Library"
          ? "AllNotes"
          : home?.params?.id || home?.name;
      useNavigationStore.getState().setFocusedRouteId(focusedRouteId);
      if (LIBRARY_ROUTES.has(home.name))
        useAppleNavigationStore.getState().setSection("library");
    }, [home]);

    return !home ? null : (
      <AppStack.Navigator
        initialRouteName={home?.name}
        screenOptions={{
          headerShown: false,
          animation: "none",
          contentStyle: {
            backgroundColor: colors.primary.background
          }
        }}
      >
        <AppStack.Screen
          name="Notes"
          getComponent={() => {
            if (Platform.OS === "ios") return LegacyNotesRedirect;
            Notes = Notes || require("../screens/home").default;
            return Notes;
          }}
        />

        <AppStack.Screen
          name="Library"
          getComponent={() => {
            Library =
              Library ||
              withMacListNavigation(require("../screens/library").default);
            return Library;
          }}
        />

        <AppStack.Screen
          name="Favorites"
          getComponent={() => {
            Favorites =
              Favorites ||
              withMacListNavigation(require("../screens/favorites").default);
            return Favorites;
          }}
        />

        <AppStack.Screen
          name="Trash"
          getComponent={() => {
            Trash =
              Trash ||
              withMacListNavigation(require("../screens/trash").default);
            return Trash;
          }}
        />

        <AppStack.Screen
          name="TaggedNotes"
          getComponent={() => {
            TaggedNotes =
              TaggedNotes ||
              withMacListNavigation(require("../screens/notes/tagged").default);
            return TaggedNotes;
          }}
          initialParams={
            home?.name === "TaggedNotes" ? home?.params : undefined
          }
        />

        <AppStack.Screen
          name="ColoredNotes"
          getComponent={() => {
            ColoredNotes =
              ColoredNotes ||
              withMacListNavigation(
                require("../screens/notes/colored").default
              );
            return ColoredNotes;
          }}
          initialParams={
            home?.name === "ColoredNotes" ? home?.params : undefined
          }
        />

        <AppStack.Screen
          name="Archive"
          getComponent={() => {
            Archive =
              Archive ||
              withMacListNavigation(require("../screens/archive").default);
            return Archive;
          }}
        />

        <AppStack.Screen name="Reminders" component={LegacyRemindersRedirect} />

        <AppStack.Screen
          name="Monographs"
          getComponent={() => {
            Monographs =
              Monographs ||
              withMacListNavigation(
                require("../screens/notes/monographs").default
              );
            return Monographs;
          }}
        />

        <AppStack.Screen
          name="Notebook"
          getComponent={() => {
            Notebook =
              Notebook ||
              withMacListNavigation(require("../screens/notebook").default);
            return Notebook;
          }}
          initialParams={home?.name === "Notebook" ? home?.params : undefined}
        />

        <AppStack.Screen
          name="Search"
          getComponent={() => {
            Search =
              Search ||
              withMacListNavigation(require("../screens/search").default);
            return Search;
          }}
        />
      </AppStack.Navigator>
    );
  },
  () => true
);
AppNavigation.displayName = "AppNavigation";

let Intro: any = null;
let Auth: any = null;
let FluidPanelsView: any = null;
let LinkNotebooks: any = null;
let MoveNotebook: any = null;
let MoveNotes: any = null;
let Settings: any = null;
let ManageTags: any = null;
let AddReminder: any = null;
let RelationsList: any = null;
let Wrapped: any = null;
let Tasks: any = null;
let TaskDetail: any = null;
let GlobalSearch: any = null;
export const RootNavigation = () => {
  const { colors } = useThemeColors();
  const introCompleted = useSettingStore(
    (state) => state.settings.introCompleted
  );

  const initialShortcut = React.useRef(
    useSettingStore.getState().pendingShortcut
  ).current;

  const isAppLoading = useSettingStore((state) => state.isAppLoading);
  const safeAreaInsets = useSafeAreaInsets();
  const deviceMode = useSettingStore((state) => state.deviceMode);
  const editorVisible = useAppleNavigationStore((state) => state.editorVisible);
  const fullscreen = useSettingStore((state) => state.fullscreen);
  const [rootRoute, setRootRoute] = React.useState<string>(
    introCompleted ? "FluidPanelsView" : "Welcome"
  );
  const pendingShortcut = useSettingStore((state) => state.pendingShortcut);
  const [navigationReady, setNavigationReady] = React.useState(false);
  const clearSelection = useSelectionStore((state) => state.clearSelection);
  const resetTimer = React.useRef<NodeJS.Timeout>(undefined);

  React.useEffect(() => {
    const returnFromCompose = () => {
      const section = composeReturnSection.current;
      if (!section) return;
      composeReturnSection.current = null;
      Keyboard.dismiss();
      rootNavigatorRef.current?.navigate(
        (section === "tasks" ? "Tasks" : "GlobalSearch") as any
      );
    };
    const subscription = eSubscribeEvent(eOnExitEditor, returnFromCompose);
    const fullscreenSubscription = eSubscribeEvent(
      eCloseFullscreenEditor,
      () => {
        if (DDS.isTab) returnFromCompose();
      }
    );
    return () => {
      subscription?.unsubscribe();
      fullscreenSubscription?.unsubscribe();
    };
  }, []);

  const onStateChange = React.useCallback(
    (state: any) => {
      const focused = state?.routes?.[state.index];
      if (focused?.name) {
        setRootRoute(focused.name);
        if (focused.name === "Tasks")
          useAppleNavigationStore.getState().setSection("tasks");
        else if (focused.name === "GlobalSearch")
          useAppleNavigationStore.getState().setSection("search");
        else if (
          focused.name === "FluidPanelsView" &&
          !composeReturnSection.current
        ) {
          // Every route the content pane can show lives under Library now,
          // including the legacy Notes route (Library > All Notes).
          useAppleNavigationStore.getState().setSection("library");
        }
      }
      if (useSelectionStore.getState().selectionMode) {
        clearSelection();
      }
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        Navigation.resetRootState(state);
      }, 1000);
      hideAllTooltips();
    },
    [clearSelection]
  );

  React.useEffect(() => {
    const unsubscribe = useSettingStore.subscribe((state, prevState) => {
      const pendingShortcut = state.pendingShortcut;

      if (pendingShortcut === prevState.pendingShortcut || !pendingShortcut) {
        return;
      }

      if (pendingShortcut.type === "notesnook.action.newnote") {
        if (fluidTabsRef.current) {
          rootNavigatorRef.current?.navigate("FluidPanelsView" as any);
          eSendEvent(eOnLoadNote, { newNote: true });
          editorState().movedAway = false;
          fluidTabsRef.current.goToPage("editor", true);
        } else {
          launchNewNoteTab();

          rootNavigatorRef.current?.navigate("FluidPanelsView" as any, {
            initialPage: "editor"
          });
        }
      }
    });

    return unsubscribe;
  }, []);

  React.useEffect(() => {
    if (
      isAppLoading ||
      !navigationReady ||
      pendingShortcut?.type !== "notesnook.action.newreminder" ||
      !rootNavigatorRef.current?.isReady()
    )
      return;
    rootNavigatorRef.current.navigate("TaskDetail" as any);
    useSettingStore.setState({ pendingShortcut: null });
  }, [isAppLoading, navigationReady, pendingShortcut]);

  const initialRouteName = !introCompleted ? "Welcome" : "FluidPanelsView";

  /**
   * The floating bar is an iPhone/iPad affordance. Mac keeps the same three
   * sections in the window's native toolbar (MacMenu/VeyraNMacToolbar.h), so no
   * bar - and no bar strip above the panes - is mounted there.
   */
  const showTabBar =
    Platform.OS === "ios" &&
    !isMacCatalyst() &&
    introCompleted &&
    !isAppLoading &&
    [
      "FluidPanelsView",
      "Tasks",
      "GlobalSearch",
      "TaskDetail",
      "AddReminder",
      "Settings"
    ].includes(rootRoute) &&
    (deviceMode !== "mobile" || !editorVisible);

  const topTabBar = showTabBar && isTopTabBar();

  return (
    <View style={{ flex: 1, backgroundColor: colors.primary.background }}>
      {topTabBar && <AppleTabBar onSelect={selectAppleSection} />}
      {/*
        The iPad bar strip (and only it) is drawn in the flow above the
        navigator, so the inset it covers is dropped for the panes below.

        Mac keeps the window's real top inset: it is the height of the native
        toolbar, which the screens that cover the whole window clear through
        their own SafeAreaView, and which the list column and the editor pane
        pad themselves with (see `macToolbarInset`, which also stands in with a
        constant on the systems where UIKit reports 0 there).
      */}
      <SafeAreaInsetsContext.Provider
        value={
          topTabBar
            ? { ...safeAreaInsets, top: 0 }
            : isMacCatalyst()
            ? { ...safeAreaInsets, top: macToolbarInset(safeAreaInsets.top) }
            : safeAreaInsets
        }
      >
      {/*
        The navigator is given flex: 1 so it takes exactly what the iPad bar
        strip leaves, instead of the whole window: its own view is sized with
        height 100%, which is 100% of *this* wrapper. Without it the Mac panes
        would run past the bottom of the window.
      */}
      <View style={{ flex: 1 }}>
      <NavigationContainer
        onReady={() => setNavigationReady(true)}
        onStateChange={onStateChange}
        ref={rootNavigatorRef}
      >
        <RootStack.Navigator
          screenOptions={{
            headerShown: false
          }}
          initialRouteName={initialRouteName}
        >
          <RootStack.Screen
            name="Welcome"
            getComponent={() => {
              Intro = Intro || require("../components/intro").default;
              return Intro;
            }}
          />
          <RootStack.Screen
            name="Auth"
            getComponent={() => {
              Auth = Auth || require("../components/auth").default;
              return Auth;
            }}
          />

          <RootStack.Screen
            name="FluidPanelsView"
            getComponent={() => {
              FluidPanelsView =
                FluidPanelsView ||
                require("../navigation/fluid-panels-view").default;
              return FluidPanelsView;
            }}
            initialParams={{
              initialPage:
                initialShortcut?.type === "notesnook.action.newnote"
                  ? "editor"
                  : undefined
            }}
          />

          <RootStack.Screen
            name="LinkNotebooks"
            getComponent={() => {
              LinkNotebooks =
                LinkNotebooks || require("../screens/link-notebooks").default;
              return LinkNotebooks;
            }}
          />

          <RootStack.Screen
            name="MoveNotebook"
            getComponent={() => {
              MoveNotebook =
                MoveNotebook || require("../screens/move-notebook").default;
              return MoveNotebook;
            }}
          />

          <RootStack.Screen
            name="MoveNotes"
            getComponent={() => {
              MoveNotes = MoveNotes || require("../screens/move-notes").default;
              return MoveNotes;
            }}
          />

          <RootStack.Screen
            name="Settings"
            options={SETTINGS_SHEET_OPTIONS}
            getComponent={() => {
              Settings = Settings || require("../screens/settings").default;
              return Settings;
            }}
          />

          <RootStack.Screen
            name="ManageTags"
            getComponent={() => {
              ManageTags =
                ManageTags || require("../screens/manage-tags").default;
              return ManageTags;
            }}
          />

          <RootStack.Screen
            name="AddReminder"
            options={TASK_SHEET_OPTIONS}
            getComponent={() => {
              // Legacy editor entry points navigate here. Present the standalone
              // Task editor without changing the Notes editor bridge.
              AddReminder =
                AddReminder || require("../screens/tasks/detail").default;
              return AddReminder;
            }}
          />

          <RootStack.Screen
            name="Tasks"
            options={MAC_SECTION_SCREEN_OPTIONS}
            getComponent={() => {
              Tasks = Tasks || require("../screens/tasks").default;
              return Tasks;
            }}
          />

          <RootStack.Screen
            name="GlobalSearch"
            options={MAC_SECTION_SCREEN_OPTIONS}
            getComponent={() => {
              GlobalSearch =
                GlobalSearch || require("../screens/global-search").default;
              return GlobalSearch;
            }}
          />

          <RootStack.Screen
            name="TaskDetail"
            options={TASK_SHEET_OPTIONS}
            getComponent={() => {
              TaskDetail =
                TaskDetail || require("../screens/tasks/detail").default;
              return TaskDetail;
            }}
          />

          <RootStack.Screen
            name="RelationsList"
            getComponent={() => {
              RelationsList =
                RelationsList || require("../screens/relations-list").default;
              return RelationsList;
            }}
          />

          <RootStack.Screen
            name="Wrapped"
            getComponent={() => {
              Wrapped = Wrapped || require("../screens/wrapped").default;
              return Wrapped;
            }}
          />
        </RootStack.Navigator>
      </NavigationContainer>
      </View>
      </SafeAreaInsetsContext.Provider>
      {showTabBar && !topTabBar && (
        <AppleTabBar onSelect={selectAppleSection} />
      )}
    </View>
  );
};

export const AppNavigationStack = React.memo(
  () => {
    return <AppNavigation />;
  },
  () => true
);
AppNavigationStack.displayName = "AppNavigationStack";
