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
      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        // 12, not 16. Measured on iPhone 17 Pro Max (440pt) at `medium`, the
        // four capture chips came to 427pt of natural width inside a 412pt
        // padding box, so TYPE — the offline typed-capture entry point — hung
        // 15pt past it and lost its right border off the 440pt screen edge
        // entirely (kora#278). Trimming 4pt of padding a side takes 8pt off
        // every pill, 32pt off the row, and lands it at 395pt with headroom.
        // The label is untouched on purpose: 13pt at 1.4 tracking is the
        // engraved instrument voice, and kora#263 established that squeezing a
        // label to fit its box splits it mid-word ("kg" became "k"/"g").
        // DetectedCard's meal-slot chips share this component and already wrap
        // (flexWrap on their row), so narrower pills can only pack better there.
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 9999,
        backgroundColor: active ? INSTRUMENT_DARK_FIXED.accent : INSTRUMENT_DARK_FIXED.glass,
        borderWidth: active ? 0 : 1,
        borderColor: INSTRUMENT_DARK_FIXED.glassBorder,
        opacity: state.pressed ? 0.85 : 1,
      })}
    >
      <Icon name={icon} size={16} color={fg} />
      <AppText
        maxFontSizeMultiplier={1.6}
        style={{
          color: fg,
          fontSize: 13,
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
