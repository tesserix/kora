import { render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/api/hooks", () => ({ useDashboard: () => ({ data: { streak_days: 12 } }) }));

import Progress from "../progress";

test("Progress shows the weight card and the real streak", async () => {
  const { findByText } = await render(<Progress />);
  expect(await findByText("Progress")).toBeTruthy();
  expect(await findByText("Weight")).toBeTruthy();
  expect(await findByText("Log streak")).toBeTruthy();
  expect(await findByText("12")).toBeTruthy();
});
