import { render, fireEvent } from "@testing-library/react-native";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock("@/lib/firebase", () => ({ auth: null }));
jest.mock("firebase/auth", () => ({ signOut: jest.fn() }));
jest.mock("@/api/hooks", () => ({ useUnreadCount: () => ({ data: { count: 2 } }) }));

import More from "../more";

beforeEach(() => mockPush.mockClear());

test("tapping Profile navigates to /profile", async () => {
  const { getByText } = await render(<More />);
  await fireEvent.press(getByText("Profile"));
  expect(mockPush).toHaveBeenCalledWith("/profile");
});

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

test("tapping Notifications navigates to /notifications", async () => {
  const { getByText } = await render(<More />);
  await fireEvent.press(getByText("Notifications"));
  expect(mockPush).toHaveBeenCalledWith("/notifications");
});

test("tapping Reminders navigates to /reminders", async () => {
  const { getByText } = await render(<More />);
  await fireEvent.press(getByText("Reminders"));
  expect(mockPush).toHaveBeenCalledWith("/reminders");
});

test("tapping Send feedback navigates to /feedback", async () => {
  const { getByText } = await render(<More />);
  await fireEvent.press(getByText("Send feedback"));
  expect(mockPush).toHaveBeenCalledWith("/feedback");
});

test("shows unread count badge when count > 0", async () => {
  const { getByText } = await render(<More />);
  expect(getByText("2")).toBeTruthy();
});
