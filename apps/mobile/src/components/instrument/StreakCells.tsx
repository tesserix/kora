import { View } from "react-native";
import { useTheme } from "@/theme";

export interface StreakCellsProps {
  hits: boolean[];
}

export function StreakCells({ hits }: StreakCellsProps) {
  const { instrument } = useTheme();

  return (
    <View style={{ flexDirection: "row", gap: 5 }}>
      {hits.map((hit, i) => (
        <View
          key={i}
          testID={`streak-${i}`}
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
