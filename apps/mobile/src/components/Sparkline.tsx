import Svg, { Polyline } from "react-native-svg";
import { useTheme } from "@/theme";

type Props = { points: number[]; color?: string; width?: number; height?: number };

// Tiny static trend line for tiles (e.g. 7-day avg intake). Caller guards the
// "not enough data" case visually; we simply render nothing below 2 points.
export function Sparkline({ points, color, width = 72, height = 28 }: Props) {
  const { colors } = useTheme();
  if (points.length < 2) return null;
  const pad = 2;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (points.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const line = points.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return (
    <Svg width={width} height={height}>
      <Polyline testID="sparkline" points={line} fill="none" stroke={color ?? colors.accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
