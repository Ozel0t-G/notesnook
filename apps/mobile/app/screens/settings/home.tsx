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

import { strings } from "@notesnook/intl";
import { NativeStackScreenProps } from "@react-navigation/native-stack";
import React from "react";
import DelayLayout from "../../components/delay-layout";
import { Header } from "../../components/header";
import { useNavigationFocus } from "../../hooks/use-navigation-focus";
import useNavigationStore from "../../stores/use-navigation-store";
import { SectionGroup } from "./section-group";
import { settingsGroups } from "./settings-data";
import { RouteParams, SettingSection } from "./types";
import { LegendList } from "@legendapp/list";
import { useThemeColors } from "@notesnook/theme";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import Navigation from "../../services/navigation";

const keyExtractor = (item: SettingSection) => item.id;

const Home = ({
  navigation
}: NativeStackScreenProps<RouteParams, "SettingsHome">) => {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  useNavigationFocus(navigation, {
    onFocus: () => {
      useNavigationStore.getState().setFocusedRouteId("Settings");
      return false;
    },
    focusOnInit: true
  });

  const renderItem = ({ item }: { item: SettingSection; index: number }) => (
    <SectionGroup item={item} />
  );

  return (
    <>
      <Header
        renderedInRoute="Settings"
        title={strings.routes.Settings()}
        canGoBack={!visual.ios}
        hasSearch={false}
        id="Settings"
        rightButton={
          visual.ios
            ? {
                name: "done",
                accessibilityLabel: strings.done(),
                onPress: () => Navigation.goBack()
              }
            : undefined
        }
      />
      <DelayLayout type="settings">
        <LegendList
          testID="settings-list"
          data={settingsGroups}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={{
            paddingHorizontal: visual.ios ? visual.pagePadding : 0,
            paddingBottom: visual.ios ? visual.sectionSpacing : 0
          }}
        />
      </DelayLayout>
    </>
  );
};

export default Home;
