import type { TextProps } from "react-native";
import { AppText } from "./Text";

// Legacy caption-uppercase label, kept for existing call sites. New code should
// prefer `GroupedSection`'s `header` prop for the same visual treatment.
export function Overline({ style, children, ...rest }: TextProps) {
  return (
    <AppText variant="caption" muted style={[{ textTransform: "uppercase" }, style]} {...rest}>
      {children}
    </AppText>
  );
}
