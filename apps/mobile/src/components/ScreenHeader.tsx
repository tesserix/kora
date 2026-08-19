import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import type { TypeVariant } from "@/theme/palette";

type Props = {
  overline?: string;
  title: string;
  // The header row WRAPS, so actions passed here drop to their own line
  // whole rather than squeezing the title (see the outer View below). As of
  // kora#264 exactly ONE of the twenty call sites passes this — recipes.tsx.
  // The issue text implied the starved-title bug was widespread; it was not,
  // and it is fixed here rather than in recipes.tsx only because the omission
  // is structural and the next caller to pass actions would inherit it.
  right?: ReactNode;
  onBack?: () => void;
  // Content headers (e.g. a challenge's dynamic title) sometimes need a
  // lighter type scale than the default nav-title look. Optional — every
  // existing call site keeps the default overline + large title.
  overlineVariant?: TypeVariant;
  titleVariant?: TypeVariant;
};

// Instrument Glass screen header (spec:
// docs/superpowers/specs/2026-08-11-kora-instrument-glass-design.md). The
// overline is demoted from the old all-caps engraved treatment to a plain
// sentence-case `mut` line — an engraved label is reserved for places an
// instrument would actually engrave one (gauge captions, slot names), not a
// generic screen breadcrumb. The back button is a glass circle, same recipe
// as meal.tsx's (glass fill + glassBorder + ink glyph).
export function ScreenHeader({ overline, title, right, onBack, overlineVariant, titleVariant }: Props) {
  const { instrument } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        justifyContent: "space-between",
        // The row wraps so `right` drops to its own line instead of starving
        // the title (kora#264). Measured on iPhone 17 Pro Max at
        // accessibility-extra-large, recipes.tsx's three actions in a 400pt
        // inner row:
        //
        //   before  title column  70pt | actions 318pt  -> header 1183pt tall
        //   after   title column 400pt | actions 318pt on line 2 -> 244pt
        //
        // Before the fix the title column was squeezed to 70pt — narrower
        // than one 90pt glyph — so "Your recipes" / "Recipes" rendered one
        // letter per line down several screens and pushed the list off the
        // bottom entirely.
        //
        // Shrinking `right` is the WRONG lever and was tried and rejected in
        // kora#263: narrowing a box past the word it holds splits short
        // indivisible labels ("kg" became "k" / "g"). "Paste" would go the
        // same way. A row of short labels wants to drop WHOLE, so the row
        // wraps.
        //
        // At `medium` the two columns still fit on one line (measured ~178pt
        // + ~122pt of 400pt), so nothing moves. Verified by screenshot at both
        // sizes, not by the suite — 1,729 green tests hid the original
        // rendering bug (kora#257).
        flexWrap: "wrap",
        rowGap: 10,
        // Only bites in the narrow band where the two columns fit but touch;
        // with `space-between` there is normally more free space than this.
        columnGap: 12,
        paddingHorizontal: 20,
        paddingTop: 4,
        paddingBottom: 14,
      }}
    >
      {/* `flexGrow: 1, flexShrink: 0`, NOT `flex: 1`. This is the line that
          decides the wrap, and it took a probe to find — the obvious suspects
          were wrong twice.

          `flex: 1` is `flexGrow: 1` + `flexShrink: 1` + `flexBasis: 0`, and a
          bare `{right}` sibling keeps RN's default `flexShrink: 0`. So this
          column was sized from whatever `right` left over, with no floor.

          Adding `flexWrap` alone changed NOTHING, because with `flexShrink: 1`
          yoga collapses this column when it decides where the line breaks:
          70 + 12 + 318 fits in 400, so the line never broke. Logging
          `onLayout` with grow/shrink toggled showed the column's true
          hypothetical size is 400pt — 400 + 12 + 318 does not fit, and the
          actions wrap. `flexShrink: 0` is safe because that 400pt is already
          clamped to the row's inner width, so this column can never overflow.

          `flexGrow: 1` stays so that whenever the row does NOT wrap the column
          still fills the line exactly as it always did — that is what keeps
          `medium` untouched on the nineteen screens that pass no actions. */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", flexGrow: 1, flexShrink: 0 }}>
        {onBack ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Go back"
            haptic="selection"
            onPress={onBack}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              alignItems: "center",
              justifyContent: "center",
              marginRight: 10,
              marginLeft: -6,
              backgroundColor: instrument.glass,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: instrument.glassBorder,
            }}
          >
            <Icon name="arrow-left" size={18} color={instrument.ink} />
          </PressableScale>
        ) : null}
        {/* `flexShrink: 1` with NO grow, and this too is measured rather than
            reasoned. While this column had `flex: 1` it GREW to fill during
            the parent's own basis measurement, so the title column reported
            the full 400pt row width whatever the title said — and the header
            then wrapped at `medium` as well, which is a regression, not a fix.
            Without the grow the column measures its own type, so the row wraps
            only when the type genuinely does not fit.

            It must still SHRINK: that is what makes a long title wrap beside
            the back button instead of running past it. Left-aligned text means
            a snug box and a filled one render identically. */}
        <View style={{ flexShrink: 1 }}>
          {overline ? (
            <AppText
              variant={overlineVariant}
              style={{ marginBottom: 4, fontSize: overlineVariant ? undefined : 13, color: instrument.mut }}
            >
              {overline}
            </AppText>
          ) : null}
          <AppText variant={titleVariant ?? "largeTitle"} style={{ color: instrument.ink }}>
            {title}
          </AppText>
        </View>
      </View>
      {right}
    </View>
  );
}
