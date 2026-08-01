import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { Platform } from "react-native";
import { router } from "expo-router";
import {
  isHealthDataAvailable,
  queryQuantitySamples,
  queryWorkoutSamples,
  requestAuthorization,
} from "@kingstinct/react-native-healthkit";

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

// Onboarding is two steps: the goal picker, then the body/activity details.
async function advance(ui: Awaited<ReturnType<typeof render>>) {
  await fireEvent.press(ui.getByText("Continue"));
}

test("step 1 shows the brand, the hero and the goal cards", async () => {
  const ui = await render(<Onboarding />);
  expect(ui.getByTestId("sf-sparkles")).toBeTruthy();
  expect(await ui.findByText(/Otto tracks it/i)).toBeTruthy();
  expect(await ui.findByText("Lose weight")).toBeTruthy();
  expect(await ui.findByText("Build muscle")).toBeTruthy();
  expect(await ui.findByText("Continue")).toBeTruthy();
});

test("step 1 withholds the detail fields and the final action", async () => {
  const ui = await render(<Onboarding />);
  expect(ui.queryByLabelText("Birth year")).toBeNull();
  expect(ui.queryByText("Get started")).toBeNull();
});

it("shows a non-medical disclaimer on the details step", async () => {
  const ui = await render(<Onboarding />);
  await advance(ui);
  expect(screen.getByText(/not medical advice/i)).toBeTruthy();
});

test("selecting a goal leaves exactly one card selected", async () => {
  const ui = await render(<Onboarding />);
  const selected = () =>
    ui.getAllByRole("radio").filter((n) => n.props.accessibilityState?.selected).length;
  // "Lose weight" (fat_loss) is selected by default.
  expect(selected()).toBe(1);
  await fireEvent.press(ui.getByText("Build muscle"));
  expect(selected()).toBe(1);
});

test("every activity level renders in full, with the descriptor that explains it", async () => {
  // Under the old equal-split Segmented, five options squeezed "Sedentary" into
  // "Sedentar/y" and wrapped "Very active" onto two lines. The descriptors are
  // why cards replaced it — without them the levels are unexplained jargon, so
  // they are asserted here rather than left as unpinned copy.
  const ui = await render(<Onboarding />);
  await advance(ui);
  const levels: Array<[string, string]> = [
    ["Sedentary", "Desk job, little walking"],
    ["Light", "1–2 sessions a week"],
    ["Moderate", "3–5 sessions a week"],
    ["Active", "6–7 sessions a week"],
    ["Very active", "Physical job or athlete"],
  ];
  for (const [label, sub] of levels) {
    expect(ui.getByText(label)).toBeTruthy();
    expect(ui.getByText(sub)).toBeTruthy();
  }
});

test("submit is blocked with an error when the numeric fields fail validation", async () => {
  const ui = await render(<Onboarding />);
  await advance(ui);
  await fireEvent.press(ui.getByText("Get started"));
  expect(mockMutate).not.toHaveBeenCalled();
  expect(await ui.findByText("Please fill in your birth year, height, and weight.")).toBeTruthy();
});

test("the goal chosen on step 1 survives the transition and reaches the payload", async () => {
  const ui = await render(<Onboarding />);
  await fireEvent.press(ui.getByText("Build muscle"));
  await advance(ui);
  await fireEvent.press(ui.getByText("Female"));
  await fireEvent.press(ui.getByText("Active"));
  await fireEvent.changeText(ui.getByLabelText("Birth year"), "1995");
  await fireEvent.changeText(ui.getByLabelText("Height in centimetres"), "170");
  await fireEvent.changeText(ui.getByLabelText("Weight in kilograms"), "65");
  await fireEvent.press(ui.getByText("Get started"));

  expect(mockMutate).toHaveBeenCalledTimes(1);
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

test("going back to step 1 keeps both the goal and what was typed on step 2", async () => {
  const ui = await render(<Onboarding />);
  await fireEvent.press(ui.getByText("Build muscle"));
  await advance(ui);
  await fireEvent.changeText(ui.getByLabelText("Birth year"), "1988");

  await fireEvent.press(ui.getByLabelText("Go back"));

  // Back on the goal picker, with the chosen goal still the selected one —
  // not merely still present on screen.
  const selectedCards = ui
    .getAllByRole("radio")
    .filter((n) => n.props.accessibilityState?.selected);
  expect(selectedCards).toHaveLength(1);
  expect(within(selectedCards[0]).getByText("Build muscle")).toBeTruthy();

  // And step 2's entry was not discarded by the round trip.
  await advance(ui);
  expect(ui.getByLabelText("Birth year").props.value).toBe("1988");
});

test("accepting a Health suggestion changes the activity level that is submitted", async () => {
  // The load-bearing integration property: the suggestion must reach the payload,
  // not just the screen. Seeded so the inference (sedentary) differs from the
  // default (moderate) — otherwise the assertion would pass either way.
  Object.defineProperty(Platform, "OS", { get: () => "ios", configurable: true });
  (isHealthDataAvailable as jest.Mock).mockReturnValue(true);
  (requestAuthorization as jest.Mock).mockResolvedValue(true);
  (queryQuantitySamples as jest.Mock).mockResolvedValue(
    Array.from({ length: 14 }, (_, i) => {
      const d = new Date();
      d.setHours(9, 0, 0, 0);
      d.setDate(d.getDate() - i);
      return { startDate: d, quantity: 3000 };
    }),
  );
  (queryWorkoutSamples as jest.Mock).mockResolvedValue([]);

  const ui = await render(<Onboarding />);
  await advance(ui);

  await fireEvent.press(ui.getByText("Use my Health data"));
  await waitFor(() => expect(ui.getByText("That reads as Sedentary.")).toBeTruthy());
  await fireEvent.press(ui.getByText("Sounds right"));

  await fireEvent.changeText(ui.getByLabelText("Birth year"), "1995");
  await fireEvent.changeText(ui.getByLabelText("Height in centimetres"), "170");
  await fireEvent.changeText(ui.getByLabelText("Weight in kilograms"), "65");
  await fireEvent.press(ui.getByText("Get started"));

  expect(mockMutate).toHaveBeenCalledWith(
    expect.objectContaining({ activity_level: "sedentary" }),
    expect.anything(),
  );
});

test("declining Health access leaves the manual cards as the way forward", async () => {
  Object.defineProperty(Platform, "OS", { get: () => "ios", configurable: true });
  (isHealthDataAvailable as jest.Mock).mockReturnValue(true);
  (requestAuthorization as jest.Mock).mockResolvedValue(false);

  const ui = await render(<Onboarding />);
  await advance(ui);
  await fireEvent.press(ui.getByText("Use my Health data"));

  await waitFor(() => expect(ui.getByText(/can't see your Health data/i)).toBeTruthy());
  // No level was asserted, and the cards are still there to choose from.
  expect(ui.queryByText(/That reads as/)).toBeNull();
  expect(ui.getByText("Sedentary")).toBeTruthy();
  expect(ui.getByText("Very active")).toBeTruthy();
});

test("imperial: submit converts ft/in + lb inputs to metric height_cm/weight_kg", async () => {
  mockUseUnits.mockReturnValue({ system: "imperial", setSystem: jest.fn() });
  const ui = await render(<Onboarding />);
  await advance(ui);

  await fireEvent.changeText(ui.getByLabelText("Birth year"), "1995");
  await fireEvent.changeText(ui.getByLabelText("Height in feet"), "5");
  await fireEvent.changeText(ui.getByLabelText("Height in inches"), "11");
  await fireEvent.changeText(ui.getByLabelText("Weight in pounds"), "150");
  await fireEvent.press(ui.getByText("Get started"));

  expect(mockMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      birth_year: 1995,
      height_cm: expect.closeTo(180.34, 2), // 5'11" -> cm
      weight_kg: expect.closeTo(68.0388555, 4), // 150 lb -> kg
    }),
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("a server failure does not tell the user their details are wrong", async () => {
  // The shipped copy blamed the user's input for every failure, including a
  // 5xx — sending someone whose details were fine round a loop they cannot
  // exit by doing what they are told. Reproduced against prod during the
  // device pass, where onboarding failed while the identical payload
  // succeeded via curl seconds later.
  const ui = await render(<Onboarding />);
  await advance(ui);
  await fireEvent.changeText(ui.getByLabelText("Birth year"), "1995");
  await fireEvent.changeText(ui.getByLabelText("Height in centimetres"), "170");
  await fireEvent.changeText(ui.getByLabelText("Weight in kilograms"), "65");
  await fireEvent.press(ui.getByText("Get started"));

  const { onError } = mockMutate.mock.calls[0][1];
  await act(async () => {
    onError(Object.assign(new Error("down"), { name: "ApiError", status: 503 }));
  });

  expect(
    await ui.findByText("Kora is having trouble right now. Please try again in a moment."),
  ).toBeTruthy();
  expect(ui.queryByText("Please check your details and try again.")).toBeNull();
});

test("a validation rejection still asks the user to check their details", async () => {
  const ui = await render(<Onboarding />);
  await advance(ui);
  await fireEvent.changeText(ui.getByLabelText("Birth year"), "1995");
  await fireEvent.changeText(ui.getByLabelText("Height in centimetres"), "170");
  await fireEvent.changeText(ui.getByLabelText("Weight in kilograms"), "65");
  await fireEvent.press(ui.getByText("Get started"));

  const { onError } = mockMutate.mock.calls[0][1];
  await act(async () => {
    onError(Object.assign(new Error("bad"), { name: "ApiError", status: 400 }));
  });

  expect(await ui.findByText("Please check your details and try again.")).toBeTruthy();
});
