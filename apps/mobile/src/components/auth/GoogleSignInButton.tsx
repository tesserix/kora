import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

// Google's two official button variants. NOT theme tokens: these are Google's
// own values, and substituting Kora's palette is what would break the branding
// guidelines that permit using their mark at all.
//
// Choosing BETWEEN these two by colour scheme is not a substitution — the
// guidelines publish both and expect the one matching the surrounding surface.
// Only the dark pair existed until now, so in light mode the button rendered
// near-black between a white Apple button and a white email button: the single
// dark element on the screen, reading as a rendering fault rather than a brand.
const GOOGLE_BRAND = {
  light: { fill: "#FFFFFF", label: "#1F1F1F" },
  dark: { fill: "#131314", label: "#E3E3E3" },
} as const;

// DELIBERATE DEVIATION, decided by the product owner (see kora#314 session).
//
// Google specifies a border alongside each variant — #747775 on light, #8E918F
// on dark. Both are heavier than Kora's own hairline, and on the sign-in screen
// the three buttons sit in one stack: Apple (native, borderless), Google, and
// email (Kora's `colors.border`). With Google's own value the middle button
// carried a visibly darker outline than the one below it and read as a
// mismatch rather than as branding.
//
// So the border — and ONLY the border — comes from the theme. The fill and the
// label above stay exactly Google's, as does the G mark, because those are what
// actually carry the brand. This is the smallest deviation that resolves the
// mismatch; softening the fill or the mark would not be.
//
// It IS a deviation: Google's guidelines say not to alter the specified
// colours. Enforcement risk is low in practice — Apple reviews the app, Google
// does not — but if that ever changes, restoring the two values above is the
// whole fix.

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
  const { radius, spacing, scheme, colors } = useTheme();
  const brand = GOOGLE_BRAND[scheme];

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
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
        // Horizontal breathing room so a wrapped label stops short of the
        // border rather than running into it (kora#173).
        paddingHorizontal: spacing.md,
        minHeight: 48,
        borderRadius: radius.lg,
        backgroundColor: brand.fill,
        borderWidth: 1,
        borderColor: colors.border,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {/* flexShrink: 0 so the mark keeps its size when the label wraps
          (kora#173) — Google's guidelines do not permit rendering it smaller. */}
      <View testID="google-g-mark" style={{ flexShrink: 0 }}>
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
      {/* flexShrink: 1 is what keeps the mark inside the button (kora#173).
          Without it this Text claims its full intrinsic width, and because the
          row is centred the overflow spills BOTH ways — at accessibility text
          sizes the G rendered outside the border, against the screen edge,
          while the label wrapped. Shrinking lets the text wrap within the
          space that is actually available instead. */}
      <AppText variant="headline" style={{ color: brand.label, flexShrink: 1 }}>
        {title}
      </AppText>
    </PressableScale>
  );
}
