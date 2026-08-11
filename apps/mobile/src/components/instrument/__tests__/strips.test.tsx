import { render } from "@testing-library/react-native";
import { Text } from "react-native";
import { TeleStrip } from "../TeleStrip";
import { MacroWide } from "../MacroWide";
import { StreakCells } from "../StreakCells";
import { EnergyBars } from "../EnergyBars";

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
