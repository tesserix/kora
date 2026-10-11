import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, ScrollView, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReadLabel } from "@/api/hooks";
import type { LabelNutrients } from "@/api/labelAnalysis";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppText } from "@/components/Text";
import { BezelCluster, ZoneRule } from "@/components/instrument/BezelCluster";
import { PressableScale } from "@/motion";
import { safeBack } from "@/lib/safeBack";
import { useTheme } from "@/theme";

const nutrients: [keyof LabelNutrients, string, string][] = [
  ["energy_kcal", "Energy", "kcal"], ["protein_g", "Protein", "g"], ["fat_g", "Fat", "g"],
  ["saturated_fat_g", "Saturated fat", "g"], ["carbohydrate_g", "Carbohydrate", "g"],
  ["sugars_g", "Sugars", "g"], ["fibre_g", "Fibre", "g"], ["sodium_mg", "Sodium", "mg"],
];

export default function LabelScan() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const reading = useReadLabel();
  const controller = useRef<AbortController | null>(null);
  const picking = useRef(false);
  const mounted = useRef(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);

  async function upload() {
    if (picking.current || reading.isPending) return;
    picking.current = true;
    setNotice(null);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!mounted.current) return;
      if (!permission.granted) { setDenied(true); return; }
      setDenied(false);
      const selected = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible });
      if (!mounted.current || selected.canceled || !selected.assets[0]) return;
      const asset = selected.assets[0];
      if ((asset.fileSize ?? 0) > 8 * 1024 * 1024) { setNotice("Choose an image smaller than 8 MB."); return; }
      controller.current?.abort();
      controller.current = new AbortController();
      reading.reset();
      reading.mutate({ input: { uri: asset.uri, name: asset.fileName ?? "label.jpg", type: asset.mimeType ?? "image/jpeg" }, signal: controller.current.signal });
    } catch {
      if (mounted.current) setNotice("Couldn't open your photos. Please try again.");
    } finally { picking.current = false; }
  }

  const errorCode = (reading.error as { code?: string } | null)?.code;
  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.xl }}>
        <ScreenHeader title="Read a nutrition label" onBack={() => safeBack("/(tabs)")} />
        <View style={{ paddingHorizontal: spacing.md, gap: spacing.md }}>
          <AppText style={{ color: instrument.mut }}>Upload a clear photo of the full nutrition panel. Kora reads and checks it automatically.</AppText>
          <PressableScale accessibilityRole="button" accessibilityLabel="Upload label image" disabled={reading.isPending} onPress={() => void upload()} style={{ minHeight: 48, borderRadius: 18, backgroundColor: instrument.accent, padding: spacing.md, alignItems: "center" }}>
            <AppText style={{ color: instrument.bg, fontWeight: "700" }}>{reading.isPending ? "Reading image…" : "Upload label image"}</AppText>
          </PressableScale>
          {denied ? <PressableScale accessibilityRole="button" accessibilityLabel="Open photo settings" onPress={() => void Linking.openSettings()} style={{ minHeight: 44, justifyContent: "center" }}><AppText>Allow photo access in Settings</AppText></PressableScale> : null}
          {notice ? <AppText accessibilityRole="alert">{notice}</AppText> : null}
          {reading.isPending ? <View accessibilityLiveRegion="polite" style={{ gap: spacing.sm }}><ActivityIndicator color={instrument.accent} /><AppText>Reading the label and checking unclear details. This may take a moment.</AppText></View> : null}
          {reading.isError ? <AppText accessibilityRole="alert">{errorCode === "budget_exhausted" ? "You've reached your AI usage limit. Try again when your allowance resets." : "Couldn't read this image. Check your connection or upload a clearer photo of the full label."}</AppText> : null}
          {reading.data ? <BezelCluster>
            <View style={{ padding: spacing.md, gap: spacing.sm }}>
              <AppText style={{ fontWeight: "700" }}>{reading.data.needs_review ? "Some details are uncertain" : "Label details"}</AppText>
              <AppText>{reading.data.analysis.summary}</AppText>
              <ZoneRule label={reading.data.basis === "per_100ml" ? "Per 100 ml" : "Per 100 g"} />
              {nutrients.map(([key, label, unit]) => <View key={key} style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.md, paddingVertical: spacing.xs }}>
                <AppText>{label}</AppText><AppText>{reading.data!.per_100[key] == null ? "Not readable" : `${Number(reading.data!.per_100[key]!.toFixed(2))} ${unit}`}</AppText>
              </View>)}
              <AppText style={{ color: instrument.mut }}>These are label values, not a record of what you ate.</AppText>
            </View>
          </BezelCluster> : null}
        </View>
      </ScrollView>
    </View>
  );
}
