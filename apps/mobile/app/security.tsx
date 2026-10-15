import { useEffect, useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { safeBack } from "@/lib/safeBack";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import {
  confirmTwoStep,
  disableTwoStep,
  fetchTwoStepEnabled,
  groupedSecret,
  startTwoStep,
  type TwoStepSetup,
} from "@/api/twoStep";
import { useTheme } from "@/theme";

type Phase = "loading" | "off" | "setup" | "on" | "failed";

// A rejected code comes back as a 400 whose message kora-api wrote for people.
function codeError(e: unknown): string {
  const err = e as { name?: string; code?: string; message?: string };
  if (err?.name === "ApiError" && (err.code === "invalid_code" || err.code === "invalid_input") && err.message) {
    return err.message;
  }
  return apiErrorMessage(e);
}

// Two-step verification: optional, off by default. Turning it on adds an
// authenticator app to the person's account, and from then on every sign-in,
// including Google and Apple, asks for its code.
export default function SecurityScreen() {
  const { instrument, spacing, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>("loading");
  const [setup, setSetup] = useState<TwoStepSetup | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Bumped by "Try again" to re-run the status read.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    fetchTwoStepEnabled().then(
      (enabled) => live && setPhase(enabled ? "on" : "off"),
      (e: unknown) => {
        if (!live) return;
        setError(apiErrorMessage(e));
        setPhase("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  function retry() {
    setError(null);
    setPhase("loading");
    setAttempt((n) => n + 1);
  }

  async function step(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setError(codeError(e));
    } finally {
      setBusy(false);
    }
  }

  const begin = () =>
    step(async () => {
      setSetup(await startTwoStep());
      setCode("");
      setPhase("setup");
    });

  // The code as six digits, or null after saying what is wrong with it.
  function digits(): string | null {
    const d = code.replace(/\s/g, "");
    if (/^\d{6}$/.test(d)) return d;
    setNotice(null);
    setError("Enter the 6-digit code from your authenticator app.");
    return null;
  }

  function confirm() {
    const d = digits();
    if (!d) return;
    void step(async () => {
      await confirmTwoStep(d);
      setSetup(null);
      setCode("");
      setPhase("on");
      setNotice("Two-step verification is on. Kora will ask for a code each time you sign in.");
    });
  }

  function turnOff() {
    const d = digits();
    if (!d) return;
    void step(async () => {
      await disableTwoStep(d);
      setCode("");
      setPhase("off");
      setNotice("Two-step verification is off.");
    });
  }

  async function openAuthenticator() {
    if (!setup) return;
    try {
      await Linking.openURL(setup.uri);
    } catch {
      setError("No authenticator app opened. Install one, or type the setup key into it.");
    }
  }

  const codeField = (
    <Field
      label="Code"
      value={code}
      onChangeText={setCode}
      keyboardType="number-pad"
      autoComplete="one-time-code"
      textContentType="oneTimeCode"
      maxLength={7}
      editable={!busy}
      style={{ letterSpacing: 6, fontSize: 22 }}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}
        keyboardShouldPersistTaps="handled"
      >
        <ScreenHeader overline="Security" title="Two-step verification" onBack={() => safeBack("/settings")} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          {phase === "loading" ? (
            <AppText style={{ fontSize: 14, color: instrument.mut }}>Checking…</AppText>
          ) : null}

          {phase === "failed" ? (
            <Button testID="security-retry" title="Try again" variant="secondary" onPress={retry} />
          ) : null}

          {phase === "off" ? (
            <>
              <GlassPanel radius={22} style={{ padding: spacing.md, gap: spacing.sm }}>
                <AppText style={{ fontSize: 15, fontWeight: "500", color: instrument.ink }}>
                  Add a code from an authenticator app to every sign-in.
                </AppText>
                <AppText style={{ fontSize: 14, color: instrument.mut }}>
                  {"Even someone with your password, or your Google or Apple account, couldn't sign in to Kora without your phone. It's optional, and you can turn it off here."}
                </AppText>
              </GlassPanel>
              <Button testID="security-enable" title={busy ? "…" : "Turn on"} disabled={busy} onPress={() => void begin()} />
            </>
          ) : null}

          {phase === "setup" && setup ? (
            <>
              <GlassPanel radius={22} style={{ padding: spacing.md, gap: spacing.sm }}>
                <AppText style={{ fontSize: 15, fontWeight: "500", color: instrument.ink }}>
                  1. Add Kora to your authenticator app.
                </AppText>
                <AppText style={{ fontSize: 14, color: instrument.mut }}>
                  Open it straight from here, or type this setup key into it:
                </AppText>
                <AppText
                  testID="security-secret"
                  selectable
                  style={{ fontFamily: fonts.mono, fontSize: 16, color: instrument.ink, letterSpacing: 1 }}
                >
                  {groupedSecret(setup.secret)}
                </AppText>
                <Button
                  testID="security-open-app"
                  title="Open authenticator app"
                  variant="secondary"
                  onPress={() => void openAuthenticator()}
                />
              </GlassPanel>
              <GlassPanel radius={22} style={{ padding: spacing.md, gap: spacing.sm }}>
                <AppText style={{ fontSize: 15, fontWeight: "500", color: instrument.ink }}>
                  2. Enter the 6-digit code it shows.
                </AppText>
                {codeField}
              </GlassPanel>
              <Button testID="security-confirm" title={busy ? "…" : "Turn on"} disabled={busy} onPress={confirm} />
            </>
          ) : null}

          {phase === "on" ? (
            <>
              <GlassPanel radius={22} style={{ padding: spacing.md, gap: spacing.sm }}>
                <AppText style={{ fontSize: 15, fontWeight: "500", color: instrument.ink }}>
                  Two-step verification is on.
                </AppText>
                <AppText style={{ fontSize: 14, color: instrument.mut }}>
                  To turn it off, enter a current code from your authenticator app.
                </AppText>
                {codeField}
              </GlassPanel>
              <Button
                testID="security-disable"
                title={busy ? "…" : "Turn off"}
                variant="destructive"
                disabled={busy}
                onPress={turnOff}
              />
            </>
          ) : null}

          {error ? (
            <AppText accessibilityLiveRegion="polite" style={{ fontSize: 14, color: instrument.danger, marginLeft: spacing.md }}>
              {error}
            </AppText>
          ) : null}
          {notice ? (
            <AppText accessibilityLiveRegion="polite" style={{ fontSize: 14, color: instrument.mut, marginLeft: spacing.md }}>
              {notice}
            </AppText>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
