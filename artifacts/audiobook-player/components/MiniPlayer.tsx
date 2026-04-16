import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { usePlayer } from "@/context/PlayerContext";

export function MiniPlayer() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { currentBook, playerState, play, pause } = usePlayer();

  if (!currentBook) return null;

  const togglePlay = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (playerState.isPlaying) {
      pause();
    } else {
      play();
    }
  };

  const openPlayer = () => {
    router.push("/player");
  };

  const initials = currentBook.title
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  const progressPct =
    currentBook.duration > 0
      ? (playerState.position / playerState.duration) * 100
      : 0;

  return (
    <Pressable
      onPress={openPlayer}
      style={[
        styles.container,
        {
          backgroundColor: colors.playerBg,
          marginBottom: insets.bottom > 0 ? insets.bottom + 60 : 74,
          marginHorizontal: 12,
        },
      ]}
    >
      <View
        style={[styles.cover, { backgroundColor: currentBook.coverColor }]}
      >
        <Text style={styles.initials}>{initials}</Text>
      </View>

      <View style={styles.info}>
        <Text
          style={[styles.title, { color: colors.playerText }]}
          numberOfLines={1}
        >
          {currentBook.title}
        </Text>
        <Text
          style={[styles.author, { color: colors.playerMuted }]}
          numberOfLines={1}
        >
          {currentBook.author}
        </Text>
      </View>

      <Pressable
        onPress={togglePlay}
        hitSlop={12}
        style={({ pressed }) => [styles.playBtn, { opacity: pressed ? 0.7 : 1 }]}
      >
        <Feather
          name={playerState.isPlaying ? "pause" : "play"}
          size={22}
          color={colors.playerAccent}
        />
      </Pressable>

      <View
        style={[
          styles.progressBar,
          { backgroundColor: "rgba(255,255,255,0.1)" },
        ]}
      >
        <View
          style={[
            styles.progressFill,
            {
              backgroundColor: colors.playerAccent,
              width: `${progressPct}%`,
            },
          ]}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    padding: 12,
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
    overflow: "hidden",
  },
  cover: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  initials: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 16,
    fontWeight: "700",
  },
  info: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
  },
  author: {
    fontSize: 12,
  },
  playBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  progressBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
  },
  progressFill: {
    height: "100%",
  },
});
