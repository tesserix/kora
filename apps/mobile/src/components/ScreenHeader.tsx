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
        paddingHorizontal: 20,
        paddingTop: 4,
        paddingBottom: 14,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", flex: 1 }}>
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
        <View style={{ flex: 1 }}>
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
