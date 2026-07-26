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
