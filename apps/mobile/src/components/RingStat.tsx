import { View } from "react-native";
import { AppText } from "./Text";
import { Numeral } from "./Numeral";
import { Icon } from "./Icon";
import { GaugeRing } from "./GaugeRing";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

type RingStatProps = {
  label: string;
  dotColor: string;
  state?: "value" | "empty" | "connect";
  value?: string;
  meta?: string;
  ringValue?: number;
  ringMax?: number;
  ringGradient?: [string, string];
  onConnect?: () => void;
  emptyText?: string;
  showRing?: boolean;
};

function Header({ label, dotColor }: { label: string; dotColor: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: dotColor }} />
      <AppText variant="footnote" muted style={{ fontWeight: "600" }}>{label}</AppText>
    </View>
  );
}

// Metric tile with an explicit state machine. INVARIANT: "connect"/"empty"
// never render a number — only "value" does.
export function RingStat({ label, dotColor, state = "value", value, meta, ringValue = 0, ringMax = 0, ringGradient, onConnect, emptyText = "—", showRing = true }: RingStatProps) {
  const { colors } = useTheme();

  if (state === "connect") {
    return (
      <View style={{ gap: 8 }}>
        <Header label={label} dotColor={dotColor} />
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Connect Apple Health"
          haptic="selection"
          onPress={onConnect}
          style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
        >
          <Icon name="heart" size={14} color={colors.accent} />
          <AppText
            variant="footnote"
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{ color: colors.accent, fontWeight: "600", flexShrink: 1 }}
          >
            Connect Apple Health
          </AppText>
        </PressableScale>
      </View>
    );
  }

  if (state === "empty") {
    return (
      <View style={{ gap: 8 }}>
        <Header label={label} dotColor={dotColor} />
        <Numeral size={28}>{emptyText}</Numeral>
      </View>
    );
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <View style={{ gap: 4, flexShrink: 1 }}>
        <Header label={label} dotColor={dotColor} />
        <Numeral size={28}>{value ?? emptyText}</Numeral>
        {meta ? <AppText variant="caption" muted>{meta}</AppText> : null}
      </View>
      {showRing ? (
        <GaugeRing value={ringValue} max={ringMax} size={44} stroke={5} gradient={ringGradient} color={ringGradient ? undefined : dotColor} />
      ) : null}
    </View>
  );
}
