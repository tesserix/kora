import Svg, { Line } from "react-native-svg";
import { useTheme } from "@/theme";

export interface SubDialProps {
  fraction: number;
  size?: number;
  testID?: string;
}

export function SubDial({ fraction, size = 42, testID = "subdial" }: SubDialProps) {
  const { instrument } = useTheme();
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
        stroke={t <= f ? instrument.accent : instrument.tick}
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
