import { View } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type Props = { initials: string; size?: number };

export function Avatar({ initials, size = 40 }: Props) {
  const { colors } = useTheme();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.secondary, alignItems: "center", justifyContent: "center" }}>
      <AppText style={{ fontSize: size * 0.38, fontWeight: "700", color: colors.secondaryForeground }}>{initials}</AppText>
    </View>
  );
}
