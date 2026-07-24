import { render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));
jest.mock("@/api/hooks", () => ({ useSubmitOnboarding: () => ({ mutate: jest.fn(), isPending: false }) }));

import Onboarding from "../onboarding";

test("Onboarding shows the editorial hero and goal cards", async () => {
  const { findByText } = await render(<Onboarding />);
  expect(await findByText(/Otto tracks it/i)).toBeTruthy();
  expect(await findByText("Lose weight")).toBeTruthy();
  expect(await findByText("Build muscle")).toBeTruthy();
  expect(await findByText("Get started")).toBeTruthy();
});
