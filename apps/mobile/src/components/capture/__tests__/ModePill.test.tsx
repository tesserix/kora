import { fireEvent, render } from "@testing-library/react-native";
import { ModePill } from "../ModePill";
import { INSTRUMENT_DARK_FIXED } from "@/theme";

test("renders label and fires onPress", async () => {
  const onPress = jest.fn();
  const { getByText, getByRole } = await render(
    <ModePill icon="camera" label="Photo" active={false} onPress={onPress} />,
  );
  expect(getByText("Photo")).toBeTruthy();
  fireEvent.press(getByRole("button"));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("marks the active pill as selected", async () => {
  const { getByRole } = await render(
    <ModePill icon="mic" label="Voice" active onPress={jest.fn()} />,
  );
  expect(getByRole("button").props.accessibilityState.selected).toBe(true);
});

// Instrument Glass: an inactive chip is a dark glass pill (glass fill +
// glassBorder), an active chip fills with the accent — always the fixed
// dark tokens, since this chip only ever appears on the always-dark
// Capture screen.
test("an inactive pill is a dark glass pill", async () => {
  const { getByRole } = await render(
    <ModePill icon="camera" label="Photo" active={false} onPress={jest.fn()} />,
  );
  const inactiveStyle = getByRole("button").props.style;
  const flatInactive = Array.isArray(inactiveStyle)
    ? Object.assign({}, ...inactiveStyle.flat().filter(Boolean))
    : inactiveStyle;
  expect(flatInactive.backgroundColor).toBe(INSTRUMENT_DARK_FIXED.glass);
  expect(flatInactive.borderColor).toBe(INSTRUMENT_DARK_FIXED.glassBorder);
});

test("an active pill fills with accent", async () => {
  const { getByRole } = await render(
    <ModePill icon="camera" label="Photo" active onPress={jest.fn()} />,
  );
  const activeStyle = getByRole("button").props.style;
  const flatActive = Array.isArray(activeStyle)
    ? Object.assign({}, ...activeStyle.flat().filter(Boolean))
    : activeStyle;
  expect(flatActive.backgroundColor).toBe(INSTRUMENT_DARK_FIXED.accent);
});
