import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";

import Plan from "../plan";
import { computePlan } from "@/lib/plan";
import { draftToParams, type PlanDraft } from "@/lib/planDraft";
import type { PlanResponse } from "@/api/types";

let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: {
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
    setParams: jest.fn(),
  },
  useLocalSearchParams: () => mockParams,
}));

// The real "@/lib/api" pulls in firebase/auth (real ESM); only ApiError is
// needed, to drive apiErrorMessage's 5xx branch.
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

const mockSubmit = jest.fn();
const mockSave = jest.fn();
const mockUsePlan = jest.fn();
let mockProfile: { onboarded_at: string | null; plan_saved_at?: string | null } | undefined;
let mockProfileError: Error | null = null;
const mockRefetch = jest.fn();
jest.mock("@/api/hooks", () => ({
  useSubmitOnboarding: () => ({ mutate: mockSubmit, isPending: false }),
  useSavePlan: () => ({ mutate: mockSave, isPending: false }),
  usePlan: (...a: unknown[]) => mockUsePlan(...a),
  useProfile: () => ({ data: mockProfile, error: mockProfileError, refetch: mockRefetch }),
}));

// PlanOtto has its own tests; here only the onUse it is handed matters.
let mockOnUse: ((d: PlanDraft) => void) | undefined;
jest.mock("@/components/plan/PlanOtto", () => ({
  PlanOtto: (props: { onUse: (d: PlanDraft) => void }) => {
    mockOnUse = props.onUse;
    return null;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ApiError } = require("@/lib/api");

const YEAR = new Date().getFullYear();
const DRAFT: PlanDraft = {
  timezone: "Asia/Kolkata",
  sex: "male",
  birth_year: YEAR - 30,
  height_cm: 180,
  weight_kg: 80,
  activity_level: "moderate",
  goal: "fat_loss",
  goal_weight_kg: 72,
  pace_kg_per_week: 0.5,
};

const kora = computePlan({
  sex: "male",
  age: 30,
  heightCm: 180,
  weightKg: 80,
  activityLevel: "moderate",
  goal: "fat_loss",
  paceKgPerWeek: 0.5,
  goalWeightKg: 72,
});

const primary = () => screen.getByTestId("plan-primary");
const r = Math.round;

async function typeProtein(text: string) {
  await fireEvent.press(screen.getByTestId("protein-value"));
  await fireEvent.changeText(screen.getByTestId("protein-input"), text);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { ...draftToParams(DRAFT), mode: "onboarding" };
  mockProfile = { onboarded_at: null };
  mockProfileError = null;
  mockUsePlan.mockReturnValue({ data: undefined, isLoading: false, error: null });
});

describe("plan page", () => {
  it("shows the plan computed from the draft with its working", async () => {
    await render(<Plan />);
    expect(screen.getByTestId("kcal-value")).toHaveTextContent(String(r(kora.kcal)));
    expect(screen.getByTestId("derivation-chain-row-0")).toHaveTextContent(`Resting burn${r(kora.bmr)} kcal`);
    expect(screen.getByTestId("derivation-chain-row-1")).toHaveTextContent(`Activity-adjusted${r(kora.tdee)} kcal`);
    expect(screen.getByTestId("derivation-chain-row-2")).toHaveTextContent("Goal adjustment−550 kcal");
    expect(screen.getByTestId("derivation-chain-row-3")).toHaveTextContent(`Daily target${r(kora.kcal)} kcal`);
    expect(screen.getByTestId("protein-value")).toHaveTextContent(`${r(kora.proteinG)}g`);
    expect(screen.getByTestId("protein-basis")).toHaveTextContent("1.8 g/kg goal wt");
    expect(screen.getByTestId("carbs-basis")).toHaveTextContent("the rest");
    expect(screen.getByTestId("fat-basis")).toHaveTextContent("25%");
    expect(screen.getByText("Start with this plan")).toBeTruthy();
    expect(screen.queryByText(/Kept at your resting burn/)).toBeNull();
    expect(screen.getByText(/not medical advice/)).toBeTruthy();
    // Onboarding mode never calls GET /v1/me/plan: the user has no plan yet.
    expect(mockUsePlan).toHaveBeenCalledWith({ enabled: false });
  });

  it("editing protein shows Your number and recomputes carbs", async () => {
    await render(<Plan />);
    await typeProtein("150");
    const expected = computePlan({
      sex: "male", age: 30, heightCm: 180, weightKg: 80, activityLevel: "moderate",
      goal: "fat_loss", paceKgPerWeek: 0.5, goalWeightKg: 72, proteinOverrideG: 150,
    });
    expect(screen.getByTestId("protein-basis")).toHaveTextContent("Your number");
    expect(screen.getByTestId("carbs-value")).toHaveTextContent(`${r(expected.carbsG)}g`);
    expect(r(expected.carbsG)).not.toBe(r(kora.carbsG));
    expect(primary().props.accessibilityState.disabled).toBe(false);
  });

  it("save is disabled while an override is flagged", async () => {
    await render(<Plan />);
    await typeProtein("300");
    expect(screen.getByTestId("override-error")).toHaveTextContent(
      "That's above 2.5 g per kg, more than your body can use.",
    );
    expect(primary().props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(primary());
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("Use Kora's clears the override", async () => {
    await render(<Plan />);
    await typeProtein("300");
    await fireEvent.press(screen.getByTestId("use-kora-protein"));
    expect(screen.queryByTestId("override-error")).toBeNull();
    expect(screen.getByTestId("protein-basis")).toHaveTextContent("1.8 g/kg goal wt");
    expect(screen.getByTestId("protein-value")).toHaveTextContent(`${r(kora.proteinG)}g`);
    expect(primary().props.accessibilityState.disabled).toBe(false);
  });

  it("an empty field means no override, not an invalid one", async () => {
    await render(<Plan />);
    await typeProtein("");
    expect(screen.queryByTestId("override-error")).toBeNull();
    expect(screen.getByTestId("protein-basis")).toHaveTextContent("1.8 g/kg goal wt");
  });

  it("Start with this plan submits onboarding with the overrides and goes home", async () => {
    await render(<Plan />);
    await fireEvent.press(screen.getByTestId("kcal-value"));
    await fireEvent.changeText(screen.getByTestId("kcal-input"), "2300");
    await typeProtein("150");
    expect(screen.getByTestId("derivation-chain-row-3")).toHaveTextContent("Your target2300 kcal");
    await fireEvent.press(primary());
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    const [body, opts] = mockSubmit.mock.calls[0];
    expect(body).toEqual({ ...DRAFT, target_kcal_override: 2300, target_protein_override_g: 150 });
    opts.onSuccess();
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("a submit failure keeps the user on the page with the draft intact and the error shown", async () => {
    await render(<Plan />);
    await typeProtein("150");
    await fireEvent.press(primary());
    const [, opts] = mockSubmit.mock.calls[0];
    await act(() => opts.onError(new ApiError(500, "internal_error", "boom")));
    expect(screen.getByTestId("submit-error")).toHaveTextContent(
      "Kora is having trouble right now. Please try again in a moment.",
    );
    expect(screen.getByTestId("protein-basis")).toHaveTextContent("Your number");
    expect(screen.getByTestId("protein-value")).toHaveTextContent("150g");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("onboarding mode for an already-onboarded user saves with PUT, never a second onboarding", async () => {
    mockProfile = { onboarded_at: "2026-10-01T00:00:00Z" };
    await render(<Plan />);
    expect(screen.getByText("Save")).toBeTruthy();
    await fireEvent.press(primary());
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledWith(DRAFT, expect.anything());
  });

  it("edit round-trip during onboarding still submits with POST", async () => {
    mockParams = { ...draftToParams(DRAFT), mode: "edit" };
    await render(<Plan />);
    expect(screen.getByText("Start with this plan")).toBeTruthy();
    await fireEvent.press(primary());
    expect(mockSubmit).toHaveBeenCalledWith(DRAFT, expect.anything());
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("keeps the button disabled until the profile has loaded, in any mode", async () => {
    mockParams = { ...draftToParams(DRAFT), mode: "edit" };
    mockProfile = undefined;
    await render(<Plan />);
    expect(primary().props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(primary());
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("a profile load failure says so and offers Try again", async () => {
    mockProfile = undefined;
    mockProfileError = new Error("offline");
    await render(<Plan />);
    expect(screen.getByTestId("profile-error")).toHaveTextContent("Couldn't load your profile.");
    expect(primary().props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByText("Try again"));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("an onboarded user who never saved a plan is told Save makes it theirs", async () => {
    mockProfile = { onboarded_at: "2026-10-01T00:00:00Z", plan_saved_at: null };
    await render(<Plan />);
    expect(screen.getByTestId("plan-unsaved")).toHaveTextContent(
      "Kora's current calculation. Save to make it your plan.",
    );
  });

  it("no unsaved caption during onboarding or once a plan is saved", async () => {
    await render(<Plan />);
    expect(screen.queryByTestId("plan-unsaved")).toBeNull();
    mockProfile = { onboarded_at: "2026-10-01T00:00:00Z", plan_saved_at: "2026-10-02T00:00:00Z" };
    await render(<Plan />);
    expect(screen.queryByTestId("plan-unsaved")).toBeNull();
  });

  it("onboarding mode keeps the button disabled until the profile has loaded", async () => {
    mockProfile = undefined;
    await render(<Plan />);
    expect(primary().props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(primary());
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("opened from Profile, loads usePlan and saves with PUT", async () => {
    mockParams = {};
    mockProfile = { onboarded_at: "2026-10-01T00:00:00Z" };
    const data: PlanResponse = {
      inputs: { ...DRAFT, timezone: "Asia/Kolkata", goal_weight_kg: 72, pace_kg_per_week: 0.5,
        target_kcal_override: 2300, target_protein_override_g: null },
      targets: {} as PlanResponse["targets"],
      override_error: null,
      input_error: null,
    };
    mockUsePlan.mockReturnValue({ data, isLoading: false, error: null });
    await render(<Plan />);
    expect(mockUsePlan).toHaveBeenCalledWith({ enabled: true });
    expect(screen.getByTestId("kcal-value")).toHaveTextContent("2300");
    expect(screen.getByTestId("kcal-basis")).toHaveTextContent("Your number");
    expect(screen.getByText("Save")).toBeTruthy();

    await fireEvent.press(screen.getByText("Body, activity & goal"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/onboarding",
      params: { ...draftToParams({ ...DRAFT, target_kcal_override: 2300 }), mode: "edit" },
    });

    await fireEvent.press(primary());
    const [body, opts] = mockSave.mock.calls[0];
    // A null override is omitted, which clears it on PUT.
    expect(body).toEqual({ ...DRAFT, target_kcal_override: 2300 });
    expect(body).not.toHaveProperty("target_protein_override_g");
    opts.onSuccess();
    expect(router.back).toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("a stored override the server flags is shown as Your number and blocks Save until cleared", async () => {
    mockParams = {};
    mockProfile = { onboarded_at: "2026-10-01T00:00:00Z" };
    mockUsePlan.mockReturnValue({
      data: {
        inputs: { ...DRAFT, timezone: "Asia/Kolkata", goal_weight_kg: 72, pace_kg_per_week: 0.5,
          target_kcal_override: null, target_protein_override_g: 300 },
        targets: {},
        override_error: "protein_above_max",
        input_error: null,
      },
      isLoading: false,
      error: null,
    });
    await render(<Plan />);
    expect(screen.getByTestId("protein-basis")).toHaveTextContent("Your number");
    expect(screen.getByTestId("override-error")).toHaveTextContent(
      "That's above 2.5 g per kg, more than your body can use.",
    );
    expect(primary().props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId("use-kora-protein"));
    expect(primary().props.accessibilityState.disabled).toBe(false);
  });

  it("an input_error from the server is shown and Save stays disabled", async () => {
    mockParams = {};
    mockProfile = { onboarded_at: "2026-10-01T00:00:00Z" };
    mockUsePlan.mockReturnValue({
      data: {
        inputs: { ...DRAFT, timezone: "Asia/Kolkata", weight_kg: 70, goal_weight_kg: 72, pace_kg_per_week: 0.5,
          target_kcal_override: null, target_protein_override_g: null },
        targets: {},
        override_error: null,
        input_error: "onboarding: goal_weight_kg is above weight_kg for a fat_loss goal",
      },
      isLoading: false,
      error: null,
    });
    await render(<Plan />);
    // The server's text is a developer string; the page says it in words.
    expect(screen.getByTestId("input-error")).toHaveTextContent(
      "Your latest weigh-in no longer fits your goal weight or pace. Update them in Body, activity & goal.",
    );
    // Targets ignore the broken destination, like the server's.
    expect(screen.getByTestId("protein-basis")).toHaveTextContent("1.8 g/kg body wt");
    expect(primary().props.accessibilityState.disabled).toBe(true);
  });

  it("use this replaces draft and clears typed overrides", async () => {
    await render(<Plan />);
    await typeProtein("150");
    const { target_protein_override_g: _p, ...rest } = DRAFT;
    await act(() => mockOnUse!({ ...rest, activity_level: "light" }));
    expect(router.setParams).toHaveBeenCalledWith(
      expect.objectContaining({
        target_protein_override_g: undefined,
        activity_level: "light",
        mode: "onboarding",
      }),
    );
    // The typed 150 no longer shadows the draft's (absent) override.
    expect(screen.getByTestId("protein-basis")).toHaveTextContent("1.8 g/kg goal wt");
  });

  it("the page scrolls a focused input above the iOS keyboard", async () => {
    // Otto's input sits near the bottom of the scroll content.
    await render(<Plan />);
    expect(screen.getByTestId("plan-scroll").props.automaticallyAdjustKeyboardInsets).toBe(true);
  });

  it("a missing draft in onboarding mode returns to onboarding", async () => {
    mockParams = { mode: "onboarding", sex: "male" };
    await render(<Plan />);
    expect(router.replace).toHaveBeenCalledWith("/onboarding");
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
