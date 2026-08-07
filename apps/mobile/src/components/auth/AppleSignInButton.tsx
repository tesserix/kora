import * as AppleAuthentication from "expo-apple-authentication";
import { Platform } from "react-native";
import { useTheme } from "@/theme";

export interface AppleSignInButtonProps {
  onPress: () => void;
  // Required: the native button renders Apple's own text, so the accessible
  // name is the only place a caller can say "…to link" (LinkAccountPrompt).
  accessibilityLabel: string;
  disabled?: boolean;
}

// Apple's own button, which renders their mark and enforces their approved
// styles. Rendering a bespoke button with Kora's green is a routine App Store
// rejection under the HIG — on the very feature added for Guideline 4.8.
//
// Returns null off iOS, so the iOS-only guarantee is STRUCTURAL rather than a
// call-site convention. LinkAccountPrompt originally forgot its own
// Platform.OS check and shipped an Android control backed by an API that isn't
// there; a component that cannot render on Android makes the third call site's
// omission impossible rather than merely unlikely.
//
// AppleAuthentication.isAvailableAsync() is deliberately NOT used: it is async
// and would flash the button in and out on mount, and every device running
// Expo 57 is iOS 13+. An unprovisioned capability throws ERR_REQUEST_UNKNOWN,
// which firebaseAuthMessage already maps to the iCloud message.
export function AppleSignInButton({ onPress, accessibilityLabel, disabled }: AppleSignInButtonProps) {
  const { radius } = useTheme();

  if (Platform.OS !== "ios") return null;

  return (
    <AppleAuthentication.AppleAuthenticationButton
      accessibilityLabel={accessibilityLabel}
      buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
      // WHITE, not BLACK: the app's background is #0A0D0B, where a black
      // button with a black mark disappears.
      buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
      cornerRadius={radius.lg}
      style={{ height: 48 }}
      onPress={() => {
        if (disabled) return;
        onPress();
      }}
    />
  );
}
