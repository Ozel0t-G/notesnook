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
  GroupingByIdKey,
  GroupingKey,
  GroupOptions,
  ItemType,
  SortOptions
} from "@notesnook/core";
import { strings } from "@notesnook/intl";
import {
  getGroupOptions,
  setGroupOptionsById
} from "../hooks/use-group-options";
import { useIsCompactModeEnabled } from "../hooks/use-is-compact-mode-enabled";
import { eSendEvent } from "../services/event-manager";
import Navigation from "../services/navigation";
import SettingsService from "../services/settings";
import { useNotebookStore } from "../stores/use-notebook-store";
import { useSelectionStore } from "../stores/use-selection-store";
import { useTagStore } from "../stores/use-tag-store";
import { GROUP, SORT } from "../utils/constants";
import { eGroupOptionsUpdated, refreshNotesPage } from "../utils/events";
import { NativeMenuItem } from "./native-menu";

export type ListViewMenuConfig = {
  group: GroupingKey;
  dataType: ItemType;
  groupId?: string;
  groupType?: GroupingByIdKey;
  /** Offer "Select" (multi-selection). */
  selectable?: boolean;
  hideGroupOptions?: boolean;
  /** Extra items shown first, e.g. "Notebook Options". */
  extra?: NativeMenuItem[];
  onExtra?: (id: string) => void;
};

function visibleSorts(group: GroupingKey) {
  const visibility: Record<string, boolean> = {
    dateCreated: group !== "trash",
    relevance: group === "search",
    dueDate: group === "reminders",
    dateModified: group === "reminders" || group === "tags",
    dateEdited: group !== "tags" && group !== "reminders" && group !== "trash",
    dateDeleted: group === "trash"
  };
  return Object.keys(SORT).filter((key) => visibility[key] !== false);
}

/**
 * The single "…" menu of a list (iOS): Select, list style, Sort By and Group
 * By with checkmarks, replacing the separate Material sort/view buttons.
 */
export function useListViewMenu(config?: ListViewMenuConfig) {
  const compact = useIsCompactModeEnabled(config?.dataType || "note");
  if (!config) return undefined;
  const options = (getGroupOptions(
    config.group,
    config.groupId,
    config.groupType
  ) || {}) as GroupOptions;

  const items: NativeMenuItem[] = [
    ...(config.extra?.length
      ? [{ title: "", inline: true, children: config.extra }]
      : []),
    {
      title: "",
      inline: true,
      children: [
        ...(config.selectable
          ? [
              {
                id: "list:select",
                title: strings.listSelect(),
                symbol: "checkmark.circle"
              }
            ]
          : []),
        ...(config.dataType === "note" || config.dataType === "notebook"
          ? [
              {
                id: "list:compact",
                title: compact
                  ? strings.listViewAsCards()
                  : strings.listViewAsCompact(),
                symbol: compact ? "list.bullet.below.rectangle" : "list.bullet"
              }
            ]
          : [])
      ]
    },
    {
      title: "",
      inline: true,
      children: [
        {
          title: strings.listSortBy(),
          symbol: "arrow.up.arrow.down",
          subtitle: strings.sortByStrings[
            options.sortBy as keyof typeof strings.sortByStrings
          ]?.(),
          children: [
            {
              title: "",
              inline: true,
              children: visibleSorts(config.group).map((key) => ({
                id: `sort:${key}`,
                title:
                  strings.sortByStrings[
                    key as keyof typeof strings.sortByStrings
                  ]?.() || key,
                checked: options.sortBy === key
              }))
            },
            {
              title: "",
              inline: true,
              children: [
                {
                  id: "order:asc",
                  title: strings.listAscending(),
                  checked: options.sortDirection === "asc"
                },
                {
                  id: "order:desc",
                  title: strings.listDescending(),
                  checked: options.sortDirection !== "asc"
                }
              ]
            }
          ]
        },
        ...(config.hideGroupOptions
          ? []
          : [
              {
                title: strings.listGroupBy(),
                symbol: "square.grid.3x1.below.line.grid.1x2",
                subtitle: strings.groupByStrings[
                  options.groupBy as keyof typeof strings.groupByStrings
                ]?.(),
                children: Object.keys(GROUP).map((key) => ({
                  id: `group:${key}`,
                  title:
                    strings.groupByStrings[
                      key as keyof typeof strings.groupByStrings
                    ]?.() || key,
                  checked: options.groupBy === key
                }))
              }
            ])
      ]
    }
  ];

  const update = async (next: GroupOptions) => {
    await setGroupOptionsById(
      config.group,
      next,
      config.groupId,
      config.groupType
    );
    setTimeout(() => {
      Navigation.queueRoutesForUpdate();
      if (config.dataType === "notebook") useNotebookStore.getState().refresh();
      else if (config.dataType === "tag") useTagStore.getState().refresh();
      eSendEvent(
        eGroupOptionsUpdated,
        config.group,
        config.groupId,
        config.groupType
      );
      eSendEvent(refreshNotesPage);
    }, 1);
  };

  const onSelect = (id: string) => {
    if (id === "list:select") {
      useSelectionStore.getState().setSelectionMode(config.dataType);
    } else if (id === "list:compact") {
      SettingsService.set(
        config.dataType === "notebook"
          ? { notebooksListMode: compact ? "normal" : "compact" }
          : { notesListMode: compact ? "normal" : "compact" }
      );
    } else if (id.startsWith("sort:")) {
      void update({
        ...options,
        sortBy: id.slice(5) as SortOptions["sortBy"]
      });
    } else if (id.startsWith("order:")) {
      void update({
        ...options,
        sortDirection: id.slice(6) as SortOptions["sortDirection"]
      });
    } else if (id.startsWith("group:")) {
      void update({
        ...options,
        groupBy: id.slice(6) as GroupOptions["groupBy"]
      });
    } else config.onExtra?.(id);
  };

  return { items, onSelect };
}
