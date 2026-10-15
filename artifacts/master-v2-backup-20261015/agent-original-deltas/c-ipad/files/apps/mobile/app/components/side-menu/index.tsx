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
import { View } from "react-native";
import { SideMenuHeader, SideMenuSettings } from "./side-menu-header";
import {
  IPadSourceSection,
  IPadSourceSymbol,
  isIPadSourceList
} from "./ipad-source-navigation";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";
import { db } from "../../common/database";
import { useGroupOptions } from "../../hooks/use-group-options";
import { presentSheet, ToastManager } from "../../services/event-manager";
import Navigation from "../../services/navigation";
import { useTagStore } from "../../stores/use-tag-store";
import { useThemeStore } from "../../stores/use-theme-store";
import { deleteItems } from "../../utils/functions";
import { AppFontSize } from "../../utils/size";
import { DefaultAppStyles } from "../../utils/styles";
import { presentDialog } from "../dialog/functions";
import { AddNotebookSheet } from "../sheets/add-notebook";
import Sort from "../sheets/sort";
import { IconButton, IconButtonProps } from "../ui/icon-button";
import { Pressable } from "../ui/pressable";
import Paragraph from "../ui/typography/paragraph";
import { SideMenuHome } from "./side-menu-home";
import { SideMenuNotebooks } from "./side-menu-notebooks";
import { SideMenuTags } from "./side-menu-tags";
import {
  useSideMenuNotebookSelectionStore,
  useSideMenuTagsSelectionStore
} from "./stores";
import { useSideBarDraggingStore } from "./dragging-store";
import { Button } from "../ui/button";
import SettingsService from "../../services/settings";
import { isFeatureAvailable } from "@notesnook/common";
import useGlobalSafeAreaInsets from "../../hooks/use-global-safe-area-insets";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { IPadPrimaryNavigationContext } from "../ipad-primary-navigation-context";
import { IPadPrimaryDestinations } from "../ipad-primary-destinations";

/**
 * Simple Tab View Implementation for the Side bar
 */
type SimpleRoute = {
  key: string;
  title?: string;
};

type SimpleNavigationState = {
  index: number;
  routes: SimpleRoute[];
};

type SimpleTabBarProps = {
  navigationState: SimpleNavigationState;
  jumpTo: (key: string) => void;
};

type SimpleTabViewProps = {
  navigationState: SimpleNavigationState;
  renderScene: ({ route }: { route: SimpleRoute }) => React.ReactNode;
  renderTabBar?: (props: SimpleTabBarProps) => React.ReactNode;
  onIndexChange?: (index: number) => void;
};

const createSceneMap = (
  scenes: Record<string, React.ComponentType<any>>
): ((props: { route: SimpleRoute }) => React.ReactNode) => {
  // eslint-disable-next-line react/display-name
  return ({ route }: { route: SimpleRoute }) => {
    const SceneComponent = scenes[route.key];
    if (!SceneComponent) return null;
    return <SceneComponent />;
  };
};

const SimpleTabView = ({
  navigationState,
  renderScene,
  renderTabBar,
  onIndexChange
}: SimpleTabViewProps) => {
  const loadedKeysRef = React.useRef(new Set<string>());
  const scenesRef = React.useRef(new Map<string, React.ReactNode>());
  const jumpTo = React.useCallback(
    (key: string) => {
      const nextIndex = navigationState.routes.findIndex(
        (route) => route.key === key
      );
      if (nextIndex !== -1 && nextIndex !== navigationState.index) {
        onIndexChange?.(nextIndex);
      }
    },
    [navigationState.index, navigationState.routes, onIndexChange]
  );

  const activeKey = navigationState.routes[navigationState.index]?.key;
  if (activeKey && !loadedKeysRef.current.has(activeKey)) {
    loadedKeysRef.current.add(activeKey);
  }

  const getSceneForRoute = React.useCallback(
    (route: SimpleRoute) => {
      const cached = scenesRef.current.get(route.key);
      if (cached) return cached;
      const created = renderScene({ route });
      scenesRef.current.set(route.key, created);
      return created;
    },
    [renderScene]
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {navigationState.routes.map((route, routeIndex) => (
          <View
            key={route.key}
            style={{
              flex: 1,
              display: navigationState.index === routeIndex ? "flex" : "none"
            }}
          >
            {loadedKeysRef.current.has(route.key)
              ? getSceneForRoute(route)
              : navigationState.index === routeIndex
              ? getSceneForRoute(route)
              : null}
          </View>
        ))}
      </View>

      {renderTabBar ? renderTabBar({ navigationState, jumpTo }) : null}
    </View>
  );
};

const renderScene = createSceneMap({
  home: SideMenuHome,
  notebooks: SideMenuNotebooks,
  tags: SideMenuTags,
  settings: () => null
});

export const SideMenu = React.memo(
  function SideMenu() {
    const { colors, isDark } = useThemeColors();
    const visual = getAppleVisualTokens(colors, isDark);
    const insets = useGlobalSafeAreaInsets();
    const ipadSources = isIPadSourceList();
    const primaryNavigation = React.useContext(IPadPrimaryNavigationContext);
    const [index, setIndex] = React.useState(
      SettingsService.getProperty("defaultSidebarTab")
    );
    const [routes] = React.useState<SimpleRoute[]>([
      {
        key: "home",
        title: "Home"
      },
      {
        key: "notebooks",
        title: "Notebooks"
      },
      {
        key: "tags",
        title: "Tags"
      }
    ]);

    return (
      <View
        style={{
          flex: 1,
          backgroundColor: visual.sidebarBackground,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left
        }}
      >
        {ipadSources ? (
          <>
            <SideMenuHeader compact />
            {primaryNavigation ? (
              <IPadPrimaryDestinations {...primaryNavigation} />
            ) : null}
            <IPadSources index={index} onIndexChange={setIndex} />
            <TabBar
              navigationState={{ index, routes }}
              jumpTo={(key) =>
                setIndex(routes.findIndex((route) => route.key === key))
              }
            />
          </>
        ) : (
          <SimpleTabView
            navigationState={{ index, routes }}
            renderTabBar={(props) => <TabBar {...props} />}
            renderScene={renderScene}
            onIndexChange={setIndex}
          />
        )}
      </View>
    );
  },
  () => true
);

const TabBar = (props: SimpleTabBarProps) => {
  const dragging = useSideBarDraggingStore((state) => state.dragging);
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const groupOptions = useGroupOptions(
    props.navigationState.index === 1 ? "notebooks" : "tags"
  );
  const notebookSelectionEnabled = useSideMenuNotebookSelectionStore(
    (state) => state.enabled
  );
  const tagSelectionEnabled = useSideMenuTagsSelectionStore(
    (state) => state.enabled
  );
  const isSelectionEnabled = notebookSelectionEnabled || tagSelectionEnabled;
  const ipadSources = isIPadSourceList();
  const compactFooter = ipadSources && !isSelectionEnabled && !dragging;

  const getIcon = (key: string) => {
    switch (key) {
      case "home":
        return "home-outline";
      case "notebooks":
        return "book-outline";
      case "tags":
        return "pound";
      default:
        return "home-outline";
    }
  };

  return (
    <>
      <View
        testID={compactFooter ? "ipad-sidebar-footer" : undefined}
        style={{
          flexDirection: "row",
          width: "100%",
          justifyContent: "space-between",
          backgroundColor: visual.navigationSurface,
          paddingHorizontal: compactFooter
            ? DefaultAppStyles.GAP_SMALL
            : DefaultAppStyles.GAP,
          paddingVertical: compactFooter
            ? 0
            : visual.ios
            ? 10
            : DefaultAppStyles.GAP_SMALL,
          alignItems: compactFooter ? "center" : undefined,
          gap: compactFooter ? DefaultAppStyles.GAP_SMALL : undefined,
          borderTopWidth: visual.ios ? 0.5 : 1,
          borderTopColor: visual.separator
        }}
      >
        {compactFooter ? <SideMenuSettings labeled compact /> : null}
        {isSelectionEnabled ? (
          <>
            {[
              {
                title: "Select all",
                icon: "check-all"
              },
              {
                title: "Delete",
                icon: "delete"
              },
              {
                title: "Move",
                icon: "arrow-right-bold-box-outline",
                hidden:
                  !notebookSelectionEnabled ||
                  (props.navigationState.index !== 1 &&
                    !(isIPadSourceList() && props.navigationState.index === 0))
              },
              {
                title: "Close",
                icon: "close"
              }
            ].map((item) =>
              item.hidden ? null : (
                <>
                  <Pressable
                    key={item.title}
                    onPress={async () => {
                      switch (item.title) {
                        case "Select all": {
                          if (notebookSelectionEnabled) {
                            useSideMenuNotebookSelectionStore
                              .getState()
                              .selectAll?.();
                          } else {
                            useSideMenuTagsSelectionStore
                              .getState()
                              .selectAll?.();
                          }

                          break;
                        }
                        case "Delete": {
                          if (notebookSelectionEnabled) {
                            const ids = useSideMenuNotebookSelectionStore
                              .getState()
                              .getSelectedItemIds();
                            deleteItems("notebook", ids);
                          } else {
                            const ids = useSideMenuTagsSelectionStore
                              .getState()
                              .getSelectedItemIds();
                            await deleteItems("tag", ids);
                          }
                          break;
                        }
                        case "Move": {
                          const ids = useSideMenuNotebookSelectionStore
                            .getState()
                            .getSelectedItemIds();
                          if (!ids.length) {
                            ToastManager.show({
                              context: "local",
                              type: "error",
                              message: strings.noNotebooksSelectedToMove()
                            });
                            return;
                          }
                          const notebooks = await db.notebooks.all.items(ids);
                          Navigation.navigate("MoveNotebook", {
                            selectedNotebooks: notebooks
                          });
                          break;
                        }
                        case "Close": {
                          useSideMenuNotebookSelectionStore.setState({
                            enabled: false,
                            selection: {}
                          });
                          useSideMenuTagsSelectionStore.setState({
                            enabled: false,
                            selection: {}
                          });
                          break;
                        }
                      }
                    }}
                    style={{
                      borderRadius: 10,
                      paddingVertical: 2,
                      width: "25%"
                    }}
                    type="plain"
                  >
                    <Icon
                      name={item.icon}
                      color={colors.primary.icon}
                      size={AppFontSize.lg}
                    />
                    <Paragraph
                      color={colors.primary.paragraph}
                      size={AppFontSize.xxxs - 1}
                    >
                      {item.title}
                    </Paragraph>
                  </Pressable>
                </>
              )
            )}
          </>
        ) : (
          <>
            {dragging ? (
              <Button
                onPress={() => {
                  useSideBarDraggingStore.setState({
                    dragging: false
                  });
                }}
                style={{
                  width: "100%"
                }}
                type="accent"
                testID="check"
                title={strings.done()}
                icon={"check"}
                iconSize={AppFontSize.lg - 2}
              />
            ) : (
              <>
                {!ipadSources ? (
                  <View
                    style={{
                      flexDirection: "row",
                      gap: DefaultAppStyles.GAP_SMALL
                    }}
                  >
                    {(isIPadSourceList()
                      ? []
                      : props.navigationState.routes
                    ).map((route, index) => {
                      const isFocused = props.navigationState.index === index;

                      return (
                        <Pressable
                          key={route.key}
                          testID={`tab-${route.key}`}
                          onPress={() => {
                            props.jumpTo(route.key);
                            switch (route.key) {
                              case "notebooks":
                                Navigation.routeNeedsUpdate(
                                  "Notebooks",
                                  Navigation.routeUpdateFunctions.Notebooks
                                );
                                break;
                              case "tags":
                                Navigation.routeNeedsUpdate(
                                  "Tags",
                                  Navigation.routeUpdateFunctions.Tags
                                );
                                break;
                              default:
                                break;
                            }
                          }}
                          style={{
                            borderRadius: visual.ios
                              ? visual.controlRadius
                              : 10,
                            paddingVertical: 2,
                            width: 40,
                            height: 40
                          }}
                          type={isFocused ? "selected" : "plain"}
                        >
                          <Icon
                            name={getIcon(route.key)}
                            color={
                              isFocused
                                ? colors.selected.icon
                                : colors.primary.icon
                            }
                            size={AppFontSize.lg}
                          />
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: DefaultAppStyles.GAP_SMALL
                  }}
                >
                  {props.navigationState.index > 0 ? (
                    <>
                      {!isIPadSourceList() ||
                      props.navigationState.index === 2 ? (
                        <SidebarActionButton
                          iconOnly={ipadSources}
                          accessibilityLabel={
                            props.navigationState.index === 1
                              ? strings.addNotebook()
                              : strings.addTag()
                          }
                          name="plus"
                          testID="sidebar-add-button"
                          size={AppFontSize.lg - 2}
                          top={10}
                          color={colors.primary.icon}
                          onPress={async () => {
                            if (props.navigationState.index === 1) {
                              await presentNewNotebook();
                            } else {
                              const tagsFeature = await isFeatureAvailable(
                                "tags"
                              );
                              if (!tagsFeature.isAllowed) {
                                ToastManager.show({
                                  message: tagsFeature.error,
                                  type: "info"
                                });
                                return;
                              }
                              presentDialog({
                                title: strings.addTag(),
                                paragraph: strings.addTagDesc(),
                                input: true,
                                positiveText: "Add",
                                positivePress: async (tag) => {
                                  if (tag) {
                                    await db.tags.add({
                                      title: tag
                                    });
                                    useTagStore.getState().refresh();
                                    return true;
                                  }
                                  ToastManager.show({
                                    context: "local",
                                    type: "error",
                                    message: strings.allFieldsRequired()
                                  });
                                  return false;
                                }
                              });
                            }
                          }}
                          style={{
                            width: 35,
                            height: 35
                          }}
                        />
                      ) : null}
                      <SidebarActionButton
                        iconOnly={ipadSources}
                        accessibilityLabel={strings.sort()}
                        name={
                          groupOptions?.sortDirection === "asc"
                            ? "sort-ascending"
                            : "sort-descending"
                        }
                        top={10}
                        testID="sidebar-sort-button"
                        color={colors.primary.icon}
                        onPress={() => {
                          presentSheet({
                            component: (
                              <Sort
                                dataType={
                                  props.navigationState.index === 1
                                    ? "notebook"
                                    : "tag"
                                }
                                group={
                                  props.navigationState.index === 1
                                    ? "notebooks"
                                    : "tags"
                                }
                                hideGroupOptions
                              />
                            )
                          });
                        }}
                        style={{
                          width: 35,
                          height: 35
                        }}
                        size={AppFontSize.lg - 2}
                      />
                    </>
                  ) : null}

                  {ipadSources || props.navigationState.index === 0 ? (
                    <>
                      <SidebarActionButton
                        iconOnly={ipadSources}
                        accessibilityLabel={strings.colorScheme()}
                        onPress={() => {
                          useThemeStore.getState().setColorScheme();
                        }}
                        style={{
                          width: 28,
                          height: 28
                        }}
                        top={10}
                        testID="sidebar-theme-button"
                        color={colors.primary.icon}
                        name={isDark ? "weather-night" : "weather-sunny"}
                        size={AppFontSize.lg - 2}
                      />
                    </>
                  ) : null}
                </View>
              </>
            )}
          </>
        )}
      </View>
      {ipadSources && !compactFooter ? <SideMenuSettings labeled /> : null}
    </>
  );
};

async function presentNewNotebook() {
  const feature = await isFeatureAvailable("notebooks");
  if (!feature.isAllowed) {
    ToastManager.show({ message: feature.error, type: "info" });
    return;
  }
  AddNotebookSheet.present();
}

function SidebarActionButton({
  iconOnly = false,
  ...props
}: IconButtonProps & { iconOnly?: boolean }) {
  const { colors } = useThemeColors();
  if (!isIPadSourceList()) return <IconButton {...props} />;
  const symbol =
    props.name === "plus"
      ? "plus"
      : props.name.startsWith("sort-")
      ? "arrow.up.arrow.down"
      : props.name === "weather-night"
      ? "moon"
      : "sun.max";
  return (
    <Pressable
      testID={props.testID}
      onPress={props.onPress}
      accessibilityRole="button"
      disabled={props.disabled}
      accessibilityState={{ disabled: !!props.disabled }}
      accessibilityLabel={props.accessibilityLabel}
      type="transparent"
      noborder
      style={{
        minHeight: 44,
        minWidth: 44,
        width: iconOnly ? 44 : "auto",
        flexShrink: iconOnly ? 0 : 1,
        flexDirection: "row",
        gap: DefaultAppStyles.GAP_SMALL,
        paddingHorizontal: iconOnly ? 0 : DefaultAppStyles.GAP_SMALL
      }}
    >
      <IPadSourceSymbol
        name={symbol}
        size={AppFontSize.md}
        color={colors.primary.icon}
      />
      {iconOnly ? null : (
        <Paragraph size={AppFontSize.md} style={{ flexShrink: 1 }}>
          {props.accessibilityLabel}
        </Paragraph>
      )}
    </Pressable>
  );
}

/** A presentation of the existing lists; their stores, filters and actions remain owners.
 * Library and notebooks share the existing notebook list's one outer scroll surface.
 * Tags retain their mounted scene when returning, like the legacy cached tab scenes.
 */
function IPadSources({
  index,
  onIndexChange
}: {
  index: number;
  onIndexChange: (index: number) => void;
}) {
  const notebookSelection = useSideMenuNotebookSelectionStore(
    (state) => state.enabled
  );
  const tagSelection = useSideMenuTagsSelectionStore((state) => state.enabled);
  const dragging = useSideBarDraggingStore((state) => state.dragging);
  const locked = notebookSelection || tagSelection || dragging;
  const loadedTags = React.useRef(index === 2);
  if (index === 2) loadedTags.current = true;
  const show = (next: number) => {
    if (locked) return;
    onIndexChange(next);
    if (next === 1 || next === 2) {
      const route = next === 1 ? "Notebooks" : "Tags";
      Navigation.routeNeedsUpdate(
        route,
        Navigation.routeUpdateFunctions[route]
      );
    }
  };
  return (
    <View style={{ flex: 1 }}>
      {index === 2 ? (
        <>
          <IPadSourceSection
            disabled={locked}
            title={strings.routes.Library()}
            expanded={false}
            onPress={() => show(0)}
            testID="ipad-source-home-return"
          />
          <IPadSourceSection
            disabled={locked}
            title={strings.routes.Notebooks()}
            expanded={false}
            onPress={() => show(1)}
            testID="ipad-source-notebooks-return"
          />
        </>
      ) : null}
      <View
        testID="ipad-source-library-pane"
        pointerEvents={index === 2 ? "none" : "auto"}
        accessibilityElementsHidden={index === 2}
        importantForAccessibility={index === 2 ? "no-hide-descendants" : "auto"}
        style={{ flex: 1, display: index === 2 ? "none" : "flex" }}
      >
        <SideMenuNotebooks
          showHeader={false}
          sourceHeader={
            <>
              <IPadSourceSection
                disabled={locked}
                title={strings.routes.Library()}
                expanded={index === 0}
                onPress={() => show(index === 0 ? 1 : 0)}
                testID="ipad-source-home"
              />
              <View
                pointerEvents={index === 0 ? "auto" : "none"}
                accessibilityElementsHidden={index !== 0}
                importantForAccessibility={
                  index === 0 ? "auto" : "no-hide-descendants"
                }
                style={{ display: index === 0 ? "flex" : "none" }}
              >
                <SideMenuHome
                  showHeader={false}
                  embedded
                  sourceLocked={locked}
                />
              </View>
              <IPadSourceSection
                disabled={locked}
                title={strings.routes.Notebooks()}
                expanded={true}
                onPress={() => show(1)}
                testID="ipad-source-notebooks"
              />
            </>
          }
          sourceFooter={
            <SidebarActionButton
              disabled={locked}
              testID="ipad-source-new-notebook"
              name="plus"
              accessibilityLabel={strings.addNotebook()}
              onPress={presentNewNotebook}
            />
          }
        />
      </View>
      <IPadSourceSection
        disabled={locked}
        title={strings.routes.Tags()}
        expanded={index === 2}
        onPress={() => show(index === 2 ? 0 : 2)}
        testID="ipad-source-tags"
      />
      <View
        testID="ipad-source-tags-pane"
        pointerEvents={index === 2 ? "auto" : "none"}
        accessibilityElementsHidden={index !== 2}
        importantForAccessibility={index === 2 ? "auto" : "no-hide-descendants"}
        style={{
          flex: index === 2 ? 1 : 0,
          display: index === 2 ? "flex" : "none"
        }}
      >
        {loadedTags.current ? <SideMenuTags showHeader={false} /> : null}
      </View>
    </View>
  );
}

export default SideMenu;
