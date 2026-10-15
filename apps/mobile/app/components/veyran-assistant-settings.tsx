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

/**
 * Settings entry for the VeyraN Assistant (Slice 1 reads + Slice 2 actions).
 *
 * It reuses the exact same panel as the editor sidebar, so the connection
 * status, the verified identity, the model catalog, the credits notice and the
 * explicit write actions are identical in both places. Off Mac Catalyst the
 * panel shows the honest unsupported state and reads nothing (no Keychain,
 * listener, browser or note context).
 */

import React from "react";
import { View } from "react-native";
import { useThemeColors } from "@notesnook/theme";
import Paragraph from "./ui/typography/paragraph";
import { AssistantPanel } from "./veyran-assistant-sidebar";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { DefaultAppStyles } from "../utils/styles";

export const VeyranAssistantSettings = () => {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);

  // The panel owns the single scroll view; the intro is its header, so no
  // nested ScrollView is created inside the settings screen.
  return (
    <AssistantPanel
      header={
        <View style={{ marginBottom: DefaultAppStyles.GAP_VERTICAL }}>
          <Paragraph color={visual.secondaryText}>
            Der Assistent läuft ausschließlich auf Mac Catalyst und liest nur die
            aktuell geöffnete, gespeicherte Notiz. Eine Anfrage wird nur durch
            dein ausdrückliches Senden gestartet; die Antwort bleibt im
            Arbeitsspeicher. Gespeichert wird ausschließlich nach einem
            separaten, ausdrücklichen Klick: als neue Notiz, als Anhang an genau
            die geladene Notiz (mit ihrer geladenen Fassung) oder als echter
            Task. Ohne deinen Klick schreibt der Assistent nichts.
          </Paragraph>
        </View>
      }
    />
  );
};

export default VeyranAssistantSettings;
