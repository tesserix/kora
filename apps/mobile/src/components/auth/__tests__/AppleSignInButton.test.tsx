import { fireEvent, render } from "@testing-library/react-native";
import { appleButtonHeight, AppleSignInButton } from "@/components/auth/AppleSignInButton";
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
  expect(button.props.buttonType).toBe(1); // CONTINUE
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

// Asserted enabled first so the disabled assertion below can distinguish
// "correctly disabled" from "always disabled".
test("is not marked disabled and is not dimmed when enabled", async () => {
  const { getByLabelText } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={jest.fn()} />,
  );
  const button = getByLabelText("Sign in with Apple");
  expect(button.props.accessibilityState?.disabled).toBe(false);
  expect(button.props.style?.opacity).toBe(1);
});

test("does not call onPress while disabled", async () => {
  const onPress = jest.fn();
  const { getByLabelText } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={onPress} disabled />,
  );
  fireEvent.press(getByLabelText("Sign in with Apple"));
  expect(onPress).not.toHaveBeenCalled();
});

test("is marked disabled and dimmed when disabled", async () => {
  const { getByLabelText } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={jest.fn()} disabled />,
  );
  const button = getByLabelText("Sign in with Apple");
  expect(button.props.accessibilityState?.disabled).toBe(true);
  expect(button.props.style?.opacity).toBe(0.6);
});

// kora#173 Task 3. MEASURED on an iPhone 17 Pro Max: at a fixed height of 48 the
// native title renders at 17.0pt ink height at BOTH `medium` and
// `accessibility-extra-large` — the label is frozen while the Google and email
// labels beside it grow to two lines. ASAuthorizationAppleIDButton exposes no
// font API, but it DOES size its title from its frame: at 127pt the same label
// measured 29.7pt, and at the shipped 76.7pt cap it measured 26.7pt. The height
// is therefore the only lever that makes this control participate in Dynamic
// Type, which is why these bounds are pinned rather than left to taste.
describe("appleButtonHeight", () => {
  test("keeps the 48pt baseline at the default content size", () => {
    expect(appleButtonHeight(1)).toBe(48);
  });

  // The floor is the load-bearing half of the clamp. Content sizes below iOS's
  // default `large` report a scale under 1 (the simulator reports 0.941 at
  // `medium`); without the floor the button would shrink to ~45pt, regressing
  // the tap target on the most common setting.
  test("never shrinks below 48pt when the content size is below default", () => {
    expect(appleButtonHeight(0.941)).toBe(48);
    expect(appleButtonHeight(0.5)).toBe(48);
  });

  test("grows with the font scale between the floor and the cap", () => {
    expect(appleButtonHeight(1.25)).toBe(60);
  });

  // Uncapped, accessibility-extra-large (2.643) would produce a 127pt slab that
  // dwarfs the Google button. 1.6 matches the ceiling used for primary controls
  // elsewhere (FloatingTabBar, ModePill, GaugeDial's hero numeral).
  test("caps growth at 1.6x so the largest sizes cannot run away", () => {
    expect(appleButtonHeight(1.6)).toBeCloseTo(76.8);
    expect(appleButtonHeight(2.643)).toBeCloseTo(76.8);
    expect(appleButtonHeight(10)).toBeCloseTo(76.8);
  });
});

test("takes its height from the live font scale, not a constant", async () => {
  // Driven through useWindowDimensions rather than PixelRatio.getFontScale()
  // so the control resizes when the user changes text size in Settings and
  // returns to a still-mounted app. Spying here pins that wiring: a hardcoded
  // height, or a non-reactive one-shot read, would not observe this value.
  // require, not a top-level import: an ESM namespace object is sealed, so
  // jest.spyOn cannot redefine a property on it. Same reason as the mock above.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = require("react-native");
  const spy = jest
    .spyOn(rn, "useWindowDimensions")
    .mockReturnValue({ width: 440, height: 956, scale: 3, fontScale: 1.25 });
  try {
    const { getByLabelText } = await render(
      <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={jest.fn()} />,
    );
    expect(getByLabelText("Sign in with Apple").props.style?.height).toBe(60);
  } finally {
    spy.mockRestore();
  }
});
