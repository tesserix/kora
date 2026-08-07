import { render } from "@testing-library/react-native";
import { Platform } from "react-native";
import { AppleSignInButton } from "@/components/auth/AppleSignInButton";

const originalOS = Platform.OS;
const originalSelect = Platform.select;

beforeAll(() => {
  Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
  Platform.select = ((specifics: Record<string, unknown>) => specifics.android) as typeof Platform.select;
});

afterAll(() => {
  Object.defineProperty(Platform, "OS", { value: originalOS, configurable: true });
  Platform.select = originalSelect;
});

jest.mock("expo-apple-authentication", () => {
  const { Pressable } = require("react-native");
  return {
    AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1 },
    AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
    AppleAuthenticationButton: (props: Record<string, unknown>) => <Pressable {...props} />,
  };
});

// The iOS suite proves this component renders at all. Here the same props must
// produce nothing — a disappearance, not a component that never worked. The
// iOS-only guarantee is structural: a third call site cannot forget the guard
// the way LinkAccountPrompt originally did.
test("renders nothing on Android", async () => {
  const { queryByLabelText, toJSON } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={jest.fn()} />,
  );
  expect(queryByLabelText("Sign in with Apple")).toBeNull();
  expect(toJSON()).toBeNull();
});
