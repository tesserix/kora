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
  await fireEvent.press(getByLabelText("Increase amount"));
  expect(onChange).toHaveBeenCalledWith(2, "sachet");
});

test("decrementing below one serving does not go to zero", async () => {
  const onChange = jest.fn();
  const { getByLabelText } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={1} unit="sachet" onChange={onChange} />,
  );
  await fireEvent.press(getByLabelText("Decrease amount"));
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
  await fireEvent.changeText(getByLabelText("Amount"), "0");
  expect(onChange).not.toHaveBeenCalled();
});

test("rerendering with a changed amount updates the stepper label", async () => {
  const { getByText, rerender } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={1} unit="sachet" onChange={() => {}} />,
  );
  expect(getByText("1 sachet (16.5 g)")).toBeTruthy();

  await rerender(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={3} unit="sachet" onChange={() => {}} />,
  );
  expect(getByText("3 sachets (49.5 g)")).toBeTruthy();
});

test("rerendering with a changed amount in exact mode updates the input", async () => {
  const { getByLabelText, rerender } = await render(
    <PortionField baseUnit="g" servingUnits={[]} amount={140} unit="g" onChange={() => {}} />,
  );
  expect(getByLabelText("Amount").props.value).toBe("140");

  await rerender(<PortionField baseUnit="g" servingUnits={[]} amount={200} unit="g" onChange={() => {}} />);
  expect(getByLabelText("Amount").props.value).toBe("200");
});

test("a subsequent increase after a prop change reports from the new amount, not the stale one", async () => {
  const onChange = jest.fn();
  const { getByLabelText, rerender } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={1} unit="sachet" onChange={onChange} />,
  );

  await rerender(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={5} unit="sachet" onChange={onChange} />,
  );
  await fireEvent.press(getByLabelText("Increase amount"));
  expect(onChange).toHaveBeenCalledWith(6, "sachet");
});
