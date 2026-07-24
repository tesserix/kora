import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";

type Props = { variant?: "success" | "neutral"; icon?: string; children: ReactNode };

export function Badge({ variant = "neutral", icon, children }: Props) {
  const { colors, radius } = useTheme();
  const bg = variant === "success" ? "hsl(145, 55%, 92%)" : colors.secondary;
  const fg = variant === "success" ? "hsl(145, 60%, 30%)" : colors.secondaryForeground;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.full, backgroundColor: bg }}>
      {icon ? <Icon name={icon} size={12} color={fg} /> : null}
      <AppText style={{ fontSize: 12, fontWeight: "700", color: fg }}>{children}</AppText>
    </View>
  );
}
