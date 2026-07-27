import { fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";

const mockMutate = jest.fn();
let mockIsPending = false;

jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));
jest.mock("@/api/hooks", () => ({
  useSubmitOnboarding: () => ({ mutate: mockMutate, isPending: mockIsPending }),
}));
jest.mock("@/motion", () => {
  const actual = jest.requireActual("@/motion");
  return { ...actual, haptics: { ...actual.haptics, success: jest.fn() } };
});

const mockUseUnits = jest.fn();
jest.mock("@/units", () => ({
  ...jest.requireActual("@/units"),
  useUnits: () => mockUseUnits(),
}));

import Onboarding from "../onboarding";
import { haptics } from "@/motion";

beforeEach(() => {
  mockMutate.mockClear();
  mockIsPending = false;
  (router.replace as jest.Mock).mockClear();
  (haptics.success as jest.Mock).mockClear();
  mockUseUnits.mockReturnValue({ system: "metric", setSystem: jest.fn() });
});

test("Onboarding shows the editorial hero and goal cards", async () => {
  const { findByText } = await render(<Onboarding />);
  expect(await findByText(/Otto tracks it/i)).toBeTruthy();
  expect(await findByText("Lose weight")).toBeTruthy();
  expect(await findByText("Build muscle")).toBeTruthy();
  expect(await findByText("Get started")).toBeTruthy();
});

test("selecting a goal card shows a trailing accent checkmark on that row only", async () => {
  const { getByText, queryAllByTestId } = await render(<Onboarding />);
  // "Lose weight" (fat_loss) is selected by default.
  expect(queryAllByTestId("sf-checkmark")).toHaveLength(1);
  await fireEvent.press(getByText("Build muscle"));
  expect(queryAllByTestId("sf-checkmark")).toHaveLength(1);
});

test("submit is blocked with an error when the numeric fields fail validation", async () => {
  const { getByText, findByText } = await render(<Onboarding />);
  // Birth year / height / weight are left blank.
  await fireEvent.press(getByText("Get started"));
  expect(mockMutate).not.toHaveBeenCalled();
  expect(await findByText("Please fill in your birth year, height, and weight.")).toBeTruthy();
});

test("valid submit sends the byte-identical onboarding payload and fires success haptic", async () => {
  const { getByText, getByLabelText } = await render(<Onboarding />);

  await fireEvent.press(getByText("Build muscle"));
  await fireEvent.press(getByText("Female"));
  await fireEvent.press(getByText("Active"));
  await fireEvent.changeText(getByLabelText("Birth year"), "1995");
  await fireEvent.changeText(getByLabelText("Height in centimetres"), "170");
  await fireEvent.changeText(getByLabelText("Weight in kilograms"), "65");
  await fireEvent.press(getByText("Get started"));

  expect(mockMutate).toHaveBeenCalledWith(
    {
      sex: "female",
      goal: "muscle_gain",
      activity_level: "active",
      birth_year: 1995,
      height_cm: 170,
      weight_kg: 65,
    },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );

  const { onSuccess } = mockMutate.mock.calls[0][1];
  onSuccess();
  expect(haptics.success).toHaveBeenCalledTimes(1);
  expect(router.replace).toHaveBeenCalledWith("/");
});

test("imperial: submit converts ft/in + lb inputs to metric height_cm/weight_kg", async () => {
  mockUseUnits.mockReturnValue({ system: "imperial", setSystem: jest.fn() });
  const { getByText, getByLabelText } = await render(<Onboarding />);

  await fireEvent.changeText(getByLabelText("Birth year"), "1995");
  await fireEvent.changeText(getByLabelText("Height in feet"), "5");
  await fireEvent.changeText(getByLabelText("Height in inches"), "11");
  await fireEvent.changeText(getByLabelText("Weight in pounds"), "150");
  await fireEvent.press(getByText("Get started"));

  expect(mockMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      birth_year: 1995,
      height_cm: expect.closeTo(180.34, 2), // 5'11" -> cm
      weight_kg: expect.closeTo(68.0388555, 4), // 150 lb -> kg
    }),
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});
