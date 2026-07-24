import { View } from "react-native";
import Svg, { Defs, LinearGradient, Stop, Polygon, Polyline, Circle } from "react-native-svg";
import { useTheme } from "@/theme";

type Props = { points: number[] };

export function WeightChart({ points }: Props) {
  const { colors } = useTheme();
  const w = 300;
  const h = 130;
  const pad = 10;
  const min = Math.min(...points) - 0.4;
  const max = Math.max(...points) + 0.4;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (points.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  const line = points.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${x(0)},${h - pad} ${line} ${x(points.length - 1)},${h - pad}`;
  return (
    <View>
      <Svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`}>
        <Defs>
          <LinearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={colors.primary} stopOpacity={0.22} />
            <Stop offset="100%" stopColor={colors.primary} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Polygon points={area} fill="url(#wg)" />
        <Polyline points={line} fill="none" stroke={colors.primary} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {points.map((v, i) => (
          <Circle key={i} cx={x(i)} cy={y(v)} r={i === points.length - 1 ? 4.5 : 2.5} fill={colors.primary} stroke={colors.background} strokeWidth={1.5} />
        ))}
      </Svg>
    </View>
  );
}
