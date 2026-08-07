import { TextInput, View, type TextInputProps } from "react-native";
import { AppText } from "./Text";
import { Card } from "./Card";
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
export function Field({ label, error, accessibilityLabel, style, ...inputProps }: FieldProps) {
  const { colors, spacing, fontSize } = useTheme();

  return (
    <View style={{ gap: 6 }}>
      <AppText variant="footnote" muted>
        {label}
      </AppText>

      <Card variant="elevated" style={{ padding: 0 }}>
        <TextInput
          accessibilityLabel={accessibilityLabel ?? label}
          placeholderTextColor={colors.secondaryLabel}
          style={[
            {
              paddingHorizontal: spacing.md,
              paddingVertical: 12,
              color: colors.label,
              fontSize: fontSize.base,
              minHeight: 48,
            },
            style,
          ]}
          {...inputProps}
        />
      </Card>

      {error ? (
        <AppText
          testID="field-error"
          variant="footnote"
          accessibilityLiveRegion="polite"
          style={{ color: colors.destructive }}
        >
          {error}
        </AppText>
      ) : null}
    </View>
  );
}
