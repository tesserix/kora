import { fireEvent, render } from "@testing-library/react-native";
import { WeekdayPicker } from "../WeekdayPicker";

test("tapping an unselected day adds it, in sorted order", async () => {
  const onChange = jest.fn();
  const { getByTestId } = await render(<WeekdayPicker days={[3]} onChange={onChange} />);

  await fireEvent.press(getByTestId("day-1"));

  expect(onChange).toHaveBeenCalledWith([1, 3]);
});

test("tapping a selected day removes it", async () => {
  const onChange = jest.fn();
  const { getByTestId } = await render(<WeekdayPicker days={[1, 3]} onChange={onChange} />);

  await fireEvent.press(getByTestId("day-3"));

  expect(onChange).toHaveBeenCalledWith([1]);
});

test("every day selects all seven", async () => {
  const onChange = jest.fn();
  const { getByText } = await render(<WeekdayPicker days={[1]} onChange={onChange} />);

  await fireEvent.press(getByText("Every day"));

  expect(onChange).toHaveBeenCalledWith([0, 1, 2, 3, 4, 5, 6]);
});
