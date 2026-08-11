import { useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { useTheme } from "@/theme";

// Reduced-transparency fallback fill — deliberately distinct from
// `instrument.bg` (the screen ground under the ambient pools). Using `bg`
// itself made a fallback panel invisible: identical color to the screen
// behind it, so the "card" vanished entirely for anyone with Reduce
// Transparency on (I4). These are near-opaque card tones, one step lighter
// (dark) / one step off-white (light) than the ground, so the panel still
// reads as an elevated surface without any blur.
export const REDUCED_TRANSPARENCY_FALLBACK = { dark: "#14171C", light: "#F7F7F8" } as const;

// One elevation level; glass never stacks on glass (spec: Shape and material).
export function useReducedTransparency(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceTransparencyEnabled?.().then((v) => live && setReduced(!!v));
    const sub = AccessibilityInfo.addEventListener?.("reduceTransparencyChanged", (v) => setReduced(!!v));
    return () => { live = false; sub?.remove?.(); };
  }, []);
  return reduced;
}

export interface GlassPanelProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  radius?: number;
  testID?: string;
}

export function GlassPanel({ children, style, radius = 24, testID }: GlassPanelProps) {
  const { instrument, scheme, shadows } = useTheme();
  const reduced = useReducedTransparency();
  const shell: ViewStyle = {
    borderRadius: radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: instrument.glassBorder,
    overflow: "hidden",
    // Reduced-transparency fallback (spec: Shape and material > Reduced
    // transparency): a near-opaque card tone distinct from `instrument.bg`
    // — see REDUCED_TRANSPARENCY_FALLBACK above for why `bg` itself doesn't work.
    backgroundColor: reduced ? REDUCED_TRANSPARENCY_FALLBACK[scheme] : "transparent",
  };
  return (
    <View testID={testID} style={[shell, shadows.card, style]}>
      {!reduced && (
        <BlurView
          testID={testID ? `${testID}-blur` : undefined}
          intensity={scheme === "dark" ? 25 : 40}
          tint={scheme === "dark" ? "dark" : "light"}
          style={[StyleSheet.absoluteFill, { backgroundColor: instrument.glass }]}
        />
      )}
      {/* top highlight — light catching the material */}
      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.glassHighlight }} />
      {children}
    </View>
  );
}
