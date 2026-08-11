import { StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { useTheme } from "@/theme";

// Static ambient light pools — the ground the glass refracts. Never animated,
// never behind long text (spec: Tokens > ambient pools).
export function AppBackground() {
  const { instrument, scheme } = useTheme();
  const dark = scheme === "dark";
  const pools = [
    { id: "bg-pool-1", cx: "14%", cy: "4%", color: instrument.accent, opacity: dark ? 0.09 : 0.14 },
    { id: "bg-pool-2", cx: "90%", cy: "44%", color: instrument.teal, opacity: dark ? 0.08 : 0.13 },
    { id: "bg-pool-3", cx: "30%", cy: "96%", color: "#FF9450", opacity: dark ? 0.06 : 0.1 },
  ];
  return (
    <View
      testID="app-background"
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: instrument.bg }]}
    >
      <Svg width="100%" height="100%">
        <Defs>
          {pools.map((p) => (
            <RadialGradient key={p.id} id={p.id} cx={p.cx} cy={p.cy} r="55%">
              <Stop offset="0" stopColor={p.color} stopOpacity={p.opacity} />
              <Stop offset="1" stopColor={p.color} stopOpacity="0" />
            </RadialGradient>
          ))}
        </Defs>
        {pools.map((p) => (
          <Rect key={p.id} testID={p.id} width="100%" height="100%" fill={`url(#${p.id})`} />
        ))}
      </Svg>
    </View>
  );
}
