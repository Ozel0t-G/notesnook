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

import type { ToolId } from "@notesnook/editor";
import React, { RefObject } from "react";
import { View } from "react-native";
import { Pressable } from "../../../components/ui/pressable";
import { SvgView } from "../../../components/ui/svg";
import Paragraph from "../../../components/ui/typography/paragraph";
import { presentSheet } from "../../../services/event-manager";
import { useThemeColors } from "@notesnook/theme";
import { defaultBorderRadius, AppFontSize } from "../../../utils/size";
import { DraggableItem, useDragState } from "./state";
import {
  findToolById,
  getToolIcon,
  getUngroupedTools
} from "./toolbar-definition";
import { ActionSheetRef, ScrollView } from "react-native-actions-sheet";
import { strings } from "@notesnook/intl";
import { DefaultAppStyles } from "../../../utils/styles";

/**
 * The `SheetProvider` context the toolbar picker is presented in.
 *
 * `ConfigureToolbar` mounts exactly one `SheetProvider` with this context
 * inside the Settings screen subtree, and `ToolSheet.present` targets the same
 * context. Presenting through the app-wide "global" provider (the root
 * `DialogProvider`, which lives *outside* the Settings `RNSScreen`) is what
 * produced the "Attempt to present RCTFabricModalHostViewController on a
 * UIViewController already presenting RNSScreen" UIKit error on the iPad
 * settings modal, so both sides must use this single shared value.
 */
export const TOOL_SHEET_CONTEXT = "configure-toolbar";

export default function ToolSheet({
  group,
  fwdRef
}: {
  group: DraggableItem;
  fwdRef: RefObject<ActionSheetRef>;
}) {
  const { colors } = useThemeColors();
  const [data] = useDragState((state) => [state.data]);
  const ungrouped = getUngroupedTools( data) as ToolId[];

  const renderTool = React.useCallback(
    (item: ToolId) => {
      const tool = findToolById(item);
      const iconSvgString = tool
        ? getToolIcon(tool.icon as ToolId, colors.secondary.icon)
        : null;
      if (item === "none") return;
      return (
        <Pressable
          key={item}
          type="secondary"
          // Each row is a real, activatable toolbar tool: expose it as a button
          // and label it with the tool's actual translated title (the same
          // `tool.title` rendered as its visible text) so VoiceOver announces
          // something meaningful instead of the raw tool id / icon.
          accessibilityRole="button"
          accessibilityLabel={tool?.title}
          onPress={() => {
            const _data = useDragState.getState().data.slice();
            if (group.groupIndex !== undefined) {
              (_data[group.groupIndex][group.index] as ToolId[]).unshift(
                item as ToolId
              );
            } else {
              _data[group.index].unshift(item);
            }
            useDragState.getState().setData(_data);
          }}
          style={{
            marginBottom: DefaultAppStyles.GAP_VERTICAL,
            width: "100%",
            height: 50,
            paddingHorizontal: DefaultAppStyles.GAP,
            paddingRight: 0,
            borderRadius: defaultBorderRadius,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "flex-start"
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center"
            }}
          >
            {iconSvgString ? (
              <SvgView width={23} height={23} src={iconSvgString} />
            ) : null}
            <Paragraph
              style={{
                marginLeft: iconSvgString ? 10 : 0
              }}
              color={colors.primary.paragraph}
              size={AppFontSize.sm}
            >
              {tool?.title}
            </Paragraph>
          </View>
        </Pressable>
      );
    },
    [
      colors.primary.paragraph,
      colors.secondary.icon,
      group.groupIndex,
      group.index
    ]
  );

  return (
    <View
      style={{
        maxHeight: 400,
        padding: DefaultAppStyles.GAP
      }}
    >
      <ScrollView nestedScrollEnabled={true}>
        {!ungrouped || ungrouped.length === 0 ? (
          <Paragraph
            style={{
              alignSelf: "center"
            }}
            color={colors.secondary.paragraph}
          >
            {strings.groupedAllTools()}
          </Paragraph>
        ) : (
          ungrouped.map(renderTool)
        )}
        <View
          style={{
            height: 200
          }}
        />
      </ScrollView>
    </View>
  );
}

ToolSheet.present = (payload: DraggableItem) => {
  presentSheet({
    // The picker belongs to the Settings screen (it edits the toolbar
    // preview rendered there), so it must be presented by the scoped provider
    // mounted inside `ConfigureToolbar` - never by the global/root provider.
    context: TOOL_SHEET_CONTEXT,
    component: (ref) => <ToolSheet fwdRef={ref} group={payload} />
  });
};
