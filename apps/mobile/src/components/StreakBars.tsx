import { View } from "react-native";
import { useTheme } from "@/theme";

type Props = { count: number; window?: number; color?: string };

// Row of small bars; the trailing `count` bars are filled to visualize a
// logging streak. Static (no animation) — safe on device.
export function StreakBars({ count, window = 7, color }: Props) {
  const { colors, radius } = useTheme();
  const filled = Math.min(Math.max(0, count), window);
  const barColor = color ?? colors.accent;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4, height: 28 }}>
      {Array.from({ length: window }, (_, i) => {
        const isFilled = i >= window - filled;
        return (
          <View
            key={i}
            testID={isFilled ? "streak-bar-filled" : undefined}
            style={{
              flex: 1,
              height: isFilled ? 28 : 12,
              borderRadius: radius.sm,
              backgroundColor: isFilled ? barColor : colors.muted,
            }}
          />
        );
      })}
    </View>
  );
}
