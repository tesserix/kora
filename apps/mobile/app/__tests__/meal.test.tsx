import { render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ name: "Lunch", mealSlot: "lunch", time: "12:30", kcal: "410", protein: "48", carbs: "132", fat: "12" }),
  router: { back: jest.fn() },
}));

import MealDetail from "../meal";

test("renders meal name, kcal and macro tiles", async () => {
  const { findByText } = await render(<MealDetail />);
  expect(await findByText("410")).toBeTruthy();
  expect(await findByText("Protein")).toBeTruthy();
  expect(await findByText("48g")).toBeTruthy();
});
