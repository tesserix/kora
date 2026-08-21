import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { router } from "expo-router";

import Onboarding from "../onboarding";
import { computePlan } from "@/lib/plan";

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

// Nudges age, height and weight off their defaults. Asserts a real target is
// on screen before returning, so a change to the rulers' defaults that lands
// out of range (and would fail validation later) fails loudly here instead of
// silently invalidating every test downstream that calls it.
async function setValidBody() {
  await increment("age-ruler");
  await increment("height-ruler");
  await increment("weight-ruler");
  expect(within(screen.getByTestId("derivation-chain-row-3")).getByText(/\d+ kcal/)).toBeTruthy();
}

describe("onboarding", () => {
  // kora#164: the defaults on the rulers ARE the plan until the user moves
  // them, so the screen shows the target they describe from the first frame
  // instead of an "awaiting your numbers" dial the user cannot dismiss
  // without touching every control.
  it("shows a target on arrival, derived from the defaults on display", async () => {
    await render(<Onboarding />);
    expect(screen.queryByTestId("plan-dial-awaiting")).toBeNull();
    // PlanDial wraps its SVG in an accessibility-hidden subtree; RNTL excludes
    // hidden elements by default, so this needs includeHiddenElements or it
    // returns null unconditionally and silently tests nothing.
    expect(
      screen.getByTestId("plan-dial-needle", { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  // The heart of kora#164. Enabling the button is only safe because the
  // values are visible (kora#165) AND because pressing it submits exactly
  // those values — not zeros, nulls or empty strings routed round
  // validateOnboardingNumbers.
  it("enables accept on arrival and submits exactly the defaults on display", async () => {
    await render(<Onboarding />);
    expect(screen.getByTestId("accept-button").props.accessibilityState.disabled).toBe(false);

    await fireEvent.press(screen.getByText("Start with this plan"));
    expect(mockMutate).toHaveBeenCalledTimes(1);
    const payload = mockMutate.mock.calls[0][0];
    expect(payload.height_cm).toBe(170);
    expect(payload.weight_kg).toBe(70);
    expect(payload.birth_year).toBe(new Date().getFullYear() - 30);
    expect(payload.goal_weight_kg).toBe(65);
    expect(payload.pace_kg_per_week).toEqual(expect.any(Number));
  });

  // kora#165 at the screen level: every ruler names its number in the units
  // the screen is in, and those numbers are the ones that leave for the
  // server (metric, always).
  it("reads out every ruler's value and submits those same values", async () => {
    await render(<Onboarding />);
    expect(screen.getByTestId("age-ruler-readout").props.children).toBe("30 years");
    expect(screen.getByTestId("height-ruler-readout").props.children).toBe("170 cm");
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("70 kg");
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("65 kg");

    await fireEvent.press(screen.getByText("Start with this plan"));
    const payload = mockMutate.mock.calls[0][0];
    expect(payload.birth_year).toBe(new Date().getFullYear() - 30);
    expect(payload.height_cm).toBe(170);
    expect(payload.weight_kg).toBe(70);
    expect(payload.goal_weight_kg).toBe(65);
  });

  // Imperial is a DISPLAY mode only — the readouts speak ft/in and lb while
  // the payload stays metric, so a readout that agreed with the payload
  // numerically would in fact be the bug.
  it("reads out imperial units while still submitting metric", async () => {
    mockUseUnits.mockReturnValue({ system: "imperial", setSystem: jest.fn() });
    await render(<Onboarding />);
    expect(screen.getByTestId("height-ruler-readout").props.children).toBe("5'7\"");
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("154 lb");
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("143 lb");

    await fireEvent.press(screen.getByText("Start with this plan"));
    const payload = mockMutate.mock.calls[0][0];
    expect(payload.height_cm).toBe(170);
    expect(payload.weight_kg).toBe(70);
  });

  it("keeps the readout in step with the value as the ruler moves", async () => {
    await render(<Onboarding />);
    await increment("weight-ruler");
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("70.5 kg");
    await fireEvent.press(screen.getByText("Start with this plan"));
    expect(mockMutate.mock.calls[0][0].weight_kg).toBe(70.5);
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

  // The regression this protects: computePlan (which drives the dial and
  // derivation rows) always used the visually-selected, always-real
  // paceKgPerWeek, while the payload used to OMIT pace_kg_per_week whenever
  // the destination ruler was untouched. A missing pace decodes to Go's zero
  // value server-side, silently collapsing the deficit to plain TDEE, so the
  // number the user agreed to on screen was not the number that got stored.
  // Now that the visible destination is an accepted value, it is always sent
  // for a non-maintenance goal — untouched included — so the two cannot
  // disagree.
  it("sends the destination for a non-maintenance goal even when its ruler was never touched", async () => {
    await render(<Onboarding />);
    await fireEvent.press(screen.getByText("Start with this plan"));
    const payload = mockMutate.mock.calls[0][0];
    expect(payload.goal).toBe("fat_loss");
    expect(payload.goal_weight_kg).toBe(65);
    expect(payload.pace_kg_per_week).toEqual(expect.any(Number));
  });

  // The default destination has to stay COHERENT with the goal and the current
  // weight, or removing the untouched-destination validation skip just moves
  // kora#164's first-run blocker somewhere new: pick "Build muscle" as your
  // very first action and the default 65kg destination contradicts the default
  // 70kg current weight, so the first tap of an enabled button is a validation
  // error about a number you never chose. Derived-until-set fixes the value
  // rather than re-hiding it.
  it("derives a destination above current weight when Build muscle is picked and nothing is touched", async () => {
    await render(<Onboarding />);
    await increment("goal-ruler"); // Lose weight -> Maintain
    await increment("goal-ruler"); // Maintain -> Build muscle
    expect(screen.getByTestId("accept-button").props.accessibilityState.disabled).toBe(false);
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("75 kg");

    await fireEvent.press(screen.getByText("Start with this plan"));
    const payload = mockMutate.mock.calls[0][0];
    expect(payload.goal).toBe("muscle_gain");
    expect(payload.goal_weight_kg).toBe(75);
    expect(payload.goal_weight_kg).toBeGreaterThan(payload.weight_kg);
    expect(screen.queryByText(/goal weight is below your current weight/)).toBeNull();
  });

  // The same incoherence reached from the other direction: stay on Lose weight
  // and drag current weight below the default destination.
  it("re-derives the destination when current weight is dragged past it", async () => {
    await render(<Onboarding />);
    // 70kg -> 60kg. A leading duplicate event is required: jest-utils' state
    // filler only delivers an `onUpdate` from the second event onward.
    await act(() =>
      fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
        { translationX: 90 },
        { translationX: 90 },
      ]),
    );
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("60 kg");
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("55 kg");
    expect(screen.getByTestId("accept-button").props.accessibilityState.disabled).toBe(false);

    await fireEvent.press(screen.getByText("Start with this plan"));
    const payload = mockMutate.mock.calls[0][0];
    expect(payload.weight_kg).toBe(60);
    expect(payload.goal_weight_kg).toBe(55);
    expect(screen.queryByText(/goal weight is above your current weight/)).toBeNull();
  });

  // Deriving stops the moment the user says otherwise. Silently rewriting a
  // destination somebody deliberately dialled in would be a worse bug than the
  // one the derivation fixes.
  it("never overwrites a destination the user set, however the goal or weight then change", async () => {
    await render(<Onboarding />);
    await increment("goal-weight-ruler"); // 65 -> 65.5, explicitly set
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("65.5 kg");

    await act(() =>
      fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
        { translationX: 90 },
        { translationX: 90 },
      ]),
    );
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("60 kg");
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("65.5 kg");

    await increment("goal-ruler"); // -> Maintain (destination hidden)
    await increment("goal-ruler"); // -> Build muscle (destination back)
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("65.5 kg");
    expect(screen.getByTestId("accept-button").props.accessibilityState.disabled).toBe(false);

    await fireEvent.press(screen.getByText("Start with this plan"));
    expect(mockMutate.mock.calls[0][0].goal_weight_kg).toBe(65.5);
  });

  // The derivation is a DEFAULTING mechanism, never a gate: whichever way the
  // goal and weight are driven, the button stays live.
  it("keeps accept enabled across every goal with an untouched destination", async () => {
    await render(<Onboarding />);
    for (let i = 0; i < 3; i++) {
      expect(screen.getByTestId("accept-button").props.accessibilityState.disabled).toBe(false);
      await increment("goal-ruler");
    }
    expect(screen.getByTestId("accept-button").props.accessibilityState.disabled).toBe(false);
  });

  it("enables accept for maintenance without any destination", async () => {
    await render(<Onboarding />);
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

  // The withholding this replaces was the other half of kora#164: the chain
  // and macro trio showed "—" until every ruler had been touched, so the
  // user could not see the plan they were being asked to accept. The
  // defaults are accepted values now, so their derivation is shown — and it
  // must be the derivation of the numbers actually on the rulers.
  it("shows the derivation chain and macro numbers for the defaults on arrival", async () => {
    await render(<Onboarding />);
    for (const row of [0, 1, 2, 3]) {
      expect(
        within(screen.getByTestId(`derivation-chain-row-${row}`)).queryByText("—"),
      ).toBeNull();
    }
    expect(
      within(screen.getByTestId("derivation-chain-row-3")).getByText(/\d+ kcal/),
    ).toBeTruthy();
    expect(screen.getAllByText(/^\d+g$/)).toHaveLength(3);

    const displayed = within(screen.getByTestId("derivation-chain-row-3")).getByText(/\d+ kcal/)
      .props.children;
    const displayedKcal = Number(String(displayed).replace(/[^\d]/g, ""));

    await fireEvent.press(screen.getByText("Start with this plan"));
    const payload = mockMutate.mock.calls[0][0];
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
  it("keeps PlanDelta silent on arrival, then announces the first change the user makes", async () => {
    jest.useFakeTimers();
    try {
      await render(<Onboarding />);
      // kcal is real from the first frame now, but nothing has CHANGED yet —
      // PlanDelta's mount guard must still keep the screen quiet.
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      expect(screen.queryByTestId("plan-delta-text")).toBeNull();

      await increment("weight-ruler");
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      expect(screen.getByTestId("plan-delta-text")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  // The one gate that survives kora#164: a press while the mutation is
  // already in flight would submit twice.
  it("disables the accept button while a submit is in flight", async () => {
    mockIsPending = true;
    await render(<Onboarding />);
    expect(screen.getByTestId("accept-button").props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByText("Saving…"));
    expect(mockMutate).not.toHaveBeenCalled();
  });

  // Same change as the derivation rows, one level up: the "N weeks to goal"
  // caption describes the distance between two visible, accepted numbers, so
  // it says so from arrival rather than showing "—" under a ruler that is
  // plainly displaying 65 kg. The caption IS the Text node (its own children,
  // not a nested one), so assert on `.props.children` rather than an in-scope
  // `within(...).getByText`, which only searches descendants.
  it("states the weeks to goal for the defaults on arrival", async () => {
    await render(<Onboarding />);
    const caption = screen.getByTestId("destination-caption").props.children;
    expect(caption).not.toBe("—");
    expect(String(caption)).toMatch(/weeks to goal|You're already there/);
  });
});

// kora#284. At accessibility-extra-large the scroll region reached only "Age":
// both rulers and the goal selector sat below the fold on first paint, under a
// header whose numeral and captions had doubled. Past 1.3 the header stops
// being pinned and scrolls with them; at or below it, nothing moves — but the
// dial, which since kora#268 grows with Dynamic Type like everything else, gets
// a height ceiling so it does not spend the pinned header's whole budget.
//
// These tests pin the structure and the arithmetic. They do NOT show that the
// rulers are above the fold: jest performs no layout, so not one point of
// height here is measured. kora#257 is the standing warning — a clipped-ruler
// regression shipped past 1,729 green tests. Only a device or a capture can
// answer the question this fix is actually about.
describe("onboarding header at accessibility text sizes (kora#284)", () => {
  const windowSpies: Array<{ mockRestore: () => void }> = [];

  // A 393x852 device (iPhone 16 Pro class), which is the geometry the budget
  // comment does its arithmetic on.
  function withFontScale(fontScale: number, height = 852) {
    // require, not a top-level import: an ESM namespace object is sealed, so
    // jest.spyOn cannot redefine a property on it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require("react-native");
    const spy = jest
      .spyOn(rn, "useWindowDimensions")
      .mockReturnValue({ width: 393, height, scale: 3, fontScale });
    windowSpies.push(spy);
    return spy;
  }

  afterEach(() => {
    windowSpies.splice(0).forEach((spy) => spy.mockRestore());
  });

  // PlanDial hides its SVG from assistive tech, and RNTL excludes hidden
  // elements by default — without this the query returns null unconditionally
  // and the assertions below test nothing.
  const faceOf = () => screen.getByTestId("plan-dial-face", { includeHiddenElements: true }).props;
  const headerIsInsideScroll = () =>
    within(screen.getByTestId("auth-scaffold-scroll")).queryByTestId(
      "auth-scaffold-header-wrapper",
    ) !== null;

  it("keeps the header pinned at the default content size", async () => {
    withFontScale(1);
    await render(<Onboarding />);
    expect(headerIsInsideScroll()).toBe(false);
    // Floored at 1: the design size, unchanged, which is what lets the existing
    // `onboarding` golden at `medium` stand.
    expect(faceOf().height).toBe(178);
  });

  it("keeps the header pinned at the threshold itself and bounds the dial there", async () => {
    // `>`, not `>=`. 1.3 is the last size that behaves as it always has.
    withFontScale(1.3);
    await render(<Onboarding />);
    expect(headerIsInsideScroll()).toBe(false);
    // 852 * 0.23 = 195.96pt, against the 178 * 1.3 = 231.4 an unbounded dial
    // would take — the +53pt on an already-crowded header that the ceiling
    // exists to refuse.
    expect(faceOf().height).toBeCloseTo(195.96, 2);
    expect(faceOf().height).toBeLessThan(178 * 1.3);
  });

  it("moves the header into the scroll view just past the threshold", async () => {
    withFontScale(1.31);
    await render(<Onboarding />);
    expect(headerIsInsideScroll()).toBe(true);
  });

  it("drops the ceiling once the header scrolls, so the dial takes its natural scale", async () => {
    withFontScale(1.31);
    await render(<Onboarding />);
    // No budget at all now: the scale is instrumentScale's, clamped only by the
    // width available to the dial (393 - 24*2 = 345pt), so 178 * 345/264.
    expect(faceOf().height).toBeCloseTo(178 * (345 / 264), 2);
    expect(faceOf().height).toBeGreaterThan(852 * 0.23);
  });

  it("never shrinks the dial below its design height on a short window", async () => {
    // 568 * 0.23 = 130.6pt, well under the 178 the dial is drawn at. A ceiling
    // is a ceiling, not a target: PlanDial floors the result at 1, because
    // below the design size this stops reading as an instrument at all.
    withFontScale(1.3, 568);
    await render(<Onboarding />);
    expect(faceOf().height).toBe(178);
  });

  it("still reaches every ruler at accessibility sizes", async () => {
    // Reachable in the TREE, which is all jest can say. The point of the move
    // is that they are reachable on the SCREEN, and nothing here shows that.
    withFontScale(2.643);
    await render(<Onboarding />);
    const scroll = within(screen.getByTestId("auth-scaffold-scroll"));
    for (const id of ["goal-ruler", "age-ruler", "height-ruler", "weight-ruler"]) {
      expect(scroll.getByTestId(id)).toBeTruthy();
    }
  });
});
