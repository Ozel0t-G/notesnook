import React from "react";
import { Pressable, View } from "react-native";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import { getAppleVisualTokens } from "../utils/apple-visual-tokens";
import { TaskSymbolView } from "./task-symbol-view";
import Paragraph from "./ui/typography/paragraph";
import {
  ASSISTANT_SIDEBAR_WIDTH,
  VeyranAssistantSidebar
} from "./veyran-assistant-sidebar";

/** Geometry only: closing/resizing never unmounts the existing Assistant host. */
export function MacAssistantInspector({
  visible,
  docked,
  height,
  onClose
}: {
  visible: boolean;
  docked: boolean;
  height: number;
  onClose: () => void;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  return (
    <View
      testID="mac-assistant-inspector"
      pointerEvents={visible ? "auto" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
      style={{
        display: visible ? "flex" : "none",
        width: docked ? ASSISTANT_SIDEBAR_WIDTH : "100%",
        height: docked ? "100%" : Math.min(260, Math.max(0, height) * 0.4),
        flexShrink: 0,
        backgroundColor: visual.secondarySurface,
        borderLeftWidth: docked ? 0.5 : 0,
        borderTopWidth: docked ? 0 : 0.5,
        borderColor: visual.separator
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 12,
          minHeight: 36
        }}
      >
        <Paragraph style={{ flex: 1 }} color={visual.secondaryText}>
          Assistant
        </Paragraph>
        <Pressable
          testID="mac-assistant-inspector-close"
          accessibilityRole="button"
          accessibilityLabel={`${strings.hide()} Assistant`}
          onPress={onClose}
          style={({ pressed }) => ({
            width: 36,
            height: 36,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.4 : 1
          })}
        >
          <TaskSymbolView name="xmark" size={13} color={visual.secondaryText} />
        </Pressable>
      </View>
      <VeyranAssistantSidebar
        style={{
          width: "100%",
          height: 0,
          flex: 1,
          borderLeftWidth: 0
        }}
      />
    </View>
  );
}
