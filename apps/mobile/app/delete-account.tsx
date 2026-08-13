import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { signOut } from "firebase/auth";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { PressableScale } from "@/motion";
import { safeBack } from "@/lib/safeBack";
import { deleteAccount } from "@/api/hooks";
import { unregisterPushToken } from "@/lib/push";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { auth } from "@/lib/firebase";
import { useTheme } from "@/theme";

// What the server's cascade actually removes, named in the user's words rather
// than in table names. Kept in sync with the 17 cascading FKs listed in
// docs/superpowers/specs/2026-08-07-account-deletion-design.md.
const DESTROYED = [
  "Your food logs and photos",
  "Saved meals and pinned foods",
  "Weight and water history",
  "Friends, groups and challenges",
  "Coach conversations",
];

const CONFIRM_WORD = "delete";

// Case-insensitive and trimmed: iOS autocapitalises by default, and punishing a
// user for their keyboard would make a working gesture look broken. The typed
// word is still a deliberate act — "delet" and an empty field are both refused.
function isConfirmed(value: string): boolean {
  return value.trim().toLowerCase() === CONFIRM_WORD;
}

export default function DeleteAccountScreen() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = isConfirmed(value);

  const onConfirm = async (): Promise<void> => {
    if (!confirmed || pending) return;
    setPending(true);
    setError(null);

    // Best-effort and FIRST: unregisterDevice needs a live session, and this
    // also clears the locally cached token so a shared device stops receiving
    // the previous user's push. Never allowed to block the deletion itself.
    try {
      await unregisterPushToken();
    } catch {
      // Deliberately swallowed — see src/lib/push.ts for this convention.
    }

    try {
      await deleteAccount();
    } catch (e: unknown) {
      setError(apiErrorMessage(e));
      setPending(false);
      return;
    }

    // The account is gone. A failure past this point must not strand the user
    // on a screen for an account that no longer exists, so sign-out is
    // best-effort and navigation happens regardless.
    try {
      if (auth) await signOut(auth);
    } catch {
      // Deliberately swallowed — the session is dead server-side either way.
    }
    router.replace("/sign-in");
  };

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}
      >
        <ScreenHeader overline="Account" title="Delete account" onBack={() => safeBack("/settings")} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <GlassPanel radius={22} style={{ padding: spacing.md, gap: spacing.sm }}>
            <AppText style={{ fontSize: 15, fontWeight: "500", color: instrument.ink }}>
              This deletes your Kora account and everything in it.
            </AppText>
            {DESTROYED.map((line) => (
              <AppText key={line} style={{ fontSize: 14, color: instrument.mut }}>
                {`•  ${line}`}
              </AppText>
            ))}
            <AppText style={{ fontSize: 14, fontWeight: "600", color: instrument.danger }}>
              This cannot be undone.
            </AppText>
          </GlassPanel>

          <View style={{ gap: spacing.xs }}>
            <AppText style={{ fontSize: 13, color: instrument.mut, marginLeft: spacing.md }}>
              Type “delete” to confirm.
            </AppText>
            <GlassPanel radius={22} style={{ paddingHorizontal: spacing.md }}>
              <TextInput
                testID="confirm-input"
                value={value}
                onChangeText={setValue}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!pending}
                placeholder="delete"
                placeholderTextColor={instrument.mut}
                style={{ minHeight: 48, fontSize: 16, color: instrument.ink }}
              />
            </GlassPanel>
          </View>

          {error ? (
            <AppText style={{ fontSize: 14, color: instrument.danger, marginLeft: spacing.md }}>
              {error}
            </AppText>
          ) : null}

          <PressableScale
            testID="confirm-delete"
            accessibilityRole="button"
            accessibilityLabel="Delete my account"
            accessibilityState={{ disabled: !confirmed || pending }}
            haptic="none"
            onPress={onConfirm}
            style={{
              minHeight: 50,
              borderRadius: 16,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: instrument.inset,
              opacity: confirmed && !pending ? 1 : 0.4,
            }}
          >
            <AppText style={{ fontSize: 16, fontWeight: "600", color: instrument.danger }}>
              {pending ? "Deleting…" : "Delete my account"}
            </AppText>
          </PressableScale>
        </View>
      </ScrollView>
    </View>
  );
}
