import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
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

// iOS segmented control, restyled to Instrument Glass: an inset track holding
// a sliding glassBorder-edged pill behind the selected label. The old
// `cardSecondary`/`card` pairing carried a faint green tint in dark mode
// (spec: "any green/legacy accent → ink/mut"). The pill's position springs
// between segments; selecting a new segment fires the selection haptic.
export function Segmented({ options, value, onChange }: Props) {
  const { instrument, shadows } = useTheme();
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
        backgroundColor: instrument.inset,
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
            backgroundColor: instrument.glass,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: instrument.glassBorder,
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
            {/*
              Segments are equal-width, so a label wider than its share of the
              track has nowhere to go. Left to reflow it wraps and grows the
              whole control's height, which is what "Usual meals" did to the
              five-tab food-memory row. Shrink first and truncate as a floor —
              the same order iOS uses — so one long label can never disturb the
              row's rhythm.
            */}
            <AppText
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
              style={{ fontSize: 15, fontWeight: selected ? "600" : "400", color: instrument.ink }}
            >
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
