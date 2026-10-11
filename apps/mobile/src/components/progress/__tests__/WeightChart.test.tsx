import { render } from "@testing-library/react-native";
import * as Reanimated from "react-native-reanimated";
import { WeightChart } from "../WeightChart";

afterEach(() => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(false);
});

// react-native-svg flattens Polyline/Polygon `points` into a single `d` path
// string on the underlying host node (there's no raw `points` prop to read),
// so geometry assertions parse `d` instead — the coordinate math it encodes
// (x/y/min/max) is otherwise unchanged from before this task.
function coordsFromPath(d: string): number[][] {
  const nums = d.replace(/^M/, "").replace(/z$/, "").trim().split(/\s+/).map(Number);
  const coords: number[][] = [];
  for (let i = 0; i < nums.length; i += 2) coords.push([nums[i], nums[i + 1]]);
  return coords;
}

test("keeps the existing >=2 point coordinate math (first/last x, y bounds)", async () => {
  const { getByTestId } = await render(<WeightChart points={[70, 72.4, 71.1, 69.8]} />);
  const line = getByTestId("weight-chart-line");
  const coords = coordsFromPath(line.props.d as string);
  expect(coords).toHaveLength(4);
  expect(coords[0][0]).toBe(10); // x(0) = pad
  expect(coords[3][0]).toBe(290); // x(last) = w - pad
  for (const [, y] of coords) {
    expect(y).toBeGreaterThanOrEqual(10);
    expect(y).toBeLessThanOrEqual(120);
  }
});

test("area polygon closes the fill at the chart baseline", async () => {
  const { getByTestId } = await render(<WeightChart points={[70, 71]} />);
  const area = getByTestId("weight-chart-area");
  const coords = coordsFromPath(area.props.d as string);
  expect(coords[0]).toEqual([10, 120]); // baseline start
  expect(coords[coords.length - 1]).toEqual([290, 120]); // baseline end
});

test("without reduced motion, the line and area start hidden (about to draw in)", async () => {
  const { getByTestId } = await render(<WeightChart points={[70, 72, 71]} />);
  const line = getByTestId("weight-chart-line");
  const area = getByTestId("weight-chart-area");
  const dashLength = (line.props.strokeDasharray as number[])[0];
  expect(dashLength).toBeGreaterThan(0);
  expect(line.props.strokeDashoffset).toBe(dashLength); // fully retracted
  expect(area.props.opacity).toBe(0);
});

// Kora ignition Task 8: the endpoint dot demotes to r 3.5 (was 4.5) and
// gains a soft halo behind it (r 8, opacity 0.22) — the chart's accent
// budget item.
test("the endpoint carries a soft accent halo behind its dot", async () => {
  const { getByTestId } = await render(<WeightChart points={[70, 72, 71]} />);
  const halo = getByTestId("weight-chart-endpoint-halo");
  const dot = getByTestId("weight-chart-endpoint");
  expect(halo.props.r).toBe(8);
  expect(halo.props.opacity).toBe(0.22);
  expect(dot.props.r).toBe(3.5);
});

test("reduced motion renders fully drawn immediately, no retracted state", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const { getByTestId } = await render(<WeightChart points={[70, 72, 71]} />);
  const line = getByTestId("weight-chart-line");
  const area = getByTestId("weight-chart-area");
  // react-native-svg's length-prop extraction resolves an explicit 0 offset
  // to `null` (rather than the number 0) — both mean "no offset applied",
  // i.e. the line renders fully drawn.
  expect(line.props.strokeDashoffset === 0 || line.props.strokeDashoffset === null).toBe(true);
  expect(area.props.opacity).toBe(1);
});

// kora#45: a metric measured by two different instruments must not be drawn as
// one line. These assert the SVG the chart emits, which is all jest can see —
// it performs no layout (see the reanimated mock note in jest.setup.js, #257),
// so they prove the geometry and not what a person would perceive on a device.
test("a single-instrument series is still one line, one area, no break rule", async () => {
  const { getByTestId, queryByTestId } = await render(<WeightChart points={[70, 71, 72]} breaksAfter={[]} />);
  expect(getByTestId("weight-chart-line")).toBeTruthy();
  expect(queryByTestId("weight-chart-line-1")).toBeNull();
  expect(queryByTestId("weight-chart-break-after-1")).toBeNull();
});

test("a break splits the polyline in two rather than joining across instruments", async () => {
  const { getByTestId } = await render(
    // The Renpho-to-Omron cliff: 48.9 -> 25.7 is a definition change.
    <WeightChart points={[48.9, 49.1, 25.7, 25.9]} breaksAfter={[1]} />,
  );
  const first = coordsFromPath(getByTestId("weight-chart-line").props.d as string);
  const second = coordsFromPath(getByTestId("weight-chart-line-1").props.d as string);
  expect(first).toHaveLength(2);
  expect(second).toHaveLength(2);
  // No segment spans the seam, and no point is dropped or duplicated at it.
  expect(first.length + second.length).toBe(4);
  expect(first[0][0]).toBe(10);
  expect(second[1][0]).toBe(290);
});

test("the seam carries a visible dashed rule between the two instruments", async () => {
  const { getByTestId } = await render(<WeightChart points={[48.9, 49.1, 25.7, 25.9]} breaksAfter={[1]} />);
  const rule = getByTestId("weight-chart-break-after-1");
  // Midway between x(1)=103.33 and x(2)=196.67.
  expect(Number(rule.props.x1)).toBeCloseTo(150, 1);
  expect(Number(rule.props.x1)).toBe(Number(rule.props.x2));
  expect(rule.props.strokeDasharray).toEqual([3, 3]);
});

test("both segments share one vertical scale, so the step change stays visible", async () => {
  const { getByTestId } = await render(<WeightChart points={[48.9, 49.1, 25.7, 25.9]} breaksAfter={[1]} />);
  const first = coordsFromPath(getByTestId("weight-chart-line").props.d as string);
  const second = coordsFromPath(getByTestId("weight-chart-line-1").props.d as string);
  // A per-segment rescale would have put both runs at similar heights and hidden
  // the very discontinuity the break exists to show.
  expect(second[0][1]).toBeGreaterThan(first[1][1] + 50);
});

test("a lone reading from a new instrument draws its dot but no one-point line", async () => {
  const { getByTestId, queryByTestId } = await render(
    <WeightChart points={[48.9, 49.1, 25.7]} breaksAfter={[1]} />,
  );
  expect(getByTestId("weight-chart-line")).toBeTruthy();
  expect(queryByTestId("weight-chart-line-1")).toBeNull();
  // The endpoint is that lone reading, and it is still drawn.
  expect(getByTestId("weight-chart-endpoint")).toBeTruthy();
});
