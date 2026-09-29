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

import { useThemeColors } from "@notesnook/theme";
import {
  NavigationProp,
  StackActions,
  useNavigation
} from "@react-navigation/native";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Switch,
  Text,
  TextInput,
  View
} from "react-native";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { SymbolTile } from "../../components/ui/symbol-tile";
import { systemColor } from "../../utils/ios-system-colors";
import { iosSettingSymbol, useSettingsFooter } from "./ios-appearance";
import { FeatureResult, useIsFeatureAvailable } from "@notesnook/common";
//@ts-ignore
import ToggleSwitch from "toggle-switch-react-native";
import AppIcon from "../../components/ui/AppIcon";
import { IconButton } from "../../components/ui/icon-button";
import Input from "../../components/ui/input";
import { Pressable } from "../../components/ui/pressable";
import Seperator from "../../components/ui/seperator";
import Heading from "../../components/ui/typography/heading";
import Paragraph from "../../components/ui/typography/paragraph";
import { ToastManager } from "../../services/event-manager";
import SettingsService from "../../services/settings";
import useNavigationStore from "../../stores/use-navigation-store";
import { SettingStore, useSettingStore } from "../../stores/use-setting-store";
import { AppFontSize } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { components } from "./components";
import { RouteParams, SettingSection } from "./types";

const _SectionItem = ({
  item,
  last = true
}: {
  item: SettingSection;
  last?: boolean;
}) => {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const registerFooter = useSettingsFooter();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const isFeatureAvailable = item.featureId
    ? // eslint-disable-next-line react-hooks/rules-of-hooks
      useIsFeatureAvailable(item.featureId)
    : ({
        isAllowed: true
      } as FeatureResult);
  const [settings, itemProperty] = useSettingStore((state) => [
    state.settings,
    item.property ? state.settings[item.property] : null
  ]);
  const navigation = useNavigation<NavigationProp<RouteParams>>();
  const current = item.useHook && item.useHook(item);
  const [isHidden, setIsHidden] = useState(
    item.hidden && item.hidden(item.property || current)
  );
  const [isDisabled, setIsDisabled] = useState(
    item.disabled && item.disabled(item.property || current)
  );
  const inputRef = useRef<TextInput>(null);
  const [loading, setLoading] = useState(false);

  const onChangeSettings = async () => {
    if (isDisabled) return;
    if (!checkIsFeatureAvailable()) return;
    if (loading) return;
    if (item.onVerify && !(await item.onVerify())) return;
    if (item.modifer) {
      setLoading(true);
      await item.modifer(item.property || current);
      setLoading(false);
      return;
    }
    if (!item.property) return;
    const nextValue = !settings[item.property];
    SettingsService.set({
      [item.property]: nextValue
    });
    setImmediate(() => {
      item.onChange?.(nextValue);
      item.hidden &&
        setIsHidden(item.hidden && item.hidden(item.property || current));
      item.disabled &&
        setIsDisabled(item.disabled && item.disabled(item.property || current));
    });
  };

  const styles =
    item.type === "danger" && !visual.ios
      ? {
          backgroundColor: colors.error.background
        }
      : {};
  const [iosSymbol, iosTint] = iosSettingSymbol(item.id);

  const updateInput = (value: any) => {
    inputRef?.current?.setNativeProps({
      text: value + ""
    });
  };

  const onChangeInputSelectorValue = (text: any) => {
    if (text) {
      const min = item.minInputValue || 0;
      const max = item.maxInputValue || 0;
      const value = parseInt(text);
      text =
        Number.isNaN(value) || value < min ? min : value > max ? max : text;

      SettingsService.set({
        [item.property as string]: `${text}`
      });
    }
  };

  useEffect(() => {
    setIsHidden(item.hidden && item.hidden(item.property || current));
    setIsDisabled(
      !isFeatureAvailable?.isAllowed ||
        (item.disabled && item.disabled(item.property || current))
    );
  }, [current, item, itemProperty, isFeatureAvailable?.isAllowed]);

  const inlineDescription =
    !visual.ios ||
    item.type === "component" ||
    item.type === "input" ||
    item.type === "input-selector";
  const descriptionText = item.description
    ? typeof item.description === "function"
      ? item.description(current)
      : item.description
    : undefined;
  // iOS: explanations go to the group's footer, not under each row. Screens
  // (rows that open a page) show theirs on that page instead.
  useEffect(() => {
    if (!registerFooter || inlineDescription) return;
    registerFooter(
      item.id,
      !isHidden && item.type !== "screen" ? descriptionText : undefined
    );
    return () => registerFooter(item.id, undefined);
  }, [registerFooter, inlineDescription, isHidden, descriptionText, item]);

  const checkIsFeatureAvailable = React.useCallback(() => {
    if (!isFeatureAvailable) return false;
    if (isFeatureAvailable && !isFeatureAvailable?.isAllowed) {
      // VeyraN does not sell or manage a Notesnook subscription, so this is
      // reported honestly instead of opening the purchase sheet — see
      // artifacts/veyran-brand-entitlement-audit.md.
      ToastManager.show({
        message: isFeatureAvailable.error,
        type: "info"
      });
      return false;
    }

    return true;
  }, [isFeatureAvailable]);

  return isHidden ? null : (
    <Pressable
      testID={item.id}
      disabled={item.type === "component"}
      style={{
        width: "100%",
        alignItems: "center",
        padding: visual.ios ? 0 : DefaultAppStyles.GAP,
        paddingLeft: visual.ios ? 16 : DefaultAppStyles.GAP,
        paddingRight: visual.ios ? 16 : DefaultAppStyles.GAP,
        flexDirection: "row",
        justifyContent: "space-between",
        paddingVertical: visual.ios ? 9 : DefaultAppStyles.GAP,
        minHeight: visual.ios ? 48 : undefined,
        borderRadius: 0,
        overflow: "hidden",
        ...(visual.ios && !last
          ? { borderBottomWidth: 0.5, borderBottomColor: visual.separator }
          : {}),
        ...styles
      }}
      onPress={async () => {
        if (!checkIsFeatureAvailable()) return;
        if (isDisabled) return;
        if (loading) return;
        switch (item.type) {
          case "screen":
            {
              if (item.onVerify && !(await item.onVerify())) return;
              navigation.dispatch(StackActions.push("SettingsGroup", item));
              useNavigationStore.getState().update("Settings");
            }
            break;
          case "switch":
            {
              onChangeSettings();
            }
            break;
          default:
            {
              if (item.onVerify && !(await item.onVerify())) return;
              if (item.modifer && item.showActionProgress) {
                setLoading(true);
                try {
                  await item.modifer(current);
                } finally {
                  setLoading(false);
                }
              } else {
                item.modifer?.(current);
              }
            }
            break;
        }
      }}
    >
      {!isFeatureAvailable?.isAllowed ? (
        <View
          style={{
            width: 35,
            height: 35,
            borderRadius: 100,
            backgroundColor: colors.primary.accent,
            justifyContent: "center",
            alignItems: "center",
            position: "absolute",
            bottom: -8,
            right: -8
          }}
        >
          <AppIcon
            color={colors.static.orange}
            size={AppFontSize.md}
            name="crown"
          />
        </View>
      ) : null}
      <View
        style={{
          flexDirection: "row",
          flexShrink: 1
        }}
      >
        {visual.ios ? (
          <View style={{ marginRight: 14, justifyContent: "center" }}>
            <SymbolTile symbol={iosSymbol} color={systemColor(iosTint, isDark)} />
          </View>
        ) : (
        <View
          style={{
            width: 40,
            height: 40,
            justifyContent: "center",
            alignItems: "center",
            marginRight: 12,
            backgroundColor:
              item.component === "colorpicker"
                ? colors.primary.accent
                : undefined,
            borderRadius: 100
          }}
        >
          {!!item.icon && (
            <AppIcon
              color={
                item.type === "danger"
                  ? colors.error.icon
                  : colors.secondary.icon
              }
              iconFamily={item.iconFamily}
              name={item.icon}
              size={item.iconSize || 30}
            />
          )}
        </View>
        )}

        <View
          style={{
            flexShrink: 1,
            paddingRight: item.type === "switch" ? 10 : 0,
            flex: item.type === "component" ? 1 : 0
          }}
        >
          {item.name && visual.ios ? (
            <Text
              style={{
                fontSize: 17,
                color:
                  item.type === "danger"
                    ? systemColor("red", isDark)
                    : colors.primary.heading
              }}
            >
              {typeof item.name === "function" ? item.name(current) : item.name}
            </Text>
          ) : item.name ? (
            <Heading
              color={
                item.type === "danger"
                  ? colors.error.paragraph
                  : colors.primary.heading
              }
              size={AppFontSize.sm}
            >
              {typeof item.name === "function" ? item.name(current) : item.name}
            </Heading>
          ) : null}

          {!!item.description && inlineDescription && (
            <Paragraph
              color={
                item.type === "danger"
                  ? colors.error.paragraph
                  : colors.primary.paragraph
              }
              size={AppFontSize.sm}
            >
              {typeof item.description === "function"
                ? item.description(current)
                : item.description}
            </Paragraph>
          )}

          {!!item.component && item.type !== "screen" && (
            <>
              <Seperator half />
              {components[item.component]}
            </>
          )}

          {item.type === "input" && (
            <Input
              {...item.inputProperties}
              onSubmit={(e) => {
                SettingsService.set({
                  [item.property as string]: e.nativeEvent.text
                });
                item.inputProperties?.onSubmitEditing?.(e);
              }}
              editable={!isDisabled}
              onChangeText={(text) => {
                SettingsService.set({
                  [item.property as string]: text
                });
                item.inputProperties?.onSubmitEditing?.(text as any);
              }}
              containerStyle={{ marginTop: DefaultAppStyles.GAP_VERTICAL }}
              fwdRef={inputRef}
              onLayout={() => {
                inputRef?.current?.setNativeProps({
                  text:
                    SettingsService.get()[
                      item.property as keyof SettingStore["settings"]
                    ] + ""
                });
              }}
              defaultValue={item.inputProperties?.defaultValue}
            />
          )}

          {item.type === "input-selector" && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                marginTop: DefaultAppStyles.GAP_VERTICAL
              }}
            >
              <IconButton
                name="minus"
                color={colors.primary.icon}
                onPress={() => {
                  if (!checkIsFeatureAvailable()) return;
                  if (isDisabled) return;
                  const rawValue = SettingsService.get()[
                    item.property as keyof SettingStore["settings"]
                  ] as string;
                  if (rawValue) {
                    const currentValue = parseInt(rawValue);
                    const minValue = item.minInputValue || 0;
                    if (currentValue <= minValue) return;
                    const nextValue = currentValue - 1;
                    SettingsService.set({
                      [item.property as string]: nextValue
                    });
                    updateInput(nextValue);
                  }
                }}
                size={AppFontSize.xl}
              />
              <Input
                {...item.inputProperties}
                onSubmit={(e) => {
                  onChangeInputSelectorValue(e.nativeEvent.text);
                  item.inputProperties?.onSubmitEditing?.(e);
                }}
                editable={!isDisabled}
                onChangeText={(text) => {
                  onChangeInputSelectorValue(text);
                  item.inputProperties?.onSubmitEditing?.(text as any);
                }}
                keyboardType="decimal-pad"
                containerStyle={{
                  width: 60
                }}
                inputStyle={{
                  width: 60,
                  textAlign: "center"
                }}
                wrapperStyle={{
                  maxWidth: 60,
                  flexGrow: 0,
                  marginBottom: 0,
                  marginHorizontal: DefaultAppStyles.GAP_SMALL
                }}
                fwdRef={inputRef}
                onLayout={() => {
                  if (item.property) {
                    updateInput(SettingsService.get()[item.property]);
                  }
                }}
                defaultValue={item.inputProperties?.defaultValue}
              />
              <IconButton
                name="plus"
                color={colors.primary.icon}
                onPress={() => {
                  if (!checkIsFeatureAvailable()) return;
                  if (isDisabled) return;
                  const rawValue = SettingsService.get()[
                    item.property as keyof SettingStore["settings"]
                  ] as string;
                  if (rawValue) {
                    const currentValue = parseInt(rawValue);
                    const max = item.maxInputValue || 0;
                    if (currentValue >= max) return;
                    const nextValue = currentValue + 1;
                    SettingsService.set({
                      [item.property as string]: nextValue
                    });
                    updateInput(nextValue);
                  }
                }}
                size={AppFontSize.xl}
              />
            </View>
          )}
        </View>
      </View>

      {visual.ios && item.value ? (
        <Text
          numberOfLines={1}
          style={{
            color: visual.secondaryText,
            fontSize: 17,
            marginLeft: 8,
            flexShrink: 1
          }}
        >
          {item.value(current)}
        </Text>
      ) : null}

      {visual.ios && item.type === "screen" ? (
        <TaskSymbolView
          name="chevron.right"
          size={13}
          color={visual.tertiaryText}
        />
      ) : null}

      {item.type === "switch" && !loading && visual.ios ? (
        <Switch
          value={
            !!(item.getter
              ? item.getter(item.property || current)
              : settings[item?.property as never])
          }
          onValueChange={onChangeSettings}
          disabled={!!isDisabled}
          trackColor={{ true: colors.primary.accent }}
          accessibilityLabel={
            typeof item.name === "function" ? item.name(current) : item.name
          }
        />
      ) : null}

      {item.type === "switch" && !loading && !visual.ios && (
        <ToggleSwitch
          isOn={
            item.getter
              ? item.getter(item.property || current)
              : settings[item?.property as never]
          }
          onColor={colors.primary.accent}
          offColor={colors.primary.icon}
          size="small"
          animationSpeed={150}
          onToggle={onChangeSettings}
        />
      )}

      {loading ? (
        <ActivityIndicator
          size={AppFontSize.xxl}
          color={colors.primary.accent}
        />
      ) : null}
    </Pressable>
  );
};
export const SectionItem = React.memo(_SectionItem, () => true);
