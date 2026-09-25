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
  Pressable,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { db } from "../../common/database";
import { TaskSymbolView } from "../../components/task-symbol-view";
import { eSendEvent } from "../../services/event-manager";
import Navigation from "../../services/navigation";
import { getAppleVisualTokens } from "../../utils/apple-visual-tokens";
import { eOnLoadNote } from "../../utils/events";
import { fluidTabsRef } from "../../utils/global-refs";

type SearchRow =
  | { kind: "note"; index: number; key: string }
  | { kind: "task"; task: Task; key: string };

function NoteResult({
  index,
  results,
  onPress
}: {
  index: number;
  results: VirtualizedGrouping<HighlightedResult>;
  onPress: (note: Note) => void;
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

  if (!note) return <View style={{ height: 56 }} />;
  return (
    <Pressable
      onPress={() => onPress(note)}
      accessibilityRole="button"
      accessibilityLabel={note.title || note.headline || strings.routes.Notes()}
      style={{
        minHeight: 62,
        flexDirection: "row",
        alignItems: "center",
        borderBottomWidth: 0.5,
        borderBottomColor: visual.separator,
        paddingVertical: 9
      }}
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
          {note.title || note.headline || strings.routes.Notes()}
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
    </Pressable>
  );
}

export default function GlobalSearch() {
  const { colors, isDark } = useThemeColors();
  const visual = getAppleVisualTokens(colors, isDark);
  const [query, setQuery] = React.useState("");
  const [results, setResults] =
    React.useState<VirtualizedGrouping<HighlightedResult>>();
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [loading, setLoading] = React.useState(false);
  const generation = React.useRef(0);

  React.useEffect(() => {
    const term = query.trim();
    const current = ++generation.current;
    if (!term || !db.isInitialized) {
      setResults(undefined);
      setTasks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
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
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

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
          paddingHorizontal: 20,
          paddingTop: 16,
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
                  marginBottom: 5
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
                  marginBottom: 5
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
              />
            ) : item.kind === "task" ? (
              <Pressable
                onPress={() =>
                  Navigation.push("TaskDetail", { taskId: item.task.id })
                }
                accessibilityRole="button"
                accessibilityLabel={item.task.title}
                style={{
                  minHeight: 58,
                  flexDirection: "row",
                  alignItems: "center",
                  borderBottomWidth: 0.5,
                  borderBottomColor: visual.separator
                }}
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
              </Pressable>
            ) : null}
          </>
        )}
      />
    </SafeAreaView>
  );
}
