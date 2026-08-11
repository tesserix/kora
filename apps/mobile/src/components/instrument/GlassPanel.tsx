import { useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { useTheme } from "@/theme";

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
    backgroundColor: reduced ? (scheme === "dark" ? "#14171C" : "#F7F7F8") : "transparent",
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
