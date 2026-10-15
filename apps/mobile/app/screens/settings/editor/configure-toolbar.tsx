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

import { isFeatureAvailable } from "@notesnook/common";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import { StyleSheet, View } from "react-native";
import { DraxProvider, DraxScrollView } from "react-native-drax";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import SheetProvider from "../../../components/sheet-provider";
import { Button } from "../../../components/ui/button";
import { Notice } from "../../../components/ui/notice";
import Paragraph from "../../../components/ui/typography/paragraph";
import { eSendEvent, ToastManager } from "../../../services/event-manager";
import { eCloseSheet } from "../../../utils/events";
import { AppFontSize } from "../../../utils/size";
import { DefaultAppStyles } from "../../../utils/styles";
import { Group } from "./group";
import { DragState, useDragState } from "./state";
import { TOOL_SHEET_CONTEXT } from "./tool-sheet";
export const ConfigureToolbar = () => {
  const data = useDragState((state) => state.data);
  const preset = useDragState((state) => state.preset);
  const { colors } = useThemeColors();

  /**
   * Dismiss the scoped toolbar picker the moment this screen goes away.
   *
   * The picker is presented by the `SheetProvider` mounted just below, inside
   * the same Settings screen subtree. React runs deletion-effect cleanups
   * parent-first, so this cleanup fires *before* the provider unsubscribes and
   * is torn down - the provider is still live, its `eCloseSheet` listener is
   * still installed and its `ActionSheetRef` still points at the mounted
   * sheet, so the sheet is actually hidden. Without it a presented sheet would
   * outlive the screen that owns it (a leaked native modal).
   *
   * Only the scoped context is closed; the global provider and every other
   * context are untouched (its listener filters on this exact context string).
   */
  React.useLayoutEffect(() => {
    return () => {
      eSendEvent(eCloseSheet, TOOL_SHEET_CONTEXT);
    };
  }, []);

  const renderGroups = () => {
    return data?.map((item, index) => (
      <Group key={`group-${index}-${item.length}`} item={item} index={index} />
    ));
  };

  return (
    <DraxProvider>
      <Animated.View
        entering={FadeInDown}
        exiting={FadeOutDown}
        style={styles.container}
      >
        <View
          style={{
            paddingVertical: DefaultAppStyles.GAP_VERTICAL
          }}
        >
          <Notice text={strings.configureToolbarNotice()} type="information" />

          <Paragraph
            style={{
              marginTop: DefaultAppStyles.GAP_VERTICAL
            }}
            size={AppFontSize.xs}
            color={colors.secondary.paragraph}
          >
            {strings.presets()}
          </Paragraph>

          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              width: "100%",
              marginTop: DefaultAppStyles.GAP_VERTICAL
            }}
          >
            {[
              {
                id: "default",
                name: strings.default()
              },
              {
                id: "minimal",
                name: strings.minimal()
              },
              {
                id: "custom",
                name: strings.custom()
              }
            ].map((item) => (
              <Button
                type={preset === item.id ? "accent" : "secondaryAccented"}
                style={{
                  borderRadius: 100,
                  marginRight: 10,
                  paddingVertical: DefaultAppStyles.GAP_VERTICAL_SMALL
                }}
                onPress={async () => {
                  if (item.id === "custom") {
                    const customToolbarPresetFeature = await isFeatureAvailable(
                      "customToolbarPreset"
                    );
                    if (!customToolbarPresetFeature.isAllowed) {
                      ToastManager.show({
                        message: customToolbarPresetFeature.error,
                        type: "info"
                      });
                      return;
                    }
                  }
                  useDragState
                    .getState()
                    .setPreset(item.id as DragState["preset"]);
                }}
                fontSize={AppFontSize.sm - 1}
                key={item.name}
                title={item.name}
              />
            ))}
          </View>
        </View>
        {/*
         * The one scoped sheet host for the toolbar picker. It is a stable
         * sibling of the (remountable, `key={preset}`) scroll content, so
         * switching presets re-renders the groups without remounting the sheet
         * host and losing an open picker. It renders no UI of its own until a
         * matching `eOpenSheet` arrives.
         */}
        <SheetProvider context={TOOL_SHEET_CONTEXT} />
        <DraxScrollView
          style={{
            flex: 1
          }}
          key={preset}
          scrollEventThrottle={13}
          showsVerticalScrollIndicator={false}
        >
          {renderGroups()}
          <View
            style={{
              height: 500
            }}
          >
            <Button
              title={strings.createAGroup()}
              type="secondaryAccented"
              icon="plus"
              style={{
                width: "100%"
              }}
              onPress={() => {
                const _data = data ? data.slice() : [];
                _data.push([]);
                useDragState.getState().setData(_data);
              }}
            />
          </View>
        </DraxScrollView>
      </Animated.View>
    </DraxProvider>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: DefaultAppStyles.GAP,
    width: "100%"
  }
});
