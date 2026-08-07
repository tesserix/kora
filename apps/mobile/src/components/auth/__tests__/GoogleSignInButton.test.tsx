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

// Google's dark-theme branding spec. These are Google's values and must not be
// swapped for theme tokens, however tempting the consistency looks.
test("uses Google's dark-theme fill and hairline border", async () => {
  const { getByLabelText } = await render(
    <GoogleSignInButton accessibilityLabel="Sign in with Google" onPress={jest.fn()} />,
  );
  const style = styleOf(getByLabelText("Sign in with Google"));
  expect(style.backgroundColor).toBe("#131314");
  expect(style.borderColor).toBe("#8E918F");
  expect(style.borderWidth).toBe(1);
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
