import type { ReactNode } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBackground } from "./AppBackground";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

type Props = {
  children: ReactNode;
  footer: ReactNode;
  header?: ReactNode;
  onBack?: () => void;
  progress?: { step: number; total: number };
};

/**
 * Above this content size the header stops being sticky and becomes the first
 * child of the scroll view instead (kora#284).
 *
 * At accessibility-extra-large the onboarding scroll region reached only "Age"
 * before the footer: both rulers and the goal selector were below the fold on
 * first paint, under a large empty band. A screen whose primary controls are
 * all below the fold does not read as "scroll for more", it reads as broken —
 * the same misreading cost a wrong conclusion on sign-in (kora#173). Capping
 * the dial does not fix it, because the numeral and the captions are what
 * double, and shrinking those is the `flexShrink` failure class kora#263 ruled
 * out.
 *
 * 1.3 is a JUDGEMENT, not a measurement. It sits between iOS's `large` (1.118)
 * and `xLarge` (1.353), which is roughly where the header's text growth starts
 * costing a full control's worth of height on a 852pt window — past it the
 * header is spending more than a ruler to say the same thing. Anything at or
 * below the threshold is untouched, which is what keeps the `onboarding`
 * golden at the default content size from moving.
 */
export const HEADER_SCROLLS_ABOVE_FONT_SCALE = 1.3;

// Shared layout for the pre-app screens (sign-in and both onboarding steps).
//
// The primary action lives in a sticky footer OUTSIDE the scroll view. Putting
// it inline at the end of the scroll means a long form plus an open keyboard
// can push it out of reach.
//
// Not built on ScreenHeader: that component forces a title into the header and
// has no progress affordance, whereas this design keeps the title in the body.
// The back control still matches ScreenHeader's conventions ("Go back",
// selection haptic, arrow-left) so the two feel identical in use.
export function AuthScaffold({ children, footer, header, onBack, progress }: Props) {
  const { colors, instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const hasNavRow = Boolean(onBack || progress);
  // Gated on `header` as well as the scale so the sign-in path — which passes
  // no header — takes the identical branch at every content size. There is no
  // fontScale at which a headerless scaffold renders differently than it did.
  const headerScrolls = Boolean(header) && fontScale > HEADER_SCROLLS_ABOVE_FONT_SCALE;

  // One element, two possible parents. Built once so the sticky and scrolling
  // arrangements cannot drift apart: same testID, same inset ownership, same
  // box. The only difference is the negative horizontal margin, which cancels
  // the content container's `paddingHorizontal` so the header keeps EXACTLY the
  // full-width box it has as a sibling. Without it the header would be inset
  // twice — and PlanDial derives its available width from the window less one
  // `spacing.lg` on each side, so the second inset would silently make the dial
  // wider than the space it is drawn into.
  const headerBlock = header ? (
    <View
      testID="auth-scaffold-header-wrapper"
      style={{
        paddingTop: hasNavRow ? 0 : insets.top,
        ...(headerScrolls ? { marginHorizontal: -spacing.lg } : null),
      }}
    >
      {header}
    </View>
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />

      {hasNavRow ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.md,
            paddingTop: insets.top + spacing.sm,
            paddingHorizontal: spacing.lg,
            paddingBottom: spacing.sm,
          }}
        >
          {onBack ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Go back"
              haptic="selection"
              hitSlop={12}
              onPress={onBack}
              style={{ minWidth: 44, minHeight: 44, justifyContent: "center", marginLeft: -6 }}
            >
              <Icon name="arrow-left" size={22} color={colors.label} />
            </PressableScale>
          ) : null}

          {progress ? (
            <View
              accessibilityLabel={`Step ${progress.step} of ${progress.total}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              {Array.from({ length: progress.total }, (_, i) => {
                const current = i + 1 === progress.step;
                return (
                  <View
                    key={i}
                    testID="progress-dot"
                    style={{
                      width: current ? 20 : 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: current ? colors.primary : colors.border,
                    }}
                  />
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}

      {headerScrolls ? null : headerBlock}

      <ScrollView
        testID="auth-scaffold-scroll"
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{
          flexGrow: 1,
          // When the header scrolls it is the first child, and it still owns
          // the top inset, so the content must not add one on top of it. The
          // gap between it and the body is the container's own `gap`, which is
          // the same spacing.md the sticky arrangement uses.
          paddingTop: headerScrolls
            ? hasNavRow
              ? spacing.sm
              : 0
            : hasNavRow
              ? spacing.sm
              : header
                ? spacing.md
                : insets.top + spacing.xl,
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.lg,
          gap: spacing.md,
        }}
      >
        {headerScrolls ? headerBlock : null}
        {children}
      </ScrollView>

      <View
        testID="auth-scaffold-footer"
        style={{
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.md,
          paddingBottom: insets.bottom + spacing.md,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        }}
      >
        {footer}
      </View>
    </View>
  );
}
