import { render, fireEvent } from "@testing-library/react-native";
import { WeightLogSheet } from "../WeightLogSheet";

const mockAddMutate = jest.fn();
jest.mock("@/api/hooks", () => ({ useAddWeight: () => ({ mutate: mockAddMutate, isPending: false }) }));

const mockUseUnits = jest.fn();
jest.mock("@/units", () => ({
  ...jest.requireActual("@/units"),
  useUnits: () => mockUseUnits(),
}));

beforeEach(() => {
  mockAddMutate.mockClear();
  mockUseUnits.mockReturnValue({ system: "metric", setSystem: jest.fn() });
});

test("Save parses the input and calls useAddWeight; rejects non-positive", async () => {
  const onClose = jest.fn();
  const { getByText, getByLabelText } = await render(
    <WeightLogSheet visible initialKg={72.4} onClose={onClose} />,
  );
  // clear + enter a bad value -> no mutate
  await fireEvent.changeText(getByLabelText("Weight in kilograms"), "0");
  await fireEvent.press(getByText("Save"));
  expect(mockAddMutate).not.toHaveBeenCalled();
  // valid value -> mutate with parsed number
  await fireEvent.changeText(getByLabelText("Weight in kilograms"), "71.8");
  await fireEvent.press(getByText("Save"));
  expect(mockAddMutate).toHaveBeenCalledWith(
    { weight_kg: 71.8 },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("syncs the input to the current weight when the sheet opens", async () => {
  const onClose = jest.fn();
  const { getByLabelText, rerender } = await render(
    <WeightLogSheet visible={false} initialKg={0} onClose={onClose} />,
  );
  await rerender(<WeightLogSheet visible initialKg={80} onClose={onClose} />);
  expect(getByLabelText("Weight in kilograms").props.value).toBe("80");
});

test("imperial: seeds the field in lb and converts the saved value back to kg", async () => {
  mockUseUnits.mockReturnValue({ system: "imperial", setSystem: jest.fn() });
  const onClose = jest.fn();
  const { getByText, getByLabelText } = await render(
    <WeightLogSheet visible initialKg={78.6} onClose={onClose} />,
  );
  const input = getByLabelText("Weight in pounds");
  // 78.6 kg -> 173.28... lb, rounded to one decimal to match display precision.
  expect(input.props.value).toBe("173.3");
  expect(getByText("lb")).toBeTruthy();

  await fireEvent.changeText(input, "150");
  await fireEvent.press(getByText("Save"));
  expect(mockAddMutate).toHaveBeenCalledWith(
    { weight_kg: expect.closeTo(68.0388555, 4) },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});
