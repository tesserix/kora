import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText } from "./Text";
import { Overline } from "./Overline";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";

type Props = { overline?: string; title: string; right?: ReactNode; onBack?: () => void };

export function ScreenHeader({ overline, title, right, onBack }: Props) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 4, paddingBottom: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", flex: 1 }}>
        {onBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go back"
            onPress={onBack}
            style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center", marginRight: 4, marginLeft: -8 }}
          >
            <Icon name="arrow-left" size={22} color={colors.foreground} />
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }}>
          {overline ? <Overline style={{ marginBottom: 3 }}>{overline}</Overline> : null}
          <AppText style={{ fontSize: 28, fontWeight: "800", letterSpacing: -0.84 }}>{title}</AppText>
        </View>
      </View>
      {right}
    </View>
  );
}
