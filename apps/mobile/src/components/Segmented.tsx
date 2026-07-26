import { useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { AppText } from "./Text";
import { haptics, springs } from "@/motion";
import { useTheme } from "@/theme";

type SegmentedOption = { key: string; label: string };

type Props = {
  options: SegmentedOption[];
  value: string;
  onChange: (key: string) => void;
};

// iOS segmented control: a `cardSecondary` track holding a sliding elevated pill
// behind the selected label. The pill's position springs between segments;
// selecting a new segment fires the selection haptic.
export function Segmented({ options, value, onChange }: Props) {
  const { colors, shadows } = useTheme();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.key === value));
  const indicatorPosition = useSharedValue(selectedIndex);

  useEffect(() => {
    indicatorPosition.value = withSpring(selectedIndex, springs.standard);
  }, [selectedIndex, indicatorPosition]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: `${indicatorPosition.value * 100}%` }],
  }));

  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: colors.cardSecondary,
        borderRadius: 9,
        padding: 2,
      }}
    >
      <Animated.View
        style={[
          {
            position: "absolute",
            top: 2,
            bottom: 2,
            left: 2,
            width: `${100 / options.length}%`,
            borderRadius: 7,
            backgroundColor: colors.card,
          },
          shadows.sm,
          indicatorStyle,
        ]}
      />
      {options.map((option) => {
        const selected = option.key === value;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            onPress={() => {
              if (option.key === value) return;
              haptics.selection();
              onChange(option.key);
            }}
            style={{ flex: 1, paddingVertical: 6, alignItems: "center", justifyContent: "center" }}
          >
            <AppText variant="subheadline" style={{ fontWeight: selected ? "600" : "400" }}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
