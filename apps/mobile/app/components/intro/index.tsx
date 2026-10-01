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
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import {
  Image,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Navigation from "../../services/navigation";
import SettingsService from "../../services/settings";
import { AuthMode, hideAuth } from "../auth/common";
import { TaskSymbolView } from "../task-symbol-view";

/**
 * A single "What's New"-style welcome page (Notes, Reminders, Journal): app
 * icon, three features, Continue. Nothing forces an account; signing in is
 * offered from Settings and the "Sign in to sync" hint.
 */
const Intro = () => {
  const { colors } = useThemeColors();
  const { width } = useWindowDimensions();
  const isMacLayout = Platform.OS === "ios" && Platform.isMacCatalyst;
  // Mac: a narrower centered column with macOS push-button proportions.
  const contentWidth = Math.min(width - 48, isMacLayout ? 420 : 440);
  const accent = colors.primary.accent;
  // F6: the Continue label uses the theme's own accent foreground on the Mac
  // instead of a hardcoded white; iPhone/iPad keep the white they always had.
  const isMac = Platform.OS === "ios" && Platform.isMacCatalyst;

  const features: { symbol: string; title: string; body: string }[] = [
    {
      symbol: "note.text",
      title: strings.welcomeNotesTitle(),
      body: strings.welcomeNotesBody()
    },
    // AlarmKit is unavailable on Mac Catalyst, so this page does not advertise
    // task alarms there.
    ...(Platform.OS === "ios" && Platform.isMacCatalyst
      ? []
      : [
          {
            symbol: "alarm",
            title: strings.welcomeTasksTitle(),
            body: strings.welcomeTasksBody()
          }
        ]),
    {
      symbol: "lock.shield",
      title: strings.welcomeEncryptedTitle(),
      body: strings.welcomeEncryptedBody()
    }
  ];

  const finish = () => {
    SettingsService.set({ introCompleted: true });
    hideAuth("intro", true);
  };

  return (
    <SafeAreaView
      testID="notesnook.splashscreen"
      style={{ flex: 1, backgroundColor: colors.primary.background }}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: "center",
          paddingTop: isMacLayout ? 72 : 56,
          paddingBottom: 24
        }}
      >
        <Image
          source={require("../../assets/images/veyran-icon.png")}
          accessibilityIgnoresInvertColors
          style={
            isMacLayout
              ? { width: 64, height: 64, borderRadius: 14 }
              : { width: 88, height: 88, borderRadius: 20 }
          }
        />
        <Text
          accessibilityRole="header"
          style={{
            width: contentWidth,
            marginTop: 24,
            textAlign: "center",
            color: colors.primary.heading,
            fontSize: isMacLayout ? 26 : 34,
            fontWeight: "700"
          }}
        >
          {strings.welcomeTitle()}
        </Text>
        <View style={{ width: contentWidth, marginTop: 40, gap: 28 }}>
          {features.map((feature) => (
            <View
              key={feature.symbol}
              accessible
              accessibilityLabel={`${feature.title}. ${feature.body}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 18 }}
            >
              <View style={{ width: 44, alignItems: "center" }}>
                <TaskSymbolView
                  name={feature.symbol}
                  size={34}
                  color={accent}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    color: colors.primary.heading,
                    fontSize: 17,
                    fontWeight: "600"
                  }}
                >
                  {feature.title}
                </Text>
                <Text
                  style={{
                    color: colors.secondary.paragraph,
                    fontSize: 15,
                    marginTop: 2
                  }}
                >
                  {feature.body}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
      <View
        style={{
          width: contentWidth,
          alignSelf: "center",
          paddingBottom: 12,
          gap: 6
        }}
      >
        <Pressable
          testID="intro-continue"
          onPress={finish}
          accessibilityRole="button"
          accessibilityLabel={strings.welcomeContinue()}
          style={({ pressed }) => ({
            minHeight: isMacLayout ? 36 : 50,
            borderRadius: isMacLayout ? 8 : 14,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: accent,
            opacity: pressed ? 0.8 : 1
          })}
        >
          <Text
            style={{
              color: isMac ? colors.primary.accentForeground : "#FFFFFF",
              fontSize: isMacLayout ? 14 : 17,
              fontWeight: "600"
            }}
          >
            {strings.welcomeContinue()}
          </Text>
        </Pressable>
        <Pressable
          testID="intro-sign-in"
          onPress={() => {
            SettingsService.set({ introCompleted: true });
            Navigation.push("Auth", {
              mode: AuthMode.welcomeLogin,
              context: "intro"
            });
          }}
          accessibilityRole="button"
          accessibilityLabel={strings.iAlreadyHaveAnAccount()}
          style={({ pressed }) => ({
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.5 : 1
          })}
        >
          <Text style={{ color: accent, fontSize: isMacLayout ? 13 : 17 }}>
            {strings.iAlreadyHaveAnAccount()}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
};

export default Intro;
