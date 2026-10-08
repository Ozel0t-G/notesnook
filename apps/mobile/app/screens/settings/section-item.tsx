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
  StyleProp,
  Switch,
  Text,
  TextInput,
  View,
  ViewStyle
} from "react-native";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { SymbolTile } from "../../components/ui/symbol-tile";
import { isMacCatalyst } from "../../utils/constants";
import { systemColor } from "../../utils/ios-system-colors";
import { iosSettingSymbol, useSettingsFooter } from "./ios-appearance";
import {
  isFeatureAvailable as checkFeatureAvailability,
  useIsFeatureAvailable
} from "@notesnook/common";
import { strings } from "@notesnook/intl";
import { isFeatureDenied, resolveFeatureGate } from "./feature-gate";
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

/**
 * Purely decorative children of a row (the SF Symbol tile, the chevron) must
 * not become accessibility elements of their own: VoiceOver used to announce an
 * Appearance row as "format, Appearance, Forward" (the symbol's name first).
 */
function Decorative({
  children,
  style
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={style}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {children}
    </View>
  );
}

/**
 * Mac Catalyst draws React Native's `Switch` as a checkbox whose empty state
 * has no visible frame in the light theme (UIKit paints it from the window
 * background). Drawing it from the visual tokens keeps the frame visible in
 * both themes; the row itself carries the switch semantics, so the box is
 * decorative and inherits the row's vertical centering.
 */
function MacCheckbox({ value }: { value: boolean }) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  return (
    <View
      style={{
        width: 18,
        height: 18,
        marginLeft: 8,
        borderRadius: 4,
        borderWidth: 1.5,
        borderColor: value ? colors.primary.accent : visual.tertiaryText,
        backgroundColor: value ? colors.primary.accent : "transparent",
        alignItems: "center",
        justifyContent: "center"
      }}
    >
      {value ? (
        <TaskSymbolView
          name="checkmark"
          size={11}
          color={colors.static.white}
        />
      ) : null}
    </View>
  );
}

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
    : undefined;
  /**
   * `undefined` here means the async check has not resolved yet, which must
   * NOT be presented as denied (see feature-gate.ts): otherwise a
   * client-supported row flashes a crown/disabled state and drops its first
   * tap. Only a resolved "not allowed" disables the row or shows the crown.
   */
  const featureDenied = isFeatureDenied(isFeatureAvailable);
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
  /**
   * Serializes gated actions so a double tap landing while the feature check is
   * still awaiting cannot toggle twice or push the same screen twice.
   */
  const actionInFlight = useRef(false);

  const applyToggle = async () => {
    if (item.onVerify && !(await item.onVerify())) return;
    if (item.modifer) {
      setLoading(true);
      try {
        await item.modifer(item.property || current);
      } finally {
        setLoading(false);
      }
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

  /**
   * Runs a gated action only once the feature gate has *resolved* as allowed.
   * `checkIsFeatureAvailable` awaits a fresh check while the hook result is
   * still pending (see feature-gate.ts), so a quick tap can never enter an
   * unsupported backend feature before the check settles.
   */
  const runGatedAction = async (action: () => void | Promise<void>) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    try {
      if (!(await checkIsFeatureAvailable())) return;
      if (isDisabled) return;
      if (loading) return;
      await action();
    } finally {
      actionInFlight.current = false;
    }
  };

  const onChangeSettings = () => runGatedAction(applyToggle);

  const styles =
    item.type === "danger" && !visual.ios
      ? {
          backgroundColor: colors.error.background
        }
      : {};
  const [iosSymbol, iosTint] = iosSettingSymbol(item.id);
  const isMac = isMacCatalyst();
  /** The row's name, resolved once for both the label and the row text. */
  const itemName =
    typeof item.name === "function" ? item.name(current) : item.name;
  const switchValue = !!(item.getter
    ? item.getter(item.property || current)
    : settings[item?.property as never]);
  /**
   * Only real actions become buttons: an input, picker or component row keeps
   * its own controls and must not be swallowed by a button role.
   */
  const accessibilityRole =
    item.type === "switch"
      ? ("switch" as const)
      : item.type === "screen" ||
        item.type === "danger" ||
        (!item.type && !!item.modifer)
      ? ("button" as const)
      : undefined;

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
      featureDenied ||
        (item.disabled && item.disabled(item.property || current))
    );
  }, [current, item, itemProperty, featureDenied]);

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

  /**
   * Resolves the row's feature gate at action time. While the hook result is
   * still pending this awaits a fresh check instead of failing open, so a quick
   * tap can never enter an unsupported backend feature before the check
   * settles. A resolved denial is refused with an honest toast: VeyraN does not
   * sell or manage a Notesnook subscription, so we never open the purchase
   * sheet — see artifacts/veyran-brand-entitlement-audit.md.
   */
  const checkIsFeatureAvailable = async () => {
    const featureId = item.featureId;
    if (!featureId) return true;
    const resolution = await resolveFeatureGate(isFeatureAvailable, () =>
      checkFeatureAvailability(featureId)
    );
    if (resolution.gate === "denied") {
      ToastManager.show({
        message: resolution.error || strings.featureNotAvailable(),
        type: "info"
      });
      return false;
    }
    return true;
  };

  return isHidden ? null : (
    <Pressable
      testID={item.id}
      disabled={item.type === "component"}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityRole ? itemName : undefined}
      accessibilityState={
        item.type === "switch"
          ? { checked: switchValue, disabled: !!isDisabled }
          : isDisabled
          ? { disabled: true }
          : undefined
      }
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
      onPress={() =>
        runGatedAction(async () => {
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
                await applyToggle();
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
        })
      }
    >
      {featureDenied ? (
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
          <Decorative style={{ marginRight: 14, justifyContent: "center" }}>
            <SymbolTile
              symbol={iosSymbol}
              color={systemColor(iosTint, isDark)}
            />
          </Decorative>
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
              {itemName}
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
              {itemName}
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
                onPress={() =>
                  runGatedAction(() => {
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
                  })
                }
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
                onPress={() =>
                  runGatedAction(() => {
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
                  })
                }
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
        <Decorative>
          <TaskSymbolView
            name="chevron.right"
            size={13}
            color={visual.tertiaryText}
          />
        </Decorative>
      ) : null}

      {item.type === "switch" && !loading && visual.ios ? (
        isMac ? (
          <MacCheckbox value={switchValue} />
        ) : (
          // The row itself is the switch element (see accessibilityRole
          // above), so the control's own element is hidden.
          <Switch
            value={switchValue}
            onValueChange={onChangeSettings}
            disabled={!!isDisabled}
            trackColor={{ true: colors.primary.accent }}
            accessible={false}
            importantForAccessibility="no"
          />
        )
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
