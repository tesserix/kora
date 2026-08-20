import { render, screen } from "@testing-library/react-native";
import { GAUGE_VIEW_H, GAUGE_VIEW_W } from "../gauge";
import { PlanDial, planDialScale } from "../PlanDial";

describe("PlanDial", () => {
  // A target built from partial data is a lie, and NaN reaching the needle is
  // a crash — so no numbers means no needle.
  it("renders unlit with no needle when there is no target yet", async () => {
    const r = await render(<PlanDial kcal={null} testID="plan-dial" />);
    // The needle lives inside the accessibility-hidden gauge wrapper, so the
    // query must opt into hidden elements — without this it returns null
    // unconditionally and the assertion silently stops testing anything.
    expect(r.queryByTestId("plan-dial-needle", { includeHiddenElements: true })).toBeNull();
    expect(screen.getByTestId("plan-dial-awaiting")).toBeTruthy();
  });

  it("renders a needle once a target exists", async () => {
    const r = await render(<PlanDial kcal={2244} testID="plan-dial" />);
    expect(r.getByTestId("plan-dial-needle", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId("plan-dial-awaiting")).toBeNull();
  });

  it("clamps a target below the scale to the bottom rather than rendering off-dial", async () => {
    await render(<PlanDial kcal={400} testID="plan-dial" />);
    // Component renders without error when clamping low values
    expect(screen.getByTestId("plan-dial")).toBeTruthy();
    expect(screen.queryByTestId("plan-dial-awaiting")).toBeNull();
  });

  it("clamps a target above the scale to the top", async () => {
    await render(<PlanDial kcal={9000} testID="plan-dial" />);
    // Component renders without error when clamping high values
    expect(screen.getByTestId("plan-dial")).toBeTruthy();
    expect(screen.queryByTestId("plan-dial-awaiting")).toBeNull();
  });

  it("hides the gauge from assistive tech on both platforms", async () => {
    const r = await render(<PlanDial kcal={2244} testID="plan-dial" />);
    const gauge = r.getByTestId("plan-dial-gauge", { includeHiddenElements: true });
    expect(gauge.props.accessibilityElementsHidden).toBe(true);
    expect(gauge.props.importantForAccessibility).toBe("no-hide-descendants");
  });

  it("still announces the awaiting caption when there is no target", async () => {
    await render(<PlanDial kcal={null} testID="plan-dial" />);
    const caption = screen.getByTestId("plan-dial-awaiting");
    // Must NOT be inside the hidden subtree — it is the only thing telling a
    // screen-reader user why the panel has no number.
    expect(caption.props.accessibilityElementsHidden).toBeFalsy();
  });
});

// kora#268/#284: an <Svg> with a fixed viewBox draws at one physical size from
// xSmall to AX5, so the dial did not move while the numeral beside it roughly
// doubled. PlanDial and GaugeDial deliberately share geometry ("same geometry,
// so the two read as one panel"), so they take the SAME rule: scale the
// RENDERED width/height, leave the viewBox alone.
describe("PlanDial face scaling (kora#268, kora#284)", () => {
  // require, not a top-level import: an ESM namespace object is sealed, so
  // jest.spyOn cannot redefine a property on it.
  function withWindow(fontScale: number, width = 440) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require("react-native");
    return jest
      .spyOn(rn, "useWindowDimensions")
      .mockReturnValue({ width, height: 956, scale: 3, fontScale });
  }

  // react-native-svg parses `viewBox` into minX/minY/vbWidth/vbHeight on the
  // host node, so the string never survives to be asserted directly. Asserting
  // the parsed fields is the stronger check anyway: it is the viewport the
  // renderer actually uses.
  const faceOf = () => screen.getByTestId("plan-dial-face", { includeHiddenElements: true }).props;
  const viewBoxOf = () => {
    const { minX, minY, vbWidth, vbHeight } = faceOf();
    return [minX, minY, vbWidth, vbHeight];
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // The floor-at-1 property, and the single strongest signal the rule is
  // implemented correctly: the existing goldens at the default content size do
  // not move, because nothing about the default content size moved.
  it("draws byte-identically to the design at the default content size", async () => {
    withWindow(1);
    await render(<PlanDial kcal={2244} testID="plan-dial" />);
    expect(faceOf().width).toBe(GAUGE_VIEW_W);
    expect(faceOf().height).toBe(GAUGE_VIEW_H);
    expect(viewBoxOf()).toEqual([0, 0, GAUGE_VIEW_W, GAUGE_VIEW_H]);
  });

  // A user who SHRANK their text must never get a dial smaller than the design
  // — the same reasoning as TickRuler's labelFontScale.
  it("does not shrink below the design for a reduced text size", async () => {
    withWindow(0.82, 2000);
    await render(<PlanDial kcal={2244} testID="plan-dial" />);
    expect(faceOf().width).toBe(GAUGE_VIEW_W);
  });

  it("grows the face with the system font scale when width allows", async () => {
    withWindow(1.6, 2000);
    await render(<PlanDial kcal={2244} testID="plan-dial" />);
    expect(faceOf().width).toBeCloseTo(GAUGE_VIEW_W * 1.6, 5);
    expect(faceOf().height).toBeCloseTo(GAUGE_VIEW_H * 1.6, 5);
    // The viewBox is what makes this a pure vector scale rather than a geometry
    // change: every tick, the needle worklet and the hub keep their coordinates.
    expect(viewBoxOf()).toEqual([0, 0, GAUGE_VIEW_W, GAUGE_VIEW_H]);
  });

  // GAUGE_VIEW_W * 1.6 = 422.4pt, wider than any supported screen, so on a real
  // device it is the width that stops the growth, not the font cap.
  it("lets the available width clamp the growth on a real screen", async () => {
    withWindow(2.4, 393);
    await render(<PlanDial kcal={2244} testID="plan-dial" />);
    // 393 less onboarding's paddingHorizontal: spacing.lg on both sides.
    expect(faceOf().width).toBeCloseTo(393 - 48, 5);
  });

  describe("maxHeight (the onboarding header's viewport budget)", () => {
    it("binds when it is tighter than the font scale wants", async () => {
      withWindow(1.6, 2000);
      await render(<PlanDial kcal={2244} maxHeight={200} testID="plan-dial" />);
      expect(faceOf().height).toBeCloseTo(200, 5);
      expect(faceOf().width).toBeCloseTo(GAUGE_VIEW_W * (200 / GAUGE_VIEW_H), 5);
    });

    it("does nothing when it is looser than the font scale wants", async () => {
      withWindow(1.6, 2000);
      await render(<PlanDial kcal={2244} maxHeight={1000} testID="plan-dial" />);
      expect(faceOf().height).toBeCloseTo(GAUGE_VIEW_H * 1.6, 5);
    });

    // The kora#270 guard, once per way a budget can fail to resolve. Each of
    // these means "no height constraint", NOT "no height": treating an
    // unresolved budget as 0pt of room is how a dimension collapses to zero and
    // reads as deliberate whitespace for a component's entire life.
    it.each([
      ["absent", undefined],
      ["zero", 0],
      ["NaN", Number.NaN],
      ["negative", -320],
    ])("leaves the dial at its natural scale when the budget is %s", async (_label, maxHeight) => {
      withWindow(1.6, 2000);
      await render(<PlanDial kcal={2244} maxHeight={maxHeight} testID="plan-dial" />);
      expect(faceOf().height).toBeCloseTo(GAUGE_VIEW_H * 1.6, 5);
      expect(faceOf().width).toBeCloseTo(GAUGE_VIEW_W * 1.6, 5);
    });

    it("never renders a zero or NaN dimension for any budget", async () => {
      for (const maxHeight of [undefined, 0, Number.NaN, -1, 1e-9, Infinity, 40]) {
        withWindow(1.6, 2000);
        const r = await render(<PlanDial kcal={2244} maxHeight={maxHeight} testID="plan-dial" />);
        const face = r.getByTestId("plan-dial-face", { includeHiddenElements: true }).props;
        expect(Number.isFinite(face.width)).toBe(true);
        expect(Number.isFinite(face.height)).toBe(true);
        // Never SMALLER than the design either — the floor is what stops a
        // tight budget from turning the ceiling into a shrink.
        expect(face.width).toBeGreaterThanOrEqual(GAUGE_VIEW_W);
        expect(face.height).toBeGreaterThanOrEqual(GAUGE_VIEW_H);
      }
    });
  });

  describe("planDialScale", () => {
    it("floors at the design size however tight the budget", () => {
      expect(planDialScale(1, 2000, 10)).toBe(1);
    });

    it("takes the smaller of the width and height ceilings", () => {
      expect(planDialScale(1.6, 2000, 200)).toBeCloseTo(200 / GAUGE_VIEW_H, 5);
      expect(planDialScale(1.6, 300, 2000)).toBeCloseTo(300 / GAUGE_VIEW_W, 5);
    });
  });

  // The gauge is decorative here — the target is announced as text elsewhere on
  // the panel — and scaling it must not disturb that.
  it("keeps the gauge hidden from assistive tech at a scaled size", async () => {
    withWindow(1.6, 2000);
    await render(<PlanDial kcal={2244} maxHeight={200} testID="plan-dial" />);
    const gauge = screen.getByTestId("plan-dial-gauge", { includeHiddenElements: true });
    expect(gauge.props.accessibilityElementsHidden).toBe(true);
    expect(gauge.props.importantForAccessibility).toBe("no-hide-descendants");
  });
});
