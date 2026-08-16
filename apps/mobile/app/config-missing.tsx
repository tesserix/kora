import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

// This screen is a deliberate dead end: app/_layout.tsx `router.replace`s here
// when readFirebaseConfig() returns null, so there is no stack behind it and no
// other screen worth reaching — hence a header with NO back button. It also has
// no "Reload" button on purpose. `isFirebaseConfigured` is `config !== null`
// evaluated once at module scope, and EXPO_PUBLIC_* values are inlined into the
// bundle at build time, so nothing this screen could call would re-read .env.
// A button that cannot do what it says is worse than none; what the developer
// is owed instead is the exact sequence that DOES work.

const ENV_VAR_NAMES = [
  "EXPO_PUBLIC_FIREBASE_API_KEY",
  "EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "EXPO_PUBLIC_FIREBASE_PROJECT_ID",
  "EXPO_PUBLIC_FIREBASE_APP_ID",
] as const;

// babel inlines `process.env.EXPO_PUBLIC_X` at bundle time, so each variable has
// to be read as a literal member expression — a `process.env[name]` lookup over
// ENV_VAR_NAMES would compile to `undefined` in a real build and report all four
// as missing. Only the NAME of a variable ever reaches the screen: an API key
// rendered here would be shoulder-surfable off a shared screen or a screenshot,
// and knowing WHICH keys are absent is the whole diagnostic value anyway.
function missingEnvVars(): string[] {
  const set: Record<(typeof ENV_VAR_NAMES)[number], boolean> = {
    EXPO_PUBLIC_FIREBASE_API_KEY: !!process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
    EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: !!process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
    EXPO_PUBLIC_FIREBASE_PROJECT_ID: !!process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
    EXPO_PUBLIC_FIREBASE_APP_ID: !!process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  };
  return ENV_VAR_NAMES.filter((name) => !set[name]);
}

const STEPS = [
  "Put the missing values in apps/mobile/.env. apps/mobile/.env.example lists all four and already has the two non-secret ones filled in; the rest come from Firebase Console > Project settings > Your apps > kora-mobile.",
  "Restart Metro: npx expo start --clear. EXPO_PUBLIC_ values are baked into the bundle when it is built, so editing .env under a running Metro changes nothing on its own.",
  "Reload the app: press r in the Metro terminal, or shake the device and choose Reload from the dev menu.",
] as const;

export default function ConfigMissing() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const missing = missingEnvVars();

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 40 }}
      >
        {/* No onBack: this screen is where startup stopped, not somewhere you
            navigated to. A back button would land on a blank stack. */}
        <ScreenHeader overline="Setup" title="Firebase isn't configured" />

        <View style={{ paddingHorizontal: spacing.md, gap: spacing.md }}>
          <AppText style={{ fontSize: 13, color: instrument.mut, lineHeight: 19 }}>
            Kora cannot sign anyone in without Firebase credentials, so startup stops here.
          </AppText>

          <GlassPanel radius={18}>
            <View style={{ padding: spacing.md, gap: 8 }}>
              <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.ink }}>
                {missing.length > 0 ? "Not set in this build" : "All four are set in this process"}
              </AppText>
              {missing.length > 0 ? (
                missing.map((name) => (
                  <AppText key={name} style={{ fontSize: 13, color: instrument.ink }}>
                    {name}
                  </AppText>
                ))
              ) : (
                <AppText style={{ fontSize: 13, color: instrument.mut, lineHeight: 18 }}>
                  The running bundle was built before they were. Steps 2 and 3 below will pick them
                  up.
                </AppText>
              )}
            </View>
          </GlassPanel>

          <GlassPanel radius={18}>
            <View style={{ padding: spacing.md, gap: 10 }}>
              <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.ink }}>
                How to reload
              </AppText>
              {STEPS.map((step, i) => (
                <View key={step} style={{ flexDirection: "row", gap: 8 }}>
                  <AppText style={{ fontSize: 13, color: instrument.mut, lineHeight: 18 }}>
                    {`${i + 1}.`}
                  </AppText>
                  <AppText style={{ flex: 1, fontSize: 13, color: instrument.mut, lineHeight: 18 }}>
                    {step}
                  </AppText>
                </View>
              ))}
            </View>
          </GlassPanel>

          <AppText style={{ fontSize: 12, color: instrument.mut, lineHeight: 17 }}>
            In an EAS build these come from the project&apos;s EAS environment variables, not from
            apps/mobile/.env.
          </AppText>
        </View>
      </ScrollView>
    </View>
  );
}
