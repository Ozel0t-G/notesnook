import React from "react";
import { Platform, requireNativeComponent, ViewStyle } from "react-native";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";

type NativeProps = {
  symbolName: string;
  symbolColor: string;
  style: ViewStyle;
  accessibilityLabel?: string;
  accessible?: boolean;
};

const NativeSymbol =
  Platform.OS === "ios"
    ? requireNativeComponent<NativeProps>("TaskSymbolView")
    : undefined;

export function TaskSymbolView({
  name,
  color,
  size = 24,
  accessibilityLabel
}: {
  name: string;
  color: string;
  size?: number;
  accessibilityLabel?: string;
}) {
  if (!NativeSymbol)
    return <Icon name="format-list-bulleted" size={size} color={color} />;
  return (
    <NativeSymbol
      symbolName={name}
      symbolColor={color}
      style={{ width: size, height: size }}
      accessibilityLabel={accessibilityLabel}
      accessible={!!accessibilityLabel}
    />
  );
}
