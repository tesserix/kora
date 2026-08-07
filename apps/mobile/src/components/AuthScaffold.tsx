import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBackground } from "./AppBackground";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

type Props = {
  children: ReactNode;
  footer: ReactNode;
  onBack?: () => void;
  progress?: { step: number; total: number };
};

// Shared layout for the pre-app screens (sign-in and both onboarding steps).
//
// The primary action lives in a sticky footer OUTSIDE the scroll view, as in
// design-system/ui_kits/kora/Onboarding.jsx. The shipped screens put it inline
// at the end of the scroll, where a long form plus an open keyboard can push it
// out of reach.
//
// Not built on ScreenHeader: that component forces a title into the header and
// has no progress affordance, whereas this design keeps the title in the body.
// The back control still matches ScreenHeader's conventions ("Go back",
// selection haptic, arrow-left) so the two feel identical in use.
export function AuthScaffold({ children, footer, onBack, progress }: Props) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const hasHeader = Boolean(onBack || progress);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />

      {hasHeader ? (
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

      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: hasHeader ? spacing.sm : insets.top + spacing.xl,
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.lg,
          gap: spacing.md,
        }}
      >
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
