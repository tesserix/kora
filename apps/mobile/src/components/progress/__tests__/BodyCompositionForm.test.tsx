import { createRef } from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { BodyCompositionForm, type BodyCompositionFormHandle } from "../BodyCompositionForm";

const mockUseUnits = jest.fn();
jest.mock("@/units", () => ({
  ...jest.requireActual("@/units"),
  useUnits: () => mockUseUnits(),
}));

// The date row (kora#314) defaults to "today" via localDateNow() — fixed
// here so these tests don't flip on whatever day they happen to run, and so
// every payload assertion below can state the date literally.
jest.mock("@/lib/localDate", () => ({ localDateNow: () => "2026-08-22" }));
const TODAY = "2026-08-22";
const todayFields = { logged_at: `${TODAY}T12:00:00Z`, local_date: TODAY };

beforeEach(() => {
  mockUseUnits.mockReturnValue({ system: "metric", setSystem: jest.fn() });
});

// jest performs no layout (see the reanimated mock note in jest.setup.js,
// kora#257). These assert the props and the payload — that a field exists, is
// labelled, and that what leaves the form is what was typed. They prove
// NOTHING about whether the form fits on a screen at accessibility sizes; that
// remains a device check.

test("saves only the fields that were filled, omitting the rest entirely", async () => {
  const onSubmit = jest.fn();
  const { getByLabelText, getByText } = await render(<BodyCompositionForm onSubmit={onSubmit} />);

  await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
  await fireEvent.changeText(getByLabelText("Body fat percent"), "24.2");
  await fireEvent.press(getByText("Save"));

  expect(onSubmit).toHaveBeenCalledTimes(1);
  const payload = onSubmit.mock.calls[0][0];
  expect(payload).toEqual({ weight_kg: 70.2, body_fat_pct: 24.2, source: "manual", ...todayFields });
  // The eight untouched metrics are absent, not zero.
  expect("visceral_fat_rating" in payload).toBe(false);
  expect("muscle_mass_kg" in payload).toBe(false);
});

test("a weight-only entry carries the weight and nothing else — not nine zeroes", async () => {
  const onSubmit = jest.fn();
  const { getByLabelText, getByText } = await render(<BodyCompositionForm onSubmit={onSubmit} />);
  await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
  await fireEvent.press(getByText("Save"));
  // Exact equality on purpose: this is the assertion that fails if anything on
  // the path from field to payload ever coalesces an untouched metric to 0.
  expect(onSubmit.mock.calls[0][0]).toEqual({ weight_kg: 70.2, source: "manual", ...todayFields });
});

test("refuses to save without a weight, and says so on the field", async () => {
  const onSubmit = jest.fn();
  const { getByLabelText, getByText, getAllByTestId } = await render(
    <BodyCompositionForm onSubmit={onSubmit} />,
  );
  await fireEvent.changeText(getByLabelText("Body fat percent"), "24.2");
  await fireEvent.press(getByText("Save"));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(getAllByTestId("field-error")[0].props.children).toBe("Enter a weight in kg.");
});

test("a field's error clears as soon as that field is corrected", async () => {
  const onSubmit = jest.fn();
  const { getByLabelText, getByText, queryAllByTestId } = await render(
    <BodyCompositionForm onSubmit={onSubmit} />,
  );
  await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70");
  await fireEvent.changeText(getByLabelText("Body fat percent"), "132");
  await fireEvent.press(getByText("Save"));
  expect(queryAllByTestId("field-error")).toHaveLength(1);
  await fireEvent.changeText(getByLabelText("Body fat percent"), "32");
  expect(queryAllByTestId("field-error")).toHaveLength(0);
});

describe("units and labels", () => {
  test("labels visceral fat as a rating with no unit, in either system", async () => {
    const { getByText, queryByText, getByLabelText } = await render(<BodyCompositionForm onSubmit={jest.fn()} />);
    // No "(%)" and no unit at all in the visible label.
    expect(getByText("Visceral fat")).toBeTruthy();
    expect(queryByText("Visceral fat (%)")).toBeNull();
    expect(getByLabelText("Visceral fat rating")).toBeTruthy();
  });

  test("labels the percentage and mass fields with their units", async () => {
    const { getByText } = await render(<BodyCompositionForm onSubmit={jest.fn()} />);
    expect(getByText("Body fat (%)")).toBeTruthy();
    expect(getByText("Muscle mass (kg)")).toBeTruthy();
    expect(getByText("Scale BMR (kcal)")).toBeTruthy();
  });

  test("imperial shows the kg-backed fields in lb and converts back on save", async () => {
    mockUseUnits.mockReturnValue({ system: "imperial", setSystem: jest.fn() });
    const onSubmit = jest.fn();
    const { getByText, getByLabelText } = await render(<BodyCompositionForm onSubmit={onSubmit} />);
    expect(getByText("Weight (lb)")).toBeTruthy();
    // Still a percentage in Ohio.
    expect(getByText("Body fat (%)")).toBeTruthy();

    await fireEvent.changeText(getByLabelText("Weight in pounds"), "150");
    await fireEvent.press(getByText("Save"));
    expect(onSubmit.mock.calls[0][0].weight_kg).toBeCloseTo(68.0388555, 4);
  });
});

describe("derived values", () => {
  test("has no input for BMI, fat mass or fat-free mass — they cannot be typed", async () => {
    const { getAllByPlaceholderText, getByLabelText, queryByLabelText } = await render(
      <BodyCompositionForm onSubmit={jest.fn()} />,
    );
    // Nine optional inputs — the nine measured metrics beside weight, and
    // nothing else. A derived value with a text input would be exactly the
    // second source of truth these columns were left out to avoid.
    expect(getAllByPlaceholderText("Optional")).toHaveLength(9);
    // The labels they would carry if they were fields, by this form's own
    // naming convention (see metricAccessibilityLabel).
    expect(queryByLabelText("BMI")).toBeNull();
    expect(queryByLabelText("Fat mass in kilograms")).toBeNull();
    expect(queryByLabelText("Fat-free mass in kilograms")).toBeNull();
    // They are read-only readouts instead.
    expect(getByLabelText("BMI, calculated: —")).toBeTruthy();
  });

  test("computes them live from what is on screen plus the profile height", async () => {
    const { getByLabelText } = await render(<BodyCompositionForm heightCm={165} onSubmit={jest.fn()} />);
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.changeText(getByLabelText("Body fat percent"), "32.6");
    expect(getByLabelText("BMI, calculated: 25.8")).toBeTruthy();
    expect(getByLabelText("Fat mass, calculated: 22.9 kg")).toBeTruthy();
    expect(getByLabelText("Fat-free mass, calculated: 47.3 kg")).toBeTruthy();
  });

  test("shows an em dash rather than a number when its inputs are missing", async () => {
    const { getByLabelText } = await render(<BodyCompositionForm onSubmit={jest.fn()} />);
    // No height and no body fat: BMI and both masses are unknowable, and an
    // unknown that renders as 0 is indistinguishable from a measurement.
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    expect(getByLabelText("BMI, calculated: —")).toBeTruthy();
    expect(getByLabelText("Fat mass, calculated: —")).toBeTruthy();
  });

  test("shows the derived masses in the reader's own units", async () => {
    mockUseUnits.mockReturnValue({ system: "imperial", setSystem: jest.fn() });
    const { getByLabelText } = await render(<BodyCompositionForm heightCm={165} onSubmit={jest.fn()} />);
    await fireEvent.changeText(getByLabelText("Weight in pounds"), "154.8");
    await fireEvent.changeText(getByLabelText("Body fat percent"), "32.6");
    expect(getByLabelText("Fat mass, calculated: 50.5 lb")).toBeTruthy();
  });
});

describe("reuse as kora#314's confirm surface", () => {
  test("pre-fills the values a caller hands it, and leaves the rest empty", async () => {
    const { getByLabelText } = await render(
      <BodyCompositionForm
        initialValues={{ weight_kg: 70.2, body_fat_pct: 24.2, visceral_fat_rating: 7 }}
        sources={["scale_screenshot"]}
        onSubmit={jest.fn()}
      />,
    );
    expect(getByLabelText("Weight in kilograms").props.value).toBe("70.2");
    expect(getByLabelText("Visceral fat rating").props.value).toBe("7");
    // Not read from the screenshot, so not filled in — and not a zero.
    expect(getByLabelText("Protein percent").props.value).toBe("");
  });

  test("every pre-filled value stays editable, and an edit is what gets saved", async () => {
    const onSubmit = jest.fn();
    const { getByLabelText, getByText } = await render(
      <BodyCompositionForm
        initialValues={{ weight_kg: 70.2, body_fat_pct: 24.2 }}
        sources={["scale_screenshot"]}
        onSubmit={onSubmit}
      />,
    );
    await fireEvent.changeText(getByLabelText("Body fat percent"), "23.9");
    await fireEvent.press(getByText("Save"));
    expect(onSubmit.mock.calls[0][0]).toEqual({
      weight_kg: 70.2,
      body_fat_pct: 23.9,
      source: "scale_screenshot",
      ...todayFields,
    });
  });

  test("a single source is stated, not offered as a choice the user could misclaim", async () => {
    const { getByTestId, queryByTestId } = await render(
      <BodyCompositionForm sources={["scale_screenshot"]} onSubmit={jest.fn()} />,
    );
    expect(getByTestId("composition-source-fixed").props.children).toBe("Scale screenshot");
    expect(queryByTestId("composition-source")).toBeNull();
  });
});

describe("the date row (kora#314)", () => {
  test("defaults to today when no reading date is supplied", async () => {
    const { getByLabelText } = await render(<BodyCompositionForm onSubmit={jest.fn()} />);
    expect(getByLabelText("Reading date").props.value).toBe(TODAY);
  });

  test("pre-fills the screenshot's own reading date when one is given", async () => {
    const { getByLabelText } = await render(
      <BodyCompositionForm initialReadingDate="2026-08-19" onSubmit={jest.fn()} />,
    );
    expect(getByLabelText("Reading date").props.value).toBe("2026-08-19");
  });

  test("an edited date is what the payload carries, as logged_at and local_date", async () => {
    const onSubmit = jest.fn();
    const { getByLabelText, getByText } = await render(<BodyCompositionForm onSubmit={onSubmit} />);
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.changeText(getByLabelText("Reading date"), "2026-08-19");
    await fireEvent.press(getByText("Save"));
    expect(onSubmit.mock.calls[0][0]).toEqual({
      weight_kg: 70.2,
      source: "manual",
      logged_at: "2026-08-19T12:00:00Z",
      local_date: "2026-08-19",
    });
  });

  test("refuses to save a future date, and says so on the field", async () => {
    const onSubmit = jest.fn();
    const { getByLabelText, getByText, getAllByTestId } = await render(
      <BodyCompositionForm onSubmit={onSubmit} />,
    );
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.changeText(getByLabelText("Reading date"), "2026-08-23");
    await fireEvent.press(getByText("Save"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getAllByTestId("field-error").map((n) => n.props.children)).toContain("Date can't be in the future.");
  });

  test("refuses a malformed date", async () => {
    const onSubmit = jest.fn();
    const { getByLabelText, getByText, getAllByTestId } = await render(
      <BodyCompositionForm onSubmit={onSubmit} />,
    );
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.changeText(getByLabelText("Reading date"), "19/08/2026");
    await fireEvent.press(getByText("Save"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getAllByTestId("field-error").map((n) => n.props.children)).toContain("Enter a date as YYYY-MM-DD.");
  });

  test("a date error clears as soon as the field is corrected, like every other field", async () => {
    const onSubmit = jest.fn();
    const { getByLabelText, getByText, queryAllByTestId } = await render(
      <BodyCompositionForm onSubmit={onSubmit} />,
    );
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.changeText(getByLabelText("Reading date"), "2026-08-23");
    await fireEvent.press(getByText("Save"));
    expect(queryAllByTestId("field-error")).toHaveLength(1);
    await fireEvent.changeText(getByLabelText("Reading date"), "2026-08-19");
    expect(queryAllByTestId("field-error")).toHaveLength(0);
  });
});

// kora#314's silent-failure fix (LogWeightSheet pins Save in Sheet's footer):
// this component's own validation and save path must be identical whether
// the caller renders the inline button or triggers it through the ref.
describe("hideSubmitButton + imperative submit (kora#314)", () => {
  test("hideSubmitButton renders no inline Save control at all", async () => {
    const { queryByText } = await render(<BodyCompositionForm hideSubmitButton onSubmit={jest.fn()} />);
    expect(queryByText("Save")).toBeNull();
  });

  test("ref.submit() runs the SAME validate-then-submit path as the inline button", async () => {
    const onSubmit = jest.fn();
    const ref = createRef<BodyCompositionFormHandle>();
    const { getByLabelText } = await render(
      <BodyCompositionForm ref={ref} hideSubmitButton onSubmit={onSubmit} />,
    );
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await act(async () => ref.current?.submit());
    expect(onSubmit.mock.calls[0][0]).toEqual({ weight_kg: 70.2, source: "manual", ...todayFields });
  });

  test("ref.submit() is blocked by the same per-field errors, shown the same way", async () => {
    const onSubmit = jest.fn();
    const ref = createRef<BodyCompositionFormHandle>();
    const { getAllByTestId } = await render(<BodyCompositionForm ref={ref} hideSubmitButton onSubmit={onSubmit} />);
    // No weight typed at all — the one field this form refuses to save without.
    await act(async () => ref.current?.submit());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getAllByTestId("field-error")[0].props.children).toBe("Enter a weight in kg.");
  });

  test("submit() always runs against the LATEST typed values, not whatever they were when the ref was captured", async () => {
    // Guards the no-deps-array choice on useImperativeHandle: if the handle
    // were built once and never refreshed, this would submit an empty draft
    // instead of "70.2".
    const onSubmit = jest.fn();
    const ref = createRef<BodyCompositionFormHandle>();
    const { getByLabelText } = await render(
      <BodyCompositionForm ref={ref} hideSubmitButton onSubmit={onSubmit} />,
    );
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await act(async () => ref.current?.submit());
    expect(onSubmit.mock.calls[0][0].weight_kg).toBe(70.2);
  });
});

test("the chosen instrument is what the payload carries", async () => {
  const onSubmit = jest.fn();
  const { getByLabelText, getByText, getByTestId } = await render(<BodyCompositionForm onSubmit={onSubmit} />);
  await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
  await fireEvent.press(getByTestId("composition-source-segment-dexa"));
  await fireEvent.press(getByText("Save"));
  expect(onSubmit.mock.calls[0][0].source).toBe("dexa");
});

// kora#314 PR C: consolidating the three Trends entry points into one sheet
// hangs Manual mode's collapsed weight-only view, and Screenshot mode's
// already-expanded confirm view, off these two props. Every test above this
// point renders WITHOUT `expandable`, so they double as the guarantee that
// existing callers (kora#45's original surface) see no behaviour change at
// all — the prop defaults to false and the form is fully expanded, exactly
// as it always was.
describe("expandable (kora#314 PR C)", () => {
  test("collapsed by default when expandable: only weight and the toggle show, nothing else", async () => {
    const { getByLabelText, getByTestId, queryByTestId, queryByLabelText } = await render(
      <BodyCompositionForm expandable onSubmit={jest.fn()} />,
    );
    expect(getByLabelText("Weight in kilograms")).toBeTruthy();
    expect(getByTestId("composition-expand-toggle")).toBeTruthy();
    expect(queryByTestId("composition-date")).toBeNull();
    expect(queryByTestId("composition-derived")).toBeNull();
    expect(queryByTestId("composition-source")).toBeNull();
    expect(queryByTestId("composition-source-fixed")).toBeNull();
    expect(queryByLabelText("Body fat percent")).toBeNull();
  });

  test("tapping the toggle reveals the rest, and tapping again hides it", async () => {
    const { getByTestId, getByLabelText, queryByTestId } = await render(
      <BodyCompositionForm expandable onSubmit={jest.fn()} />,
    );
    await fireEvent.press(getByTestId("composition-expand-toggle"));
    expect(getByTestId("composition-date")).toBeTruthy();
    expect(getByTestId("composition-derived")).toBeTruthy();
    expect(getByLabelText("Body fat percent")).toBeTruthy();

    await fireEvent.press(getByTestId("composition-expand-toggle"));
    expect(queryByTestId("composition-date")).toBeNull();
    expect(queryByTestId("composition-derived")).toBeNull();
  });

  test("initiallyExpanded opens the section already open — the screenshot-confirm shape", async () => {
    const { getByTestId } = await render(
      <BodyCompositionForm expandable initiallyExpanded onSubmit={jest.fn()} />,
    );
    expect(getByTestId("composition-derived")).toBeTruthy();
  });

  test("a weight-only save while collapsed sends no composition keys — not nine zeroes, not nine absences typed in", async () => {
    const onSubmit = jest.fn();
    const { getByLabelText, getByText } = await render(<BodyCompositionForm expandable onSubmit={onSubmit} />);
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.press(getByText("Save"));
    // Still today's date and "manual" source (the collapsed section's OWN
    // defaults survive hidden, per this component's own doc comment) — just
    // no visible way to have typed anything else.
    expect(onSubmit.mock.calls[0][0]).toEqual({
      weight_kg: 70.2,
      source: "manual",
      ...todayFields,
    });
  });

  test("collapsing does not discard a value already typed into the hidden section", async () => {
    const onSubmit = jest.fn();
    const { getByTestId, getByLabelText, getByText } = await render(
      <BodyCompositionForm expandable initiallyExpanded onSubmit={onSubmit} />,
    );
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.changeText(getByLabelText("Body fat percent"), "24.2");
    // Collapse, then save from the collapsed view.
    await fireEvent.press(getByTestId("composition-expand-toggle"));
    await fireEvent.press(getByText("Save"));
    expect(onSubmit.mock.calls[0][0]).toEqual({
      weight_kg: 70.2,
      body_fat_pct: 24.2,
      source: "manual",
      ...todayFields,
    });
  });

  test("a multi-entry sources array pre-selects sources[0] as a CORRECTABLE control, not a stated fact", async () => {
    // kora#314 PR C: the detected-instrument case. Unlike the single-entry
    // `sources={["scale_screenshot"]}` case tested above (a stated fact),
    // three entries render the existing SegmentedGlass control so a
    // misdetection can be corrected.
    const onSubmit = jest.fn();
    const { getByTestId, getByLabelText, getByText, queryByTestId } = await render(
      <BodyCompositionForm
        expandable
        initiallyExpanded
        sources={["inbody", "scale_screenshot", "dexa"]}
        onSubmit={onSubmit}
      />,
    );
    expect(queryByTestId("composition-source-fixed")).toBeNull();
    expect(getByTestId("composition-source")).toBeTruthy();
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.press(getByText("Save"));
    // Pre-selected to sources[0] — the detected guess — without the user
    // touching the control at all.
    expect(onSubmit.mock.calls[0][0].source).toBe("inbody");

    // And it IS correctable: pressing a different segment changes what saves.
    await fireEvent.press(getByTestId("composition-source-segment-dexa"));
    await fireEvent.press(getByText("Save"));
    expect(onSubmit.mock.calls[1][0].source).toBe("dexa");
  });
});

// kora#378: the midday-UTC stamp for a date-only entry is in the FUTURE for
// most of the day. `useWeightSeries` asks the API for `to = now` and
// `WeightSeries` filters `logged_at < to`, so a weigh-in saved this morning
// was written correctly and then excluded from its own series until 12:00
// UTC -- 17:30 in IST, 22:00 in AEST. It looked exactly like a failed save.
describe("logged_at is never in the future (kora#378)", () => {
  const RealDate = Date;
  function freezeNow(iso: string) {
    const fixed = new RealDate(iso).getTime();
    // Only `Date.now` and `new Date()` (no args) are frozen; every other
    // construction must keep working, because the form parses date strings.
    global.Date = class extends RealDate {
      constructor(...args: unknown[]) {
        super(...((args.length ? args : [fixed]) as [any]));
      }
      static now() {
        return fixed;
      }
    } as DateConstructor;
  }
  afterEach(() => {
    global.Date = RealDate;
  });

  test("a weigh-in saved before midday UTC carries the current instant, not midday", async () => {
    freezeNow(`${TODAY}T03:51:00Z`);
    const onSubmit = jest.fn();
    const { getByLabelText, getByText } = await render(<BodyCompositionForm onSubmit={onSubmit} />);
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.press(getByText("Save"));

    const loggedAt = onSubmit.mock.calls[0][0].logged_at;
    expect(new RealDate(loggedAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(loggedAt).toBe(`${TODAY}T03:51:00.000Z`);
  });

  test("a weigh-in saved after midday UTC keeps the midday stamp", async () => {
    freezeNow(`${TODAY}T18:00:00Z`);
    const onSubmit = jest.fn();
    const { getByLabelText, getByText } = await render(<BodyCompositionForm onSubmit={onSubmit} />);
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.press(getByText("Save"));

    expect(onSubmit.mock.calls[0][0].logged_at).toBe(`${TODAY}T12:00:00Z`);
  });

  test("a past date is untouched -- midday keeps it clear of timezone edges", async () => {
    freezeNow(`${TODAY}T03:51:00Z`);
    const onSubmit = jest.fn();
    const { getByLabelText, getByText } = await render(<BodyCompositionForm onSubmit={onSubmit} />);
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.changeText(getByLabelText("Reading date"), "2026-08-19");
    await fireEvent.press(getByText("Save"));

    expect(onSubmit.mock.calls[0][0].logged_at).toBe("2026-08-19T12:00:00Z");
  });
});
