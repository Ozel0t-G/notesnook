import { Notebook, Tag } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { db } from "../../common/database";
import Navigation, { NavigationProps } from "../../services/navigation";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";

type LibraryDestination = {
  key: string;
  label: string;
  symbol: string;
  onPress: () => void;
};

export default function Library({ navigation }: NavigationProps<"Library">) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const [notebooks, setNotebooks] = React.useState<Notebook[]>([]);
  const [tags, setTags] = React.useState<Tag[]>([]);

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!db.isInitialized) return;
      const [nextNotebooks, nextTags] = await Promise.all([
        db.notebooks.all.limit(2000).items(),
        db.tags.all.limit(2000).items()
      ]);
      if (alive) {
        setNotebooks(nextNotebooks);
        setTags(nextTags);
      }
    };
    void load();
    const unsubscribe = navigation.addListener("focus", () => void load());
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [navigation]);

  const destinations: LibraryDestination[] = [
    {
      key: "favorites",
      label: strings.routes.Favorites(),
      symbol: "star",
      onPress: () => navigation.navigate("Favorites", {})
    },
    {
      key: "monographs",
      label: strings.routes.Monographs(),
      symbol: "text.book.closed",
      onPress: () =>
        navigation.navigate("Monographs", {
          type: "monograph",
          id: "monograph",
          canGoBack: true
        })
    },
    {
      key: "archive",
      label: strings.routes.Archive(),
      symbol: "archivebox",
      onPress: () => navigation.navigate("Archive", {})
    },
    {
      key: "trash",
      label: strings.routes.Trash(),
      symbol: "trash",
      onPress: () => navigation.navigate("Trash", {})
    }
  ];

  const sectionTitle = (title: string) => (
    <Text
      style={{
        color: visual.secondaryText,
        fontSize: 13,
        fontWeight: "600",
        marginTop: 28,
        marginBottom: 9,
        marginHorizontal: 20
      }}
    >
      {title.toLocaleUpperCase()}
    </Text>
  );

  const row = (item: LibraryDestination, index: number, length: number) => (
    <Pressable
      key={item.key}
      onPress={item.onPress}
      accessibilityRole="button"
      accessibilityLabel={item.label}
      style={{
        minHeight: 54,
        flexDirection: "row",
        alignItems: "center",
        marginHorizontal: 16,
        paddingHorizontal: 16,
        borderTopLeftRadius: index === 0 ? visual.controlRadius : 0,
        borderTopRightRadius: index === 0 ? visual.controlRadius : 0,
        borderBottomLeftRadius: index === length - 1 ? visual.controlRadius : 0,
        borderBottomRightRadius: index === length - 1 ? visual.controlRadius : 0,
        borderBottomWidth: index === length - 1 ? 0 : 0.5,
        borderBottomColor: visual.separator,
        backgroundColor: visual.contentSurface
      }}
    >
      <TaskSymbolView name={item.symbol} size={21} color={colors.primary.accent} />
      <Text
        numberOfLines={1}
        style={{ flex: 1, color: visual.primaryText, fontSize: 16, marginLeft: 14 }}
      >
        {item.label}
      </Text>
      <TaskSymbolView name="chevron.right" size={14} color={visual.tertiaryText} />
    </Pressable>
  );

  const notebookRows: LibraryDestination[] = notebooks.map((item) => ({
    key: `notebook:${item.id}`,
    label: item.title,
    symbol: "book.closed",
    onPress: () => navigation.navigate("Notebook", { id: item.id, canGoBack: true })
  }));
  const tagRows: LibraryDestination[] = tags.map((item) => ({
    key: `tag:${item.id}`,
    label: item.title,
    symbol: "number",
    onPress: () =>
      navigation.navigate("TaggedNotes", {
        type: "tag",
        id: item.id,
        canGoBack: true
      })
  }));

  return (
    <View style={{ flex: 1, backgroundColor: visual.screenBackground }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 20,
            paddingTop: 20
          }}
        >
          <Text
            style={{ flex: 1, color: visual.primaryText, fontSize: 34, fontWeight: "700" }}
          >
            {strings.routes.Library()}
          </Text>
          <Pressable
            onPress={() => Navigation.push("Settings", {})}
            accessibilityRole="button"
            accessibilityLabel={strings.routes.Settings()}
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <TaskSymbolView name="gearshape" size={23} color={visual.primaryText} />
          </Pressable>
        </View>
        {destinations.map((item, index) => row(item, index, destinations.length))}
        {sectionTitle(strings.routes.Notebooks())}
        {notebookRows.map((item, index) => row(item, index, notebookRows.length))}
        {sectionTitle(strings.routes.Tags())}
        {tagRows.map((item, index) => row(item, index, tagRows.length))}
      </ScrollView>
    </View>
  );
}
