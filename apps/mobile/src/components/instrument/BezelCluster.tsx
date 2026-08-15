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
        glow && {
          shadowColor: instrument.accent,
          shadowOpacity: 0.3,
          shadowRadius: 27,
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
