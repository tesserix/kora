import { View } from "react-native";
import { useTheme } from "@/theme";

// Kora's mark, from assets/images/icon.png: a 3x3 grid of dots. Six large in
// `primary`; three smaller muted ones at top-centre, middle-right and
// bottom-centre. Plain Views — the shape is circles, so SVG buys nothing.
//
// This is the source of truth for the mark. It is NOT the Lucide `sparkles`
// glyph that BrandLockup used to render; that came from the prototype kit and
// was never Kora's mark.
const MUTED_POSITIONS = new Set(["0-1", "1-2", "2-1"]);

// Fraction of a grid cell taken up by a large dot, and the muted dots'
// diameter relative to a large one. Both measured off icon.png.
const LARGE_DOT_RATIO = 0.82;
const MUTED_DOT_RATIO = 0.6;

export interface BrandMarkProps {
  size?: number;
}

export function BrandMark({ size = 40 }: BrandMarkProps) {
  const { colors } = useTheme();
  const cell = size / 3;
  const largeDot = cell * LARGE_DOT_RATIO;
  const mutedDot = largeDot * MUTED_DOT_RATIO;

  return (
    <View style={{ width: size, height: size }}>
      {[0, 1, 2].map((row) => (
        <View key={row} style={{ flexDirection: "row", height: cell }}>
          {[0, 1, 2].map((col) => {
            const muted = MUTED_POSITIONS.has(`${row}-${col}`);
            const diameter = muted ? mutedDot : largeDot;
            return (
              <View
                key={col}
                style={{ width: cell, height: cell, alignItems: "center", justifyContent: "center" }}
              >
                <View
                  testID={`brand-dot-${row}-${col}`}
                  style={{
                    width: diameter,
                    height: diameter,
                    borderRadius: diameter / 2,
                    backgroundColor: muted ? colors.cardSecondary : colors.primary,
                  }}
                />
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}
