import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";
import { withAlpha } from "@/lib/color";

type Props = { variant?: "success" | "accent" | "neutral" | "instrument"; icon?: string; children: ReactNode };

// Capsule badge, tinted at 15% opacity of its semantic color (derived from the
// theme token — never a hardcoded hex/hsl literal).
//
// "instrument" is the one exception: a solid instrument.accent fill with
// instrument.accentOn text, not the 15%-alpha tint the legacy variants use.
// It exists for Instrument Glass screens (e.g. more.tsx) where an unread
// count is the single allowed accent element and needs to read as a solid,
// engraved pill rather than a soft legacy tint — the default variants are
// untouched.
export function Badge({ variant = "neutral", icon, children }: Props) {
  const { colors, radius, instrument } = useTheme();
  if (variant === "instrument") {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderRadius: radius.full,
          backgroundColor: instrument.accent,
        }}
      >
        {icon ? <Icon name={icon} size={12} color={instrument.accentOn} /> : null}
        <AppText variant="footnote" style={{ fontWeight: "700", color: instrument.accentOn }}>
          {children}
        </AppText>
      </View>
    );
  }
  const tint = variant === "success" ? colors.success : variant === "accent" ? colors.accent : undefined;
  const bg = tint ? withAlpha(tint, 0.15) : colors.cardSecondary;
  const fg = tint ?? colors.label;
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
