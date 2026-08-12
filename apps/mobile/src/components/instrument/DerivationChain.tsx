import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Numeral } from "@/components/Numeral";
import { useTheme } from "@/theme";

export type DerivationRow = {
  label: string;
  value: string;
  /** Milestone 2: an Otto proposal renders as before → after, never a silent swap. */
  proposed?: string;
};

interface DerivationChainProps {
  rows: DerivationRow[];
  testID?: string;
}

export function DerivationChain({ rows, testID = "derivation-chain" }: DerivationChainProps) {
  const { instrument, spacing } = useTheme();

  return (
    <View testID={testID}>
      {rows.map((row, i) => (
        <View
          key={row.label}
          testID={`${testID}-row-${i}`}
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: spacing.sm,
            paddingVertical: spacing.xs + 2,
            borderBottomWidth: i === rows.length - 1 ? 0 : 1,
            borderBottomColor: instrument.hairline,
          }}
        >
          <AppText variant="footnote" muted>
            {row.label}
          </AppText>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.xs }}>
            {row.proposed ? (
              <AppText
                testID={`${testID}-row-${i}-was`}
                variant="footnote"
                muted
                style={{ textDecorationLine: "line-through" }}
              >
                {row.value}
              </AppText>
            ) : null}
            <Numeral>{row.proposed ?? row.value}</Numeral>
          </View>
        </View>
      ))}
    </View>
  );
}
