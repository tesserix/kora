import { Switch, type SwitchProps } from "react-native";
import { useTheme } from "@/theme";

type ToggleSwitchProps = Omit<SwitchProps, "trackColor">;

// Themed wrapper around RN's Switch. On iOS, RN's Switch hardcodes
// `alignSelf: "flex-start"` on its native style (Switch.js), which wins over
// any parent `alignItems: "center"` — the switch pins to the top of its row
// instead of centering, nearly clipping GlassPanel's top hairline on the
// first row. Passing `alignSelf: "center"` back in via `style` overrides that
// default (RN flattens style arrays right-to-left), so every toggle row
// centers consistently across Reminders/Friends/Settings.
export function ToggleSwitch({ style, ...props }: ToggleSwitchProps) {
  const { instrument } = useTheme();
  return (
    <Switch
      {...props}
      trackColor={{ true: instrument.accent, false: instrument.inset }}
      style={[{ alignSelf: "center" }, style]}
    />
  );
}
