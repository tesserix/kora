import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

// Google's dark-theme branding spec. NOT theme tokens: these are Google's
// values and changing them to match Kora's palette breaks the branding
// guidelines that permit using their mark at all.
const GOOGLE_DARK_FILL = "#131314";
const GOOGLE_DARK_BORDER = "#8E918F";
const GOOGLE_DARK_LABEL = "#E3E3E3";

export interface GoogleSignInButtonProps {
  onPress: () => void;
  accessibilityLabel: string;
  title?: string;
  disabled?: boolean;
}

// Custom rather than the library's GoogleSigninButton, which is fixed-style
// and does not match this app. The G is react-native-svg paths; using Google's
// asset inside a sign-in button is what their guidelines permit.
export function GoogleSignInButton({
  onPress,
  accessibilityLabel,
  title = "Sign in with Google",
  disabled,
}: GoogleSignInButtonProps) {
  const { radius, spacing } = useTheme();

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      haptic="selection"
      onPress={() => {
        if (disabled) return;
        onPress();
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: spacing.sm + 2,
        minHeight: 48,
        borderRadius: radius.lg,
        backgroundColor: GOOGLE_DARK_FILL,
        borderWidth: 1,
        borderColor: GOOGLE_DARK_BORDER,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <View testID="google-g-mark">
        <Svg width={18} height={18} viewBox="0 0 48 48">
          <Path
            fill="#EA4335"
            d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
          />
          <Path
            fill="#4285F4"
            d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
          />
          <Path
            fill="#FBBC05"
            d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"
          />
          <Path
            fill="#34A853"
            d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
          />
        </Svg>
      </View>
      <AppText variant="headline" style={{ color: GOOGLE_DARK_LABEL }}>
        {title}
      </AppText>
    </PressableScale>
  );
}
