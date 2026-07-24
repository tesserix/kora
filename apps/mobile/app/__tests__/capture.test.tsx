import { fireEvent, render } from "@testing-library/react-native";
import type { Resolution } from "@/api/types";

jest.mock("expo-router", () => ({ router: { back: jest.fn() } }));
jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone" } }),
}));

import CaptureScreen, { CaptureBody } from "../capture";

function makeResolution(): Resolution {
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
        portion_grams: 140,
        kcal: 231,
        match_score: 0.96,
        match_tier: "auto",
      },
    ],
    tier: "auto",
    is_estimate: false,
    provenance: "afcd",
  };
}

const noopBodyProps = {
  displayName: "Alex",
  insetTop: 0,
  mode: "photo" as const,
  onModeChange: jest.fn(),
  mealSlot: "lunch" as const,
  onChangeMealSlot: jest.fn(),
  onAdd: jest.fn(),
  adding: false,
  text: "",
  onChangeText: jest.fn(),
  onClose: jest.fn(),
};

test("renders the Otto greeting and all four mode pills", async () => {
  const { findByText } = await render(<CaptureScreen />);
  expect(await findByText(/show me your meal/i)).toBeTruthy();
  expect(await findByText("Photo")).toBeTruthy();
  expect(await findByText("Voice")).toBeTruthy();
  expect(await findByText("Scan")).toBeTruthy();
  expect(await findByText("Type")).toBeTruthy();
});

test("tapping a mode pill switches mode and changes the idle affordance", async () => {
  const { findByText, findByTestId, getByTestId, queryByTestId } = await render(<CaptureScreen />);
  expect(getByTestId("capture-idle-photo")).toBeTruthy();

  fireEvent.press(await findByText("Voice"));
  expect(await findByTestId("capture-idle-voice")).toBeTruthy();
  expect(queryByTestId("capture-idle-photo")).toBeNull();

  fireEvent.press(await findByText("Scan"));
  expect(await findByTestId("capture-idle-scan")).toBeTruthy();
  expect(queryByTestId("capture-idle-voice")).toBeNull();

  fireEvent.press(await findByText("Type"));
  expect(await findByTestId("capture-idle-type")).toBeTruthy();
  expect(queryByTestId("capture-idle-scan")).toBeNull();
});

test("analyzing stage shows the spinner", async () => {
  const { getByTestId } = await render(
    <CaptureBody {...noopBodyProps} stage="analyzing" resolution={null} />,
  );
  expect(getByTestId("capture-analyzing-spinner")).toBeTruthy();
});

test("result stage renders DetectedCard when resolution is set", async () => {
  const resolution = makeResolution();
  const { getByText } = await render(
    <CaptureBody {...noopBodyProps} stage="result" resolution={resolution} />,
  );
  expect(getByText(/Detected · 1 items/i)).toBeTruthy();
  expect(getByText("Grilled chicken breast")).toBeTruthy();
});

test("idle stage does not render the analyzing spinner or a result card", async () => {
  const { queryByTestId, queryByText } = await render(
    <CaptureBody {...noopBodyProps} stage="idle" resolution={null} />,
  );
  expect(queryByTestId("capture-analyzing-spinner")).toBeNull();
  expect(queryByText(/Detected ·/i)).toBeNull();
});
