import { render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));
jest.mock("@/api/hooks", () => ({
  useFoodSearch: () => ({
    data: [
      {
        id: "f1",
        name: "Grilled chicken breast",
        brand: "",
        provenance: "seed",
        serving_desc: "1 breast",
        serving_grams: 140,
        kcal_per_100g: 165,
        protein_per_100g: 31,
        carbs_per_100g: 0,
        fat_per_100g: 3.6,
      },
    ],
    isLoading: false,
  }),
  useCreateLog: () => ({ mutate: jest.fn(), isPending: false }),
}));

import LogScreen from "../log";

test("Log screen shows the editorial header and a food tile result", async () => {
  const { findByText } = await render(<LogScreen />);
  expect(await findByText("Log food")).toBeTruthy();
  expect(await findByText("Grilled chicken breast")).toBeTruthy();
});
