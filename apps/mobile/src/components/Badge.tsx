import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";
import { withAlpha } from "@/lib/color";

type Props = { variant?: "success" | "neutral"; icon?: string; children: ReactNode };

// Capsule badge, tinted at 15% opacity of its semantic color (derived from the
// theme token — never a hardcoded hex/hsl literal).
export function Badge({ variant = "neutral", icon, children }: Props) {
  const { colors, radius } = useTheme();
  const bg = variant === "success" ? withAlpha(colors.success, 0.15) : colors.cardSecondary;
  const fg = variant === "success" ? colors.success : colors.label;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: radius.full,
        backgroundColor: bg,
      }}
    >
      {icon ? <Icon name={icon} size={12} color={fg} /> : null}
      <AppText variant="footnote" style={{ fontWeight: "700", color: fg }}>
        {children}
      </AppText>
    </View>
  );
}
