import { render } from "@testing-library/react-native";
import { DerivationChain } from "../DerivationChain";

const ROWS = [
  { label: "Resting burn", value: "1,803" },
  { label: "Moving ×1.55", value: "2,794" },
  { label: "To lose 0.5 kg/week", value: "−550" },
  { label: "Your daily target", value: "2,244" },
];

describe("DerivationChain", () => {
  it("renders every row's label and value", async () => {
    const r = await render(<DerivationChain rows={ROWS} testID="chain" />);
    ROWS.forEach((row) => {
      expect(r.getByText(row.label)).toBeTruthy();
      expect(r.getByText(row.value)).toBeTruthy();
    });
  });

  it("shows only the current value when nothing is proposed", async () => {
    const r = await render(<DerivationChain rows={ROWS} testID="chain" />);
    expect(r.queryByTestId("chain-row-0-was")).toBeNull();
  });

  // Built now, used in milestone 2: an Otto proposal renders here as a diff
  // rather than silently replacing the numbers.
  it("shows the old value struck through beside the proposed one", async () => {
    const r = await render(
      <DerivationChain rows={[{ label: "Pace", value: "0.5 kg/wk", proposed: "0.25 kg/wk" }]} testID="chain" />,
    );
    expect(r.getByTestId("chain-row-0-was")).toHaveTextContent("0.5 kg/wk");
    expect(r.getByText("0.25 kg/wk")).toBeTruthy();
  });
});
