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

// The NESCAFÉ Mocha failure: the field opens in exact mode showing the
// serving's GRAM figure (16.5 g), the user taps the "sachet" chip, and the
// gram figure is reread as a serving count — 16.5 sachets, 272 g, ~1500 kcal
// instead of 90.
test("selecting a named serving from exact mode does not carry the gram figure across", async () => {
  const onChange = jest.fn();
  const { getByText } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={16.5} unit="g" onChange={onChange} />,
  );
  await fireEvent.press(getByText("sachet"));
  expect(onChange).toHaveBeenCalledWith(1, "sachet");
  expect(onChange).not.toHaveBeenCalledWith(16.5, "sachet");
});

// The other direction is a quantity conversion the food row itself supplies,
// so the field can keep describing the same portion rather than reinterpreting
// the count as grams.
test("leaving a named serving for the base unit seeds the serving's own base amount", async () => {
  const onChange = jest.fn();
  const { getByText, getByLabelText } = await render(
    <PortionField baseUnit="g" servingUnits={SACHET} amount={2} unit="sachet" onChange={onChange} />,
  );
  await fireEvent.press(getByText("Enter exact amount"));
  // 2 sachets is 33 g, not "2 g".
  expect(getByLabelText("Amount").props.value).toBe("33");
  // Merely looking at the exact field is not an edit — the pending entry is
  // still the named serving, which the server resolves to the same figure.
  expect(onChange).not.toHaveBeenCalled();
});

// Same reinterpretation seen from a unit chip, for a food carrying more than
// one named serving so the base-unit chip is a real transition.
test("switching from a named serving chip to the base unit converts the count", async () => {
  const onChange = jest.fn();
  const units = [
    { name: "sachet", amount: 1, base_amount: 16.5 },
    { name: "box", amount: 1, base_amount: 165 },
  ];
  const { getByText } = await render(
    <PortionField baseUnit="g" servingUnits={units} amount={140} unit="g" onChange={onChange} />,
  );
  await fireEvent.press(getByText("sachet"));
  expect(onChange).toHaveBeenLastCalledWith(1, "sachet");
  await fireEvent.press(getByText("g"));
  expect(onChange).toHaveBeenLastCalledWith(16.5, "g");
});

// Re-tapping the unit already selected must not disturb an in-progress entry.
test("reselecting the current unit reports nothing", async () => {
  const onChange = jest.fn();
  const { getByText } = await render(
    <PortionField baseUnit="g" servingUnits={[]} amount={140} unit="g" onChange={onChange} />,
  );
  await fireEvent.press(getByText("g"));
  expect(onChange).not.toHaveBeenCalled();
});
