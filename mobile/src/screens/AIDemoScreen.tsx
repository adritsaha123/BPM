import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { API_URL, api, type Health } from "../api";
import { colors, spacing } from "../theme";

/** Demo screen proving the phone -> FastAPI -> LLM loop works. Replace freely. */
export default function AIDemoScreen() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setHealthError(String(e)));
  }, []);

  async function send() {
    if (!message.trim()) return;
    setLoading(true);
    setReply(null);
    try {
      const res = await api.chat(message.trim());
      setReply(res.reply);
    } catch (e) {
      setReply(`Error: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Hackathon Starter</Text>

        <View style={styles.status}>
          <Text style={styles.statusText}>API: {API_URL}</Text>
          {health && (
            <Text style={[styles.statusText, { color: colors.ok }]}>
              Connected · AI {health.ai === "live" ? "live" : "in mock mode"}
            </Text>
          )}
          {healthError && (
            <Text style={[styles.statusText, { color: colors.error }]}>
              Can't reach backend. Is it running with --host 0.0.0.0?
            </Text>
          )}
        </View>

        <TextInput
          style={styles.input}
          placeholder="Ask the AI something…"
          placeholderTextColor={colors.muted}
          value={message}
          onChangeText={setMessage}
          onSubmitEditing={send}
          multiline
        />

        <Pressable style={({ pressed }) => [styles.button, pressed && { opacity: 0.8 }]} onPress={send}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Send</Text>}
        </Pressable>

        {reply && (
          <View style={styles.reply}>
            <Text style={styles.replyText}>{reply}</Text>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: { padding: spacing.lg, paddingTop: spacing.xl * 2, gap: spacing.md },
  title: { fontSize: 28, fontWeight: "700", color: colors.text },
  status: { gap: 4 },
  statusText: { fontSize: 13, color: colors.muted },
  input: {
    minHeight: 80,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.md,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.card,
    textAlignVertical: "top",
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  reply: { backgroundColor: colors.card, borderRadius: 12, padding: spacing.md },
  replyText: { fontSize: 16, color: colors.text, lineHeight: 22 },
});
