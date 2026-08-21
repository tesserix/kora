import { StyleSheet, View } from "react-native";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

export type SegmentedGlassOption = { key: string; label: string };

type Props = {
  options: SegmentedGlassOption[];
  value: string;
  onChange: (key: string) => void;
  testID?: string;
};

// The one app-wide segmented-control recipe (spec: "SEGMENTED CONTROL — one
// style app-wide"): a glass-tinted track holding equal-width segments, the
// active one lit as a solid `ink` pill carrying `bg` text, inactive segments
// `mut` on the bare track, labels in the 11px uppercase/tracked engraved
// treatment reserved for instrument zones. It's a plain View (not a
// `GlassPanel`) — glass never stacks on glass, so this is meant to live
// inside a `GlassPanel` or other glass surface, same as Trends' Weight panel.
// Extracted from Trends' original `RangeSegmented` (app/(tabs)/progress.tsx)
// — that screen now consumes this component instead of a local copy.
//
// kora#166: the selected segment used to be an `inset` well + `glassBorder`
// ring. Both tokens are near-transparent tints of the surface they sit on, so
// composited over the glass track the "selected" pill measured ~1.2:1 against
// its own surroundings — well under WCAG 2.1 SC 1.4.11's 3:1 floor for a UI
// component's state indicator, and in practice invisible. Reading which of
// Male/Female was active meant comparing two label greys. The fill is now the
// existing `ink` token (the same value `tickLit` uses for a lit instrument
// mark), which clears 3:1 by an order of magnitude in both schemes without
// introducing any new colour — `accent` stays reserved for the rulers' centre
// index, so the control does not compete with them for the one accent.
//
// kora#288 — DO NOT CAP THIS LABEL'S DYNAMIC TYPE. The obvious move here is
// the one kora#274 made for `largeTitle`: cap `maxFontSizeMultiplier` at
// Apple's own ceiling for the text style, on the grounds that RN multiplies
// every authored size by a single body-derived multiplier while Apple's ramp
// is per-text-style. That reasoning does not transfer to an 11pt label, and
// the measurement says so.
//
// Apple's ramp was read straight out of UIKit on the target device rather than
// recalled — `UIFont.preferredFont(forTextStyle:compatibleWith:)` over every
// content-size category, run under `simctl spawn` on the iPhone 17 Pro Max
// (iOS 26.2). caption1 goes 12pt at `large` to 43pt at AX5. Normalised to
// `large`, against the multipliers RN actually applies
// (React/CoreModules/RCTAccessibilityManager.mm):
//
//            L      xL     xxL    xxxL   AX1    AX2    AX3    AX4    AX5
//   Apple    1.000  1.167  1.333  1.500  1.833  2.167  2.667  3.083  3.583
//   RN       1.000  1.118  1.235  1.353  1.786  2.143  2.643  3.143  3.571
//
// RN is UNDER Apple almost everywhere and never more than 2% away — at AX3 it
// is 2.643 against Apple's 2.667. There is no over-scale to correct. This is
// the opposite of largeTitle, where RN applies 2.643 against Apple's 1.529 and
// the cap is a correction toward the platform. Capping here would put the label
// BELOW what iOS itself draws, which is exactly the cap kora#268 rejected.
//
// Worth knowing, because it is the strongest argument in the other direction:
// UIKit's own `UISegmentedControl` does not participate in Dynamic Type AT ALL.
// Measured the same way — a control built inside a window with
// `traitOverrides.preferredContentSizeCategory` set — its title labels resolve
// to a flat 13.0pt and its intrinsic height to a flat 31.0pt at every category
// from xS to AX5, while a `.caption1` UILabel in the SAME window scales
// 11 -> 43pt. So Apple's answer to a segmented control at accessibility sizes
// is to freeze it. We deliberately do NOT copy that: a frozen 11pt label is a
// real accessibility loss, and unlike Apple we cannot also redesign every
// caller's copy. We scale, and we shrink to fit when the copy is too long —
// see `minimumFontScale` below for what that trade actually costs.
export function SegmentedGlass({ options, value, onChange, testID = "segmented-glass" }: Props) {
  const { instrument } = useTheme();
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        backgroundColor: instrument.glass,
        borderRadius: 12,
        padding: 3,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: instrument.glassBorder,
      }}
    >
      {options.map((opt) => {
        const selected = opt.key === value;
        return (
          <PressableScale
            key={opt.key}
            accessibilityRole="tab"
            accessibilityLabel={opt.label}
            accessibilityState={{ selected }}
            haptic="selection"
            onPress={() => {
              if (opt.key !== value) onChange(opt.key);
            }}
            testID={`${testID}-segment-${opt.key}`}
            style={{
              flex: 1,
              paddingVertical: 7,
              // kora#288. The segment used to have NO horizontal padding, so a
              // label was entitled to fill its box wall-to-wall — and at
              // accessibility sizes it does. Measured on device at AX3 (iPhone
              // 17 Pro Max, a11y frames + ink extents off the 3x capture):
              // Settings' three 120.3pt segments rendered SYSTEM's ink at
              // 41.0..155.7 and LIGHT's at 176.0..262.7. Nothing crossed a
              // boundary — the failure is not literal overlap — but with zero
              // gutter the three labels read as one run-on string
              // "SYSTEM LIGHT DARK" and the control stops looking segmented at
              // all. Feedback was worse: "SOMETHING'S BROKEN" ended at 216.3
              // and "I HAVE AN IDEA" began at 223.0, so the N and the I sat
              // 6.7pt apart while the letters WITHIN each word are tracked
              // 1.4pt — the eye groups across the segment boundary before it
              // groups within the word.
              //
              // 8pt gives a 16pt gutter between adjacent labels, an order above
              // the 1.4pt letter tracking, so word grouping wins. It costs the
              // tightest real label (SYSTEM, which needs 121.2pt at AX3 in a
              // 120.3pt box) a shrink to ~86% — it still renders at ~25pt,
              // over twice its authored 11pt and well above the flat 13pt
              // UIKit's own UISegmentedControl would have used (see below).
              paddingHorizontal: 8,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: selected ? instrument.ink : "transparent",
              // The border is drawn on every segment, selected or not, so the
              // pill cannot change the row's metrics as it moves — a hairline
              // appearing on selection shifts the label by half a point and
              // makes the whole control twitch.
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: selected ? instrument.ink : "transparent",
            }}
          >
            <AppText
              numberOfLines={1}
              adjustsFontSizeToFit
              // 0.5, not the 0.85 that used to be here, because 0.85 was never
              // in force and stating it was actively misleading (kora#288).
              // MEASURED at AX3 on device: the label's own scaled size is
              // 11 * 2.643 = 29.1pt, and "SOMETHING'S BROKEN" rendered with a
              // 10.7pt cap height => ~15pt, i.e. 0.51 of the scaled size. RN's
              // iOS Text ignores `minimumFontScale` and shrinks as far as it
              // takes to fit. The prop still matters on Android, which DOES
              // honour it, so leaving 0.85 there meant the same control clipped
              // on one platform where it shrank on the other. 0.5 is the
              // measured iOS floor, so the two platforms now agree.
              minimumFontScale={0.5}
              style={{
                fontSize: 11,
                letterSpacing: 1.4,
                textTransform: "uppercase",
                fontWeight: "600",
                // Inverted on the lit pill: `bg` is the page colour, so the
                // active label reads as cut out of the fill rather than
                // printed on it.
                color: selected ? instrument.bg : instrument.mut,
              }}
            >
              {opt.label}
            </AppText>
          </PressableScale>
        );
      })}
    </View>
  );
}
