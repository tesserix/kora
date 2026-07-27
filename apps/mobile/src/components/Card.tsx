import { View, type ViewProps } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useTheme } from "@/theme";

type CardProps = ViewProps & { variant?: "flat" | "elevated" | "hero" };

// Flat = the original borderless surface (unchanged default). Elevated adds a
// real soft shadow + layered surface. Hero adds a faint green top-gradient tint.
export function Card({ variant = "flat", style, children, ...rest }: CardProps) {
  const { colors, radius, spacing, shadows, gradients } = useTheme();
  const elevated = variant !== "flat";
  const borderRadius = elevated ? radius.xl : radius.lg;

  return (
    <View
      style={[
        {
          backgroundColor: elevated ? colors.elevated : colors.card,
          borderRadius,
          padding: spacing.md,
          ...(elevated ? shadows.card : null),
        },
        style,
      ]}
      {...rest}
    >
      {variant === "hero" ? (
        <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 96, borderRadius, overflow: "hidden" }}>
          <Svg width="100%" height={96} preserveAspectRatio="none" viewBox="0 0 100 96">
            <Defs>
              <LinearGradient id="cardHero" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%" stopColor={gradients.green[0]} stopOpacity={0.12} />
                <Stop offset="100%" stopColor={gradients.green[0]} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect x={0} y={0} width={100} height={96} fill="url(#cardHero)" />
          </Svg>
        </View>
      ) : null}
      {children}
    </View>
  );
}
