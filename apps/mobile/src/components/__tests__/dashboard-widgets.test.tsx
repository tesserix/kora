import { render } from "@testing-library/react-native";
import { ProvenanceChip } from "../ProvenanceChip";
import { UNKNOWN_PROVENANCE } from "@/api/types";

test("ProvenanceChip labels verified vs estimate", async () => {
  const verified = await render(<ProvenanceChip provenance="afcd" />);
  expect(verified.getByText(/verified/i)).toBeTruthy();
  const estimate = await render(<ProvenanceChip provenance="user_estimate" />);
  expect(estimate.getByText(/estimate/i)).toBeTruthy();
});

// An offline-cache-synthesized food (see foodsFromPins/foodsFromSavedMeals in
// src/offline/foodCache.ts) has exact macros reverse-scaled from real
// numbers — it is not a model's guess, so it must not carry the "AI estimate
// ±15%" disclaimer that every OTHER unverified provenance gets.
test("ProvenanceChip renders nothing for an unknown/synthesized provenance", async () => {
  const { queryByText, toJSON } = await render(<ProvenanceChip provenance={UNKNOWN_PROVENANCE} />);
  expect(queryByText(/estimate/i)).toBeNull();
  expect(toJSON()).toBeNull();
});

// A plain empty string is a different claim than the UNKNOWN_PROVENANCE
// sentinel: FoodItem.provenance is an unconstrained server column, so an
// empty value there could just be a data gap, not a deliberate "we don't
// know". Silencing the disclaimer for it would be an accidental loss of a
// warning a nutrition app should err on the side of keeping.
test("ProvenanceChip still shows the estimate disclaimer for a plain empty provenance", async () => {
  const { getByText } = await render(<ProvenanceChip provenance="" />);
  expect(getByText(/estimate/i)).toBeTruthy();
});
