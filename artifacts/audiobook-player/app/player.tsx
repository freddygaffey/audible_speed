import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React, { useCallback } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { usePlayer } from "@/context/PlayerContext";
import { useColors } from "@/hooks/useColors";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10];

export default function PlayerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { currentBook, playerState, play, pause, skipForward, skipBack, setSpeed, closePlayer } =
    usePlayer();

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 34 : insets.bottom;

  const handleBack = () => {
    router.back();
  };

  const togglePlay = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (playerState.isPlaying) {
      pause();
    } else {
      play();
    }
  };

  const handleSkipForward = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    skipForward();
  };

  const handleSkipBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    skipBack();
  };

  const handleSpeedChange = (speed: number) => {
    Haptics.selectionAsync();
    setSpeed(speed);
  };

  if (!currentBook) {
    return (
      <View
        style={[
          styles.noBook,
          { backgroundColor: colors.playerBg, paddingTop: topPad },
        ]}
      >
        <Feather name="book" size={48} color={colors.playerMuted} />
        <Text style={[styles.noBookText, { color: colors.playerText }]}>
          No book selected
        </Text>
        <Pressable onPress={handleBack} style={styles.goBack}>
          <Text style={[styles.goBackText, { color: colors.playerAccent }]}>
            Go to Library
          </Text>
        </Pressable>
      </View>
    );
  }

  const initials = currentBook.title
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  const progressPct =
    playerState.duration > 0
      ? playerState.position / playerState.duration
      : 0;

  return (
    <View style={[styles.root, { backgroundColor: colors.playerBg }]}>
      <View style={[styles.header, { paddingTop: topPad + 8 }]}>
        <Pressable
          onPress={handleBack}
          hitSlop={12}
          style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]}
        >
          <Feather name="chevron-down" size={28} color={colors.playerText} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.playerText }]}>
          Now Playing
        </Text>
        <Pressable
          onPress={() => {
            closePlayer();
            router.back();
          }}
          hitSlop={12}
          style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]}
        >
          <Feather name="x" size={24} color={colors.playerMuted} />
        </Pressable>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={[
          styles.contentInner,
          { paddingBottom: bottomPad + 20 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={[styles.coverArt, { backgroundColor: currentBook.coverColor }]}
        >
          <Text style={styles.coverInitials}>{initials}</Text>
        </View>

        <View style={styles.bookInfo}>
          <Text style={[styles.bookTitle, { color: colors.playerText }]}>
            {currentBook.title}
          </Text>
          <Text style={[styles.bookAuthor, { color: colors.playerMuted }]}>
            {currentBook.author}
          </Text>
          {currentBook.narrator && (
            <Text style={[styles.narrator, { color: colors.playerAccent }]}>
              Narrated by {currentBook.narrator}
            </Text>
          )}
          {currentBook.chapter && (
            <View
              style={[
                styles.chapterBadge,
                { backgroundColor: "rgba(255,255,255,0.08)" },
              ]}
            >
              <Text style={[styles.chapterText, { color: colors.playerMuted }]}>
                {currentBook.chapter}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.progressSection}>
          <View
            style={[
              styles.progressTrack,
              { backgroundColor: "rgba(255,255,255,0.1)" },
            ]}
          >
            <View
              style={[
                styles.progressFill,
                {
                  backgroundColor: colors.playerAccent,
                  width: `${progressPct * 100}%`,
                },
              ]}
            />
            <View
              style={[
                styles.progressThumb,
                {
                  backgroundColor: colors.playerAccent,
                  left: `${progressPct * 100}%`,
                },
              ]}
            />
          </View>
          <View style={styles.timeRow}>
            <Text style={[styles.timeText, { color: colors.playerMuted }]}>
              {formatTime(playerState.position)}
            </Text>
            <Text style={[styles.timeText, { color: colors.playerMuted }]}>
              -{formatTime(Math.max(0, playerState.duration - playerState.position))}
            </Text>
          </View>
        </View>

        <View style={styles.controls}>
          <Pressable
            onPress={handleSkipBack}
            style={({ pressed }) => [styles.controlBtn, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Feather name="rotate-ccw" size={26} color={colors.playerText} />
            <Text style={[styles.skipLabel, { color: colors.playerMuted }]}>15</Text>
          </Pressable>

          <Pressable
            onPress={togglePlay}
            style={({ pressed }) => [
              styles.playBtn,
              {
                backgroundColor: colors.playerAccent,
                opacity: pressed ? 0.85 : 1,
                transform: [{ scale: pressed ? 0.95 : 1 }],
              },
            ]}
          >
            <Feather
              name={playerState.isPlaying ? "pause" : "play"}
              size={34}
              color="#fff"
            />
          </Pressable>

          <Pressable
            onPress={handleSkipForward}
            style={({ pressed }) => [styles.controlBtn, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Feather name="rotate-cw" size={26} color={colors.playerText} />
            <Text style={[styles.skipLabel, { color: colors.playerMuted }]}>30</Text>
          </Pressable>
        </View>

        <View style={styles.speedSection}>
          <Text style={[styles.speedLabel, { color: colors.playerMuted }]}>
            Playback Speed
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.speedRow}
          >
            {SPEEDS.map((speed) => (
              <Pressable
                key={speed}
                onPress={() => handleSpeedChange(speed)}
                style={[
                  styles.speedChip,
                  {
                    backgroundColor:
                      playerState.speed === speed
                        ? colors.playerAccent
                        : "rgba(255,255,255,0.08)",
                    borderColor:
                      playerState.speed === speed
                        ? colors.playerAccent
                        : "rgba(255,255,255,0.12)",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.speedChipText,
                    {
                      color:
                        playerState.speed === speed
                          ? "#fff"
                          : colors.playerMuted,
                      fontWeight: playerState.speed === speed ? "700" : "500",
                    },
                  ]}
                >
                  {speed}x
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        {currentBook.description && (
          <View
            style={[
              styles.descCard,
              { backgroundColor: "rgba(255,255,255,0.05)" },
            ]}
          >
            <Text
              style={[styles.descLabel, { color: colors.playerMuted }]}
            >
              About this book
            </Text>
            <Text style={[styles.descText, { color: colors.playerText }]}>
              {currentBook.description}
            </Text>
          </View>
        )}

        <View style={styles.statsRow}>
          <StatItem
            label="Progress"
            value={`${Math.round(progressPct * 100)}%`}
            colors={colors}
          />
          <StatItem
            label="Time Left"
            value={formatTimeRemaining(
              Math.max(0, playerState.duration - playerState.position)
            )}
            colors={colors}
          />
          {currentBook.totalChapters && (
            <StatItem
              label="Chapter"
              value={`${currentBook.currentChapter} / ${currentBook.totalChapters}`}
              colors={colors}
            />
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function formatTimeRemaining(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function StatItem({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: any;
}) {
  return (
    <View
      style={[
        styles.statItem,
        { backgroundColor: "rgba(255,255,255,0.05)" },
      ]}
    >
      <Text style={[styles.statValue, { color: colors.playerText }]}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: colors.playerMuted }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  noBook: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  noBookText: {
    fontSize: 18,
    fontWeight: "600",
  },
  goBack: {
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  goBackText: {
    fontSize: 16,
    fontWeight: "600",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  content: {
    flex: 1,
  },
  contentInner: {
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 28,
  },
  coverArt: {
    width: 220,
    height: 220,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 16,
    marginTop: 12,
  },
  coverInitials: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 64,
    fontWeight: "800",
    letterSpacing: 4,
  },
  bookInfo: {
    alignItems: "center",
    gap: 6,
    width: "100%",
  },
  bookTitle: {
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: -0.3,
    lineHeight: 28,
  },
  bookAuthor: {
    fontSize: 15,
    textAlign: "center",
  },
  narrator: {
    fontSize: 13,
    textAlign: "center",
    fontWeight: "500",
  },
  chapterBadge: {
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginTop: 4,
  },
  chapterText: {
    fontSize: 13,
    fontWeight: "500",
  },
  progressSection: {
    width: "100%",
    gap: 8,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    width: "100%",
    position: "relative",
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
  },
  progressThumb: {
    position: "absolute",
    top: -6,
    width: 16,
    height: 16,
    borderRadius: 8,
    marginLeft: -8,
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  timeText: {
    fontSize: 12,
    fontWeight: "500",
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 40,
    width: "100%",
  },
  controlBtn: {
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  skipLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
  playBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#e8a045",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
  },
  speedSection: {
    width: "100%",
    gap: 12,
  },
  speedLabel: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    textAlign: "center",
  },
  speedRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 4,
  },
  speedChip: {
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  speedChipText: {
    fontSize: 14,
  },
  descCard: {
    width: "100%",
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  descLabel: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  descText: {
    fontSize: 14,
    lineHeight: 22,
  },
  statsRow: {
    flexDirection: "row",
    gap: 10,
    width: "100%",
  },
  statItem: {
    flex: 1,
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    gap: 4,
  },
  statValue: {
    fontSize: 18,
    fontWeight: "700",
  },
  statLabel: {
    fontSize: 11,
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
