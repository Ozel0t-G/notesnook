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

import { ScopedThemeProvider, useThemeColors } from "@notesnook/theme";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";
import { Platform, View } from "react-native";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { isMacCatalyst } from "../../utils/constants";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useNavigationStore from "../../stores/use-navigation-store";
import Group from "./group";
import Home from "./home";
import { RouteParams } from "./types";
const SettingsStack = createNativeStackNavigator<RouteParams>();

export const Settings = () => {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: visual.screenBackground,
        // iOS presents Settings as a sheet, which is not under the status bar.
        // Mac Catalyst presents it as a full view inside the window, under the
        // native toolbar, so it uses the padded top inset the root publishes
        // (like the Tasks and Search sections do through their SafeAreaView).
        paddingTop: Platform.OS === "ios" && !isMacCatalyst() ? 0 : insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right
      }}
    >
      <ScopedThemeProvider value="list">
        <SettingsStack.Navigator
          initialRouteName="SettingsHome"
          screenListeners={{
            focus: (e) => {
              if (e.target?.startsWith("SettingsHome-")) {
                useNavigationStore.getState().update("Settings");
              }
            }
          }}
          screenOptions={{
            animation: "none",
            headerShown: false,
            contentStyle: {
              backgroundColor: visual.screenBackground
            }
          }}
        >
          <SettingsStack.Screen name="SettingsHome" component={Home} />
          <SettingsStack.Screen name="SettingsGroup" component={Group} />
        </SettingsStack.Navigator>
      </ScopedThemeProvider>
    </View>
  );
};

export default Settings;
