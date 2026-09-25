import React from "react";
import {
  Platform,
  requireNativeComponent,
  StyleSheet,
  View,
  ViewStyle
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AppleSection,
  useAppleNavigationStore
} from "../stores/use-apple-navigation-store";

type NativeTabBarProps = {
  selectedSection: AppleSection;
  onSelect: (event: { nativeEvent: { section: AppleSection } }) => void;
  style: ViewStyle;
};

const NativeTabBar =
  Platform.OS === "ios"
    ? requireNativeComponent<NativeTabBarProps>("VeyraNTabBarView")
    : undefined;

export function AppleTabBar({
  onSelect
}: {
  onSelect: (section: AppleSection) => void;
}) {
  const section = useAppleNavigationStore((state) => state.section);
  const insets = useSafeAreaInsets();

  if (!NativeTabBar) return null;
  return (
    <View style={[styles.container, { height: 49 + insets.bottom }]}>
      <NativeTabBar
        selectedSection={section}
        onSelect={({ nativeEvent }) => onSelect(nativeEvent.section)}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%"
  }
});
