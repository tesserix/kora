import * as AppleAuthentication from "expo-apple-authentication";
import { Platform, useWindowDimensions } from "react-native";
import { useTheme } from "@/theme";

export interface AppleSignInButtonProps {
  onPress: () => void;
  // Required: the native button renders Apple's own text, so the accessible
  // name is the only place a caller can say "…to link" (LinkAccountPrompt).
  accessibilityLabel: string;
  disabled?: boolean;
}

// The native control has no intrinsic Dynamic Type support, but MEASURED on an
// iPhone 17 Pro Max: ASAuthorizationAppleIDButton sizes its title from its
// frame. At a fixed height of 48 the label renders at 17pt ink height at BOTH
// `medium` and `accessibility-extra-large` — it never moved. Scaling the frame
// to 127pt took the same label to 29.7pt. So growing the box is a real fix, not
// a cosmetic one: the title tracks the frame (sub-linearly — a 2.64x frame gave
// a 1.75x label), which is also why the cap below does not starve it.
const BASE_HEIGHT = 48;

// Matches the 1.6 ceiling used for primary controls elsewhere (FloatingTabBar,
// ModePill, GaugeDial's hero numeral). Uncapped, AXL would give a 127pt slab
// that dwarfs the Google button beside it.
const MAX_SCALE = 1.6;

// Floored at 1 deliberately. iOS content sizes BELOW the default `large` report
// a fontScale under 1 (this simulator reports 0.941 at `medium`), which would
// shrink the button to 45pt — under the 44pt-plus tap target the 48pt baseline
// was chosen for, and a visible regression on the most common setting. Dynamic
// Type may grow this control; it may not shrink it.
export function appleButtonHeight(fontScale: number): number {
  return BASE_HEIGHT * Math.min(Math.max(fontScale, 1), MAX_SCALE);
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
  // useWindowDimensions, not PixelRatio.getFontScale(): the former is reactive,
  // so the button resizes when the user changes text size in Settings and
  // returns to a still-mounted app. Hooks run before the platform guard below.
  const { fontScale } = useWindowDimensions();

  if (Platform.OS !== "ios") return null;

  return (
    <AppleAuthentication.AppleAuthenticationButton
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
      // WHITE, not BLACK: the app's background is #0A0D0B, where a black
      // button with a black mark disappears.
      buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
      cornerRadius={radius.lg}
      style={{ height: appleButtonHeight(fontScale), opacity: disabled ? 0.6 : 1 }}
      onPress={() => {
        if (disabled) return;
        onPress();
      }}
    />
  );
}
