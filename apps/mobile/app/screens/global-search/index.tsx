import {
  HighlightedResult,
  Note,
  Task,
  VirtualizedGrouping
} from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { useThemeColors } from "@notesnook/theme";
import React from "react";
import {
  ActivityIndicator,
  FlatList,
  NativeModules,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { db } from "../../common/database";
import { MacHoverHighlight, useMacHover } from "../../components/mac-hover";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { eSendEvent } from "../../services/event-manager";
import Navigation from "../../services/navigation";
import { useGlobalSearchStore } from "../../stores/use-global-search-store";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { isMacCatalyst } from "../../utils/constants";
import { eOnLoadNote } from "../../utils/events";
import { fluidTabsRef } from "../../utils/global-refs";
import { MAC_SOURCE_LIST_INSET } from "../../utils/mac-layout";

type SearchRow =
  | { kind: "note"; index: number; key: string }
  | { kind: "task"; task: Task; key: string };

/** Row metrics of the Mac source lists (see the note list's own rows). */
const MAC_ROW_PADDING = 8;
const MAC_ROW_RADIUS = 6;

/**
 * One result row. On Mac it is a source-list row like the note list's: no card
 * background, a hairline separator, the list's 10 pt inset and 8 pt of inner
 * padding, and the pointer highlight. On iPhone/iPad it keeps the plain
 * full-width row the screen has always had.
 */
function ResultRow({
  mac,
  iosMinHeight = 62,
  iosPaddingVertical = 9,
  onPress,
  accessibilityLabel,
  children
}: {
  mac: boolean;
  /** iPhone/iPad row metrics; Mac uses the source-list ones instead. */
  iosMinHeight?: number;
  iosPaddingVertical?: number;
  onPress: () => void;
  accessibilityLabel: string;
  children: React.ReactNode;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const { hovered, hoverProps } = useMacHover(mac);
  return (
    <Pressable
      {...hoverProps}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={{
        minHeight: mac ? undefined : iosMinHeight,
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: mac ? 10 : iosPaddingVertical,
        paddingHorizontal: mac ? MAC_ROW_PADDING : 0,
        marginHorizontal: mac ? MAC_SOURCE_LIST_INSET : 0,
        borderRadius: mac ? MAC_ROW_RADIUS : 0,
        borderBottomWidth: mac ? StyleSheet.hairlineWidth : 0.5,
        borderBottomColor: visual.separator
      }}
    >
      <MacHoverHighlight visible={hovered} radius={MAC_ROW_RADIUS} />
      {children}
    </Pressable>
  );
}

function NoteResult({
  index,
  results,
  onPress,
  mac
}: {
  index: number;
  results: VirtualizedGrouping<HighlightedResult>;
  onPress: (note: Note) => void;
  mac: boolean;
}) {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const [note, setNote] = React.useState<Note>();

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      const result = (await results.item(index)).item;
      if (!result?.id) return;
      const found = await db.notes.note(result.id);
      if (alive && found) setNote(found);
    };
    void load();
    return () => {
      alive = false;
    };
  }, [index, results]);

  if (!note) return <View style={{ height: mac ? 44 : 56 }} />;
  const title = note.title || note.headline || strings.routes.Notes();
  return (
    <ResultRow
      mac={mac}
      onPress={() => onPress(note)}
      accessibilityLabel={title}
    >
      <TaskSymbolView
        name="note.text"
        size={20}
        color={colors.primary.accent}
      />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text
          numberOfLines={1}
          style={{ color: visual.primaryText, fontSize: 16 }}
        >
          {title}
        </Text>
        {!!note.headline && note.headline !== note.title && (
          <Text
            numberOfLines={1}
            style={{ color: visual.secondaryText, fontSize: 13, marginTop: 2 }}
          >
            {note.headline}
          </Text>
        )}
      </View>
    </ResultRow>
  );
}

export default function GlobalSearch() {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  // The query lives in the store, not here: on Mac the window toolbar's search
  // field is the real input and writes it (see hooks/use-mac-menu-commands.ts).
  const query = useGlobalSearchStore((state) => state.query);
  const setQuery = useGlobalSearchStore((state) => state.setQuery);
  const submitToken = useGlobalSearchStore((state) => state.submitToken);
  const [results, setResults] =
    React.useState<VirtualizedGrouping<HighlightedResult>>();
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [loading, setLoading] = React.useState(false);
  const generation = React.useRef(0);
  /** The `submitToken` the query was last searched with (see below). */
  const searchedSubmitToken = React.useRef(submitToken);
  /**
   * Whether the Mac window toolbar carries the app's search field (Mac
   * Catalyst 16 and newer; see VeyraNMacMenu's `toolbarSearch` constant and
   * +[VeyraNMacToolbar toolbarSearchAvailable]). Where it does, this screen's
   * own large title and field are redundant: the toolbar field is the input
   * and the screen is only the results. Where it does not (iPhone, iPad and
   * Mac Catalyst 15, which has no such item) nothing changes.
   */
  const mac =
    Platform.OS === "ios" &&
    // `isMacCatalyst()` is `boolean | undefined` (Platform.isMacCatalyst is
    // optional), hence the explicit coercion.
    isMacCatalyst() === true &&
    NativeModules.VeyraNMacMenu?.toolbarSearch === true;

  React.useEffect(() => {
    const term = query.trim();
    const current = ++generation.current;
    const run = async () => {
      try {
        const [notes, allTasks] = await Promise.all([
          db.lookup.notesWithHighlighting(
            term,
            db.notes.all,
            db.settings.getGroupOptions("search")
          ),
          db.tasks.list()
        ]);
        if (current !== generation.current) return;
        const normalized = term.toLocaleLowerCase();
        setResults(notes);
        setTasks(
          allTasks.filter((task) =>
            task.title.toLocaleLowerCase().includes(normalized)
          )
        );
      } catch {
        if (current === generation.current) {
          setResults(undefined);
          setTasks([]);
        }
      } finally {
        if (current === generation.current) setLoading(false);
      }
    };

    // `submitToken` only changes on Return in the toolbar's search field: that
    // is the explicit "run it now", so it skips the typing debounce below.
    const submitted = searchedSubmitToken.current !== submitToken;
    searchedSubmitToken.current = submitToken;

    if (!term || !db.isInitialized) {
      setResults(undefined);
      setTasks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    if (submitted) {
      void run();
      return;
    }
    const timer = setTimeout(run, 250);
    return () => clearTimeout(timer);
  }, [query, submitToken]);

  const rows: SearchRow[] = [
    ...Array.from({ length: results?.length || 0 }, (_, index) => ({
      kind: "note" as const,
      index,
      key: `note:${index}`
    })),
    ...tasks.map((task) => ({
      kind: "task" as const,
      task,
      key: `task:${task.id}`
    }))
  ];

  const openNote = (note: Note) => {
    Navigation.navigate("FluidPanelsView", {});
    eSendEvent(eOnLoadNote, { item: note });
    requestAnimationFrame(() => fluidTabsRef.current?.goToPage("editor"));
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: visual.screenBackground }}
      edges={["top"]}
    >
      {/* Mac: the window toolbar's search field is the input, so the screen's
          own large title and field are not shown and the results start at the
          top. iPhone/iPad (and Mac Catalyst 15, which has no toolbar field)
          keep both. */}
      {!mac && (
        <Text
          style={{
            color: visual.primaryText,
            fontSize: 34,
            fontWeight: "700",
            marginHorizontal: 20,
            marginTop: 20,
            marginBottom: 16
          }}
        >
          {strings.search()}
        </Text>
      )}
      {!mac && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: visual.secondarySurface,
            borderRadius: visual.controlRadius,
            marginHorizontal: 16,
            paddingHorizontal: 12,
            minHeight: 46
          }}
        >
          <TaskSymbolView
            name="magnifyingglass"
            size={18}
            color={visual.secondaryText}
          />
          <TextInput
            autoFocus
            testID="global-search-input"
            value={query}
            onChangeText={setQuery}
            placeholder={strings.search()}
            placeholderTextColor={visual.tertiaryText}
            accessibilityLabel={strings.search()}
            returnKeyType="search"
            style={{
              flex: 1,
              color: visual.primaryText,
              fontSize: 16,
              marginLeft: 9
            }}
          />
        </View>
      )}
      {loading && (
        <ActivityIndicator
          style={{ marginTop: 16 }}
          color={colors.primary.accent}
        />
      )}
      <FlatList
        keyboardShouldPersistTaps="handled"
        data={rows}
        keyExtractor={(item) => item.key}
        contentContainerStyle={{
          paddingHorizontal: mac ? 0 : 20,
          paddingTop: mac ? 8 : 16,
          paddingBottom: 20
        }}
        ListEmptyComponent={
          !loading && !!query.trim() ? (
            <Text
              style={{
                color: visual.secondaryText,
                textAlign: "center",
                marginTop: 40
              }}
            >
              {strings.noResultsFound()}
            </Text>
          ) : null
        }
        renderItem={({ item, index }) => (
          <>
            {index === 0 && item.kind === "note" && (
              <Text
                style={{
                  color: visual.secondaryText,
                  fontWeight: "600",
                  marginBottom: 5,
                  paddingHorizontal: mac ? MAC_SOURCE_LIST_INSET + 8 : 0
                }}
              >
                {strings.routes.Notes()}
              </Text>
            )}
            {item.kind === "task" && index === (results?.length || 0) && (
              <Text
                style={{
                  color: visual.secondaryText,
                  fontWeight: "600",
                  marginTop: 18,
                  marginBottom: 5,
                  paddingHorizontal: mac ? MAC_SOURCE_LIST_INSET + 8 : 0
                }}
              >
                {strings.tasksTitle()}
              </Text>
            )}
            {item.kind === "note" && results ? (
              <NoteResult
                index={item.index}
                results={results}
                onPress={openNote}
                mac={mac}
              />
            ) : item.kind === "task" ? (
              <ResultRow
                mac={mac}
                iosMinHeight={58}
                iosPaddingVertical={0}
                onPress={() =>
                  Navigation.push("TaskDetail", { taskId: item.task.id })
                }
                accessibilityLabel={item.task.title}
              >
                <TaskSymbolView
                  name="checklist"
                  size={20}
                  color={colors.primary.accent}
                />
                <Text
                  numberOfLines={2}
                  style={{
                    color: visual.primaryText,
                    fontSize: 16,
                    flex: 1,
                    marginLeft: 12
                  }}
                >
                  {item.task.title}
                </Text>
              </ResultRow>
            ) : null}
          </>
        )}
      />
    </SafeAreaView>
  );
}
