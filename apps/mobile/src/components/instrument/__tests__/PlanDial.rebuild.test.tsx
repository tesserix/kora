import { render } from "@testing-library/react-native";

// kora#238: the claim under test is a JS-side render-count fact — "PlanDial
// rebuilds its whole gauge SVG on every reported ruler change" — so the
// instrument is a spy on the geometry builder, not a screenshot. `buildGaugeTicks`
// is wrapped rather than replaced so the dial still renders real geometry and
// the rest of the suite's visual assertions keep their meaning.
jest.mock("../gauge", () => {
  const actual = jest.requireActual("../gauge");
  return { ...actual, buildGaugeTicks: jest.fn(actual.buildGaugeTicks) };
});

import { buildGaugeTicks } from "../gauge";
import { PlanDial } from "../PlanDial";

const buildSpy = buildGaugeTicks as jest.MockedFunction<typeof buildGaugeTicks>;

beforeEach(() => {
  buildSpy.mockClear();
});

// A drag across the pace/weight rulers reports a new kcal every time it crosses
// a step (PX_PER_UNIT = 9, so ~every 9px). Each report re-renders the plan
// column. The dial's FRACTION changes; its tick GEOMETRY — position, width,
// major, red — is a function of constants only. Rebuilding 41 ticks and
// re-creating 41 <Line> nodes per step is the waste this pins shut.
test("does not rebuild the tick geometry when the target changes", async () => {
  const r = await render(<PlanDial kcal={1800} testID="plan-dial" />);
  const afterFirstPaint = buildSpy.mock.calls.length;
  expect(afterFirstPaint).toBeLessThanOrEqual(1);

  // 20 reported changes, the sort of thing one brisk ruler drag produces.
  for (let i = 1; i <= 20; i++) {
    await r.rerender(<PlanDial kcal={1800 + i * 9} testID="plan-dial" />);
  }

  expect(buildSpy.mock.calls.length).toBe(afterFirstPaint);
});

// The lit/dimmed boundary is the only thing on the arc that fraction moves, and
// it must move on the UI thread (the way #176 put the ruler's own scale there)
// rather than by re-creating the SVG tree. Node identity is the observable
// proof that the tree was not rebuilt.
test("keeps the same tick nodes across a run of target changes", async () => {
  const r = await render(<PlanDial kcal={1800} testID="plan-dial" />);
  const first = r.getByTestId("plan-dial-tick-20", { includeHiddenElements: true });

  for (let i = 1; i <= 20; i++) {
    await r.rerender(<PlanDial kcal={1800 + i * 9} testID="plan-dial" />);
  }

  expect(r.getByTestId("plan-dial-tick-20", { includeHiddenElements: true })).toBe(first);
});

// Guard on the fix itself: the geometry is shared, so nothing may mutate it.
test("the geometry it renders is not fraction-dependent", () => {
  const a = buildSpy.mock.results;
  void a;
  const lowest = jest.requireActual("../gauge").buildGaugeTicks(0);
  const highest = jest.requireActual("../gauge").buildGaugeTicks(1);
  lowest.forEach((t: { x1: number; y1: number; x2: number; y2: number; width: number }, i: number) => {
    const u = highest[i];
    expect([t.x1, t.y1, t.x2, t.y2, t.width]).toEqual([u.x1, u.y1, u.x2, u.y2, u.width]);
  });
});
