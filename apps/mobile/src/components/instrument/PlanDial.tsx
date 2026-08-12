import { View } from "react-native";
import Svg, { Circle, Line } from "react-native-svg";
import { useTheme } from "@/theme";
import { AppText } from "@/components/Text";
import {
  buildGaugeTicks,
  needleFor,
  GAUGE_CENTER_X,
  GAUGE_CENTER_Y,
  GAUGE_VIEW_H,
  GAUGE_VIEW_W,
} from "./gauge";

// GaugeDial is a PROGRESS instrument — value eaten against a budget, with an
// eaten/burned footer. This is a SETTING instrument: the needle sits at the
// target's position on a fixed scale, so changing activity sweeps the needle
// rather than nudging a fill. Same geometry, so the two read as one panel.
export const PLAN_DIAL_MIN = 1200;
export const PLAN_DIAL_MAX = 3600;

interface PlanDialProps {
  kcal: number | null;
  testID?: string;
}

export function PlanDial({ kcal, testID = "plan-dial" }: PlanDialProps) {
  const { instrument } = useTheme();
  const hasTarget = kcal !== null && Number.isFinite(kcal);

  const fraction = hasTarget
    ? Math.min(1, Math.max(0, (kcal - PLAN_DIAL_MIN) / (PLAN_DIAL_MAX - PLAN_DIAL_MIN)))
    : 0;
  const ticks = buildGaugeTicks(hasTarget ? fraction : 0);
  const needle = hasTarget ? needleFor(fraction) : null;

  return (
    <View testID={testID} accessible={false}>
      <Svg width="100%" height={GAUGE_VIEW_H} viewBox={`0 0 ${GAUGE_VIEW_W} ${GAUGE_VIEW_H}`}>
          {ticks.map((t, i) => (
            <Line
              key={i}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              strokeWidth={t.width}
              strokeLinecap="round"
              stroke={t.lit ? (t.red ? instrument.accent : instrument.tickLit) : instrument.tick}
            />
          ))}
          {needle ? (
            <>
              <Line
                testID={`${testID}-needle`}
                x1={needle.x1}
                y1={needle.y1}
                x2={needle.x2}
                y2={needle.y2}
                stroke={instrument.accent}
                strokeWidth={2.6}
                strokeLinecap="round"
              />
              <Circle cx={GAUGE_CENTER_X} cy={GAUGE_CENTER_Y} r={5} fill={instrument.accent} />
            </>
          ) : (
            <Circle
              cx={GAUGE_CENTER_X}
              cy={GAUGE_CENTER_Y}
              r={5}
              fill="none"
              stroke={instrument.tick}
              strokeWidth={1.4}
            />
          )}
        </Svg>
        {!hasTarget ? (
          <AppText
            testID={`${testID}-awaiting`}
            variant="caption"
            muted
            style={{ textAlign: "center", letterSpacing: 1.6, textTransform: "uppercase" }}
          >
            Awaiting your numbers
          </AppText>
        ) : null}
    </View>
  );
}
