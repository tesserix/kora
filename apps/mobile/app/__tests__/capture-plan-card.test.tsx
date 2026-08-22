import { act, fireEvent, render as rtlRender } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCameraPermissions } from "expo-camera";
import { requestRecordingPermissionsAsync, useAudioRecorder } from "expo-audio";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { Linking } from "react-native";
import type { MealPlanProposal } from "@/api/types";

import CaptureScreen from "../capture";

jest.mock("expo-router", () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
}));

// Same shape as the real "@/lib/api" ApiError — see capture.test.tsx for why
// this is mocked instead of pulling in the real module under Jest.
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.name = "ApiError";
    }
  },
}));

const mockCaptureMessageMutate = jest.fn();
const mockAcceptPlanMutate = jest.fn();

jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone" } }),
  useCaptureMessage: () => ({ mutate: mockCaptureMessageMutate, isPending: false }),
  useAcceptMealPlan: () => ({ mutate: mockAcceptPlanMutate, isPending: false }),
  useResolvePhoto: () => ({ mutate: jest.fn(), isPending: false }),
  useResolveVoice: () => ({ mutate: jest.fn(), isPending: false }),
  useResolveBarcode: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateLog: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useFoodSearch: () => ({ data: [], isLoading: false, isError: false }),
}));

function render(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function makePlan(overrides: Partial<MealPlanProposal> = {}): MealPlanProposal {
  return {
    id: "plan-1",
    summary: "Hits your 2000 kcal and 120g protein targets.",
    days: [
      { date: "Monday", meals: [{
        name: "Oats and whey",
        description: "32g protein",
        preparation: "Simmer oats, then stir through whey.",
      }] },
      { date: "Tuesday", meals: [{
        name: "Chicken rice bowl",
        description: "Balanced meal",
        preparation: "Cook chicken through and serve over rice.",
      }] },
    ],
    agent_name: "Kora Meal Planner",
    reviewed_by: "Kora Nutrition Coach",
    accepted_at: null,
    starts_on: null,
    timezone: "",
    created_at: "2026-08-22T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockCaptureMessageMutate.mockReset();
  mockAcceptPlanMutate.mockReset();
  (router.back as jest.Mock).mockReset();
  (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true });
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true });
  (requestRecordingPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true, status: "granted" });
  (useAudioRecorder as jest.Mock).mockReset().mockReturnValue({
    prepareToRecordAsync: jest.fn(async () => {}),
    record: jest.fn(),
    pause: jest.fn(),
    stop: jest.fn(async () => {}),
    getStatus: jest.fn(async () => ({ isRecording: false })),
    uri: null,
    isRecording: false,
    currentTime: 0,
    id: "mock-recorder",
  });
  (useCameraPermissions as jest.Mock).mockReset().mockReturnValue([
    { granted: true, status: "granted", canAskAgain: true, expires: "never" },
    jest.fn(async () => ({ granted: true, status: "granted" })),
    jest.fn(async () => ({ granted: true, status: "granted" })),
  ]);
});

async function sendPlanRequest(plan: MealPlanProposal | null = makePlan()) {
  const view = await render(<CaptureScreen />);
  await fireEvent.press(await view.findByText("Type"));
  await fireEvent.changeText(await view.findByLabelText("Tell Otto what you ate"), "plan my meals for the week");
  await fireEvent.press(await view.findByLabelText("Send"));

  const [, options] = mockCaptureMessageMutate.mock.calls[0];
  await act(async () =>
    options.onSuccess({
      kind: "answer",
      answer: "This fits your targets. Approve it, or tell me what to change.",
      citations: [],
      show_support: false,
      agent: { name: "Kora Meal Planner", skill: "plan-meals", reviewed_by: "Kora Nutrition Coach" },
      plan,
    }),
  );
  return view;
}

test("a reviewed plan arrives as a card the user can approve, not just prose", async () => {
  const { findByTestId, findByText } = await sendPlanRequest(makePlan());

  await findByTestId("plan-card");
  await findByText("Hits your 2000 kcal and 120g protein targets.");
  await findByText("Monday");
  await findByText("Oats and whey");
  await findByText("Simmer oats, then stir through whey.");
  await findByText("Chicken rice bowl");
  // The prose that justifies the plan stays: the card is what it IS, the
  // paragraph is why it fits.
  await findByText("This fits your targets. Approve it, or tell me what to change.");
});

test("recipe help opens only the fixed preparation-search origin with an encoded meal name", async () => {
  const openURL = jest.spyOn(Linking, "openURL").mockResolvedValueOnce(true);
  const view = await sendPlanRequest(makePlan());

  await fireEvent.press(await view.findByLabelText("Find preparation video for Oats and whey"));

  expect(openURL).toHaveBeenCalledWith(
    "https://www.youtube.com/results?search_query=Oats%20and%20whey%20recipe",
  );
});

test("approving a plan records the decision and settles the card", async () => {
  const view = await sendPlanRequest(makePlan());

  await fireEvent.press(await view.findByTestId("plan-card-approve"));

  const [planID, options] = mockAcceptPlanMutate.mock.calls[0];
  expect(planID).toBe("plan-1");

  await act(async () => {
    options.onSuccess(makePlan({ accepted_at: "2026-08-22T06:00:00Z" }));
    options.onSettled?.();
  });

  await view.findByTestId("plan-card-approved");
  await view.findByText("Plan approved");
  expect(view.queryByTestId("plan-card-approve")).toBeNull();
});

test("an ordinary answer carries no card", async () => {
  const { queryByTestId } = await sendPlanRequest(null);

  expect(queryByTestId("plan-card")).toBeNull();
});
