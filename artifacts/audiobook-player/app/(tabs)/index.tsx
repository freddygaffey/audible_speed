import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AddBookModal } from "@/components/AddBookModal";
import { BookCard } from "@/components/BookCard";
import { MiniPlayer } from "@/components/MiniPlayer";
import { Audiobook, usePlayer } from "@/context/PlayerContext";
import { useColors } from "@/hooks/useColors";

type SortMode = "recent" | "progress" | "title";

export default function LibraryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { library, openBook, removeBook, currentBook } = usePlayer();
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  const filtered = library
    .filter(
      (b) =>
        b.title.toLowerCase().includes(search.toLowerCase()) ||
        b.author.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      if (sortMode === "title") return a.title.localeCompare(b.title);
      if (sortMode === "progress") return b.progress - a.progress;
      return b.addedAt - a.addedAt;
    });

  const inProgress = filtered.filter((b) => b.progress > 0 && b.progress < 0.99);
  const notStarted = filtered.filter((b) => b.progress === 0);
  const finished = filtered.filter((b) => b.progress >= 0.99);

  const handlePress = (book: Audiobook) => {
    openBook(book);
    router.push("/player");
  };

  const handleLongPress = (book: Audiobook) => {
    Alert.alert(book.title, "What would you like to do?", [
      {
        text: "Remove from library",
        style: "destructive",
        onPress: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          removeBook(book.id);
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const sections: { title: string; data: Audiobook[] }[] = [];
  if (inProgress.length > 0) sections.push({ title: "In Progress", data: inProgress });
  if (notStarted.length > 0) sections.push({ title: "Not Started", data: notStarted });
  if (finished.length > 0) sections.push({ title: "Finished", data: finished });

  const flatData: (Audiobook | { sectionTitle: string })[] = [];
  for (const sec of sections) {
    flatData.push({ sectionTitle: sec.title });
    flatData.push(...sec.data);
  }

  const renderItem = ({ item }: { item: Audiobook | { sectionTitle: string } }) => {
    if ("sectionTitle" in item) {
      return (
        <Text style={[styles.sectionHeader, { color: colors.mutedForeground }]}>
          {item.sectionTitle}
        </Text>
      );
    }
    return (
      <BookCard
        book={item}
        onPress={() => handlePress(item)}
        onLongPress={() => handleLongPress(item)}
      />
    );
  };

  const keyExtractor = (item: Audiobook | { sectionTitle: string }) => {
    if ("sectionTitle" in item) return "section-" + item.sectionTitle;
    return item.id;
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 8 }]}>
        <View style={styles.headerTop}>
          <View>
            <Text style={[styles.headerLabel, { color: colors.mutedForeground }]}>
              Your Library
            </Text>
            <Text style={[styles.headerTitle, { color: colors.foreground }]}>
              Audiobooks
            </Text>
          </View>
          <Pressable
            onPress={() => setShowAdd(true)}
            style={({ pressed }) => [
              styles.addBtn,
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Feather name="plus" size={20} color="#fff" />
          </Pressable>
        </View>

        <View
          style={[
            styles.searchBar,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: colors.foreground }]}
            value={search}
            onChangeText={setSearch}
            placeholder="Search titles or authors..."
            placeholderTextColor={colors.mutedForeground}
            returnKeyType="search"
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch("")} hitSlop={8}>
              <Feather name="x" size={15} color={colors.mutedForeground} />
            </Pressable>
          )}
        </View>

        <View style={styles.sortRow}>
          {(["recent", "progress", "title"] as SortMode[]).map((mode) => (
            <Pressable
              key={mode}
              onPress={() => setSortMode(mode)}
              style={[
                styles.sortChip,
                {
                  backgroundColor:
                    sortMode === mode ? colors.primary : colors.card,
                  borderColor:
                    sortMode === mode ? colors.primary : colors.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.sortChipText,
                  {
                    color:
                      sortMode === mode
                        ? "#fff"
                        : colors.mutedForeground,
                  },
                ]}
              >
                {mode === "recent"
                  ? "Recent"
                  : mode === "progress"
                  ? "In Progress"
                  : "A-Z"}
              </Text>
            </Pressable>
          ))}
          <Text style={[styles.count, { color: colors.mutedForeground }]}>
            {filtered.length} book{filtered.length !== 1 ? "s" : ""}
          </Text>
        </View>
      </View>

      {flatData.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="book-open" size={48} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            {search ? "No results" : "Your library is empty"}
          </Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            {search
              ? "Try a different search term"
              : "Tap the + button to add your first audiobook"}
          </Text>
        </View>
      ) : (
        <FlatList
          data={flatData}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: currentBook ? 150 : (Platform.OS === "web" ? 34 : insets.bottom + 20) },
          ]}
          showsVerticalScrollIndicator={false}
        />
      )}

      <MiniPlayer />

      <AddBookModal visible={showAdd} onClose={() => setShowAdd(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 12,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLabel: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 2,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  addBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sortChip: {
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  sortChipText: {
    fontSize: 13,
    fontWeight: "600",
  },
  count: {
    fontSize: 13,
    marginLeft: "auto",
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 4,
  },
  list: {
    paddingTop: 4,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
  },
  emptyText: {
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
  },
});
