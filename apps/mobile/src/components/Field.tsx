import { useState } from "react";
import { StyleSheet, TextInput, View, type TextInputProps } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

export interface FieldProps extends TextInputProps {
  label: string;
  error?: string;
}

// A labelled input: persistent label above, input below, optional error slot
// beneath. Replaces the placeholder-as-label pattern across the auth flow —
// placeholder-only inputs lose their label the moment the user types, so
// anyone who pauses mid-form loses context, and screen readers get a
// placeholder where a label belongs.
//
// The error slot is deliberately unused by every screen in this pass: sign-in
// keeps a single screen-level error and onboarding validates on submit.
// Wiring per-field errors would change validation behaviour.
//
// Restyled to Instrument Glass: an inset "well" (recessed track background)
// with a glassBorder edge, ink text, mut placeholder, and an accent-colored
// border while focused (spec: Field.tsx > "inset well bg, glassBorder
// border, ink text, mut placeholder, accent focus ring").
export function Field({ label, error, accessibilityLabel, style, onFocus, onBlur, ...inputProps }: FieldProps) {
  const { instrument, spacing, fontSize, fonts } = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={{ gap: 6 }}>
      {/* Engraved label: 9px uppercase, ~0.22em tracking, mut — the spec's
          "engraved labels" recipe (9-11px / 0.14-0.26em / mut), matched to
          this field's own size rather than the shared 10px/1.5 recipe in
          instrument/typography.ts. */}
      <AppText style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.98, color: instrument.mut }}>
        {label}
      </AppText>

      <View
        style={{
          borderRadius: 12,
          backgroundColor: instrument.inset,
          borderWidth: focused ? 1.5 : StyleSheet.hairlineWidth,
          borderColor: focused ? instrument.accent : instrument.glassBorder,
        }}
      >
        <TextInput
          accessibilityLabel={accessibilityLabel ?? label}
          placeholderTextColor={instrument.mut}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[
            {
              paddingHorizontal: spacing.md,
              paddingVertical: 12,
              color: instrument.ink,
              fontSize: fontSize.base,
              minHeight: 48,
              fontFamily: fonts.mono,
              fontVariant: ["tabular-nums"],
            },
            style,
          ]}
          {...inputProps}
        />
      </View>

      {error ? (
        <AppText testID="field-error" accessibilityLiveRegion="polite" style={{ fontSize: 13, color: instrument.danger }}>
          {error}
        </AppText>
      ) : null}
    </View>
  );
}
