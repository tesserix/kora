import { fireEvent, render } from "@testing-library/react-native";
import { SelectableCard } from "../SelectableCard";

function flatten(style: unknown) {
  return Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
}

test("a selected card reports radio semantics and shows the checkmark", async () => {
  const { getByRole, getByTestId } = await render(
    <SelectableCard
      icon="trending-down"
      title="Lose weight"
      subtitle="Gentle calorie deficit"
      selected
      onPress={() => {}}
    />,
  );
  expect(getByRole("radio").props.accessibilityState.selected).toBe(true);
  expect(getByTestId("sf-checkmark")).toBeTruthy();
});

test("an unselected card reports selected:false and renders no checkmark", async () => {
  const { getByRole, queryByTestId } = await render(
    <SelectableCard title="Light" subtitle="1-2 sessions a week" selected={false} onPress={() => {}} />,
  );
  expect(getByRole("radio").props.accessibilityState.selected).toBe(false);
  expect(queryByTestId("sf-checkmark")).toBeNull();
});

test("pressing the card invokes onPress", async () => {
  const onPress = jest.fn();
  const { getByRole } = await render(
    <SelectableCard title="Maintain" selected={false} onPress={onPress} />,
  );
  fireEvent.press(getByRole("radio"));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("the icon tile renders only when an icon is supplied", async () => {
  const withIcon = await render(
    <SelectableCard icon="trending-up" title="Build muscle" selected={false} onPress={() => {}} />,
  );
  expect(withIcon.queryByTestId("selectable-icon-tile")).toBeTruthy();

  const withoutIcon = await render(
    <SelectableCard title="Sedentary" selected={false} onPress={() => {}} />,
  );
  expect(withoutIcon.queryByTestId("selectable-icon-tile")).toBeNull();
});

test("selection is carried by the border too, not by the checkmark alone", async () => {
  // Three redundant cues (border, tile fill, radio) so selection does not rest
  // on one accent colour, which fails for colour-blind users.
  const on = await render(
    <SelectableCard title="Active" selected onPress={() => {}} />,
  );
  const off = await render(
    <SelectableCard title="Active" selected={false} onPress={() => {}} />,
  );
  const onStyle = flatten(on.getByRole("radio").props.style);
  const offStyle = flatten(off.getByRole("radio").props.style);
  expect(onStyle.borderColor).not.toBe(offStyle.borderColor);
  expect(onStyle.borderWidth).toBe(2);
});

test("the tap target clears the 44pt accessibility minimum", async () => {
  const { getByRole } = await render(
    <SelectableCard title="Active" selected={false} onPress={() => {}} />,
  );
  expect(flatten(getByRole("radio").props.style).minHeight).toBeGreaterThanOrEqual(44);
});
