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

import React from "react";
import {
  Platform,
  requireNativeComponent,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle
} from "react-native";

/**
 * One entry of a native UIMenu. An entry with `children` is a submenu;
 * `inline: true` draws it as a separated group, which is how iOS shows menu
 * sections.
 */
export type NativeMenuItem = {
  id?: string;
  title: string;
  subtitle?: string;
  /** SF Symbol name. */
  symbol?: string;
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  inline?: boolean;
  children?: NativeMenuItem[];
};

type SelectEvent = { nativeEvent: { id: string } };

type NativeMenuButtonProps = {
  menuItems: NativeMenuItem[];
  menuTitle?: string;
  accessibilityTitle?: string;
  onSelectItem: (event: SelectEvent) => void;
  deferred?: boolean;
  onMenuRequest?: () => void;
  style?: StyleProp<ViewStyle>;
};

type NativeContextMenuProps = {
  menuItems: NativeMenuItem[];
  menuTitle?: string;
  previewCornerRadius?: number;
  onSelectItem: (event: SelectEvent) => void;
  deferred?: boolean;
  menuEnabled?: boolean;
  onMenuRequest?: () => void;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

const NativeMenuButton =
  Platform.OS === "ios"
    ? requireNativeComponent<NativeMenuButtonProps>("VeyraNMenuButton")
    : undefined;

const NativeContextMenu =
  Platform.OS === "ios"
    ? requireNativeComponent<NativeContextMenuProps>("VeyraNContextMenu")
    : undefined;

/** Removes items without an id or children so the native side never gets holes. */
export function compactMenu(
  items: (NativeMenuItem | false | null | undefined)[]
): NativeMenuItem[] {
  return items.flatMap((item) => {
    if (!item) return [];
    if (item.children) {
      const children = compactMenu(item.children);
      return children.length ? [{ ...item, children }] : [];
    }
    return [item];
  });
}

/**
 * A pull-down menu anchored to its content: tapping anywhere on `children`
 * opens the native iOS menu (with checkmarks, groups and destructive items).
 */
export function MenuButton({
  items,
  title,
  accessibilityLabel,
  onSelect,
  onRequest,
  style,
  children,
  testID
}: {
  items: (NativeMenuItem | false | null | undefined)[];
  title?: string;
  accessibilityLabel?: string;
  onSelect: (id: string) => void;
  /** Items are loaded when the menu opens (UIDeferredMenuElement). */
  onRequest?: () => void;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  testID?: string;
}) {
  const menuItems = React.useMemo(() => compactMenu(items), [items]);
  return (
    <View style={style} testID={testID}>
      {children}
      {NativeMenuButton ? (
        <NativeMenuButton
          menuItems={menuItems}
          menuTitle={title || ""}
          accessibilityTitle={accessibilityLabel || title || ""}
          onSelectItem={({ nativeEvent }) => onSelect(nativeEvent.id)}
          deferred={!!onRequest}
          onMenuRequest={onRequest}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </View>
  );
}

/** Long press on `children` lifts it and shows a native context menu. */
export function ContextMenu({
  items,
  title,
  onSelect,
  onRequest,
  enabled = true,
  style,
  previewCornerRadius,
  children
}: {
  items: (NativeMenuItem | false | null | undefined)[];
  title?: string;
  onSelect: (id: string) => void;
  /** Items are loaded when the menu opens (UIDeferredMenuElement). */
  onRequest?: () => void;
  enabled?: boolean;
  style?: StyleProp<ViewStyle>;
  previewCornerRadius?: number;
  children: React.ReactNode;
}) {
  const menuItems = React.useMemo(() => compactMenu(items), [items]);
  if (!NativeContextMenu) return <View style={style}>{children}</View>;
  return (
    <NativeContextMenu
      menuItems={menuItems}
      menuTitle={title || ""}
      previewCornerRadius={previewCornerRadius ?? 12}
      onSelectItem={({ nativeEvent }) => onSelect(nativeEvent.id)}
      deferred={!!onRequest}
      menuEnabled={enabled}
      onMenuRequest={onRequest}
      style={style}
    >
      {children}
    </NativeContextMenu>
  );
}
