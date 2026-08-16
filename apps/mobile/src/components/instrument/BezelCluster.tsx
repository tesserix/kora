import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { GlassPanel } from "./GlassPanel";
import { monoStyle } from "./typography";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

// Spec 2026-08-16 "Panel architecture": one bezel-grade instrument per
// screen. The rim is a two-stop linear gradient (conic was cut — RN can't
// draw it without Skia). Clusters wrap fixed-cardinality content only.
const RIM_INSET = 1.5;

export interface BezelClusterProps {
  children: ReactNode;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  glow?: boolean;
  testID?: string;
}

export function BezelCluster({ children, radius = 26, style, glow = false, testID }: BezelClusterProps) {
  const { instrument, shadows } = useTheme();
  return (
    <View
      testID={testID}
      style={[
        // Backlight, not accent. This was `instrument.accent` at 0.3 — a wide
        // orange halo around the whole cluster, which spent the screen's one
        // accent moment on its CONTAINER and then competed with the hero it
        // surrounds (the gauge on Home, the chart on Progress). The spec's
        // budget is "one hero orange moment per screen + dock chrome", and
        // app/(tabs)/more.tsx already reasons this way in a comment: its accent
        // is "a whisper glow behind the avatar well, not a full-panel glow".
        //
        // Warm ink instead of a dark shadow because the ground is #0B0D10 — a
        // black halo on near-black separates nothing. A lume-toned backlight
        // does, and it is the language the spec already uses for instrument
        // faces ("watch-dial lume"), so the cluster still lifts off the ground
        // without claiming to be the thing worth looking at.
        glow && {
          shadowColor: instrument.ink,
          shadowOpacity: 0.16,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 0 },
        },
        style,
      ]}
    >
      <LinearGradient
        testID={testID ? `${testID}-rim` : "bezel-rim"}
        colors={[instrument.glassHighlight, "transparent", instrument.shade]}
        locations={[0, 0.22, 0.9]}
        style={[{ borderRadius: radius + RIM_INSET, padding: RIM_INSET }, shadows.card]}
      >
        <GlassPanel radius={radius}>{children}</GlassPanel>
      </LinearGradient>
    </View>
  );
}

export interface ZoneRuleProps {
  label: string;
  /**
   * An optional mono-figure detail rendered after the label (e.g. a slot's
   * "· 380 kcal" subtotal) — same 10px engraved scale and instrument.mut
   * color as the label, but routed through monoStyle so the digits keep
   * tabular-nums instead of inheriting the label's sans engraving. Omitting
   * this prop keeps ZoneRule's single-label rendering byte-identical to
   * before (spec 2026-08-16 "Diary recomposition" review fix).
   */
  detail?: string;
  testID?: string;
}

export function ZoneRule({ label, detail, testID }: ZoneRuleProps) {
  const { instrument, fonts } = useTheme();
  const mono = monoStyle(fonts);
  const line = { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline } as const;
  return (
    <View testID={testID} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16 }}>
      <View style={line} />
      <AppText maxFontSizeMultiplier={1.4} style={{ fontSize: 10, fontWeight: "600", letterSpacing: 1.5, color: instrument.mut }}>
        {label.toUpperCase()}
      </AppText>
      {detail ? (
        <AppText
          maxFontSizeMultiplier={1.4}
          style={[{ fontSize: 10, fontWeight: "600", letterSpacing: 1.5, color: instrument.mut }, mono]}
        >
          {detail.toUpperCase()}
        </AppText>
      ) : null}
      <View style={line} />
    </View>
  );
}

export interface WellFooterProps {
  children: ReactNode;
  testID?: string;
}

export function WellFooter({ children, testID }: WellFooterProps) {
  const { instrument } = useTheme();
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: instrument.inset,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: instrument.hairline,
        paddingVertical: 12,
        paddingHorizontal: 16,
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, backgroundColor: instrument.wellShadow }} />
      {children}
    </View>
  );
}
