import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
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
import { computePlan } from "@/lib/plan";

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

  it("submits age as a birth year and includes the destination once the destination ruler is touched", async () => {
    await render(<Onboarding />);
    await setValidBody();
    await increment("goal-weight-ruler");
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

  it("includes the destination once the goal-weight ruler has been touched", async () => {
    await render(<Onboarding />);
    await setValidBody();
    await increment("goal-weight-ruler");
    await fireEvent.press(screen.getByText("Start with this plan"));
    const payload = mockMutate.mock.calls[0][0];
    expect(payload.goal_weight_kg).toEqual(expect.any(Number));
    expect(payload.pace_kg_per_week).toEqual(expect.any(Number));
  });

  // The regression this closes: computePlan (which drives the dial and
  // derivation rows) always used the visually-selected, always-real
  // paceKgPerWeek — even while the destination ruler was untouched and the
  // payload therefore omitted pace_kg_per_week. A missing pace decodes to
  // Go's zero value server-side, silently collapsing the deficit to plain
  // TDEE, so the number the user agreed to on screen was not the number
  // that got stored. canAccept closes this by making submission impossible
  // until the destination is real, so the two can no longer disagree.
  it("disables accept for a non-maintenance goal until the destination is touched, and does not submit on press", async () => {
    await render(<Onboarding />);
    await setValidBody();
    // Default goal is "Lose weight" (fat_loss); body numbers are real but
    // the destination ruler has not been touched.
    expect(screen.getByTestId("accept-button").props.accessibilityState.disabled).toBe(true);

    await fireEvent.press(screen.getByText("Start with this plan"));
    expect(mockMutate).not.toHaveBeenCalled();

    await increment("goal-weight-ruler");
    expect(screen.getByTestId("accept-button").props.accessibilityState.disabled).toBe(false);
  });

  it("enables accept for maintenance without any destination", async () => {
    await render(<Onboarding />);
    await setValidBody();
    await increment("goal-ruler"); // Lose weight -> Maintain
    expect(screen.getByTestId("accept-button").props.accessibilityState.disabled).toBe(false);
  });

  // The assertion that actually pins screen-equals-server: read the target
  // the dial/derivation row displayed, recompute computePlan using the pace
  // that was actually submitted, and require they match. Pinning each side
  // in isolation (as the omit/include tests above do) would not have caught
  // this regression — both sides individually looked correct.
  it("keeps the submitted pace in agreement with the displayed target", async () => {
    await render(<Onboarding />);
    await setValidBody();
    await increment("goal-weight-ruler");

    const displayedValue = within(screen.getByTestId("derivation-chain-row-3")).getByText(
      /\d+ kcal/,
    ).props.children;
    const displayedKcal = Number(String(displayedValue).replace(/[^\d]/g, ""));

    await fireEvent.press(screen.getByText("Start with this plan"));
    const payload = mockMutate.mock.calls[0][0];
    expect(payload.pace_kg_per_week).toEqual(expect.any(Number));

    const recomputed = computePlan({
      sex: payload.sex,
      age: new Date().getFullYear() - payload.birth_year,
      heightCm: payload.height_cm,
      weightKg: payload.weight_kg,
      activityLevel: payload.activity_level,
      goal: payload.goal,
      paceKgPerWeek: payload.pace_kg_per_week,
    });

    expect(Math.round(recomputed.kcal)).toBe(displayedKcal);
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
    await increment("goal-weight-ruler");
    await fireEvent.press(screen.getByText("Start with this plan"));
    await waitFor(() => expect(screen.getByText(/connection|offline|try again/i)).toBeTruthy());
  });

  it("navigates home on success", async () => {
    mockMutate.mockImplementation((_input, opts) => opts.onSuccess());
    await render(<Onboarding />);
    await setValidBody();
    await increment("goal-weight-ruler");
    await fireEvent.press(screen.getByText("Start with this plan"));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  });

  // A concrete number in the derivation chain or macro grid before the user
  // has agreed to anything is exactly the failure this screen exists to
  // remove — those sections must withhold their values ("—", matching the
  // header) until hasAllNumbers is true, the same gate PlanDial already uses.
  it("withholds the derivation chain and macro numbers until the target is real", async () => {
    await render(<Onboarding />);
    expect(within(screen.getByTestId("derivation-chain-row-0")).getByText("—")).toBeTruthy();
    expect(within(screen.getByTestId("derivation-chain-row-1")).getByText("—")).toBeTruthy();
    expect(within(screen.getByTestId("derivation-chain-row-2")).getByText("—")).toBeTruthy();
    expect(within(screen.getByTestId("derivation-chain-row-3")).getByText("—")).toBeTruthy();
    // No numeric kcal or gram figure anywhere on screen — not just in the
    // rows we happened to check by testID.
    expect(screen.queryByText(/\d+ kcal/)).toBeNull();
    expect(screen.queryByText(/^\d+g$/)).toBeNull();

    await setValidBody();

    expect(
      within(screen.getByTestId("derivation-chain-row-3")).getByText(/\d+ kcal/),
    ).toBeTruthy();
    expect(screen.getAllByText(/^\d+g$/)).toHaveLength(3);
  });

  // Traced case: weight 120kg, pick the 1.0 stop, drag to 50kg. The clamp
  // used to run in a useEffect AFTER commit, so the render that shrinks
  // `paces` briefly carries the stale (now out-of-range) index into
  // `labels[index]`, which is undefined — a screen reader announces nothing
  // and the stop layout is momentarily wrong for one frame.
  it("keeps the pace ruler's accessibility value defined when a weight drop shrinks the pace stops", async () => {
    await render(<Onboarding />);

    // Raise weight from the default 70kg to 100kg (cap 1.0 => all four pace
    // stops allowed) via a direct drag rather than ~60 increments. A leading
    // duplicate event is required — jest-utils' state-transition filler only
    // delivers an `onUpdate` (where the ruler actually applies translationX)
    // from the second event onward; a single-element list is consumed
    // entirely by `onBegin`.
    await act(() =>
      fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
        { translationX: -270 },
        { translationX: -270 },
      ]),
    );
    // Select the last stop (index 3, "1 kg/wk") from the default index 1.
    await increment("pace-ruler");
    await increment("pace-ruler");
    expect(screen.getByTestId("pace-ruler").props.accessibilityValue).toEqual({
      text: "1 kg/wk",
    });

    // Drop weight to 60kg — cap becomes 0.6, which only allows [0.25, 0.5],
    // shrinking the pace list out from under the selected index.
    await act(() =>
      fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
        { translationX: 360 },
        { translationX: 360 },
      ]),
    );

    const ruler = screen.getByTestId("pace-ruler");
    expect(ruler.props.accessibilityValue).toEqual({ text: "0.5 kg/wk" });
  });

  // Nothing stops a regression that passes `plan.kcal` to PlanDial while
  // leaving the gated `dialKcal` on PlanDelta (or vice versa) — pin the
  // silence explicitly through the transition, not just PlanDelta's own
  // isolated suite.
  it("keeps PlanDelta silent through the null-to-first-target transition, then announces the next change", async () => {
    jest.useFakeTimers();
    try {
      await render(<Onboarding />);
      await increment("age-ruler");
      await increment("height-ruler");
      // The third touch flips hasAllNumbers — kcal goes from null to its
      // first real value. PlanDelta's own mount-guard treats a null
      // "previous" as nothing having changed yet, so this must stay silent.
      await increment("weight-ruler");
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      expect(screen.queryByTestId("plan-delta-text")).toBeNull();

      // The next change has a real previous kcal behind it, so it must
      // announce.
      await increment("weight-ruler");
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      expect(screen.getByTestId("plan-delta-text")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  // The accept gate is the whole point of this screen: the defaults (age 30,
  // height 170, weight 70) pass validation on their own, so without this the
  // button would let a press submit fabricated body measurements while the
  // dial overhead still says "Awaiting your numbers". A `disabled` prop that
  // still fires on press would pass a shallower check than this — the
  // "does not call submit" assertion is the one that actually matters.
  it("disables the accept button until every required number is set, and does not submit on press", async () => {
    await render(<Onboarding />);
    const button = screen.getByTestId("accept-button");
    expect(button.props.accessibilityState.disabled).toBe(true);

    await fireEvent.press(screen.getByText("Start with this plan"));
    expect(mockMutate).not.toHaveBeenCalled();

    await setValidBody();
    // Default goal is "Lose weight" (fat_loss), so the button also needs the
    // destination ruler touched — see the dedicated destination-gating tests
    // below for that half of the accept gate.
    await increment("goal-weight-ruler");
    expect(screen.getByTestId("accept-button").props.accessibilityState.disabled).toBe(false);
  });

  // Same leak as the derivation rows and macro trio, one level up: the
  // "N weeks to goal" caption is derived from weightKg/goalWeightKg defaults
  // and was rendered whenever the goal wasn't maintenance, regardless of
  // whether the user had touched anything.
  it("withholds the destination caption's weeks figure until the target is real", async () => {
    await render(<Onboarding />);
    // Default goal is "Lose weight" (fat_loss), so the destination section
    // (and its caption) is already showing. The caption IS the Text node
    // (its own children, not a nested one), so assert on `.props.children`
    // rather than an in-scope `within(...).getByText`, which only searches
    // descendants and would never match the element's own text.
    expect(screen.getByTestId("destination-caption").props.children).toBe("—");

    await setValidBody();

    // Body numbers are real now, but the destination ruler itself has not
    // been touched — the caption must still withhold rather than compute
    // weeks from the untouched goalWeightKg default.
    expect(screen.getByTestId("destination-caption").props.children).toBe("—");

    await increment("goal-weight-ruler");

    const captionText = screen.getByTestId("destination-caption").props.children;
    expect(captionText).not.toBe("—");
    expect(String(captionText)).toMatch(/weeks to goal|You're already there/);
  });
});
