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
import { LegendList } from "@legendapp/list";
import { i18n } from "@lingui/core";
import { strings } from "@notesnook/intl";
import {
  ThemeDefinition,
  getPreviewColors,
  getThemePresentation,
  useThemeColors,
  validateTheme
} from "@notesnook/theme";
import type {
  CompiledThemeDefinition,
  ThemeMetadata
} from "@notesnook/themes-server";
import { keepLocalCopy, pick } from "@react-native-documents/picker";
import React, { useRef, useState } from "react";
import {
  Linking,
  StyleSheet,
  TouchableOpacity,
  View,
  useWindowDimensions
} from "react-native";
import ReactNativeBlobUtil from "react-native-blob-util";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";
import { DatabaseLogger } from "../../common/database";
import { santizeUri } from "../../common/filesystem/utils";
import SheetProvider from "../../components/sheet-provider";
import { Button } from "../../components/ui/button";
import { IconButton } from "../../components/ui/icon-button";
import Input from "../../components/ui/input";
import { Pressable } from "../../components/ui/pressable";
import Heading from "../../components/ui/typography/heading";
import Paragraph from "../../components/ui/typography/paragraph";
import { ToastManager, presentSheet } from "../../services/event-manager";
import { useThemeStore } from "../../stores/use-theme-store";
import { getColorLinearShade } from "../../utils/colors";
import { getElevationStyle } from "../../utils/elevation";
import { MenuItemsList } from "../../utils/menu-items";
import { AppFontSize, defaultBorderRadius } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import Clipboard from "@react-native-clipboard/clipboard";
import {
  BUILT_IN_THEMES_BY_ID,
  visibleLocalThemes
} from "../../utils/veyran-theme-migration";
import {
  ACCENT_CHOICES,
  accentChoiceAccessibilityLabel,
  accentPaletteHeading,
  accentSwatchColor,
  contrastForeground,
  currentLocale,
  resolveAccentChoiceId
} from "../../utils/accent-theme";

/**
 * The locale the palette renders in.
 *
 * The app's own translation locale wins whenever a catalogue is actually
 * loaded. The bundled catalogue ships English only, so the device locale (the
 * same source the Mac note dates use) is what makes a German person see German
 * instead of the untranslated source string.
 */
function paletteLocale(): string {
  const active = i18n.locale;
  if (active && !active.toLowerCase().startsWith("en")) return active;
  return currentLocale();
}

/**
 * The accent palette.
 *
 * It is deliberately separate from the theme list below: the theme is *what*
 * the app looks like, the accent is the one brand color layered on top of it.
 * A pick here recolors the entire app through the theme engine and is written
 * to the existing settings blob, so it survives relaunch, a reset and a
 * light/dark or theme switch. The theme definition itself is never edited, so
 * "Theme color" (and an imported theme's own colors) stay exactly as authored.
 */
const SWATCH_SIZE = 30;
const SWATCH_PADDING = DefaultAppStyles.GAP_SMALL;

/**
 * Where the popover hangs, measured against the Themes screen itself.
 *
 * The screen is presented inside an iOS Settings sheet. There `measureInWindow`
 * reports coordinates in the presented screen's own space, while a React
 * Native `Modal` renders into a separate window-rooted, full-screen hierarchy;
 * the difference between the two -- the sheet's top inset -- is exactly what
 * used to place the popover above its trigger. Nothing below ever leaves the
 * screen's view tree, so there is only one coordinate space and the popover
 * lands directly under the trigger on iPhone and iPad, portrait or landscape.
 */
type AccentAnchor = { x: number; y: number; width: number; height: number };

const COLLAPSED_ACCENT_ANCHOR: AccentAnchor = {
  x: 0,
  y: 0,
  width: 0,
  height: 0
};

/**
 * The popover's width: seven 30pt color-only swatches, their gaps and the
 * surrounding padding.
 */
const ACCENT_POPOVER_WIDTH =
  ACCENT_CHOICES.length * SWATCH_SIZE +
  (ACCENT_CHOICES.length - 1) * DefaultAppStyles.GAP_SMALL +
  SWATCH_PADDING * 2;

/**
 * The palette trigger: the color currently in effect, with a chevron.
 *
 * It is deliberately small. The seven swatches live in `AccentSwatchPopover`,
 * which the screen renders as its own last child so it can hang over the theme
 * search without taking any layout space. The trigger keeps none of that
 * state: it publishes its view through `triggerRef` and toggles through
 * `onToggle`.
 */
function AccentPalette({
  open,
  triggerRef,
  onToggle
}: {
  open: boolean;
  triggerRef: React.RefObject<View | null>;
  onToggle: () => void;
}) {
  const accentColor = useThemeStore((state) => state.accentColor);
  const baseDarkTheme = useThemeStore((state) => state.baseDarkTheme);
  const baseLightTheme = useThemeStore((state) => state.baseLightTheme);
  const scheme = useThemeStore((state) => state.colorScheme);
  const { colors } = useThemeColors();

  const activeTheme = scheme === "dark" ? baseDarkTheme : baseLightTheme;
  const resolved = resolveAccentChoiceId(accentColor, activeTheme);
  const locale = paletteLocale();

  const selectedChoice =
    ACCENT_CHOICES.find((choice) => choice.id === resolved) ??
    ACCENT_CHOICES[0];
  const currentSwatch = accentSwatchColor(selectedChoice, activeTheme);

  return (
    <View
      style={{
        marginBottom: DefaultAppStyles.GAP_VERTICAL,
        paddingHorizontal: DefaultAppStyles.GAP,
        marginTop: DefaultAppStyles.GAP_VERTICAL
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between"
        }}
      >
        <Paragraph size={AppFontSize.xs} color={colors.secondary.paragraph}>
          {accentPaletteHeading(locale)}
        </Paragraph>
        <View ref={triggerRef} collapsable={false}>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={onToggle}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={accentChoiceAccessibilityLabel(
              resolved,
              activeTheme,
              locale
            )}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: DefaultAppStyles.GAP_VERTICAL_SMALL,
              paddingLeft: 5,
              paddingRight: DefaultAppStyles.GAP_VERTICAL_SMALL,
              paddingVertical: 3,
              borderRadius: 100,
              borderWidth: 1,
              borderColor: colors.primary.border,
              backgroundColor: colors.secondary.background
            }}
          >
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                backgroundColor: currentSwatch,
                borderWidth: 1,
                borderColor: colors.primary.border
              }}
            />
            <Icon
              name="chevron-down"
              size={16}
              color={colors.secondary.paragraph}
            />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

/**
 * The accent popover: an outside-tap backdrop plus the seven swatches, hung
 * under the trigger.
 *
 * It is rendered inside the Themes screen -- never inside a `Modal` -- so the
 * `anchor` the screen measured with `measureLayout` is already in this view's
 * coordinate space. No color names are drawn; the localized names survive as
 * accessibility labels only. Picking a swatch writes through the theme store,
 * so the choice persists exactly as before.
 */
function AccentSwatchPopover({
  anchor,
  onDismiss
}: {
  anchor: AccentAnchor;
  onDismiss: () => void;
}) {
  const accentColor = useThemeStore((state) => state.accentColor);
  const baseDarkTheme = useThemeStore((state) => state.baseDarkTheme);
  const baseLightTheme = useThemeStore((state) => state.baseLightTheme);
  const scheme = useThemeStore((state) => state.colorScheme);
  const { colors } = useThemeColors();
  const windowWidth = useWindowDimensions().width;

  const activeTheme = scheme === "dark" ? baseDarkTheme : baseLightTheme;
  const resolved = resolveAccentChoiceId(accentColor, activeTheme);
  const locale = paletteLocale();

  /**
   * The popover is right-aligned under the trigger (which itself is right
   * aligned), clamped to the screen so the seven swatches still fit on a
   * narrow iPhone without running off the edge.
   */
  const popoverLeft = Math.max(
    SWATCH_PADDING,
    Math.min(
      anchor.x + anchor.width - ACCENT_POPOVER_WIDTH,
      windowWidth - ACCENT_POPOVER_WIDTH - SWATCH_PADDING
    )
  );

  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <TouchableOpacity
        accessible={false}
        activeOpacity={1}
        onPress={onDismiss}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={{
          position: "absolute",
          left: popoverLeft,
          // Directly below the trigger, with a small gap: both numbers come
          // from the same measurement, so this holds whatever the presenting
          // sheet does.
          top: anchor.y + anchor.height + DefaultAppStyles.GAP_SMALL,
          flexDirection: "row",
          alignItems: "center",
          gap: DefaultAppStyles.GAP_SMALL,
          paddingHorizontal: SWATCH_PADDING,
          paddingVertical: DefaultAppStyles.GAP_VERTICAL_SMALL,
          borderRadius: defaultBorderRadius,
          borderWidth: 1,
          borderColor: colors.primary.border,
          backgroundColor: colors.secondary.background,
          ...getElevationStyle(4)
        }}
      >
        {ACCENT_CHOICES.map((choice) => {
          const isSelected = resolved === choice.id;
          const swatch = accentSwatchColor(choice, activeTheme);
          return (
            <TouchableOpacity
              key={choice.id}
              onPress={() => {
                useThemeStore.getState().setAccentColor(choice.id);
                onDismiss();
              }}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={accentChoiceAccessibilityLabel(
                choice.id,
                activeTheme,
                locale
              )}
              style={{
                width: SWATCH_SIZE,
                height: SWATCH_SIZE,
                alignItems: "center",
                justifyContent: "center"
              }}
            >
              <View
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  backgroundColor: swatch,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: isSelected ? 2 : 0,
                  borderColor: colors.primary.heading
                }}
              >
                {isSelected ? (
                  <Icon
                    name="check"
                    size={15}
                    color={contrastForeground(swatch)}
                  />
                ) : null}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function ThemeSelector() {
  // The list and the "applied" checks use the user's own theme definitions,
  // never the accent-applied copies, so re-applying a theme can never bake the
  // current palette color into what gets persisted.
  const [baseDarkTheme, baseLightTheme] = useThemeStore((state) => [
    state.baseDarkTheme,
    state.baseLightTheme
  ]);

  const { colors } = useThemeColors();
  const themeColors = colors;
  const [searchQuery, setSearchQuery] = useState<string>();
  const [colorScheme, setColorScheme] = useState<"all" | "dark" | "light">(
    "all"
  );

  /**
   * The accent popover is positioned and rendered by this screen, not by the
   * trigger's own subtree: the screen is the common ancestor of the trigger and
   * of the overlay, which is what lets the two share a coordinate space (see
   * `AccentAnchor`).
   */
  const screenRef = useRef<View | null>(null);
  const accentTriggerRef = useRef<View | null>(null);
  const [accentPopover, setAccentPopover] = useState<{
    open: boolean;
    anchor: AccentAnchor;
  }>({ open: false, anchor: COLLAPSED_ACCENT_ANCHOR });

  const closeAccentPopover = () => {
    setAccentPopover((state) => ({ ...state, open: false }));
  };

  /**
   * Measures the trigger against the screen with `measureLayout` and opens the
   * popover from that rect. Both the trigger and the popover live in the
   * screen's view tree, so there is exactly one coordinate space, and the
   * popover lands with a small gap under the trigger on iPhone and iPad,
   * portrait or landscape, regardless of how the OS presents Settings.
   */
  const toggleAccentPopover = () => {
    if (accentPopover.open) {
      closeAccentPopover();
      return;
    }
    const screen = screenRef.current;
    const trigger = accentTriggerRef.current;
    if (!screen || !trigger) return;
    trigger.measureLayout(
      screen,
      (x, y, width, height) => {
        setAccentPopover({ open: true, anchor: { x, y, width, height } });
      },
      () => {
        // Not expected: the trigger is a non-collapsed native view. Keep the
        // popover reachable rather than swallowing the tap.
        setAccentPopover((state) => ({ ...state, open: true }));
      }
    );
  };

  const select = (item: Partial<ThemeMetadata>) => {
    presentSheet({
      context: "theme-details",
      component: (ref, close) => <ThemeSetter close={close} theme={item} />
    });
  };

  const renderItem = React.useCallback(
    ({ item, index }: { item: ThemeMetadata; index: number }) => {
      const presentation = getThemePresentation(item);
      const colors =
        item.previewColors ||
        getPreviewColors(item as unknown as ThemeDefinition);

      return (
        <>
          <TouchableOpacity
            activeOpacity={0.9}
            style={{
              borderRadius: 10,
              padding: DefaultAppStyles.GAP_SMALL,
              marginBottom: DefaultAppStyles.GAP_VERTICAL,
              flexShrink: 1,
              marginHorizontal: 10
            }}
            onPress={() => select(item)}
          >
            <View
              style={{
                backgroundColor: colors?.background,
                height: 200,
                width: "100%",
                borderRadius: 10,
                marginBottom: DefaultAppStyles.GAP_VERTICAL,
                overflow: "hidden",
                flexDirection: "row",
                justifyContent: "space-between",
                ...getElevationStyle(3)
              }}
            >
              <View
                style={{
                  height: "100%",
                  width: "49.5%",
                  backgroundColor: colors.navigationMenu.background,
                  padding: DefaultAppStyles.GAP_SMALL,
                  paddingVertical: 3,
                  borderRadius: defaultBorderRadius
                }}
              >
                {MenuItemsList.map((item, index) => (
                  <View
                    key={item.id}
                    style={{
                      height: 12,
                      width: "100%",
                      backgroundColor:
                        index === 0
                          ? colors.navigationMenu.accent + 40
                          : colors.navigationMenu.background,
                      borderRadius: 2,
                      paddingHorizontal: 3,
                      flexDirection: "row",
                      alignItems: "center",
                      marginBottom: 4
                    }}
                  >
                    <Icon
                      size={8}
                      name={item.icon}
                      color={
                        index === 0
                          ? colors.navigationMenu.accent
                          : colors.navigationMenu.icon
                      }
                    />

                    <View
                      style={{
                        height: 3,
                        width: "40%",
                        backgroundColor:
                          index === 0
                            ? colors.navigationMenu.accent
                            : colors.paragraph,
                        borderRadius: 2,
                        marginLeft: 3
                      }}
                    ></View>
                  </View>
                ))}
              </View>

              <View
                style={{
                  height: "100%",
                  width: "49.5%",
                  backgroundColor: colors.list.background,
                  borderRadius: defaultBorderRadius,
                  paddingHorizontal: 2,
                  paddingRight: 6
                }}
              >
                <View
                  style={{
                    height: 12,
                    width: "100%",
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: 3
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center"
                    }}
                  >
                    <Icon size={8} color={colors.list.heading} name="menu" />
                    <Heading
                      style={{
                        marginLeft: 3
                      }}
                      color={colors.list.heading}
                      size={7}
                    >
                      {strings.dataTypesPluralCamelCase.note()}
                    </Heading>
                  </View>

                  <Icon name="magnify" color={colors.list.heading} size={7} />
                </View>
              </View>

              <View
                style={{
                  width: "100%",
                  alignItems: "flex-end",
                  justifyContent: "flex-end",
                  marginTop: DefaultAppStyles.GAP_VERTICAL_SMALL,
                  position: "absolute",
                  bottom: 6,
                  right: 6,
                  flexDirection: "row",
                  gap: 10
                }}
              >
                {baseDarkTheme.id === item.id ||
                baseLightTheme.id === item.id ? (
                  <IconButton
                    name="check"
                    type="plain"
                    style={{
                      borderRadius: 100,
                      paddingHorizontal: 6,
                      alignSelf: "flex-end",
                      width: 25,
                      height: 25
                    }}
                    color={colors.accent}
                    size={16}
                  />
                ) : null}

                <Button
                  title={
                    item.colorScheme === "dark"
                      ? strings.dark()
                      : strings.light()
                  }
                  type="secondaryAccented"
                  height={25}
                  buttonType={{
                    color: item.colorScheme === "dark" ? "black" : "#f0f0f060",
                    text: colors.accent
                  }}
                  style={{
                    borderRadius: 100,
                    paddingHorizontal: DefaultAppStyles.GAP,
                    alignSelf: "flex-end",
                    borderColor:
                      item.colorScheme === "dark"
                        ? getColorLinearShade("#000000", 0.1, true)
                        : getColorLinearShade("#f0f0f0", 0.1, true)
                  }}
                  fontSize={AppFontSize.xxs}
                />
              </View>
            </View>

            <Heading size={AppFontSize.sm} color={themeColors.primary.heading}>
              {presentation.name}
            </Heading>
            {presentation.author ? (
              <Paragraph
                size={AppFontSize.xs}
                color={themeColors.secondary?.paragraph}
              >
                {strings.by()} {presentation.author}
              </Paragraph>
            ) : null}
          </TouchableOpacity>
        </>
      );
    },
    [
      baseDarkTheme.id,
      baseLightTheme.id,
      themeColors.primary.heading,
      themeColors.secondary?.paragraph
    ]
  );

  let resetTimer: NodeJS.Timeout;
  const onSearch = (text: string) => {
    clearTimeout(resetTimer as NodeJS.Timeout);
    resetTimer = setTimeout(() => {
      setSearchQuery(text);
    }, 400);
  };

  return (
    <>
      <SheetProvider context="theme-details" />
      <View
        ref={screenRef}
        collapsable={false}
        style={{
          flex: 1
        }}
      >
        <AccentPalette
          open={accentPopover.open}
          triggerRef={accentTriggerRef}
          onToggle={toggleAccentPopover}
        />
        <View
          style={{
            paddingHorizontal: DefaultAppStyles.GAP,
            marginBottom: DefaultAppStyles.GAP_VERTICAL,
            paddingTop: DefaultAppStyles.GAP_VERTICAL
          }}
        >
          <Input onChangeText={onSearch} placeholder={strings.searchThemes()} />

          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 10
            }}
          >
            <View
              style={{
                flexDirection: "row",
                gap: DefaultAppStyles.GAP_SMALL
              }}
            >
              <Button
                style={{
                  paddingVertical: DefaultAppStyles.GAP_VERTICAL_SMALL,
                  paddingHorizontal: DefaultAppStyles.GAP_SMALL
                }}
                type={
                  colorScheme === "all" || !colorScheme ? "accent" : "secondary"
                }
                title={strings.all()}
                fontSize={AppFontSize.xs}
                onPress={() => {
                  setColorScheme("all");
                }}
              />
              <Button
                style={{
                  paddingVertical: DefaultAppStyles.GAP_VERTICAL_SMALL,
                  paddingHorizontal: DefaultAppStyles.GAP_SMALL
                }}
                type={colorScheme === "dark" ? "accent" : "secondary"}
                title={strings.dark()}
                fontSize={AppFontSize.xs}
                onPress={() => {
                  setColorScheme("dark");
                }}
              />
              <Button
                style={{
                  paddingVertical: DefaultAppStyles.GAP_VERTICAL_SMALL,
                  paddingHorizontal: DefaultAppStyles.GAP_SMALL
                }}
                fontSize={AppFontSize.xs}
                type={colorScheme === "light" ? "accent" : "secondary"}
                title={strings.light()}
                onPress={() => {
                  setColorScheme("light");
                }}
              />
            </View>

            <Button
              title={strings.loadFromFile()}
              style={{
                paddingVertical: DefaultAppStyles.GAP_VERTICAL_SMALL,
                paddingHorizontal: DefaultAppStyles.GAP_SMALL
              }}
              type={"secondaryAccented"}
              icon="folder"
              fontSize={AppFontSize.xs}
              onPress={async () => {
                try {
                  const pickResponse = await pick({
                    allowMultiSelection: false
                  });
                  const copiedFile = await keepLocalCopy({
                    destination: "cachesDirectory",
                    files: [
                      {
                        uri: pickResponse[0].uri,
                        fileName: pickResponse[0].name || "theme.json"
                      }
                    ]
                  });
                  if (copiedFile[0].status !== "success") return;

                  const themeJsonCopiedPath = santizeUri(
                    copiedFile[0].localUri
                  );

                  const themeJson = await ReactNativeBlobUtil.fs.readFile(
                    themeJsonCopiedPath,
                    "utf8"
                  );
                  ReactNativeBlobUtil.fs
                    .unlink(themeJsonCopiedPath)
                    .catch(() => {});
                  let json;
                  try {
                    json = JSON.parse(themeJson);
                  } catch (e) {
                    ToastManager.show({
                      heading: strings.invalidThemeFileFormat(),
                      type: "error",
                      context: "global"
                    });
                    return;
                  }
                  const result = validateTheme(json);

                  if (result.error) {
                    if (
                      typeof result.error === "string" &&
                      result.error.includes("missing from the theme")
                    ) {
                      ToastManager.show({
                        heading: strings.themeMissingRequiredFields(),
                        type: "error",
                        context: "global",
                        actionText: strings.copyLogs(),
                        func: () => {
                          Clipboard.setString(result.error || "");
                          ToastManager.show({
                            heading: strings.logsCopied(),
                            type: "success",
                            context: "global"
                          });
                        }
                      });
                    } else {
                      ToastManager.error(new Error(result.error));
                    }

                    return;
                  }
                  select(json);
                } catch (e) {
                  if ((e as Error).message.includes("Code=3072")) {
                    return;
                  }
                  ToastManager.error(e as Error);
                }
              }}
            />
          </View>
        </View>

        <LegendList
          numColumns={2}
          data={
            visibleLocalThemes(
              baseDarkTheme,
              baseLightTheme,
              searchQuery,
              colorScheme
            ) as unknown as ThemeMetadata[]
          }
          ListEmptyComponent={
            <View
              style={{
                height: 100,
                width: "100%",
                justifyContent: "center",
                alignItems: "center"
              }}
            >
              {searchQuery ? (
                <Paragraph color={colors.secondary.paragraph}>
                  {strings.noResultsForSearch(searchQuery)}
                </Paragraph>
              ) : (
                <Paragraph>{strings.noThemesFound()}.</Paragraph>
              )}
            </View>
          }
          estimatedItemSize={200}
          renderItem={renderItem}
        />
        {accentPopover.open ? (
          <AccentSwatchPopover
            anchor={accentPopover.anchor}
            onDismiss={closeAccentPopover}
          />
        ) : null}
      </View>
    </>
  );
}

export default function ThemeSelectorScreen() {
  return <ThemeSelector />;
}

const ThemeSetter = ({
  theme,
  close
}: {
  theme: Partial<CompiledThemeDefinition>;
  close?: (ctx?: string) => void;
}) => {
  const presentation = getThemePresentation(theme);
  const homepage = presentation.homepage;
  const [baseDarkTheme, baseLightTheme] = useThemeStore((state) => [
    state.baseDarkTheme,
    state.baseLightTheme
  ]);
  const themeColors = useThemeColors();

  const colors =
    theme?.previewColors ||
    getPreviewColors(theme as unknown as ThemeDefinition);

  const applyTheme = async () => {
    if (!theme.id) return;
    try {
      // Bundled themes and imported custom themes are applied locally.
      const builtIn = BUILT_IN_THEMES_BY_ID.get(theme.id);
      const fullTheme = builtIn || (theme as ThemeDefinition);
      if (!fullTheme) return;
      theme.colorScheme === "dark"
        ? useThemeStore.getState().setDarkTheme(fullTheme)
        : useThemeStore.getState().setLightTheme(fullTheme);
      ToastManager.show({
        heading: `${presentation.name} applied successfully`,
        type: "success",
        context: "global"
      });
    } catch (e) {
      DatabaseLogger.error(e);
    }

    setTimeout(() => {
      close?.();
    });
  };

  return (
    <>
      <View
        style={{
          paddingHorizontal: DefaultAppStyles.GAP
        }}
      >
        <View
          style={{
            borderRadius: 10,
            marginBottom: DefaultAppStyles.GAP_VERTICAL,
            paddingHorizontal: DefaultAppStyles.GAP,
            paddingVertical: DefaultAppStyles.GAP_VERTICAL
          }}
        >
          <View
            style={{
              width: "100%",
              justifyContent: "center",
              alignItems: "center",
              backgroundColor: colors?.accent + "20",
              padding: DefaultAppStyles.GAP,
              borderRadius: 15,
              marginBottom: DefaultAppStyles.GAP_VERTICAL
            }}
          >
            <View
              style={{
                backgroundColor: colors?.background,
                borderWidth: 0.5,
                borderColor: colors?.border,
                height: 200,
                width: "100%",
                borderRadius: 10,
                marginBottom: DefaultAppStyles.GAP_VERTICAL,
                overflow: "hidden",
                flexDirection: "row",
                justifyContent: "space-between",
                ...getElevationStyle(3),
                maxWidth: 200
              }}
            >
              <View
                style={{
                  height: "100%",
                  width: "49.5%",
                  backgroundColor: colors?.navigationMenu.background,
                  padding: DefaultAppStyles.GAP_SMALL,
                  paddingVertical: 3,
                  borderRadius: defaultBorderRadius
                }}
              >
                {MenuItemsList.map((item, index) => (
                  <View
                    key={item.id}
                    style={{
                      height: 12,
                      width: "100%",
                      backgroundColor:
                        index === 0
                          ? //@ts-ignore
                            colors?.navigationMenu?.accent + 40
                          : colors?.navigationMenu.background,
                      borderRadius: 2,
                      paddingHorizontal: 3,
                      flexDirection: "row",
                      alignItems: "center",
                      marginBottom: 4
                    }}
                  >
                    <Icon
                      size={8}
                      name={item.icon}
                      color={
                        index === 0
                          ? colors?.navigationMenu.accent
                          : colors?.navigationMenu.icon
                      }
                    />

                    <View
                      style={{
                        height: 3,
                        width: "40%",
                        backgroundColor:
                          index === 0
                            ? colors?.navigationMenu.accent
                            : colors?.paragraph,
                        borderRadius: 2,
                        marginLeft: 3
                      }}
                    ></View>
                  </View>
                ))}
              </View>

              <View
                style={{
                  height: "100%",
                  width: "49.5%",
                  backgroundColor: colors?.list.background,
                  borderRadius: defaultBorderRadius,
                  paddingHorizontal: 2,
                  paddingRight: 6
                }}
              >
                <View
                  style={{
                    height: 12,
                    width: "100%",
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: 3
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center"
                    }}
                  >
                    <Icon size={8} color={colors?.list.heading} name="menu" />
                    <Heading
                      style={{
                        marginLeft: 3
                      }}
                      color={colors?.list.heading}
                      size={7}
                    >
                      {strings.dataTypesPluralCamelCase.note()}
                    </Heading>
                  </View>

                  <Icon name="magnify" color={colors?.list.heading} size={7} />
                </View>
              </View>
            </View>
          </View>

          <Heading
            size={AppFontSize.md}
            color={themeColors.colors.primary.heading}
          >
            {presentation.name}
          </Heading>
          <Paragraph color={themeColors.colors.primary.paragraph}>
            {presentation.description}
          </Paragraph>

          {presentation.author ? (
            <Paragraph
              size={AppFontSize.xs}
              color={themeColors.colors.secondary.paragraph}
            >
              {strings.by()} {presentation.author}
            </Paragraph>
          ) : null}
          <View
            style={{
              marginTop: DefaultAppStyles.GAP_VERTICAL_SMALL,
              flexDirection: "column",
              rowGap: 3
            }}
          >
            <Paragraph
              size={AppFontSize.xs}
              color={themeColors.colors.secondary.paragraph}
            >
              ${strings.version()} {theme.version}
            </Paragraph>

            <Paragraph
              size={AppFontSize.xs}
              color={themeColors.colors.secondary.paragraph}
            >
              {theme.license}
            </Paragraph>

            {homepage ? (
              <View
                style={{
                  flexDirection: "row"
                }}
              >
                <Paragraph
                  size={AppFontSize.xs}
                  color={themeColors.colors.secondary.accent}
                  onPress={() => {
                    Linking.openURL(homepage);
                  }}
                >
                  {strings.visitHomePage()}
                </Paragraph>
              </View>
            ) : null}
          </View>
        </View>

        {baseDarkTheme.id === theme.id || baseLightTheme.id === theme.id ? (
          <Pressable
            onPress={applyTheme}
            type="accent"
            style={{
              paddingVertical: DefaultAppStyles.GAP_VERTICAL
            }}
          >
            <Heading color={colors.accentForeground} size={AppFontSize.md}>
              {baseDarkTheme.id === theme.id
                ? strings.appliedDark()
                : strings.appliedLight()}
            </Heading>
            <Paragraph color={colors.accentForeground} size={AppFontSize.xs}>
              ({strings.tapToApplyAgain()})
            </Paragraph>
          </Pressable>
        ) : (
          <Button
            style={{
              width: "100%",
              marginBottom: DefaultAppStyles.GAP_VERTICAL
            }}
            onPress={applyTheme}
            title={
              theme.colorScheme === "dark"
                ? strings.setAsDarkTheme()
                : strings.setAsLightTheme()
            }
            type="secondaryAccented"
          />
        )}
      </View>
    </>
  );
};
