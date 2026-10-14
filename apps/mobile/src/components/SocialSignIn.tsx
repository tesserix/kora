import { SymbolView } from "expo-symbols";
import { Platform, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { Provider } from "@/auth/session";
import { PressableScale } from "@/motion";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type Props = {
  onPress: (provider: Provider) => void;
  disabled?: boolean;
};

// Continue with Apple / Continue with Google. Both are the providers' own
// marks in their own colours, not Kora's accent: Apple's HIG and Google's
// branding rules each require it, and App Review checks the Apple one.
//
// Apple's button inverts against the screen (white on dark, black on light)
// as the HIG's white/black styles do. Google's follows its neutral light and
// dark styles. Both share Button's 48pt height so the stack reads as one set.
export function SocialSignIn({ onPress, disabled }: Props) {
  const { scheme, spacing } = useTheme();
  const dark = scheme === "dark";
  const apple = dark ? { bg: "#FFFFFF", fg: "#000000" } : { bg: "#000000", fg: "#FFFFFF" };
  const google = dark
    ? { bg: "#131314", fg: "#E3E3E3", border: "#8E918F" }
    : { bg: "#FFFFFF", fg: "#1F1F1F", border: "#747775" };

  return (
    <View style={{ gap: spacing.sm, opacity: disabled ? 0.6 : 1 }}>
      <PressableScale
        testID="sign-in-apple"
        accessibilityRole="button"
        accessibilityLabel="Continue with Apple"
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={() => onPress("apple")}
        style={[styles.button, { backgroundColor: apple.bg }]}
      >
        {Platform.OS === "ios" ? (
          <SymbolView name="apple.logo" size={18} tintColor={apple.fg} />
        ) : (
          <AppleMark color={apple.fg} />
        )}
        <AppText style={[styles.label, { color: apple.fg }]}>Continue with Apple</AppText>
      </PressableScale>

      <PressableScale
        testID="sign-in-google"
        accessibilityRole="button"
        accessibilityLabel="Continue with Google"
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        onPress={() => onPress("google")}
        style={[styles.button, { backgroundColor: google.bg, borderWidth: 1, borderColor: google.border }]}
      >
        <GoogleMark />
        <AppText style={[styles.label, { color: google.fg }]}>Continue with Google</AppText>
      </PressableScale>
    </View>
  );
}

function AppleMark({ color }: { color: string }) {
  return (
    <Svg width={16} height={18} viewBox="0 0 814 1000">
      <Path
        fill={color}
        d="M788 341c-6 4-108 62-108 190 0 148 130 200 134 202-1 3-21 72-69 142-43 62-88 124-156 124s-86-40-165-40c-77 0-104 41-166 41s-106-58-156-128C44 790 0 671 0 557c0-182 119-279 236-279 62 0 114 41 153 41 37 0 95-43 166-43 27 0 124 2 188 95zM554 170c29-35 50-83 50-131 0-7-1-14-2-19-48 2-104 32-138 71-27 30-52 78-52 127 0 7 1 15 2 17 3 1 8 1 13 1 43 0 97-29 127-66z"
      />
    </Svg>
  );
}

function GoogleMark() {
  return (
    <Svg width={18} height={18} viewBox="0 0 48 48">
      <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 16,
  },
  label: { fontSize: 16, fontWeight: "600" },
});
