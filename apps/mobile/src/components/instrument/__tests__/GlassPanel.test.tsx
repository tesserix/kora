import { Text } from "react-native";
import { render } from "@testing-library/react-native";
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
