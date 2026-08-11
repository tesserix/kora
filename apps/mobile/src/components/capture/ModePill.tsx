import { Pressable } from "react-native";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { haptics } from "@/motion";
import { INSTRUMENT_DARK_FIXED } from "@/theme";

interface Props {
  icon: string;
  label: string;
  active: boolean;
  onPress: () => void;
}

// One of the four input-mode chips in the composer bar (Photo/Voice/Scan/Type),
// also reused for the DetectedCard meal-slot chips. Instrument Glass: a dark
// glass pill (glass fill + glassBorder) holding an accent-filled active chip.
// Styled from the fixed dark instrument tokens (never useTheme().instrument)
// because this component only ever appears on the always-dark Capture
// screen, which must ignore the device's light/dark scheme entirely — an
// engraving-style label, per the spec's "camera modes are an instrument-
// engraving zone" allowance.
export function ModePill({ icon, label, active, onPress }: Props) {
  // Spec: "active chip ink text, inactive mut" — the accent lives in the
  // fill, not the label.
  const fg = active ? INSTRUMENT_DARK_FIXED.ink : INSTRUMENT_DARK_FIXED.mut;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 9999,
        backgroundColor: active ? INSTRUMENT_DARK_FIXED.accent : INSTRUMENT_DARK_FIXED.glass,
        borderWidth: active ? 0 : 1,
        borderColor: INSTRUMENT_DARK_FIXED.glassBorder,
        opacity: state.pressed ? 0.85 : 1,
      })}
    >
      <Icon name={icon} size={14} color={fg} />
      <AppText
        style={{
          color: fg,
          fontSize: 11,
          fontWeight: "700",
          textTransform: "uppercase",
          letterSpacing: 1.4,
        }}
      >
        {label}
      </AppText>
    </Pressable>
  );
}
