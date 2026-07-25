import { render, fireEvent } from "@testing-library/react-native";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock("@/lib/firebase", () => ({ auth: null }));
jest.mock("firebase/auth", () => ({ signOut: jest.fn() }));

import More from "../more";

beforeEach(() => mockPush.mockClear());

test("tapping Friends navigates to /friends", async () => {
  const { getByText } = await render(<More />);
  await fireEvent.press(getByText("Friends"));
  expect(mockPush).toHaveBeenCalledWith("/friends");
});

test("tapping Groups navigates to /groups", async () => {
  const { getByText } = await render(<More />);
  await fireEvent.press(getByText("Groups"));
  expect(mockPush).toHaveBeenCalledWith("/groups");
});
