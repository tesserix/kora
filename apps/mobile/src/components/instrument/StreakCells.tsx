import { View } from "react-native";
import { useTheme } from "@/theme";

export interface StreakCellsProps {
  hits: boolean[];
  /** testID prefix for each cell (`${testIDPrefix}-${i}`). Defaults to "streak" —
   * existing callers get the original testIDs unchanged. Screens that render more
   * than one StreakCells row (e.g. Trends' protein/sleep duo) pass a distinct
   * prefix so `getByTestId` stays unambiguous. */
  testIDPrefix?: string;
}

export function StreakCells({ hits, testIDPrefix = "streak" }: StreakCellsProps) {
  const { instrument } = useTheme();

  return (
    <View style={{ flexDirection: "row", gap: 5 }}>
      {hits.map((hit, i) => (
        <View
          key={i}
          testID={`${testIDPrefix}-${i}`}
          style={{
            flex: 1,
            height: 26,
            borderRadius: 6,
            backgroundColor: hit ? instrument.accent : instrument.tick,
          }}
        />
      ))}
    </View>
  );
}
