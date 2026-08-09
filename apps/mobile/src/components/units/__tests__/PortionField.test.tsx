import { fireEvent, render } from "@testing-library/react-native";
import { PortionField } from "../PortionField";

const SACHET = [{ name: "sachet", amount: 1, base_amount: 16.5 }];

test("defaults to a stepper on the food's own serving", async () => {
  const { getByText } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={1} unit="sachet" onChange={() => {}} />,
  );
  expect(getByText("1 sachet (16.5 g)")).toBeTruthy();
});

test("incrementing reports the new amount in the same unit", async () => {
  const onChange = jest.fn();
  const { getByLabelText } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={1} unit="sachet" onChange={onChange} />,
  );
  fireEvent.press(getByLabelText("Increase amount"));
  expect(onChange).toHaveBeenCalledWith(2, "sachet");
});

test("decrementing below one serving does not go to zero", async () => {
  const onChange = jest.fn();
  const { getByLabelText } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={1} unit="sachet" onChange={onChange} />,
  );
  fireEvent.press(getByLabelText("Decrease amount"));
  expect(onChange).not.toHaveBeenCalled();
});

test("the escape hatch switches to exact amount entry in the base unit", async () => {
  const onChange = jest.fn();
  const { getByText, getByLabelText } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={1} unit="sachet" onChange={onChange} />,
  );
  await fireEvent.press(getByText("Enter exact amount"));
  await fireEvent.changeText(getByLabelText("Amount"), "45");
  expect(onChange).toHaveBeenCalledWith(45, "g");
});

test("a food with no named serving opens directly in exact-amount mode", async () => {
  const { getByLabelText, queryByText } = await render(
    <PortionField baseUnit="g" servingUnits={[]} amount={140} unit="g" onChange={() => {}} />,
  );
  expect(getByLabelText("Amount")).toBeTruthy();
  expect(queryByText("Enter exact amount")).toBeNull();
});

test("a non-positive amount is not reported", async () => {
  const onChange = jest.fn();
  const { getByLabelText } = await render(
    <PortionField baseUnit="g" servingUnits={[]} amount={140} unit="g" onChange={onChange} />,
  );
  fireEvent.changeText(getByLabelText("Amount"), "0");
  expect(onChange).not.toHaveBeenCalled();
});
