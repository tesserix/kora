import { StyleSheet, View } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type Props = { initials: string; size?: number };

// Instrument Glass inset well — swapped from `colors.cardSecondary` /
// `colors.label`, both of which carry a faint green tint in dark mode (spec:
// "Avatar.tsx ... only if they leak green — check").
export function Avatar({ initials, size = 40 }: Props) {
  const { instrument } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: instrument.inset,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: instrument.glassBorder,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <AppText style={{ fontSize: size * 0.38, fontWeight: "600", color: instrument.ink }}>
        {initials}
      </AppText>
    </View>
  );
}
