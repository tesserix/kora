import { fireEvent, render } from "@testing-library/react-native";
import { BodyCompositionSheet } from "../BodyCompositionSheet";

const mockAddMutate = jest.fn();
jest.mock("@/api/hooks", () => ({ useAddWeight: () => ({ mutate: mockAddMutate, isPending: false }) }));

beforeEach(() => {
  mockAddMutate.mockClear();
});

test("hands the parsed payload straight to useAddWeight and closes on success", async () => {
  const onClose = jest.fn();
  const { getByLabelText, getByText } = await render(
    <BodyCompositionSheet visible heightCm={165} onClose={onClose} />,
  );
  await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
  await fireEvent.changeText(getByLabelText("Visceral fat rating"), "7");
  await fireEvent.press(getByText("Save"));

  expect(mockAddMutate).toHaveBeenCalledTimes(1);
  const [payload, handlers] = mockAddMutate.mock.calls[0];
  expect(payload).toEqual({ weight_kg: 70.2, visceral_fat_rating: 7, source: "manual" });
  handlers.onSuccess();
  expect(onClose).toHaveBeenCalled();
});

test("surfaces a save failure instead of closing over it", async () => {
  const onClose = jest.fn();
  const { getByLabelText, getByText, findByText } = await render(
    <BodyCompositionSheet visible onClose={onClose} />,
  );
  await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
  await fireEvent.press(getByText("Save"));
  mockAddMutate.mock.calls[0][1].onError();
  expect(await findByText("Couldn't save. Try again.")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});

test("does not pre-fill the weight from a previous weigh-in", async () => {
  // Unlike WeightLogSheet, which seeds the current weight for a one-tap
  // adjustment. Here the form is filled by copying a scale's readout, and a
  // stale figure sitting in the field is a wrong number that looks right.
  const { getByLabelText } = await render(<BodyCompositionSheet visible onClose={jest.fn()} />);
  expect(getByLabelText("Weight in kilograms").props.value).toBe("");
});
