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

test("renders with enlarged sizing and 44pt touch targets", async () => {
  const onPress = jest.fn();
  const { getByRole, getByText } = await render(
    <ModePill icon="camera" label="Photo" active={false} onPress={onPress} />,
  );
  const pressableButton = getByRole("button");
  const style = pressableButton.props.style;
  const flatStyle = Array.isArray(style)
    ? Object.assign({}, ...style.flat().filter(Boolean))
    : style;

  // Assert padding dimensions for ~36pt touch target
  expect(flatStyle.paddingVertical).toBe(9);
  // 12, down from 16 (kora#278). Four capture chips measured 427pt of natural
  // width inside a 412pt padding box on a 440pt screen, which pushed TYPE off
  // the display; 4pt a side is 32pt off the row. Pinned because the fit that
  // keeps all four chips on one line at `medium` depends on this number.
  expect(flatStyle.paddingHorizontal).toBe(12);
  expect(flatStyle.gap).toBe(7);

  // Assert hitSlop for 44pt minimum touch target
  expect(pressableButton.props.hitSlop).toEqual({
    top: 6,
    bottom: 6,
    left: 4,
    right: 4,
  });

  // Assert AppText fontSize
  const textElement = getByText("Photo");
  const textStyle = Array.isArray(textElement.props.style)
    ? Object.assign({}, ...textElement.props.style.flat().filter(Boolean))
    : textElement.props.style;
  expect(textStyle.fontSize).toBe(13);
});

// kora#278: the label is what must NOT be traded away for width. kora#263
// showed a shrink-to-fit label splitting "kg" into "k"/"g"; a mode selector
// that breaks "PHOTO" mid-word is worse than the clip it would be fixing. So
// the type ramp stays exactly where the instrument spec put it, and the row
// buys its space from padding and wrapping instead.
test("keeps the engraved label metrics rather than shrinking to fit", async () => {
  const { getByText } = await render(
    <ModePill icon="camera" label="Photo" active={false} onPress={jest.fn()} />,
  );
  const textElement = getByText("Photo");
  const textStyle = Array.isArray(textElement.props.style)
    ? Object.assign({}, ...textElement.props.style.flat().filter(Boolean))
    : textElement.props.style;
  expect(textStyle.fontSize).toBe(13);
  expect(textStyle.letterSpacing).toBe(1.4);
  expect(textElement.props.adjustsFontSizeToFit).toBeFalsy();
  expect(textElement.props.numberOfLines).toBeUndefined();
});
