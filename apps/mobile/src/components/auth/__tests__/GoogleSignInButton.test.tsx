import * as RN from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

function styleOf(node: { props: Record<string, unknown> }) {
  const s = node.props.style;
  return Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean)) : s;
}

test("renders the label and the G mark", async () => {
  const { getByLabelText, getByTestId, getByText } = await render(
    <GoogleSignInButton accessibilityLabel="Sign in with Google" onPress={jest.fn()} />,
  );
  expect(getByLabelText("Sign in with Google")).toBeTruthy();
  expect(getByText("Sign in with Google")).toBeTruthy();
  expect(getByTestId("google-g-mark")).toBeTruthy();
});

// Google publishes TWO official button variants and expects the one matching
// the surrounding surface. Only the dark pair was implemented, so in light mode
// the button rendered near-black between a white Apple button and a white email
// button — the one dark element on the screen. Both variants are pinned here
// because the failure is invisible to a test that only ever checks one scheme.
//
// These are Google's own values. Selecting between them is what the guidelines
// describe; substituting Kora's theme tokens is what they forbid.
// The BORDER is deliberately Kora's token, not Google's — see the component's
// "DELIBERATE DEVIATION" comment. Pinned as the theme value so that restoring
// Google's own border is a visible, intentional test change rather than a
// silent one.
test.each([
  ["light", "#FFFFFF", "rgba(60,60,67,0.29)", "#1F1F1F"],
  ["dark", "#131314", "rgba(255,255,255,0.09)", "#E3E3E3"],
] as const)("uses Google's %s-scheme fill and label with Kora's border", async (scheme, fill, border, label) => {
  const spy = jest.spyOn(RN, "useColorScheme").mockReturnValue(scheme);
  try {
    const { getByLabelText, getByText } = await render(
      <GoogleSignInButton accessibilityLabel="Sign in with Google" onPress={jest.fn()} />,
    );
    const style = styleOf(getByLabelText("Sign in with Google"));
    expect(style.backgroundColor).toBe(fill);
    expect(style.borderColor).toBe(border);
    expect(style.borderWidth).toBe(1);
    expect(styleOf(getByText("Sign in with Google")).color).toBe(label);
  } finally {
    spy.mockRestore();
  }
});

test("renders a caller-supplied title", async () => {
  const { getByText } = await render(
    <GoogleSignInButton
      accessibilityLabel="Continue with Google to link"
      title="Continue with Google to link"
      onPress={jest.fn()}
    />,
  );
  expect(getByText("Continue with Google to link")).toBeTruthy();
});

test("calls onPress when tapped", async () => {
  const onPress = jest.fn();
  const { getByLabelText } = await render(
    <GoogleSignInButton accessibilityLabel="Sign in with Google" onPress={onPress} />,
  );
  fireEvent.press(getByLabelText("Sign in with Google"));
  expect(onPress).toHaveBeenCalledTimes(1);
});

// Asserted enabled first so the disabled assertion below can distinguish
// "correctly forwarded" from "always disabled".
test("does not forward disabled to the pressable when enabled", async () => {
  const { getByLabelText } = await render(
    <GoogleSignInButton accessibilityLabel="Sign in with Google" onPress={jest.fn()} />,
  );
  // Pressable encodes `disabled` into its responder gate rather than exposing
  // a plain `disabled` prop on the rendered host node.
  const node = getByLabelText("Sign in with Google");
  expect(node.props.onStartShouldSetResponder?.()).toBe(true);
});

test("does not call onPress while disabled", async () => {
  const onPress = jest.fn();
  const { getByLabelText } = await render(
    <GoogleSignInButton accessibilityLabel="Sign in with Google" onPress={onPress} disabled />,
  );
  fireEvent.press(getByLabelText("Sign in with Google"));
  expect(onPress).not.toHaveBeenCalled();
});

test("forwards disabled to the pressable so it does not spring or haptic under the finger", async () => {
  const { getByLabelText } = await render(
    <GoogleSignInButton accessibilityLabel="Sign in with Google" onPress={jest.fn()} disabled />,
  );
  const node = getByLabelText("Sign in with Google");
  expect(node.props.onStartShouldSetResponder?.()).toBe(false);
});
