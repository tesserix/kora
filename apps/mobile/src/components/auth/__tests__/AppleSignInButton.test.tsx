import { fireEvent, render } from "@testing-library/react-native";
import { AppleSignInButton } from "@/components/auth/AppleSignInButton";
import { radius } from "@/theme/palette";

// jest-expo's default platform is ios, so no Platform patching is needed here.
// The Android counterpart lives in AppleSignInButton.android.test.tsx.
jest.mock("expo-apple-authentication", () => {
  const { Pressable } = require("react-native");
  return {
    AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1 },
    AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
    // Stands in for the native view so props are inspectable in the tree.
    AppleAuthenticationButton: (props: Record<string, unknown>) => <Pressable {...props} />,
  };
});

test("renders Apple's own button on iOS", async () => {
  const { getByLabelText } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={jest.fn()} />,
  );
  expect(getByLabelText("Sign in with Apple")).toBeTruthy();
});

// BLACK would disappear on #0A0D0B. This is a HIG-approved style, not a
// cosmetic preference, so it is pinned.
test("uses the WHITE style and the theme's corner radius", async () => {
  const { getByLabelText } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={jest.fn()} />,
  );
  const button = getByLabelText("Sign in with Apple");
  expect(button.props.buttonStyle).toBe(0); // WHITE
  expect(button.props.buttonType).toBe(0); // SIGN_IN
  expect(button.props.cornerRadius).toBe(radius.lg);
});

test("calls onPress when tapped", async () => {
  const onPress = jest.fn();
  const { getByLabelText } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={onPress} />,
  );
  fireEvent.press(getByLabelText("Sign in with Apple"));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("does not call onPress while disabled", async () => {
  const onPress = jest.fn();
  const { getByLabelText } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={onPress} disabled />,
  );
  fireEvent.press(getByLabelText("Sign in with Apple"));
  expect(onPress).not.toHaveBeenCalled();
});
