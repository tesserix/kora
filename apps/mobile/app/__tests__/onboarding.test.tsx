import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { router } from "expo-router";

import Onboarding from "../onboarding";
import { computePlan } from "@/lib/plan";
import { draftFromParams, draftToParams, type PlanDraft } from "@/lib/planDraft";
import { CM_PER_IN, kgFromLb } from "@/units";

const mockMutate = jest.fn();
let mockParams: Record<string, string> = {};

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn(), navigate: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: () => mockParams,
}));
// Mocked so a test can prove this screen never submits: it hands the draft
// to /plan, which owns the API call now.
jest.mock("@/api/hooks", () => ({
  useSubmitOnboarding: () => ({ mutate: mockMutate, isPending: false }),
}));

const mockUseUnits = jest.fn();
jest.mock("@/units", () => ({
  ...jest.requireActual("@/units"),
  useUnits: () => mockUseUnits(),
}));

beforeEach(() => {
  mockMutate.mockClear();
  mockParams = {};
  (router.replace as jest.Mock).mockClear();
  (router.push as jest.Mock).mockClear();
  (router.navigate as jest.Mock).mockClear();
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

// A single tap on an unset ruler commits its rest value (TickRuler's
// `${testID}-tap` gesture); a pan never activates on a tap.
async function tap(testID: string) {
  await act(() => fireGestureHandler(getByGestureTestId(`${testID}-tap`)));
}

// A leading duplicate event is required: jest-utils' state filler only
// delivers an `onUpdate` from the second event onward.
async function drag(testID: string, translationX: number) {
  await act(() =>
    fireGestureHandler(getByGestureTestId(`${testID}-pan`), [{ translationX }, { translationX }]),
  );
}

// Sets every field by tapping once, so each lands on its rest value.
async function completeByTapping() {
  await tap("goal-ruler");
  await fireEvent.press(screen.getByTestId("segmented-glass-segment-male"));
  await tap("age-ruler");
  await tap("height-ruler");
  await tap("weight-ruler");
  await tap("activity-ruler");
  await tap("goal-weight-ruler");
  await tap("pace-ruler");
}

const seeButton = () => screen.getByTestId("see-plan-button");
const pushedDraft = (): PlanDraft | null =>
  draftFromParams((router.push as jest.Mock).mock.calls[0][0].params);

describe("onboarding", () => {
  // The screen holds no defaults: a number on a ruler before the user has
  // set it would be kora#164's displayed-but-unaccepted trap.
  it("nothing is selected on first render and See my plan is disabled", async () => {
    await render(<Onboarding />);
    for (const id of [
      "goal-ruler",
      "age-ruler",
      "height-ruler",
      "weight-ruler",
      "activity-ruler",
    ]) {
      expect(screen.getByTestId(id).props.accessibilityValue).toEqual({ text: "Not set" });
    }
    for (const key of ["male", "female"]) {
      expect(
        screen.getByTestId(`segmented-glass-segment-${key}`).props.accessibilityState.selected,
      ).toBe(false);
    }
    // No destination until goal and weight exist to derive its rest from.
    expect(screen.queryByTestId("goal-weight-ruler")).toBeNull();
    expect(screen.queryByTestId("pace-ruler")).toBeNull();
    expect(seeButton().props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByText("See my plan"));
    expect(router.push).not.toHaveBeenCalled();
  });

  it("the header names what is missing", async () => {
    await render(<Onboarding />);
    const missing = () => screen.getByTestId("plan-missing").props.children;
    expect(missing()).toBe("Set your goal, sex, age, height, weight and activity");
    expect(screen.queryByTestId("plan-dial-needle", { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId("derivation-chain-row-3")).toBeNull();

    await tap("goal-ruler"); // Lose weight: a destination is now required
    // ...but its rulers only appear once weight is set, so they aren't named yet.
    expect(missing()).toBe("Set your sex, age, height, weight and activity");
    await tap("height-ruler");
    await tap("weight-ruler");
    expect(missing()).toBe("Set your sex, age, activity, goal weight and pace");

    await fireEvent.press(screen.getByTestId("segmented-glass-segment-female"));
    await tap("age-ruler");
    await tap("goal-weight-ruler");
    await tap("pace-ruler");
    expect(missing()).toBe("Set your activity");
    expect(
      screen.getByText("Pick one: this changes your calories by up to ~500 kcal"),
    ).toBeTruthy();

    await tap("activity-ruler");
    expect(screen.queryByTestId("plan-missing")).toBeNull();
    expect(screen.getByTestId("plan-dial-needle", { includeHiddenElements: true })).toBeTruthy();
  });

  it("a user can complete onboarding without dragging any ruler", async () => {
    await render(<Onboarding />);
    await completeByTapping();
    expect(seeButton().props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(screen.getByText("See my plan"));
    expect(pushedDraft()).toEqual({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sex: "male",
      goal: "fat_loss",
      activity_level: "moderate",
      birth_year: new Date().getFullYear() - 30,
      height_cm: 170,
      weight_kg: 70,
      goal_weight_kg: 65,
      pace_kg_per_week: 0.5,
    });
  });

  it("imperial tap-to-set sends kilograms", async () => {
    mockUseUnits.mockReturnValue({ system: "imperial", setSystem: jest.fn() });
    await render(<Onboarding />);
    await completeByTapping();
    // The rests are the lb/in equivalents of 70 kg / 170 cm.
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("154 lb");
    expect(screen.getByTestId("height-ruler-readout").props.children).toBe("5'7\"");
    await fireEvent.press(screen.getByText("See my plan"));
    const draft = pushedDraft();
    expect(draft?.weight_kg).toBeCloseTo(kgFromLb(154), 6);
    expect(draft?.height_cm).toBeCloseTo(67 * CM_PER_IN, 6);
    expect(draft?.goal_weight_kg).toBeCloseTo(kgFromLb(143), 6);
  });

  it("See my plan pushes /plan with the draft and does not call the onboarding API", async () => {
    await render(<Onboarding />);
    await completeByTapping();
    await fireEvent.press(screen.getByText("See my plan"));
    expect(router.push).toHaveBeenCalledTimes(1);
    const arg = (router.push as jest.Mock).mock.calls[0][0];
    expect(arg.pathname).toBe("/plan");
    expect(arg.params.mode).toBe("onboarding");
    for (const v of Object.values(arg.params)) expect(typeof v).toBe("string");
    expect(mockMutate).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("edit mode pre-fills from params and navigates back to /plan", async () => {
    const draft: PlanDraft = {
      sex: "female",
      birth_year: new Date().getFullYear() - 41,
      height_cm: 162,
      weight_kg: 80,
      activity_level: "light",
      goal: "fat_loss",
      goal_weight_kg: 72,
      pace_kg_per_week: 0.75,
      target_kcal_override: 1600,
    };
    mockParams = { ...draftToParams(draft), mode: "edit" };
    await render(<Onboarding />);
    expect(screen.getByTestId("age-ruler-readout").props.children).toBe("41 years");
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("80 kg");
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("72 kg");
    expect(screen.getByTestId("pace-ruler").props.accessibilityValue).toEqual({
      text: "0.75 kg/wk",
    });
    expect(screen.queryByTestId("plan-missing")).toBeNull();

    await increment("weight-ruler");
    await fireEvent.press(screen.getByText("Update plan"));
    expect(router.push).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledTimes(1);
    const arg = (router.navigate as jest.Mock).mock.calls[0][0];
    expect(arg.pathname).toBe("/plan");
    expect(arg.params.mode).toBe("edit");
    // The override rides along: editing the inputs must not silently drop it.
    expect(draftFromParams(arg.params)).toEqual({
      ...draft,
      weight_kg: 80.5,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it("edit mode has a back control that returns to /plan", async () => {
    mockParams = { mode: "edit", sex: "female", birth_year: String(new Date().getFullYear() - 41), height_cm: "162",
      weight_kg: "80", activity_level: "light", goal: "maintenance" };
    await render(<Onboarding />);
    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(router.back).toHaveBeenCalled();
  });

  it("onboarding mode has no back control", async () => {
    await render(<Onboarding />);
    expect(screen.queryByLabelText("Go back")).toBeNull();
  });

  it("ignores a draft that fails validation and starts unset", async () => {
    mockParams = { mode: "edit", sex: "female", weight_kg: "NaN" };
    await render(<Onboarding />);
    expect(screen.getByTestId("weight-ruler").props.accessibilityValue).toEqual({
      text: "Not set",
    });
    expect(screen.getByText("See my plan")).toBeTruthy();
  });

  // The destination has no meaning when maintaining — it disappears rather
  // than greying out, and the draft omits it.
  it("hides the destination when the goal is Maintain and omits it from the draft", async () => {
    await render(<Onboarding />);
    await completeByTapping();
    await increment("goal-ruler");
    expect(screen.queryByTestId("goal-weight-ruler")).toBeNull();
    expect(screen.queryByTestId("pace-ruler")).toBeNull();
    await fireEvent.press(screen.getByText("See my plan"));
    const draft = pushedDraft();
    expect(draft?.goal).toBe("maintenance");
    expect(draft?.goal_weight_kg).toBeUndefined();
    expect(draft?.pace_kg_per_week).toBeUndefined();
  });

  // The destination's rest tracks goal and current weight, so a single tap
  // can never commit a destination validateGoalWeight would refuse.
  it("rests the destination above current weight for Build muscle", async () => {
    await render(<Onboarding />);
    await increment("goal-ruler"); // unset -> Maintain (rest 0 + 1)
    await increment("goal-ruler"); // -> Build muscle
    await tap("weight-ruler");
    await tap("goal-weight-ruler");
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("75 kg");
  });

  it("follows a changed weight with the destination's rest while it is unset", async () => {
    await render(<Onboarding />);
    await tap("goal-ruler");
    await tap("weight-ruler");
    await drag("weight-ruler", 90); // 70kg -> 60kg
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("60 kg");
    await tap("goal-weight-ruler");
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("55 kg");
  });

  // A destination the user set stands, whatever the goal or weight then do.
  it("never overwrites a destination the user set", async () => {
    await render(<Onboarding />);
    await completeByTapping();
    await increment("goal-weight-ruler"); // 65 -> 65.5
    await drag("weight-ruler", 90);
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("65.5 kg");
    await increment("goal-ruler"); // -> Maintain (destination hidden)
    await increment("goal-ruler"); // -> Build muscle (destination back)
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("65.5 kg");
  });

  it("blocks a goal weight that contradicts the goal", async () => {
    await render(<Onboarding />);
    await completeByTapping();
    await drag("goal-weight-ruler", -90); // 65 -> 75kg, above the current 70kg
    expect(screen.getByTestId("goal-weight-ruler-readout").props.children).toBe("75 kg");
    await fireEvent.press(screen.getByText("See my plan"));
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByText(/goal weight is above your current weight/)).toBeTruthy();
  });

  // The pinned agreement: the target in the derivation chain is the one the
  // pushed draft computes to, so /plan opens on the number shown here.
  it("shows the derivation of exactly the draft it hands over", async () => {
    await render(<Onboarding />);
    await completeByTapping();
    for (const row of [0, 1, 2, 3]) {
      expect(within(screen.getByTestId(`derivation-chain-row-${row}`)).queryByText("—")).toBeNull();
    }
    expect(screen.getAllByText(/^\d+g$/)).toHaveLength(3);
    const displayed = within(screen.getByTestId("derivation-chain-row-3")).getByText(/\d+ kcal/)
      .props.children;

    await fireEvent.press(screen.getByText("See my plan"));
    const d = pushedDraft()!;
    const recomputed = computePlan({
      sex: d.sex,
      age: new Date().getFullYear() - d.birth_year,
      heightCm: d.height_cm,
      weightKg: d.weight_kg,
      activityLevel: d.activity_level,
      goal: d.goal,
      paceKgPerWeek: d.pace_kg_per_week ?? 0,
      goalWeightKg: d.goal_weight_kg,
    });
    expect(Number(String(displayed).replace(/[^\d]/g, ""))).toBe(Math.round(recomputed.kcal));
  });

  // Traced case: weight 100kg, pick the 1.0 stop, drag to 60kg. The pace index
  // is clamped at render time, so the shrunk list never reads labels[index]
  // out of range.
  it("keeps the pace ruler's accessibility value defined when a weight drop shrinks the pace stops", async () => {
    await render(<Onboarding />);
    await tap("goal-ruler");
    await tap("weight-ruler");
    await drag("weight-ruler", -270); // 70 -> 100kg: all four stops
    await tap("pace-ruler");
    await increment("pace-ruler");
    await increment("pace-ruler");
    expect(screen.getByTestId("pace-ruler").props.accessibilityValue).toEqual({ text: "1 kg/wk" });

    await drag("weight-ruler", 360); // 100 -> 60kg: [0.25, 0.5]
    expect(screen.getByTestId("pace-ruler").props.accessibilityValue).toEqual({
      text: "0.5 kg/wk",
    });
  });

  it("keeps PlanDelta silent when the plan first appears, then announces a change", async () => {
    jest.useFakeTimers();
    try {
      await render(<Onboarding />);
      await completeByTapping();
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

  it("states the weeks to goal once the destination is set", async () => {
    await render(<Onboarding />);
    await completeByTapping();
    expect(screen.getByTestId("destination-caption").props.children).toBe("10 weeks to goal");
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

  // The dial only exists once every field is set, so these open on a
  // complete draft (edit mode) rather than an empty screen.
  beforeEach(() => {
    mockParams = {
      ...draftToParams({
        sex: "male",
        birth_year: new Date().getFullYear() - 30,
        height_cm: 170,
        weight_kg: 70,
        activity_level: "moderate",
        goal: "maintenance",
      }),
      mode: "edit",
    };
  });

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
