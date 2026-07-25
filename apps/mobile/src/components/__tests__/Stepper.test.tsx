import { render, fireEvent } from "@testing-library/react-native";
import { Stepper } from "../Stepper";

test("increments by step and decrements clamped at min", async () => {
  const onChange = jest.fn();
  const { getByLabelText, rerender } = await render(<Stepper value={100} onChange={onChange} step={10} min={10} />);
  await fireEvent.press(getByLabelText("Increase"));
  expect(onChange).toHaveBeenLastCalledWith(110);

  await rerender(<Stepper value={10} onChange={onChange} step={10} min={10} />);
  await fireEvent.press(getByLabelText("Decrease"));
  expect(onChange).toHaveBeenLastCalledWith(10); // clamped, not 0
});
