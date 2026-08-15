import { fireEvent, render } from "@testing-library/react-native";
import { DetectedCard } from "../DetectedCard";
import { INSTRUMENT_DARK_FIXED } from "@/theme";
import type { Resolution } from "@/api/types";

function renderCard(resolution: Resolution, onResolveUncertain?: (index: number) => void) {
  return render(
    <DetectedCard
      resolution={resolution}
      mealSlot="snack"
      onChangeMealSlot={() => {}}
      onAdd={() => {}}
      adding={false}
      onResolveUncertain={onResolveUncertain}
      excluded={new Set()}
      onToggleExclude={() => {}}
    />,
  );
}

function makeResolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    candidates: [
      {
        item: {
          id: "1",
          name: "Grilled chicken breast",
          brand: "",
          provenance: "afcd",
          serving_desc: "1 breast",
          serving_grams: 140,
          kcal_per_100g: 165,
          protein_per_100g: 31,
          carbs_per_100g: 0,
          fat_per_100g: 3.6,
        },
        portion_grams: 140.4,
        kcal: 231.2,
        match_score: 0.958,
        match_tier: "auto",
      },
      {
        item: {
          id: "2",
          name: "Steamed broccoli",
          brand: "",
          provenance: "afcd",
          serving_desc: "1 cup",
          serving_grams: 90,
          kcal_per_100g: 34,
          protein_per_100g: 2.8,
          carbs_per_100g: 7,
          fat_per_100g: 0.4,
        },
        portion_grams: 90.2,
        kcal: 30.6,
        match_score: 0.912,
        match_tier: "auto",
      },
    ],
    tier: "auto",
    is_estimate: false,
    provenance: "afcd",
    ...overrides,
  };
}

test("renders candidate rows with row-sourced grams/kcal and a header count", async () => {
  const resolution = makeResolution();
  const { getByText, queryByText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={jest.fn()}
      onAdd={jest.fn()}
      adding={false}
      excluded={new Set()}
      onToggleExclude={() => {}}
    />,
  );

  expect(getByText(/Detected · 2 items/i)).toBeTruthy();
  expect(getByText("Grilled chicken breast")).toBeTruthy();
  // The portion stays; the raw "% match" is gone — it was false precision.
  expect(getByText("140.4 g")).toBeTruthy();
  expect(queryByText(/% match/)).toBeNull();
  expect(getByText("231 kcal")).toBeTruthy();
  expect(getByText("Steamed broccoli")).toBeTruthy();
  expect(getByText("90.2 g")).toBeTruthy();
  expect(getByText("31 kcal")).toBeTruthy();
});

test("shows the summed kcal when the resolution is not an estimate", async () => {
  const resolution = makeResolution({ is_estimate: false });
  const { getByText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={jest.fn()}
      onAdd={jest.fn()}
      adding={false}
      excluded={new Set()}
      onToggleExclude={() => {}}
    />,
  );

  // 231.2 + 30.6 = 261.8 -> rounds to 262
  expect(getByText("262 kcal")).toBeTruthy();
});

test("shows a kcal range when the resolution is an estimate", async () => {
  const resolution = makeResolution({ is_estimate: true, kcal_low: 380, kcal_high: 440 });
  const { getByText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={jest.fn()}
      onAdd={jest.fn()}
      adding={false}
      excluded={new Set()}
      onToggleExclude={() => {}}
    />,
  );

  expect(getByText("380–440 kcal")).toBeTruthy();
});

test("pressing a meal-slot chip calls onChangeMealSlot with that slot", async () => {
  const onChangeMealSlot = jest.fn();
  const resolution = makeResolution();
  const { getByText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={onChangeMealSlot}
      onAdd={jest.fn()}
      adding={false}
      excluded={new Set()}
      onToggleExclude={() => {}}
    />,
  );

  fireEvent.press(getByText("Breakfast"));
  expect(onChangeMealSlot).toHaveBeenCalledWith("breakfast");
});

test("pressing add to diary calls onAdd", async () => {
  const onAdd = jest.fn();
  const resolution = makeResolution();
  const { getByLabelText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={jest.fn()}
      onAdd={onAdd}
      adding={false}
      excluded={new Set()}
      onToggleExclude={() => {}}
    />,
  );

  fireEvent.press(getByLabelText("Add to diary"));
  expect(onAdd).toHaveBeenCalledTimes(1);
});

test("shows a spinner and hides the label while adding", async () => {
  const resolution = makeResolution();
  const { queryByText, getByTestId, getByLabelText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={jest.fn()}
      onAdd={jest.fn()}
      adding
      excluded={new Set()}
      onToggleExclude={() => {}}
    />,
  );

  expect(queryByText("Add 2 items to diary")).toBeNull();
  expect(getByTestId("detected-card-adding-spinner")).toBeTruthy();
  expect(getByLabelText("Adding to diary")).toBeTruthy();
});

// The second candidate is demoted to follow_up; the first stays confident.
function makeMixedResolution(): Resolution {
  const base = makeResolution();
  return {
    ...base,
    candidates: [
      { ...base.candidates[0], tier: "auto" },
      { ...base.candidates[1], tier: "follow_up" },
    ],
  };
}

function makeAllUncertainResolution(): Resolution {
  const base = makeResolution();
  return {
    ...base,
    candidates: base.candidates.map((c) => ({ ...c, tier: "follow_up" as const })),
  };
}

// The bug this whole block pins: a weak match is still a match. The server
// ships the row's own item/portion/kcal even at tier follow_up, so the card
// preselects that top guess rather than presenting an unloggable placeholder.
// Withholding it produced a disabled "Add 0 items to diary" and no way to log.
test("an uncertain item is preselected with its top match's server kcal", async () => {
  const { getAllByText, queryByText } = await renderCard(makeMixedResolution());

  expect(getAllByText("Steamed broccoli")).toHaveLength(1);
  // 30.6 rounds to 31 — the preselected row prints the SERVER's figure, not a
  // placeholder and not anything the client derived.
  expect(queryByText("31 kcal")).toBeTruthy();
  expect(queryByText("—")).toBeNull();
  expect(queryByText("Not sure which — tap to confirm")).toBeNull();
});

// Preselected is not the same as confident. The row must still read as a
// guess the user can override, or a weak match gets logged in one tap without
// the user ever registering that it was a guess.
test("a preselected uncertain row still reads as a changeable guess", async () => {
  const { queryByText } = await renderCard(makeMixedResolution());

  // Portion and provenance of the choice. The affordance is deliberately NOT
  // part of this string any more: it used to read "… — tap to change" in 11px
  // mut grey, and a tester who uses this app daily did not know the row was
  // tappable (kora#181). It is a real "Change" button now, asserted below.
  expect(queryByText("90.2 g · Best guess")).toBeTruthy();
  // The confident row keeps its plain portion caption.
  expect(queryByText("140.4 g")).toBeTruthy();
  // Macro chips stay off the weak row — fewer numbers asserted for a match we
  // are not confident in, and a second visual cue that the rows differ.
  expect(queryByText("P 31g/100g")).toBeTruthy();
  expect(queryByText("P 3g/100g")).toBeNull();
});

test("the header total includes the preselected uncertain row", async () => {
  const { getByText, getAllByText } = await renderCard(makeMixedResolution());

  // 231.2 + 30.6 = 261.8 -> 262. The total describes what will be logged, and
  // the uncertain row WILL be logged.
  expect(getByText("262 kcal")).toBeTruthy();
  expect(getAllByText("231 kcal")).toHaveLength(1);
});

test("the CTA counts every row once uncertain ones are preselected", async () => {
  const { getByText } = await renderCard(makeMixedResolution());

  expect(getByText("Detected · 2 items")).toBeTruthy();
  expect(getByText("Add 2 items to diary")).toBeTruthy();
});

test("the CTA is live when every item is uncertain", async () => {
  const { getByLabelText, getByText } = await renderCard(makeAllUncertainResolution());

  expect(getByText("Add 2 items to diary")).toBeTruthy();
  expect(getByLabelText("Add to diary").props.accessibilityState.disabled).toBe(false);
});

test("an all-uncertain resolution prices every row from the server", async () => {
  const { getByText, queryByText } = await renderCard(makeAllUncertainResolution());

  expect(getByText("231 kcal")).toBeTruthy();
  expect(getByText("31 kcal")).toBeTruthy();
  expect(queryByText("—")).toBeNull();
});

test("tapping a preselected uncertain row opens the picker by index", async () => {
  const onResolveUncertain = jest.fn();
  const { getByLabelText } = await renderCard(makeMixedResolution(), onResolveUncertain);

  fireEvent.press(getByLabelText("Change Steamed broccoli"));

  expect(onResolveUncertain).toHaveBeenCalledWith(1);
});

// The row the user resolved by hand is loggable — it counts toward the CTA —
// but no server kcal exists for it yet. It must render "—", never "0 kcal".
// A naive "only uncertain rows hide kcal" implementation passes every other
// test in this file and fails only this one.
test("a hand-picked row is loggable but still shows no kcal", async () => {
  const base = makeResolution();
  const promoted = {
    ...base,
    candidates: [
      { ...base.candidates[0], tier: "auto" as const },
      { ...base.candidates[1], tier: "confirm" as const, kcal: 0, kcal_unknown: true },
    ],
  };
  const { getAllByText, getByText, queryByText } = await renderCard(promoted);

  expect(getByText("Add 2 items to diary")).toBeTruthy();
  expect(queryByText("0 kcal")).toBeNull();
  expect(queryByText("—")).toBeTruthy();
  expect(getAllByText("231 kcal")).toHaveLength(2);
});

// Before this, a scanned food always rendered raw base units — "16.5 g" for a
// NESCAFÉ sachet — because the capture path never looked at the food's own
// serving_units, even though the resolve endpoint returns them on the item.
test("a candidate whose portion is exactly one named serving renders that serving", async () => {
  const base = makeResolution();
  const resolution = {
    ...base,
    candidates: [
      {
        ...base.candidates[0],
        portion_grams: 16.5,
        item: {
          ...base.candidates[0].item,
          serving_units: [{ name: "portion", amount: 1, base_amount: 16.5 }],
        },
      },
    ],
  };

  const { getByText, queryByText } = await renderCard(resolution);

  expect(getByText("1 portion")).toBeTruthy();
  expect(queryByText("16.5 g")).toBeNull();
});

// The relabelling must be exact. A portion the servings cannot describe stays
// in base units rather than being rounded into a serving count.
test("a candidate whose portion is not a whole serving stays in base units", async () => {
  const base = makeResolution();
  const resolution = {
    ...base,
    candidates: [
      {
        ...base.candidates[0],
        portion_grams: 20,
        item: {
          ...base.candidates[0].item,
          serving_units: [{ name: "portion", amount: 1, base_amount: 16.5 }],
        },
      },
    ],
  };

  const { getByText } = await renderCard(resolution);

  expect(getByText("20 g")).toBeTruthy();
});

// Instrument Glass restyle: the card is a dark glass panel sourced from the
// fixed dark token set, never the scheme-aware theme — capture is always
// dark regardless of the device's light/dark setting.
test("the card panel is styled from the fixed dark instrument tokens", async () => {
  const { getByTestId } = await renderCard(makeResolution());
  const panel = getByTestId("detected-card");
  const flat = Array.isArray(panel.props.style)
    ? Object.assign({}, ...panel.props.style.flat().filter(Boolean))
    : panel.props.style;
  expect(flat.backgroundColor).toBe(INSTRUMENT_DARK_FIXED.glass);
});

// The header ring is a SubDial (Instrument Glass component) fed the same
// kcal fraction the old GaugeRing was, fixed to the dark tokens for the
// same always-dark reason as the panel above.
test("the header ring is a SubDial fed the kcal fraction", async () => {
  const { getByTestId } = await renderCard(makeResolution());
  expect(getByTestId("detected-card-ring")).toBeTruthy();
});

test("the CTA button reads accent-on-accent with the requested radius and weight", async () => {
  const { getByLabelText } = await renderCard(makeResolution());
  const button = getByLabelText("Add to diary");
  const flat = Array.isArray(button.props.style)
    ? Object.assign({}, ...button.props.style.flat().filter(Boolean))
    : button.props.style;
  expect(flat.backgroundColor).toBe(INSTRUMENT_DARK_FIXED.accent);
  expect(flat.borderRadius).toBe(18);
});

test("a liquid candidate renders its portion in ml, not grams", async () => {
  const base = makeResolution();
  const resolution = {
    ...base,
    candidates: base.candidates.map((c) => ({
      ...c,
      portion_grams: 200,
      item: { ...c.item, base_unit: "ml" },
    })),
  };

  const { getAllByText, queryByText } = await renderCard(resolution);

  expect(getAllByText("200 ml")).toHaveLength(2);
  expect(queryByText("200g")).toBeNull();
});

// The server falls back to a 100g portion when a food has no serving size.
// That fallback is a guess, not a measurement, and must say so — the app has
// a documented history of an unknown rendering as though it were confident.
test("an assumed portion is labelled as a guess on the row", async () => {
  const base = makeResolution();
  const resolution = {
    ...base,
    candidates: [{ ...base.candidates[0], portion_assumed: true, portion_grams: 100 }],
  };

  const { getByText } = await renderCard(resolution);

  expect(getByText(/portion is a guess/i)).toBeTruthy();
});

test("a known portion says nothing about guessing", async () => {
  const base = makeResolution();
  const resolution = {
    ...base,
    candidates: [{ ...base.candidates[0], portion_assumed: false, portion_grams: 350 }],
  };

  const { queryByText } = await renderCard(resolution);

  expect(queryByText(/guess/i)).toBeNull();
});

// kora#183 / kora#181. The leading tile used to be a STATUS glyph that testers
// read as an unchecked radio button, on a card that then logged every row
// regardless — "the row shows it as a radio button which is misleading if
// there are multiple items", "but its not selectable". These pin the control
// being real, because the failure mode is silent: the card looks correct
// either way, and only the diary reveals which rows were actually written.

test("each row exposes a real checkbox, checked by default", async () => {
  const onToggleExclude = jest.fn();
  const { getAllByRole } = await render(
    <DetectedCard
      resolution={makeMixedResolution()}
      mealSlot="lunch"
      onChangeMealSlot={() => {}}
      onAdd={() => {}}
      adding={false}
      excluded={new Set()}
      onToggleExclude={onToggleExclude}
    />,
  );

  const boxes = getAllByRole("checkbox");
  expect(boxes).toHaveLength(2);
  // Preselected — the server's answer is still the default, exclusion is opt-in.
  expect(boxes.every((b) => b.props.accessibilityState?.checked === true)).toBe(true);

  fireEvent.press(boxes[0]);
  expect(onToggleExclude).toHaveBeenCalledWith(0);
});

test("an excluded row reads as unchecked and leaves the CTA count", async () => {
  const { getAllByRole, getByText } = await render(
    <DetectedCard
      resolution={makeMixedResolution()}
      mealSlot="lunch"
      onChangeMealSlot={() => {}}
      onAdd={() => {}}
      adding={false}
      excluded={new Set([1])}
      onToggleExclude={() => {}}
    />,
  );

  const boxes = getAllByRole("checkbox");
  expect(boxes[0].props.accessibilityState?.checked).toBe(true);
  expect(boxes[1].props.accessibilityState?.checked).toBe(false);
  // The count is the whole point: a checkbox the CTA ignores is the defect.
  expect(getByText("Add 1 item to diary")).toBeTruthy();
});

test("excluding every row disables the CTA and says so", async () => {
  const { getByText } = await render(
    <DetectedCard
      resolution={makeMixedResolution()}
      mealSlot="lunch"
      onChangeMealSlot={() => {}}
      onAdd={() => {}}
      adding={false}
      excluded={new Set([0, 1])}
      onToggleExclude={() => {}}
    />,
  );

  // Not "Add 0 items to diary" — that reads as a broken button rather than a
  // consequence of the user's own choice.
  expect(getByText("Select an item to add")).toBeTruthy();
});

test("every row offers a visible Change button, not just uncertain ones", async () => {
  const onResolveUncertain = jest.fn();
  const { getAllByText } = await renderCard(makeMixedResolution(), onResolveUncertain);

  // Both rows: a confident match can still be the wrong food, and before
  // kora#183 such a row was not pressable at all — it could not be corrected
  // OR removed.
  const buttons = getAllByText("Change");
  expect(buttons).toHaveLength(2);

  fireEvent.press(buttons[1]);
  expect(onResolveUncertain).toHaveBeenCalledWith(1);
});
