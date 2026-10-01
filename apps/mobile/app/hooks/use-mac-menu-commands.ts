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
import React, { useEffect } from "react";
import {
  Linking,
  NativeEventEmitter,
  NativeModules,
  Platform,
  Pressable,
  Text,
  View
} from "react-native";
import { db } from "../common/database";
import { hideDialog } from "../components/dialog/functions";
import { runMacNoteAction } from "../components/mac-note-commands";
import { NativeMenuItem } from "../components/native-menu";
import { Properties } from "../components/properties";
import { AddNotebookSheet } from "../components/sheets/add-notebook";
import AppIcon from "../components/ui/AppIcon";
import { openEditor, setOnFirstSaveUnassigned } from "../screens/notes/common";
import type { SettingSection } from "../screens/settings/types";
import { useTabStore } from "../screens/editor/tiptap/use-tab-store";
import { editorController } from "../screens/editor/tiptap/utils";
import { eSendEvent, hideSheet, presentSheet } from "../services/event-manager";
import Navigation from "../services/navigation";
import { useSettingStore } from "../stores/use-setting-store";
import {
  AppleSection,
  useAppleNavigationStore
} from "../stores/use-apple-navigation-store";
import { useGlobalSearchStore } from "../stores/use-global-search-store";
import useNavigationStore from "../stores/use-navigation-store";
import { useMacSidebarStore } from "../stores/use-mac-sidebar-store";
import {
  nextListIndex,
  useMacListFocusStore
} from "../stores/use-mac-list-focus-store";
import { openNote } from "../components/list-items/note/wrapper";
import { useMacWindowStore } from "../stores/use-mac-window-store";
import { eCreateTaskRequest } from "../utils/events";
import { rootNavigatorRef } from "../utils/global-refs";
import { selectAppleSection } from "../navigation/navigation-stack";

/**
 * Root stack routes Escape can dismiss. TaskDetail/AddReminder are always
 * sheets; Settings is a sheet on iPhone/iPad but a full view inside the main
 * window on Mac Catalyst (see SETTINGS_SHEET_OPTIONS in navigation-stack.tsx).
 * Escape pops the topmost one of these with `Navigation.goBack()`, landing back
 * on whatever was underneath (normally the Library section); the base screens
 * inside FluidPanelsView have nothing to dismiss.
 */
const DISMISSABLE_ROUTES = new Set(["Settings", "TaskDetail", "AddReminder"]);

/**
 * Prefix of the section-switch commands: the section follows it
 * ("section:library"). The window toolbar's segmented control that used to send
 * them is gone; the sidebar's section rows still use the same handler, and the
 * commands keep working for the menu bar / shortcuts.
 */
const SECTION_COMMAND_PREFIX = "section:";

/**
 * Prefix of the Format menu commands (K2/E3): the editor command follows it
 * ("format:bold"). The native menu item's own title maps to the suffix, and
 * the editor bridge runs the command the matching toolbar button runs.
 */
const FORMAT_COMMAND_PREFIX = "format:";

/**
 * The window toolbar's search field, with the text it holds in the event body:
 * "search" on every keystroke (and when an edit starts), "searchSubmit" on
 * Return. Both write the Search section's query; typing also brings that
 * section forward, the way typing in Mail's toolbar field does.
 */
const SEARCH_COMMAND = "search";
const SEARCH_SUBMIT_COMMAND = "searchSubmit";

/**
 * Where Help > "VeyraN Help" points (K5/I11). The app ships no Help Book
 * (Info.plist has no CFBundleHelpBookFolder), so the native Help menu item was
 * replaced with a command that opens the project's documentation site in the
 * browser. docs/help in this repository is the source of that site
 * (notesnook.com/help); there is no VeyraN-specific help URL in the app yet.
 */
const HELP_URL = "https://notesnook.com/help";

/**
 * File > Import…: opens the app's existing restore/import flow, which lives in
 * Settings › Backup & Restore › Restore backup (screens/settings/restore-backup).
 * The same nested-navigation pattern as screens/settings/mac-account-settings.ts
 * is used: Settings is opened directly on the Restore backup group, reusing the
 * group's own SettingSection so there is no second copy of the flow.
 *
 * `settings-data` is required lazily so the menu hook does not pull the whole
 * settings module tree into every start.
 */
function openRestoreBackupFlow() {
  const navigation = rootNavigatorRef.current;
  if (!navigation) return;
  const { settingsGroups } = require("../screens/settings/settings-data") as {
    settingsGroups: { id: string; sections?: SettingSection[] }[];
  };
  const section = settingsGroups
    .find((group) => group.id === "back-restore")
    ?.sections?.find((candidate) => candidate.id === "restore-backup");
  if (!section) return;
  navigation.navigate("Settings", {
    screen: "SettingsGroup",
    params: section,
    initial: false
  } as never);
}

/**
 * Mirrors pressing Escape on iOS: close the topmost sheet or modal. Sheets and
 * dialogs are closed through the same events the rest of the app uses, and
 * both helpers are no-ops when nothing is open.
 */
function closeTopmostSheetOrModal() {
  hideSheet();
  hideDialog();

  // The root stack state, not the focused route: Settings contains its own
  // nested stack, which must not hide the sheet around it.
  const routes = rootNavigatorRef.current?.getState()?.routes;
  if (!routes?.length) return;
  const currentRoute = routes[routes.length - 1]?.name;
  if (!currentRoute || !DISMISSABLE_ROUTES.has(currentRoute)) return;
  Navigation.goBack();
}

/**
 * `noteInfo` / `noteMore`: the Properties sheet of the note that is open in the
 * editor, i.e. the very sheet the editor's ⋮ > Properties opens (see
 * screens/editor/tiptap/use-editor-events.tsx). The current note is read the
 * same way it is there, straight from the tab store, because this handler runs
 * outside React. With no note open it is a no-op.
 */
async function showCurrentNoteProperties() {
  const noteId = useTabStore
    .getState()
    .getNoteIdForTab(useTabStore.getState().currentTab);
  if (!noteId) return;
  const note = await db.notes?.note(noteId);
  if (!note) return;
  Properties.present(note, false);
}

type SheetColors = ReturnType<typeof useThemeColors>["colors"];

/**
 * Rows of the list menu, flattened for the action sheet: groups and submenus
 * become headings (only when they carry a title), their selectable leaves
 * become rows indented one level per nesting depth. `checked` / `disabled` /
 * `destructive` keep the meaning they have in a native UIMenu.
 */
function listMenuRows(
  items: NativeMenuItem[],
  onSelect: (id: string) => void,
  colors: SheetColors,
  depth = 0
): React.ReactNode[] {
  return items.flatMap((item, index) => {
    const key = `${depth}.${index}.${item.id ?? item.title}`;
    if (item.children?.length) {
      return [
        item.title
          ? React.createElement(
              Text,
              {
                key: `${key}-heading`,
                accessibilityRole: "header",
                style: {
                  color: colors.secondary.paragraph,
                  fontSize: 13,
                  fontWeight: "600",
                  paddingHorizontal: 16,
                  paddingTop: 12,
                  paddingBottom: 4,
                  marginLeft: depth * 12
                }
              },
              item.title
            )
          : null,
        ...listMenuRows(item.children, onSelect, colors, depth + 1)
      ];
    }
    if (!item.id) return [];
    return [
      React.createElement(
        Pressable,
        {
          key,
          accessibilityRole: "button",
          accessibilityState: {
            disabled: !!item.disabled,
            selected: !!item.checked
          },
          disabled: !!item.disabled,
          onPress: () => {
            hideSheet();
            onSelect(item.id as string);
          },
          style: {
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 11,
            paddingHorizontal: 16 + depth * 12,
            opacity: item.disabled ? 0.5 : 1
          }
        },
        React.createElement(
          Text,
          {
            style: {
              flex: 1,
              fontSize: 15,
              color: item.destructive
                ? colors.error.paragraph
                : colors.primary.paragraph
            }
          },
          item.title
        ),
        item.checked
          ? React.createElement(AppIcon, {
              key: "check",
              name: "check",
              size: 18,
              color: colors.primary.accent
            })
          : null
      )
    ];
  });
}

/** The list menu rendered as the app's standard list of options. */
function MacListOptionsSheet({
  items,
  onSelect
}: {
  items: NativeMenuItem[];
  onSelect: (id: string) => void;
}) {
  const { colors } = useThemeColors();
  return React.createElement(
    View,
    { style: { paddingVertical: 8 } },
    ...listMenuRows(items, onSelect, colors)
  );
}

/**
 * `listOptions`: opens the focused list's menu, which the list header publishes
 * into useMacWindowStore (see components/list-view-menu.ts, which also builds
 * the "…" menu itself). There is no way to pop a UIMenu from JS on demand -
 * VeyraNMenu opens its menu when its own overlay is tapped
 * (components/native-menu.tsx), and the Mac menu module exposes no present
 * method - so the menu is shown through the app's existing list-of-options
 * presentation, the action sheet (services/event-manager presentSheet), and a
 * selection is handed to the header's own onSelect. No list on screen (or no
 * header menu) means nothing to open.
 */
export function showListOptions() {
  const listMenu = useMacWindowStore.getState().listMenu;
  if (!listMenu?.items?.length) return;
  presentSheet({
    context: "mac-list-options",
    component: React.createElement(MacListOptionsSheet, {
      items: listMenu.items,
      onSelect: listMenu.onSelect
    })
  });
}

/**
 * Up / Down / Return in the note list (WP07/N3): moves the open note to the
 * previous / next row of the list on screen and opens it, like the arrow keys
 * in Notes. `delta` 0 re-opens the current row (Return).
 */
async function moveInNoteList(delta: 1 | -1 | 0) {
  const route = useNavigationStore.getState().focusedRouteId;
  const list = route ? useMacListFocusStore.getState().lists[route] : undefined;
  if (!list) return;
  const ids = await list.ids();
  const currentId = useTabStore.getState().getCurrentNoteId();
  const current = currentId ? ids.indexOf(currentId) : -1;
  const index =
    delta === 0 ? current : nextListIndex(current, delta, ids.length);
  if (index < 0 || (index === current && delta !== 0)) return;
  const { item } = await list.item(index);
  if (item && (item as { type?: string }).type === "note")
    await openNote(item as never);
}

/**
 * Handles the commands sent by the Mac Catalyst window chrome through the
 * VeyraNMacMenu native module: the menu bar (File > New Note / New Notebook /
 * Import… / Export…, Edit > Find in Notes plus the editor's own Find submenu
 * and Format menu - "format:<name>" runs the matching editor toolbar command -
 * the Note menu, the View sections, Sort By / Group By and Toggle Sidebar, the
 * Help link, Settings…, Escape) and
 * the window toolbar (New Note / New Task, the search field - "search" while
 * it is typed in, "searchSubmit" on Return, both with the field's text in the
 * event body - and the note/list commands the toolbar's labels have no room
 * for: "shareNote", "noteInfo" / "noteMore" for the open note's Properties,
 * and "listOptions" for the focused list's own menu). Inert on iPhone and iPad.
 *
 * Everything that acts on a note (Pin, Add to Favorites, Lock, Move to Trash,
 * Export) goes through components/mac-note-commands.tsx, which runs the very
 * actions the note list's context menu runs; with no note open it is a no-op,
 * so those commands are ignored rather than applied to nothing - and the menu
 * items are greyed out, see below.
 *
 * The reverse direction is handled here too: the toolbar only knows about the
 * sections it switched to itself, so every change to the section store is
 * pushed back to it; and the note/list commands' build context is published
 * through `setContext` so the native menu can disable what has no target (K4).
 */
export const useMacMenuCommands = () => {
  useEffect(() => {
    if (
      Platform.OS !== "ios" ||
      !Platform.isMacCatalyst ||
      !NativeModules.VeyraNMacMenu
    )
      return;

    const setToolbarSection = (section: AppleSection) =>
      NativeModules.VeyraNMacMenu.setSelectedSection(section);

    // The store may already have moved on (a deep link, the last session's
    // section) before this hook mounted.
    setToolbarSection(useAppleNavigationStore.getState().section);
    const sectionSubscription = useAppleNavigationStore.subscribe(
      (state, prevState) => {
        if (state.section !== prevState.section) {
          setToolbarSection(state.section);
        }
      }
    );

    // K4: publish whether the menu's note/list commands have a target, so the
    // native menu can grey them out. A note is "open" when the current tab has
    // one (the same source the note commands use); a list is focused when its
    // header has published its own menu into useMacWindowStore. The last
    // published pair is kept so the many store changes that do not affect
    // either flag do not cross the bridge.
    let lastNoteOpen: boolean | undefined;
    let lastListOpen: boolean | undefined;
    const publishMenuContext = () => {
      const noteOpen = !!useTabStore.getState().getCurrentNoteId();
      const listOpen = !!useMacWindowStore.getState().listMenu;
      if (noteOpen === lastNoteOpen && listOpen === lastListOpen) return;
      lastNoteOpen = noteOpen;
      lastListOpen = listOpen;
      NativeModules.VeyraNMacMenu.setContext({ noteOpen, listOpen });
    };
    publishMenuContext();
    const contextSubscriptions = [
      useTabStore.subscribe(publishMenuContext),
      useMacWindowStore.subscribe(publishMenuContext)
    ];

    const emitter = new NativeEventEmitter(NativeModules.VeyraNMacMenu);
    const subscription = emitter.addListener(
      "VeyraNMacMenuCommand",
      (body: { command?: string; text?: string }) => {
        const command = body?.command;
        if (command === SEARCH_COMMAND || command === SEARCH_SUBMIT_COMMAND) {
          if (!useSettingStore.getState().settings.introCompleted) {
            // There is no Search section before onboarding is done, so there is
            // nothing for the toolbar field to drive yet.
            return;
          }
          // The toolbar field *is* the Search screen's query while the window
          // carries it, so the text goes straight into the shared state. An
          // emptied field (Escape, the clear button) empties the query but
          // keeps the section.
          useGlobalSearchStore.getState().setQuery(body?.text ?? "");
          if (command === SEARCH_SUBMIT_COMMAND) {
            // Return: skip the screen's typing debounce.
            useGlobalSearchStore.getState().submitQuery();
          }
          // Editing the field moves to the Search section, like pressing the
          // segment would (selectAppleSection is the same handler the iPad tab
          // bar uses).
          if (useAppleNavigationStore.getState().section !== "search") {
            selectAppleSection("search");
          }
          return;
        }
        if (command?.startsWith(SECTION_COMMAND_PREFIX)) {
          if (!useSettingStore.getState().settings.introCompleted) {
            // There is no section to switch to before onboarding is done (the
            // iPhone/iPad bar is hidden for the same reason). Snap the segment
            // back to the section the app is actually on.
            setToolbarSection(useAppleNavigationStore.getState().section);
            return;
          }
          // Same handler the iPad tab bar uses, so switching sections behaves
          // identically (including the FluidPanels page it lands on).
          selectAppleSection(
            command.slice(SECTION_COMMAND_PREFIX.length) as AppleSection
          );
          return;
        }
        if (command?.startsWith(FORMAT_COMMAND_PREFIX)) {
          // Format menu (K2/E3): every item sends "format:<name>" and the
          // editor's own bridge runs the command the matching toolbar button
          // runs (see screens/editor/tiptap/commands.ts), so the menu and the
          // toolbar behave identically. The items are greyed out without an
          // open note; the bridge is a no-op then.
          void editorController.current?.commands?.format(
            command.slice(FORMAT_COMMAND_PREFIX.length)
          );
          return;
        }
        if (command?.startsWith("sort:") || command?.startsWith("group:")) {
          // View > Sort By / Group By (R19): the ids are the focused list's own
          // menu ids (components/list-view-menu.ts), so the selection is handed
          // straight to that list's onSelect. No list on screen means no target
          // (the items are greyed out then anyway).
          useMacWindowStore.getState().listMenu?.onSelect(command);
          return;
        }
        switch (command) {
          case "newNote":
            // Same action as the compose button in the Library nav bar.
            setOnFirstSaveUnassigned();
            openEditor();
            break;
          case "newNotebook":
            // File > New Notebook (Shift-Cmd-N, K6/R19): the same sheet the
            // Library source list's "New notebook" row opens
            // (components/mac-sidebar.tsx).
            AddNotebookSheet.present(
              undefined,
              undefined,
              "global",
              undefined,
              false
            );
            break;
          case "import":
            // File > Import…: the existing restore/import flow (E6).
            openRestoreBackupFlow();
            break;
          case "exportNote":
            // File > Export…: the open note's own Export action, i.e. the
            // ExportNotesSheet with PDF/Markdown/HTML (E6). No-op with no note
            // open, where the menu item is greyed out anyway.
            runMacNoteAction("export");
            break;
          case "lockNote":
            // Note > Lock Note: the open note's lock/unlock (vault) action.
            runMacNoteAction("lock-unlock");
            break;
          case "openHelp":
            // Help > "VeyraN Help" (K5/I11). A browser link rather than a Help
            // Book, which the app does not ship.
            Linking.openURL(HELP_URL).catch(() => {
              /* No browser available: leave the menu item a no-op. */
            });
            break;
          case "newTask":
            // The Tasks screen reveals its own inline "+ New Task" row (the
            // same thing tapping that row does). No-op while nothing listens,
            // i.e. while the Tasks screen is not on screen.
            eSendEvent(eCreateTaskRequest);
            break;
          case "findInNotes":
            // Edit > Find in Notes (Cmd-Shift-F): the Search section.
            selectAppleSection("search");
            break;
          case "find":
          case "findAndReplace":
          case "findNext":
          case "findPrevious":
            // Edit > Find (K3/E4): the editor's own search-and-replace popup,
            // the same one the header's magnifier opens. "find" opens it,
            // "findAndReplace" opens it with the replace field, the other two
            // step through the matches; with no match yet they are a no-op.
            void editorController.current?.commands?.find(
              command === "find"
                ? "find"
                : command === "findAndReplace"
                  ? "replace"
                  : command === "findNext"
                    ? "next"
                    : "previous"
            );
            break;
          case "shareNote":
            // The open note's own Share action (mac-note-commands.tsx); a
            // no-op with no note open, like the other note commands.
            runMacNoteAction("share");
            break;
          case "noteInfo":
          case "noteMore":
            // Both open the open note's Properties sheet; with no note open
            // there is nothing to show.
            void showCurrentNoteProperties();
            break;
          case "listOptions":
            // The focused list's own "Sort & View" menu, published by the
            // list header (see showListOptions).
            showListOptions();
            break;
          case "pinNote":
            // The open note's own Pin/Unpin action.
            runMacNoteAction("pin");
            break;
          case "toggleFavorite":
            runMacNoteAction("favorite");
            break;
          case "moveToTrash":
            // The note list's delete: the item action both the row's context
            // menu and its swipe action run (vault, published and undo
            // handling included).
            runMacNoteAction("trash");
            break;
          case "openSettings": {
            // Same action as the Settings button in the Library nav bar, but
            // idempotent: Settings is a full view inside the window on Mac, so
            // a second Cmd-, while it is already on top must not stack another
            // copy (Escape would then peel them off one at a time).
            const routes = rootNavigatorRef.current?.getState()?.routes;
            if (routes?.[routes.length - 1]?.name !== "Settings") {
              Navigation.push("Settings", {});
            }
            break;
          }
          case "toggleSidebar":
            // View > Toggle Sidebar (Ctrl-Cmd-S): the Library source list pane
            // collapses to zero width (see navigation/fluid-panels-view.tsx).
            useMacSidebarStore
              .getState()
              .toggle(useSettingStore.getState().dimensions.width);
            break;
          case "listPrevious":
            void moveInNoteList(-1);
            break;
          case "listNext":
            void moveInNoteList(1);
            break;
          case "listOpen":
            void moveInNoteList(0);
            break;
          case "escape":
            closeTopmostSheetOrModal();
            break;
          default:
            break;
        }
      }
    );

    return () => {
      subscription.remove();
      sectionSubscription();
      contextSubscriptions.forEach((unsubscribe) => unsubscribe());
    };
  }, []);
};
