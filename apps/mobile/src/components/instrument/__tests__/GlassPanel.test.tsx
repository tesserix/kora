import { AccessibilityInfo, Text } from "react-native";
import { render, waitFor } from "@testing-library/react-native";
import { GlassPanel } from "../GlassPanel";

// expo-blur's BlurView renders a host component we can find by testID.
test("renders children inside the blur material", async () => {
  const { getByText, getByTestId } = await render(
    <GlassPanel testID="panel"><Text>770</Text></GlassPanel>,
  );
  expect(getByText("770")).toBeTruthy();
  expect(getByTestId("panel-blur")).toBeTruthy();
});

test("respects a custom radius on the outer shell", async () => {
  const { getByTestId } = await render(
    <GlassPanel testID="panel" radius={18}><Text>x</Text></GlassPanel>,
  );
  const style = getByTestId("panel").props.style;
  const flat = Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
  expect(flat.borderRadius).toBe(18);
});

// I4: Reduce Transparency swaps the blur for an opaque fallback fill — and
// that fill must be visually distinct from the screen ground (instrument.bg),
// or the "card" is indistinguishable from the background it sits on.
test("falls back to an opaque, non-bg fill and renders no BlurView when Reduce Transparency is on", async () => {
  jest.spyOn(AccessibilityInfo, "isReduceTransparencyEnabled").mockResolvedValue(true);

  const { getByTestId, queryByTestId } = await render(
    <GlassPanel testID="panel"><Text>770</Text></GlassPanel>,
  );

  await waitFor(() => {
    const style = getByTestId("panel").props.style;
    const flat = Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
    // Light scheme is the test environment's default (no useColorScheme mock).
    expect(flat.backgroundColor).toBe("#F7F7F8");
  });
  expect(queryByTestId("panel-blur")).toBeNull();

  jest.restoreAllMocks();
});
