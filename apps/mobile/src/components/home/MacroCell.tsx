import { StyleSheet, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { AppText } from "@/components/Text";
import { SubDial } from "@/components/instrument/SubDial";
import { monoStyle } from "@/components/instrument/typography";
import { useMotionPrefs } from "@/motion";
import { useTheme } from "@/theme";

export interface MacroCellProps {
  label: string;
  have: number;
  target: number;
  unit?: string;
  // First cell in the row skips the left hairline divider.
  first?: boolean;
  // Same pending guard as the rest of Home's hero: an em-dash placeholder
  // instead of a fabricated 0/0 before the dashboard resolves.
  pending?: boolean;
}

// One macro's compact instrument cell (spec 2026-08-16 "Home recomposition"):
// a 42pt SubDial, an 11px label, the mono have/target reading, a 2px ink
// microbar on an inset track, and a 10px mono "Ng to go" — three of these sit
// in a row inside the hero BezelCluster, separated by a left hairline.
export function MacroCell({ label, have, target, unit = "g", first = false, pending = false }: MacroCellProps) {
  const { instrument, fonts } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const mono = monoStyle(fonts);
  const fraction = pending || target <= 0 ? 0 : have / target;
  const toGo = Math.max(0, target - have);

  // Rise-in on value change (spec Step 4), skipped under Reduce Motion — same
  // "no calmer substitute, only suppression" rule as the gauge's own flourishes.
  const entering = reduceMotion ? undefined : FadeInDown.duration(350);

  return (
    <View
      testID={`macro-cell-${label.toLowerCase()}`}
      style={{
        flex: 1,
        alignItems: "center",
        gap: 4,
        paddingVertical: 12,
        paddingHorizontal: 8,
        borderLeftWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderLeftColor: instrument.hairline,
      }}
    >
      <SubDial fraction={fraction} testID={`macro-cell-${label.toLowerCase()}-subdial`} />
      {/* Dynamic Type caps (mirrors ZoneRule's precedent in BezelCluster.tsx):
          1.4 on the two micro-labels, 1.6 on the numeral — never disabled,
          only bounded so the cell doesn't blow out at the largest sizes. */}
      <AppText maxFontSizeMultiplier={1.4} style={{ fontSize: 11, fontWeight: "600", color: instrument.mut }}>
        {label}
      </AppText>
      <Animated.View key={pending ? "pending" : have} entering={entering}>
        <AppText maxFontSizeMultiplier={1.6} style={[{ fontSize: 13, fontWeight: "600", color: instrument.ink }, mono]}>
          {pending ? "—" : `${have}/${target}${unit}`}
        </AppText>
      </Animated.View>
      <View
        style={{
          width: "100%",
          height: 2,
          borderRadius: 1,
          backgroundColor: instrument.inset,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            height: "100%",
            width: `${Math.min(fraction, 1) * 100}%`,
            backgroundColor: instrument.ink,
            borderRadius: 1,
          }}
        />
      </View>
      <AppText maxFontSizeMultiplier={1.4} style={[{ fontSize: 10, color: instrument.mut }, mono]}>
        {pending ? "—" : `${toGo}${unit} to go`}
      </AppText>
    </View>
  );
}
