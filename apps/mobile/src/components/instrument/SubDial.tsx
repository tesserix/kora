import Svg, { Line } from "react-native-svg";
import { useTheme, type InstrumentTokens } from "@/theme";

export interface SubDialProps {
  fraction: number;
  size?: number;
  testID?: string;
  /**
   * Overrides the color source for a caller that must not follow the
   * system color scheme — e.g. the always-dark Capture screen, which reads
   * from `INSTRUMENT_DARK_FIXED` rather than `useTheme().instrument` so it
   * stays dark even when the device is in light mode. Defaults to the
   * scheme-aware theme, unchanged for every other caller.
   */
  tokens?: Pick<InstrumentTokens, "accent" | "tick">;
}

export function SubDial({ fraction, size = 42, testID = "subdial", tokens }: SubDialProps) {
  const { instrument } = useTheme();
  const colors = tokens ?? instrument;
  const f = Math.min(Math.max(fraction, 0), 1);
  const C = 22;
  const R = 17;
  const START = -225;
  const END = 45;
  const SEG = 24;

  const lines = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const a = ((START + t * (END - START)) * Math.PI) / 180;
    lines.push(
      <Line
        key={i}
        testID={`${testID}-seg-${i}`}
        x1={C + (R - 4) * Math.cos(a)}
        y1={C + (R - 4) * Math.sin(a)}
        x2={C + R * Math.cos(a)}
        y2={C + R * Math.sin(a)}
        stroke={t <= f ? colors.accent : colors.tick}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    );
  }

  return (
    <Svg width={size} height={size} viewBox="0 0 44 44" testID={testID}>
      {lines}
    </Svg>
  );
}
