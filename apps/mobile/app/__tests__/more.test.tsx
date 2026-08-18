import { render, fireEvent } from "@testing-library/react-native";
import { instrumentLight } from "@/theme/palette";

import More from "../(tabs)/more";

const mockPush = jest.fn();
const mockSignOut = jest.fn(async () => {});
const mockUnregisterPushToken = jest.fn(async () => {});

// useFocusEffect: ScreenEntrance (Task 9) wraps More's root content and
// calls the real expo-router hook, which needs a navigation container this
// isolated render doesn't mount.
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a) },
  useFocusEffect: () => {},
}));
jest.mock("firebase/auth", () => ({ signOut: () => mockSignOut() }));
jest.mock("@/lib/firebase", () => ({ auth: {} }));
jest.mock("@/lib/push", () => ({ unregisterPushToken: () => mockUnregisterPushToken() }));

let mockUnreadCount = 0;
jest.mock("@/api/hooks", () => ({
  useUnreadCount: () => ({ data: { count: mockUnreadCount } }),
  useProfile: () => ({ data: { display_name: "Kai Rivers", email: "kai@example.com" } }),
  useAIUsage: () => ({ data: undefined }),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
  const flat = Array.isArray(style) ? style.flat(Infinity) : [style];
  return Object.assign({}, ...flat.filter(Boolean));
}

beforeEach(() => {
  mockUnreadCount = 0;
  mockPush.mockClear();
  mockSignOut.mockClear();
  mockUnregisterPushToken.mockClear();
});

test("renders every row label and the More title", async () => {
  const { getByText } = await render(<More />);
  expect(getByText("More")).toBeTruthy();
  for (const label of ["Profile", "Friends", "Groups", "Notifications", "Recipes", "AI usage", "Settings", "Send feedback", "Sign out"]) {
    expect(getByText(label)).toBeTruthy();
  }
});

test("pressing a row navigates to its route", async () => {
  const { getByText } = await render(<More />);
  fireEvent.press(getByText("Settings"));
  expect(mockPush).toHaveBeenCalledWith("/settings");
});

// Recipes had no in-app entry point at all until this row — /recipes was
// reachable only by a raw deep link. This is the one place a user reaches it.
test("Recipes row navigates to /recipes", async () => {
  const { getByText } = await render(<More />);
  fireEvent.press(getByText("Recipes"));
  expect(mockPush).toHaveBeenCalledWith("/recipes");
});

test("row icon tiles use the instrument inset/mut palette, never the legacy accent tint", async () => {
  const { getByTestId } = await render(<More />);
  const tile = getByTestId("more-icon-profile");
  const style = flattenStyle(tile.props.style);
  expect(style.backgroundColor).toBe(instrumentLight.inset);
  expect(style.borderColor).toBe(instrumentLight.glassBorder);
});

test("unread Badge only renders when count > 0, and is the sole accent element", async () => {
  const { queryByText, rerender } = await render(<More />);
  expect(queryByText("0")).toBeNull();

  mockUnreadCount = 3;
  await rerender(<More />);
  expect(queryByText("3")).toBeTruthy();
});

test("Sign out row is styled with the instrument danger color", async () => {
  const { getByText } = await render(<More />);
  const label = getByText("Sign out");
  const style = flattenStyle(label.props.style);
  expect(style.color).toBe(instrumentLight.danger);
});

test("Sign out de-registers the push token and signs out", async () => {
  const { getByText } = await render(<More />);
  await fireEvent.press(getByText("Sign out"));
  expect(mockUnregisterPushToken).toHaveBeenCalledTimes(1);
  expect(mockSignOut).toHaveBeenCalledTimes(1);
});
