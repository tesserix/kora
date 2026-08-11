import { render } from "@testing-library/react-native";
import { buildGaugeTicks, needleFor } from "../gauge";
import { GaugeDial } from "../GaugeDial";

test("builds 41 ticks with the redline in the last tenth", () => {
  const ticks = buildGaugeTicks(0.65);
  expect(ticks).toHaveLength(41);
  expect(ticks.filter((t) => t.red)).toHaveLength(4); // indices 37..40
  expect(ticks[26].lit).toBe(true); // 26/40 = 0.65 — last lit
  expect(ticks[27].lit).toBe(false);
});

test("the needle tracks the fraction monotonically to the right", () => {
  expect(needleFor(0.9).x2).toBeGreaterThan(needleFor(0.2).x2);
});

test("shows the remaining energy as the center numeral", async () => {
  const { getByText } = await render(<GaugeDial value={1430} target={2200} burned={304} />);
  expect(getByText("770")).toBeTruthy();
  expect(getByText("kcal in reserve")).toBeTruthy();
  expect(getByText("1,430")).toBeTruthy(); // eaten, footer
  expect(getByText("2,200")).toBeTruthy(); // budget, footer + scale numeral dedupe is fine
});

test("never renders a negative reserve", async () => {
  const { getByText } = await render(<GaugeDial value={2500} target={2200} />);
  expect(getByText("0")).toBeTruthy();
});

test("rounds raw API floats in the footer instead of showing decimals", async () => {
  const { getByText, queryByText } = await render(
    <GaugeDial value={105.02} target={1794.531} burned={42.9} />,
  );
  expect(getByText("105")).toBeTruthy(); // eaten, footer — rounded, not "105.02"
  expect(getByText("43")).toBeTruthy(); // burned, footer — rounded, not "42.9"
  expect(queryByText("105.02")).toBeNull();
  expect(queryByText("1,794.531")).toBeNull();
});

test("the center reserve numeral carries an explicit lineHeight so it can't clip", async () => {
  const { getByText } = await render(<GaugeDial value={1430} target={2200} burned={304} />);
  const node = getByText("770");
  const style = node.props.style;
  const flat = Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
  expect(flat.lineHeight).toBeGreaterThanOrEqual(flat.fontSize * 1.1);
});
