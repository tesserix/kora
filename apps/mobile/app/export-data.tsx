import { useRef, useState } from "react";
import { ScrollView, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { File, Paths } from "expo-file-system";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { PressableScale } from "@/motion";
import { safeBack } from "@/lib/safeBack";
import { fetchDataExport } from "@/api/hooks";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { useTheme } from "@/theme";

// What the export contains, in the user's words rather than in table names —
// the same convention DESTROYED uses on the delete screen, and for the same
// reason: a list of 38 table names tells a person nothing about whether their
// data is in there.
//
// Deliberately NOT generated from the server's table list. It is a promise
// about coverage, and the thing that keeps that promise honest is
// TestEveryUserScopedTableIsExportedOrExcluded on the API side, not a string
// in the app.
const INCLUDED = [
  "Every food log, with what you typed and what it resolved to",
  "Weight, measurements, water and fasting history",
  "Recipes, saved meals and pinned foods",
  "Coach conversations and your mentor profile",
  "Friends, groups, challenges and sharing circles",
  "Your profile, targets and AI usage",
];

export default function ExportDataScreen() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not `pending`, is what latches — two presses in the same tick both
  // read the pre-commit `pending` from their render closure and both pass.
  // The same guard delete-account.tsx uses; here a double press would run the
  // whole export twice rather than doing damage, but it would also race two
  // writes onto one filename.
  const inFlight = useRef(false);

  const onExport = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);

    // The file is written and shared, then deleted below. It exists only long
    // enough for the share sheet to read it.
    let file: File | null = null;
    try {
      const doc = await fetchDataExport();

      // Cache, not documents: this is a transient hand-off to the share
      // sheet, and iOS purging it under storage pressure is the correct
      // outcome. (captureMedia.ts uses documents for the opposite reason —
      // queued captures must survive.)
      file = new File(Paths.cache, `kora-export-${doc.exported_at.slice(0, 10)}.json`);
      if (file.exists) file.delete();
      file.create();
      file.write(JSON.stringify(doc, null, 2));

      await Share.share({ url: file.uri, title: "Kora data export" });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      // Best-effort, and always: leaving one person's entire health history in
      // the cache directory after the sheet closes is the kind of copy nobody
      // accounts for. A failure here is not worth surfacing — iOS will purge
      // the directory eventually either way.
      try {
        if (file?.exists) file.delete();
      } catch {
        // Deliberately swallowed.
      }
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}
      >
        <ScreenHeader overline="Account" title="Export my data" onBack={() => safeBack("/profile")} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <GlassPanel radius={22} style={{ padding: spacing.md, gap: spacing.sm }}>
            <AppText style={{ fontSize: 15, fontWeight: "500", color: instrument.ink }}>
              A complete copy of your Kora data, as one JSON file.
            </AppText>
            {INCLUDED.map((line) => (
              <AppText key={line} style={{ fontSize: 14, color: instrument.mut }}>
                {`•  ${line}`}
              </AppText>
            ))}
          </GlassPanel>

          <GlassPanel radius={22} style={{ padding: spacing.md, gap: spacing.sm }}>
            <AppText style={{ fontSize: 14, color: instrument.mut }}>
              Two things are left out on purpose: the credentials that sign you in,
              and the token that lets Kora send notifications to this device. Both
              would let anyone holding the file act as you. The file lists what was
              withheld.
            </AppText>
            <AppText style={{ fontSize: 14, color: instrument.mut }}>
              Kora never stores your food photos, so there are none to export.
            </AppText>
          </GlassPanel>

          {error ? (
            <AppText
              accessibilityLiveRegion="polite"
              style={{ fontSize: 14, color: instrument.danger, marginLeft: spacing.md }}
            >
              {error}
            </AppText>
          ) : null}

          <PressableScale
            testID="create-export"
            accessibilityRole="button"
            accessibilityLabel="Create my export"
            accessibilityState={{ disabled: pending, busy: pending }}
            disabled={pending}
            onPress={onExport}
            style={{
              minHeight: 50,
              borderRadius: 16,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: instrument.accent,
              opacity: pending ? 0.4 : 1,
            }}
          >
            <AppText style={{ fontSize: 16, fontWeight: "600", color: instrument.accentOn }}>
              {pending ? "Preparing…" : "Create my export"}
            </AppText>
          </PressableScale>
        </View>
      </ScrollView>
    </View>
  );
}
