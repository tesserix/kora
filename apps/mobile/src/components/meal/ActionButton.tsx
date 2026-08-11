import { StyleSheet } from "react-native";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

export interface ActionButtonProps {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}

// app/meal.tsx's Edit/Duplicate/Delete actions row entry — a bordered glass
// pill, Delete alone in instrument.danger (the accent budget's one
// exception: danger is a separate, non-accent signal color, same as
// elsewhere in the uplift).
export function ActionButton({ label, accessibilityLabel, onPress, disabled, danger }: ActionButtonProps) {
  const { instrument } = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      haptic="selection"
      disabled={disabled}
      onPress={onPress}
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 13,
        borderRadius: 16,
        backgroundColor: instrument.glass,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: instrument.glassBorder,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <AppText style={{ color: danger ? instrument.danger : instrument.ink, fontWeight: "600", fontSize: 14 }}>
        {label}
      </AppText>
    </PressableScale>
  );
}
