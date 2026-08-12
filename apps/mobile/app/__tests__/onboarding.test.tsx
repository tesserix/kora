import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
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

beforeEach(() => {
  mockMutate.mockClear();
  mockIsPending = false;
  (router.replace as jest.Mock).mockClear();
  mockUseUnits.mockReturnValue({ system: "metric", setSystem: jest.fn() });
});

// `fireEvent` (RNTL v14) always wraps its handler call in an async `act()`,
// so the commit is not guaranteed to have flushed until the returned promise
// resolves — an unawaited call here silently queries a stale tree on the very
// next line rather than throwing.
async function increment(testID: string) {
  await fireEvent(screen.getByTestId(testID), "accessibilityAction", {
    nativeEvent: { actionName: "increment" },
  });
}

// Drives age, height and weight to a touched, valid state. Asserts the
// awaiting caption is gone before returning, so a change to the rulers'
// defaults (which would otherwise leave one of them still untouched, or an
// out-of-range value that fails validation later) fails loudly here instead
// of silently invalidating every test downstream that calls it.
async function setValidBody() {
  await increment("age-ruler");
  await increment("height-ruler");
  await increment("weight-ruler");
  expect(screen.queryByTestId("plan-dial-awaiting")).toBeNull();
}

describe("onboarding", () => {
  it("shows no target until every required number is set", async () => {
    await render(<Onboarding />);
    expect(screen.getByTestId("plan-dial-awaiting")).toBeTruthy();
  });

  it("shows a target once age, height and weight are set", async () => {
    await render(<Onboarding />);
    await increment("age-ruler");
    await increment("height-ruler");
    await increment("weight-ruler");
    expect(screen.queryByTestId("plan-dial-awaiting")).toBeNull();
    // PlanDial wraps its SVG in an accessibility-hidden subtree; RNTL excludes
    // hidden elements by default, so this needs includeHiddenElements or it
    // returns null unconditionally and silently tests nothing.
    expect(
      screen.getByTestId("plan-dial-needle", { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  // The destination has no meaning when maintaining — it disappears rather
  // than greying out, and the payload must omit it.
  it("hides the destination when the goal is Maintain", async () => {
    await render(<Onboarding />);
    await increment("goal-ruler");
    expect(screen.queryByTestId("goal-weight-ruler")).toBeNull();
    expect(screen.queryByTestId("pace-ruler")).toBeNull();
  });

  it("does not submit before the user accepts", async () => {
    await render(<Onboarding />);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("submits age as a birth year and includes the destination", async () => {
    await render(<Onboarding />);
    await setValidBody();
    await fireEvent.press(screen.getByText("Start with this plan"));
    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sex: "male",
        goal: "fat_loss",
        activity_level: "moderate",
        goal_weight_kg: expect.any(Number),
        pace_kg_per_week: expect.any(Number),
        birth_year: expect.any(Number),
      }),
      expect.anything(),
    );
    expect(mockMutate.mock.calls[0][0]).not.toHaveProperty("age");
    // `expect.any(Number)` above only proves birth_year is numeric, not that
    // it was actually derived from age — pin the real arithmetic too.
    // setValidBody's single age-ruler increment moves the default 30-year-old
    // to 31, so the wire value must be this year minus 31, not minus 30 and
    // not the raw age itself.
    expect(mockMutate.mock.calls[0][0].birth_year).toBe(new Date().getFullYear() - 31);
  });

  it("omits the destination from a maintenance payload", async () => {
    await render(<Onboarding />);
    await setValidBody();
    await increment("goal-ruler");
    await fireEvent.press(screen.getByText("Start with this plan"));
    const payload = mockMutate.mock.calls[0][0];
    expect(payload.goal).toBe("maintenance");
    expect(payload.goal_weight_kg).toBeUndefined();
    expect(payload.pace_kg_per_week).toBeUndefined();
  });

  it("blocks a goal weight that contradicts the goal", async () => {
    await render(<Onboarding />);
    await setValidBody();
    // Drive the goal-weight ruler above current weight while losing.
    for (let i = 0; i < 40; i++) {
      await increment("goal-weight-ruler");
    }
    await fireEvent.press(screen.getByText("Start with this plan"));
    expect(mockMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/goal weight is above your current weight/)).toBeTruthy();
  });

  it("reports a submit failure without blaming the user's details", async () => {
    mockMutate.mockImplementation((_input, opts) =>
      opts.onError(new TypeError("Network request failed")),
    );
    await render(<Onboarding />);
    await setValidBody();
    await fireEvent.press(screen.getByText("Start with this plan"));
    await waitFor(() => expect(screen.getByText(/connection|offline|try again/i)).toBeTruthy());
  });

  it("navigates home on success", async () => {
    mockMutate.mockImplementation((_input, opts) => opts.onSuccess());
    await render(<Onboarding />);
    await setValidBody();
    await fireEvent.press(screen.getByText("Start with this plan"));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  });
});
