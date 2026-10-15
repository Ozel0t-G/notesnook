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

import type { Notebook } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import { View } from "react-native";
import { db } from "../common/database";
import NotebookScreen from "../screens/notebook";
import { useSelectionStore } from "../stores/use-selection-store";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { AppFontSize } from "../utils/size";
import { DefaultAppStyles } from "../utils/styles";
import { Properties } from "./properties";
import { TaskSymbolView } from "./task-symbol-view";
import { Pressable } from "./ui/pressable";
import Heading from "./ui/typography/heading";
import Paragraph from "./ui/typography/paragraph";

/** Notebook breadcrumbs and selection context below the shared header.
 * Normal information access stays in Header's More > Notebook Options menu.
 * Selection replaces that menu with Done, so retain the information action here.
 * Properties refreshes the notebook and retains description, dates and actions.
 */
export function IPadNotebookInformation({
  notebook,
  breadcrumbs,
  totalNotes
}: {
  notebook: Notebook;
  totalNotes: number;
  breadcrumbs: { id: string; title: string }[];
}) {
  const { colors, isDark } = useThemeColors();
  const selectionMode = useSelectionStore((state) => state.selectionMode);
  const visual = getAppleVisualTokens(colors, isDark);
  if (!selectionMode && !breadcrumbs?.length) return null;
  return (
    <View
      testID="ipad-notebook-information"
      style={{
        paddingHorizontal: visual.pagePadding,
        paddingBottom: DefaultAppStyles.GAP_VERTICAL_SMALL,
        backgroundColor: visual.listSurface
      }}
    >
      {/* Selection replaces the shared primary title/count with N selected. */}
      {selectionMode ? (
        <View>
          <Heading accessibilityRole="header" size={AppFontSize.lg}>
            {notebook.title}
          </Heading>
          <Paragraph size={AppFontSize.xs} color={visual.secondaryText}>
            {strings.notes(totalNotes)}
          </Paragraph>
        </View>
      ) : null}
      {breadcrumbs?.length ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center"
          }}
        >
          {breadcrumbs.map((item, index) => (
            <React.Fragment key={item.id}>
              {index === 0 ? null : (
                <TaskSymbolView
                  name="chevron.right"
                  size={AppFontSize.xs}
                  color={visual.secondaryText}
                />
              )}
              <Pressable
                testID={`ipad-notebook-ancestor-${item.id}`}
                accessibilityRole="button"
                accessibilityLabel={item.title}
                type="transparent"
                noborder
                onPress={async () => {
                  const ancestor = await db.notebooks.notebook(item.id);
                  if (ancestor) NotebookScreen.navigate(ancestor, true);
                }}
                style={{
                  width: "auto",
                  minWidth: 44,
                  minHeight: 44,
                  flexShrink: 1,
                  justifyContent: "center",
                  paddingHorizontal: DefaultAppStyles.GAP_SMALL
                }}
              >
                <Paragraph size={AppFontSize.xs} color={visual.secondaryText}>
                  {item.title}
                </Paragraph>
              </Pressable>
            </React.Fragment>
          ))}
        </View>
      ) : null}
      {selectionMode ? (
        <Pressable
          testID="ipad-notebook-properties"
          accessibilityRole="button"
          accessibilityLabel={`${strings.notebookOptions()}: ${notebook.title}`}
          type="transparent"
          noborder
          onPress={() => Properties.present(notebook)}
          style={{
            width: "auto",
            minWidth: 44,
            minHeight: 44,
            flexDirection: "row",
            alignItems: "center",
            alignSelf: "flex-start",
            flexShrink: 1,
            maxWidth: "100%",
            gap: DefaultAppStyles.GAP_SMALL
          }}
        >
          <TaskSymbolView
            name="info.circle"
            size={AppFontSize.md}
            color={colors.primary.accent}
          />
          <Paragraph
            size={AppFontSize.xs}
            color={colors.primary.accent}
            style={{ flexShrink: 1 }}
          >
            {strings.notebookOptions()}
          </Paragraph>
        </Pressable>
      ) : null}
    </View>
  );
}
