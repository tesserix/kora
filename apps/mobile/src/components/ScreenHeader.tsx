import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "./Text";
import { Overline } from "./Overline";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

type Props = { overline?: string; title: string; right?: ReactNode; onBack?: () => void };

export function ScreenHeader({ overline, title, right, onBack }: Props) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        justifyContent: "space-between",
        paddingHorizontal: 20,
        paddingTop: 4,
        paddingBottom: 14,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", flex: 1 }}>
        {onBack ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Go back"
            haptic="selection"
            onPress={onBack}
            style={{
              width: 36,
              height: 36,
              alignItems: "center",
              justifyContent: "center",
              marginRight: 4,
              marginLeft: -6,
            }}
          >
            <Icon name="arrow-left" size={22} color={colors.label} />
          </PressableScale>
        ) : null}
        <View style={{ flex: 1 }}>
          {overline ? <Overline style={{ marginBottom: 4 }}>{overline}</Overline> : null}
          <AppText variant="largeTitle">{title}</AppText>
        </View>
      </View>
      {right}
    </View>
  );
}
