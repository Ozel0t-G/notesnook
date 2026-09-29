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

import type { Item } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import React from "react";
import { StyleProp, ViewStyle } from "react-native";
import { Action, ActionId, useActions } from "../hooks/use-actions";
import { ContextMenu, MenuButton, NativeMenuItem } from "./native-menu";

/** SF Symbols for the item actions (replacing the Material icons of the grid). */
const SYMBOLS: Partial<Record<ActionId, string>> = {
  pin: "pin",
  favorite: "star",
  "lock-unlock": "lock",
  notebooks: "folder.badge.plus",
  "add-tag": "number",
  "add-reminder": "checklist",
  share: "square.and.arrow.up",
  export: "arrow.up.doc",
  "copy-link": "link",
  copy: "doc.on.doc",
  "copy-id": "number.square",
  history: "clock.arrow.circlepath",
  attachments: "paperclip",
  "read-only": "pencil.slash",
  "local-only": "icloud.slash",
  duplicate: "plus.square.on.square",
  publish: "globe",
  archive: "archivebox",
  "expiry-date": "timer",
  references: "arrow.triangle.branch",
  "remove-from-notebook": "folder.badge.minus",
  "spell-check": "textformat.abc",
  trash: "trash",
  delete: "trash",
  restore: "arrow.uturn.backward",
  "add-notebook": "folder.badge.plus",
  "edit-notebook": "pencil",
  "rename-tag": "pencil",
  "rename-color": "pencil",
  "move-notebook": "folder",
  "move-notes": "doc.on.doc",
  "add-shortcut": "sidebar.left",
  "default-notebook": "star.square",
  "default-tag": "star.square",
  "default-homepage": "house",
  select: "checkmark.circle"
};

/**
 * Groups like Apple Notes: Pin/Favorite/Lock · filing · sharing ·
 * everything else under "More" · the destructive action last.
 */
const GROUPS: ActionId[][] = [
  ["pin", "favorite", "lock-unlock"],
  ["notebooks", "add-reminder", "add-tag", "move-notebook", "move-notes"],
  ["share", "export", "copy-link", "copy"],
  ["restore"]
];
const DESTRUCTIVE: ActionId[] = ["trash", "delete"];

function menuItem(action: Action): NativeMenuItem {
  return {
    id: action.id,
    title: action.title,
    symbol: SYMBOLS[action.id],
    checked: !action.isToggle && action.checked ? true : undefined,
    destructive: DESTRUCTIVE.includes(action.id) || undefined,
    disabled: action.locked || undefined
  };
}

export function actionsToMenu(actions: Action[]): NativeMenuItem[] {
  const visible = actions.filter((action) => !action.hidden);
  const used = new Set<ActionId>();
  const groups: NativeMenuItem[] = GROUPS.map((ids) => {
    const children = ids.flatMap((id) => {
      const action = visible.find((item) => item.id === id);
      if (!action) return [];
      used.add(id);
      return [menuItem(action)];
    });
    return { title: "", inline: true, children };
  });
  const destructive = visible.filter((action) =>
    DESTRUCTIVE.includes(action.id)
  );
  destructive.forEach((action) => used.add(action.id));
  const rest = visible.filter((action) => !used.has(action.id));
  return [
    ...groups,
    ...(rest.length
      ? [
          {
            title: "",
            inline: true,
            children: [
              {
                title: strings.more(),
                symbol: "ellipsis.circle",
                children: rest.map(menuItem)
              }
            ]
          }
        ]
      : []),
    { title: "", inline: true, children: destructive.map(menuItem) }
  ].filter((group) => group.children?.length);
}

/**
 * Mounted only while a menu is open: runs `useActions` for one item and hands
 * the resulting menu to the native view, then executes the chosen action.
 */
function ItemActionsHost({
  item,
  onMenu,
  runner
}: {
  item: Item;
  onMenu: (menu: NativeMenuItem[]) => void;
  runner: React.MutableRefObject<((id: string) => void) | undefined>;
}) {
  const actions = useActions({ item, close: () => {}, presentation: "menu" });
  runner.current = (id: string) =>
    actions.find((action) => action.id === id)?.onPress();
  const menu = actionsToMenu(actions);
  const signature = JSON.stringify(menu);
  React.useEffect(() => {
    // The first render has not resolved async state (vault, publish) yet; a
    // short settle keeps the first menu the user sees accurate.
    const timer = setTimeout(() => onMenu(JSON.parse(signature)), 80);
    return () => clearTimeout(timer);
  }, [signature, onMenu]);
  return null;
}

function useItemActionsMenu(item: Item) {
  const [active, setActive] = React.useState(false);
  const [menu, setMenu] = React.useState<NativeMenuItem[]>([]);
  const runner = React.useRef<((id: string) => void) | undefined>(undefined);
  const host = active ? (
    <ItemActionsHost item={item} onMenu={setMenu} runner={runner} />
  ) : null;
  return {
    host,
    menu,
    request: () => {
      setMenu([]);
      setActive(true);
    },
    select: (id: string) => {
      runner.current?.(id);
    }
  };
}

/** Long-press context menu with the item's actions (notes, notebooks, tags). */
export function ItemContextMenu({
  item,
  enabled = true,
  style,
  previewCornerRadius,
  children
}: {
  item: Item;
  enabled?: boolean;
  style?: StyleProp<ViewStyle>;
  previewCornerRadius?: number;
  children: React.ReactNode;
}) {
  const { host, menu, request, select } = useItemActionsMenu(item);
  return (
    <ContextMenu
      title={"title" in item ? (item.title as string) : undefined}
      items={menu}
      enabled={enabled}
      onRequest={request}
      onSelect={select}
      style={style}
      previewCornerRadius={previewCornerRadius}
    >
      {children}
      {host}
    </ContextMenu>
  );
}

/** A "…" pull-down with the item's actions (editor toolbar, headers). */
export function ItemActionsButton({
  item,
  accessibilityLabel,
  style,
  children,
  testID
}: {
  item: Item;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  testID?: string;
}) {
  const { host, menu, request, select } = useItemActionsMenu(item);
  return (
    <MenuButton
      items={menu}
      onRequest={request}
      onSelect={select}
      accessibilityLabel={accessibilityLabel}
      style={style}
      testID={testID}
    >
      {children}
      {host}
    </MenuButton>
  );
}
