import { fireEvent, render } from "@testing-library/react-native";
import { ModePill } from "../ModePill";

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
