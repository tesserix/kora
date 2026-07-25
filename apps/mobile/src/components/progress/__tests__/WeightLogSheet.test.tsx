import { render, fireEvent } from "@testing-library/react-native";
import { WeightLogSheet } from "../WeightLogSheet";

const mockAddMutate = jest.fn();
jest.mock("@/api/hooks", () => ({ useAddWeight: () => ({ mutate: mockAddMutate, isPending: false }) }));
beforeEach(() => mockAddMutate.mockClear());

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
