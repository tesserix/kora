import { render, fireEvent } from "@testing-library/react-native";

import Profile from "../profile";

const mockBack = jest.fn();
const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  router: {
    back: (...a: unknown[]) => mockBack(...a),
    push: (...a: unknown[]) => mockPush(...a),
  },
}));
jest.mock("@/api/hooks", () => ({
  useProfile: () => ({
    data: {
      id: "u1",
      email: "ada@example.com",
      display_name: "Ada Lovelace",
      goal: "fat_loss",
      target_kcal: 1850,
      target_protein_g: 140,
      target_carbs_g: 160,
      target_fat_g: 55,
      onboarded_at: "2025-03-14T00:00:00.000Z",
      weight_kg: 68.4,
      share_progress: false,
    },
  }),
}));

beforeEach(() => {
  mockBack.mockClear();
  mockPush.mockClear();
});

test("renders the signed-in user's account info", async () => {
  const { getByText } = await render(<Profile />);
  expect(getByText("Ada Lovelace")).toBeTruthy();
  expect(getByText("ada@example.com")).toBeTruthy();
  expect(getByText("1850")).toBeTruthy();
});

test("shows a Go back affordance that navigates back", async () => {
  const { getByLabelText } = await render(<Profile />);
  expect(getByLabelText("Go back")).toBeTruthy();
});

test("offers a destructive Delete account row", async () => {
  const { getByText } = await render(<Profile />);
  expect(getByText("Account")).toBeTruthy();
  expect(getByText("Delete account")).toBeTruthy();
});

test("tapping Delete account routes to the confirmation screen", async () => {
  const { getByText } = await render(<Profile />);
  await fireEvent.press(getByText("Delete account"));
  expect(mockPush).toHaveBeenCalledWith("/delete-account");
});
