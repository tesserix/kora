import { render } from "@testing-library/react-native";
import { StyleSheet, Text } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { TeleStrip } from "../TeleStrip";
import { MacroWide } from "../MacroWide";
import { StreakCells } from "../StreakCells";
import { EnergyBars } from "../EnergyBars";
import { instrumentLight } from "@/theme/palette";

afterEach(() => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(false);
});

// Light scheme is the test environment's default (no useColorScheme mock) —
// same convention as BezelCluster.test.tsx.

test("TeleStrip renders every cell's value and label", async () => {
  const { getByText } = await render(
    <TeleStrip cells={[
      { icon: <Text>i</Text>, value: "8,432", label: "Steps" },
      { icon: <Text>i</Text>, value: "7:12", label: "Sleep" },
    ]} />,
  );
  expect(getByText("8,432")).toBeTruthy();
  expect(getByText("Sleep")).toBeTruthy();
});

test("MacroWide shows the shortfall, never a negative", async () => {
  const over = await render(<MacroWide label="Protein" value={150} goal={140} />);
  expect(over.getByText("0g to go")).toBeTruthy();
  const under = await render(<MacroWide label="Protein" value={96} goal={140} />);
  expect(under.getByText("44g to go")).toBeTruthy();
});

test("StreakCells marks hits distinctly from misses", async () => {
  const { getByTestId } = await render(<StreakCells hits={[true, false, true, true, false, true, true]} />);
  const hit = getByTestId("streak-0").props.style;
  const miss = getByTestId("streak-1").props.style;
  expect(JSON.stringify(hit)).not.toEqual(JSON.stringify(miss));
});

test("EnergyBars renders one bar per day plus the target line", async () => {
  const days = ["Tu", "We", "Th"].map((label, i) => ({ label, fraction: 0.6 + i * 0.2, over: i === 2 }));
  const { getByTestId } = await render(<EnergyBars days={days} />);
  for (let i = 0; i < 3; i++) expect(getByTestId(`ebar-${i}`)).toBeTruthy();
  expect(getByTestId("ebar-target")).toBeTruthy();
});

// Accent-budget demotion (kora ignition Task 8): a streak "hit" is a
// day-level accomplishment, not the screen's one accent — it reads as the
// lit tick color, same as a gauge's lit ticks.
test("StreakCells hit cells render the demoted tickLit color, not the accent", async () => {
  const { getByTestId } = await render(<StreakCells hits={[true, false]} />);
  const hit = StyleSheet.flatten(getByTestId("streak-0").props.style);
  const miss = StyleSheet.flatten(getByTestId("streak-1").props.style);
  expect(hit.backgroundColor).toBe(instrumentLight.tickLit);
  expect(miss.backgroundColor).toBe(instrumentLight.tick);
});

// Accent-budget demotion (kora ignition Task 8): only an over-budget day is
// allowed to carry the screen's accent (it's semantic warning, not
// decoration) — in-budget bars demote to the plain tick color.
test("EnergyBars only colors over-budget bars with accent; in-budget bars use tick", async () => {
  const days = [
    { label: "Mo", fraction: 0.5, over: false },
    { label: "Tu", fraction: 0.9, over: true },
  ];
  const { getByTestId } = await render(<EnergyBars days={days} />);
  const inBudget = StyleSheet.flatten(getByTestId("ebar-0").props.style);
  const overBudget = StyleSheet.flatten(getByTestId("ebar-1").props.style);
  expect(inBudget.backgroundColor).toBe(instrumentLight.tick);
  expect(overBudget.backgroundColor).toBe(instrumentLight.accent);
});

// Grow-in motion (kora ignition Task 8): bars grow from the baseline on
// mount, so without reduced motion they render collapsed (scaleY 0) at
// first paint.
test("EnergyBars bars start collapsed (about to grow in) without reduced motion", async () => {
  const days = [{ label: "Mo", fraction: 0.6, over: false }];
  const { getByTestId } = await render(<EnergyBars days={days} />);
  const bar = StyleSheet.flatten(getByTestId("ebar-0").props.style);
  expect(bar.transform).toEqual([{ scaleY: 0 }]);
});

test("EnergyBars bars render fully grown immediately under Reduce Motion", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const days = [{ label: "Mo", fraction: 0.6, over: false }];
  const { getByTestId } = await render(<EnergyBars days={days} />);
  const bar = StyleSheet.flatten(getByTestId("ebar-0").props.style);
  expect(bar.transform).toEqual([{ scaleY: 1 }]);
});
