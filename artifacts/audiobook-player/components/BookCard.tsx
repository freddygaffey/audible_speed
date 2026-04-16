import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import { Audiobook } from "@/context/PlayerContext";

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatProgress(progress: number, duration: number): string {
  const remaining = duration * (1 - progress);
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  if (progress === 0) return formatDuration(duration);
  if (progress >= 0.99) return "Finished";
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

interface BookCardProps {
  book: Audiobook;
  onPress: () => void;
  onLongPress?: () => void;
}

export function BookCard({ book, onPress, onLongPress }: BookCardProps) {
  const colors = useColors();

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  const handleLongPress = () => {
    if (onLongPress) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onLongPress();
    }
  };

  const initials = book.title
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={handleLongPress}
      style={({ pressed }) => [
        styles.container,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
      ]}
    >
      <View
        style={[styles.cover, { backgroundColor: book.coverColor }]}
      >
        <Text style={styles.initials}>{initials}</Text>
        {book.progress > 0 && book.progress < 0.99 && (
          <View style={styles.progressBadge}>
            <Text style={styles.progressBadgeText}>
              {Math.round(book.progress * 100)}%
            </Text>
          </View>
        )}
        {book.progress >= 0.99 && (
          <View style={[styles.progressBadge, styles.finishedBadge]}>
            <Feather name="check" size={10} color="#fff" />
          </View>
        )}
      </View>

      <View style={styles.info}>
        <Text
          style={[styles.title, { color: colors.foreground }]}
          numberOfLines={2}
        >
          {book.title}
        </Text>
        <Text
          style={[styles.author, { color: colors.mutedForeground }]}
          numberOfLines={1}
        >
          {book.author}
        </Text>
        {book.chapter && (
          <Text
            style={[styles.chapter, { color: colors.accent }]}
            numberOfLines={1}
          >
            {book.chapter}
          </Text>
        )}
        <View style={styles.footer}>
          <Text style={[styles.duration, { color: colors.mutedForeground }]}>
            {formatProgress(book.progress, book.duration)}
          </Text>
        </View>
      </View>

      <View style={styles.playIcon}>
        <View style={[styles.playButton, { backgroundColor: colors.primary + "20" }]}>
          <Feather name="play" size={16} color={colors.primary} />
        </View>
      </View>

      {book.progress > 0 && book.progress < 0.99 && (
        <View style={[styles.progressBar, { backgroundColor: colors.border }]}>
          <View
            style={[
              styles.progressFill,
              {
                backgroundColor: colors.primary,
                width: `${book.progress * 100}%`,
              },
            ]}
          />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    marginHorizontal: 16,
    marginVertical: 6,
    overflow: "hidden",
    gap: 14,
  },
  cover: {
    width: 64,
    height: 64,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  initials: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 1,
  },
  progressBadge: {
    position: "absolute",
    bottom: -4,
    right: -4,
    backgroundColor: "#e8a045",
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 2,
    minWidth: 28,
    alignItems: "center",
  },
  finishedBadge: {
    backgroundColor: "#2d7a4a",
    minWidth: 20,
    paddingHorizontal: 4,
  },
  progressBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },
  info: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontSize: 15,
    fontWeight: "600",
    lineHeight: 20,
  },
  author: {
    fontSize: 13,
    fontWeight: "400",
  },
  chapter: {
    fontSize: 11,
    fontWeight: "500",
    marginTop: 2,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
    gap: 8,
  },
  duration: {
    fontSize: 12,
    fontWeight: "400",
  },
  playIcon: {
    flexShrink: 0,
  },
  playButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  progressBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
  },
});
