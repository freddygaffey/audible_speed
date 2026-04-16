import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { usePlayer } from "@/context/PlayerContext";

interface AddBookModalProps {
  visible: boolean;
  onClose: () => void;
}

export function AddBookModal({ visible, onClose }: AddBookModalProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { addBook } = usePlayer();

  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [narrator, setNarrator] = useState("");
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [description, setDescription] = useState("");

  const handleAdd = () => {
    if (!title.trim() || !author.trim()) {
      Alert.alert("Missing info", "Please enter at least a title and author.");
      return;
    }
    const h = parseInt(hours || "0", 10) || 0;
    const m = parseInt(minutes || "0", 10) || 0;
    const duration = h * 3600 + m * 60;

    addBook({
      title: title.trim(),
      author: author.trim(),
      narrator: narrator.trim() || undefined,
      duration: duration || 3600,
      description: description.trim() || undefined,
      coverColor: "",
      chapter: "Introduction",
      totalChapters: 1,
      currentChapter: 1,
    });

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTitle("");
    setAuthor("");
    setNarrator("");
    setHours("");
    setMinutes("");
    setDescription("");
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={[styles.root, { backgroundColor: colors.background }]}
      >
        <View
          style={[
            styles.header,
            { borderBottomColor: colors.border, paddingTop: insets.top + 16 },
          ]}
        >
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            Add Audiobook
          </Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Feather name="x" size={24} color={colors.mutedForeground} />
          </Pressable>
        </View>

        <ScrollView
          style={styles.form}
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          keyboardShouldPersistTaps="handled"
        >
          <Field label="Title *" colors={colors}>
            <TextInput
              style={[styles.input, { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.card }]}
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. The Hitchhiker's Guide"
              placeholderTextColor={colors.mutedForeground}
              returnKeyType="next"
            />
          </Field>

          <Field label="Author *" colors={colors}>
            <TextInput
              style={[styles.input, { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.card }]}
              value={author}
              onChangeText={setAuthor}
              placeholder="e.g. Douglas Adams"
              placeholderTextColor={colors.mutedForeground}
              returnKeyType="next"
            />
          </Field>

          <Field label="Narrator" colors={colors}>
            <TextInput
              style={[styles.input, { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.card }]}
              value={narrator}
              onChangeText={setNarrator}
              placeholder="e.g. Martin Freeman"
              placeholderTextColor={colors.mutedForeground}
              returnKeyType="next"
            />
          </Field>

          <Field label="Duration" colors={colors}>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.durationInput, { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.card }]}
                value={hours}
                onChangeText={setHours}
                placeholder="0h"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="number-pad"
                maxLength={3}
              />
              <TextInput
                style={[styles.input, styles.durationInput, { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.card }]}
                value={minutes}
                onChangeText={setMinutes}
                placeholder="0m"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="number-pad"
                maxLength={2}
              />
            </View>
          </Field>

          <Field label="Description" colors={colors}>
            <TextInput
              style={[styles.input, styles.textarea, { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.card }]}
              value={description}
              onChangeText={setDescription}
              placeholder="What's this book about?"
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </Field>

          <Pressable
            onPress={handleAdd}
            style={({ pressed }) => [
              styles.addBtn,
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Feather name="plus" size={20} color="#fff" />
            <Text style={styles.addBtnText}>Add to Library</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Field({ label, colors, children }: { label: string; colors: any; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
  },
  form: {
    flex: 1,
    padding: 20,
  },
  field: {
    marginBottom: 20,
    gap: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  textarea: {
    height: 80,
    paddingTop: 12,
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  durationInput: {
    flex: 1,
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    paddingVertical: 16,
    gap: 8,
    marginTop: 8,
  },
  addBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
