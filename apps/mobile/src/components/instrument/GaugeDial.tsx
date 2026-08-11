import { View } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";
import {
  buildGaugeTicks,
  needleFor,
  scaleAnchor,
  GAUGE_VIEW_H,
  GAUGE_VIEW_W,
  GAUGE_CENTER_X,
  GAUGE_CENTER_Y,
} from "./gauge";

// The hub dot sits at GAUGE_CENTER_Y; keep this much vertical clearance above it
// so the center overlay's label never descends into the hub/needle-tail zone.
const HUB_CLEARANCE = 18;
// Distance, in SVG units, from the bottom of the viewBox up to the clearance
// line above the hub — used as the overlay's `bottom` inset so its content
// area ends above the hub instead of an eyeballed percentage.
const OVERLAY_BOTTOM = GAUGE_VIEW_H - (GAUGE_CENTER_Y - HUB_CLEARANCE);

export interface GaugeDialProps {
  value: number; // eaten kcal
  target: number; // budget kcal
  burned?: number;
  centerLabel?: string;
  testID?: string;
}

export function GaugeDial({
  value,
  target,
  burned,
  centerLabel = "kcal in reserve",
  testID = "gauge-dial",
}: GaugeDialProps) {
  const { instrument, fonts } = useTheme();
  const fraction = target > 0 ? Math.min(value / target, 1) : 0;
  const remaining = Math.max(0, Math.round(target - value));
  const needle = needleFor(fraction);
  const mono = { fontFamily: fonts.mono, fontVariant: ["tabular-nums" as const] };

  const tickColor = (t: { lit: boolean; red: boolean; major: boolean }) => {
    if (t.red) return t.lit ? instrument.accent : `${instrument.accent}73`; // 45% alpha suffix on hex
    if (!t.lit) return instrument.tick;
    return t.major ? instrument.tickLit : `${instrument.tickLit}8C`; // 55% alpha on minor lit ticks
  };

  const footer: Array<[number, string]> = [
    [value, "Eaten"],
    ...(burned === undefined ? [] : ([[burned, "Burned"]] as Array<[number, string]>)),
    [target, "Budget"],
  ];

  const accessibilityLabel = `${Math.round(remaining).toLocaleString()} calories in reserve of ${Math.round(
    target,
  ).toLocaleString()}`;

  return (
    <View testID={testID} accessible accessibilityLabel={accessibilityLabel}>
      <View style={{ alignItems: "center" }}>
        <Svg width={GAUGE_VIEW_W} height={GAUGE_VIEW_H} viewBox={`0 0 ${GAUGE_VIEW_W} ${GAUGE_VIEW_H}`}>
          {buildGaugeTicks(fraction).map((t, i) => (
            <Line
              key={i}
              testID={`gauge-tick-${i}`}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={tickColor(t)}
              strokeWidth={t.width}
              strokeLinecap="round"
            />
          ))}
          {[0, 0.5, 1].map((t) => {
            const a = scaleAnchor(t);
            return (
              <SvgText key={t} x={a.x} y={a.y} textAnchor={a.anchor} fontSize={9} fill={instrument.mut}>
                {/* explicit rounding — scale numerals must never show API float noise */}
                {Math.round(target * t).toLocaleString()}
              </SvgText>
            );
          })}
          <Line
            testID="gauge-needle"
            x1={needle.x1}
            y1={needle.y1}
            x2={needle.x2}
            y2={needle.y2}
            stroke={instrument.accent}
            strokeWidth={3}
            strokeLinecap="round"
          />
          <Circle cx={GAUGE_CENTER_X} cy={GAUGE_CENTER_Y} r={4.5} fill={instrument.accent} />
        </Svg>
        <View
          testID="gauge-center-overlay"
          style={{
            position: "absolute",
            // top/bottom bound the overlay inside the Svg's own height so the
            // numeral's line box has room to breathe and can't clip — top clears
            // the scale-numeral band (~y 61), bottom (OVERLAY_BOTTOM, derived from
            // GAUGE_CENTER_Y and HUB_CLEARANCE) keeps the label above the hub dot
            // and the needle tail instead of an eyeballed percentage.
            top: "38%",
            bottom: OVERLAY_BOTTOM,
            left: 0,
            right: 0,
            alignItems: "center",
          }}
        >
          <AppText
            variant="body"
            style={[{ fontSize: 44, lineHeight: 50, color: instrument.ink, letterSpacing: -1.2 }, mono]}
          >
            {remaining.toLocaleString()}
          </AppText>
          <AppText
            variant="body"
            style={{
              fontSize: 10,
              letterSpacing: 3,
              textTransform: "uppercase",
              color: instrument.accent,
              marginTop: 6,
              fontWeight: "600",
            }}
          >
            {centerLabel}
          </AppText>
        </View>
      </View>
      <View
        style={{
          flexDirection: "row",
          borderTopWidth: 1,
          borderTopColor: instrument.hairline,
          paddingTop: 12,
          marginTop: 4,
        }}
      >
        {footer.map(([v, k]) => (
          <View key={k} style={{ flex: 1, alignItems: "center" }}>
            <AppText variant="body" style={[{ fontSize: 15, fontWeight: "600", color: instrument.ink }, mono]}>
              {Math.round(Number(v)).toLocaleString()}
            </AppText>
            <AppText
              variant="body"
              style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: instrument.mut, marginTop: 3 }}
            >
              {k}
            </AppText>
          </View>
        ))}
      </View>
    </View>
  );
}
