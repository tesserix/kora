import { render } from "@testing-library/react-native";
import { Ring } from "../Ring";
import { MacroBar } from "../MacroBar";
import { ProvenanceChip } from "../ProvenanceChip";

test("Ring shows remaining and percentage label", async () => {
  const { getByText } = await render(<Ring value={1850} max={2200} label="kcal" />);
  expect(getByText(/1850/)).toBeTruthy();
  expect(getByText(/2200/)).toBeTruthy();
});

test("MacroBar renders label and values", async () => {
  const { getByText } = await render(<MacroBar label="Protein" value={142} target={160} color="#2D4A2B" />);
  expect(getByText("Protein")).toBeTruthy();
  expect(getByText(/142/)).toBeTruthy();
});

test("ProvenanceChip labels verified vs estimate", async () => {
  const verified = await render(<ProvenanceChip provenance="afcd" />);
  expect(verified.getByText(/verified/i)).toBeTruthy();
  const estimate = await render(<ProvenanceChip provenance="user_estimate" />);
  expect(estimate.getByText(/estimate/i)).toBeTruthy();
});
