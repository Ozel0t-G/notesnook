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

import {
  Color,
  FilteredSelector,
  Item,
  ItemType,
  Note,
  Notebook,
  Reminder,
  Tag
} from "@notesnook/core";
import { ParamListBase } from "@react-navigation/core";
import { create } from "zustand";

export type GenericRouteParam = {
  canGoBack?: boolean;
};

export type NotebookScreenParams = {
  id: string;
  item?: Notebook;
  canGoBack?: boolean;
};

export type NotesScreenParams = {
  type: "tag" | "color" | "monograph";
  id: string;
  item?: Tag | Color;
  canGoBack?: boolean;
};

export type AppLockRouteParams = {
  welcome: boolean;
  canGoBack?: boolean;
};

export type AuthParams = {
  mode: number;
  context?: "intro";
  state?: BillingState;
};

export type BillingState = {
  productId?: string;
  planId?: string;
  billingType?: "annual" | "monthly";
};

export interface RouteParams extends ParamListBase {
  Notes: GenericRouteParam;
  Library: GenericRouteParam & { initialCollection?: "all-notes" | "inbox" };
  GlobalSearch: GenericRouteParam;
  Notebooks: {
    canGoBack?: boolean;
  };
  Notebook: NotebookScreenParams;
  NotesPage: NotesScreenParams;
  Tags: GenericRouteParam;
  Favorites: GenericRouteParam;
  Trash: GenericRouteParam;
  Search:
    | {
        placeholder: string;
        type: "note";
        title: string;
        route: RouteName;
        items: FilteredSelector<Note>;
      }
    | {
        placeholder: string;
        type: Exclude<ItemType, "note">;
        title: string;
        route: RouteName;
        items?: FilteredSelector<Item>;
      };
  TaggedNotes: NotesScreenParams;
  ColoredNotes: NotesScreenParams;
  TopicNotes: NotesScreenParams;
  Archive: GenericRouteParam;
  Monographs: NotesScreenParams;
  Reminders: GenericRouteParam;
  Tasks:
    | {
        listId?: string;
        smartList?: "today" | "scheduled" | "all" | "flagged" | "completed";
        /** Legacy single-shot highlight. Kept so any older caller keeps
         * working; new callers use `focusTaskId` + `focusRequestId` so a repeat
         * of the same Task re-arms the focus instead of being ignored. */
        highlightTaskId?: string;
        /** The Task to scroll into view and briefly highlight. Never opens the
         * editor or the keyboard. Used by notification taps, widget/app-intent
         * "open" actions, and legacy reminder migration links -- anywhere a
         * user should land on the Task in its list context rather than jump
         * straight into editing it. */
        focusTaskId?: string;
        /** A unique nonce for one focus request. Tapping the same Task again
         * after the highlight expired must re-arm the focus, which a stable
         * Task ID alone cannot signal. */
        focusRequestId?: string;
        /** Include completed Tasks in a List view. Used to show a completed
         * Task in its current canonical List without resurrecting it. */
        includeCompleted?: boolean;
      }
    | undefined;
  TaskDetail:
    | {
        taskId?: string;
        listId?: string;
        initialTitle?: string;
        initialDate?: string;
        initialTime?: string;
        initialFlagged?: boolean;
      }
    | undefined;
  SettingsGroup: GenericRouteParam;
  FluidPanelsView: { initialPage?: "editor" | "home"; screen?: "Library" };
  AppLock: GenericRouteParam;
  Settings: GenericRouteParam;
  Auth: AuthParams;
  LinkNotebooks: {
    noteIds: string[];
  };
  MoveNotebook: {
    selectedNotebooks: Notebook[];
  };
  MoveNotes: {
    notebook: Notebook;
  };
  ManageTags: {
    ids?: string[];
  };
  AddReminder: {
    reminder?: Reminder;
    reference?: Note;
  };
  RelationsList: {
    item: Item;
    referenceType: "notebook" | "tag" | "reminder" | "note";
    relationType: "to" | "from";
    title: string;
    onAdd?: () => void;
  };
  Intro: GenericRouteParam;
  PayWall: {
    canGoBack?: boolean;
    context: "signup" | "logged-in" | "logged-out" | "subscribed";
    state?: BillingState;
  };
  Wrapped: GenericRouteParam;
}

export type RouteName = keyof RouteParams;

export type HeaderRightButton = {
  title: string;
  onPress: () => void;
};

interface NavigationStore {
  currentRoute: RouteName;
  canGoBack?: boolean;
  focusedRouteId?: string;
  update: (currentScreen: RouteName) => void;
  headerRightButtons?: HeaderRightButton[];
  buttonAction: () => void;
  setButtonAction: (buttonAction: () => void) => void;
  setFocusedRouteId: (id?: string) => void;
}

const useNavigationStore = create<NavigationStore>((set, get) => ({
  focusedRouteId: "Notes",
  setFocusedRouteId: (id) => {
    set({
      focusedRouteId: id
    });
  },
  currentRoute: "Notes",
  canGoBack: false,
  update: (currentScreen) => {
    set({
      currentRoute: currentScreen
    });
  },
  headerRightButtons: [],
  buttonAction: () => null,
  setButtonAction: (buttonAction) => set({ buttonAction })
}));

export default useNavigationStore;
