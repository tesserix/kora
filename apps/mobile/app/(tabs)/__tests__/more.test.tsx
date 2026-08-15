import { render, fireEvent, waitFor } from "@testing-library/react-native";

import More from "../more";

const mockPush = jest.fn();
// useFocusEffect: ScreenEntrance (Task 9) wraps More's root content and
// calls the real expo-router hook, which needs a navigation container this
// isolated render doesn't mount.
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a) },
  useFocusEffect: () => {},
}));
jest.mock("@/lib/firebase", () => ({ auth: { name: "fake-auth" } }));

const mockSignOut = jest.fn();
jest.mock("firebase/auth", () => ({ signOut: (...a: unknown[]) => mockSignOut(...a) }));
jest.mock("@/api/hooks", () => ({
  useUnreadCount: () => ({ data: { count: 2 } }),
  useProfile: () => ({ data: { display_name: "Kai Rivers", email: "kai@example.com" } }),
}));

const mockUnregister = jest.fn();
jest.mock("@/lib/push", () => ({ unregisterPushToken: () => mockUnregister() }));

// Local scheduled reminders are a separate surface from remote push (#171).
const mockCancelReminders = jest.fn();
jest.mock("@/reminders/schedule", () => ({ cancelAllReminders: () => mockCancelReminders() }));

beforeEach(() => {
  mockPush.mockClear();
  mockSignOut.mockReset().mockResolvedValue(undefined);
  mockUnregister.mockReset().mockResolvedValue(undefined);
  mockCancelReminders.mockReset().mockResolvedValue(undefined);
});

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

test("tapping Send feedback navigates to /feedback", async () => {
  const { getByText } = await render(<More />);
  await fireEvent.press(getByText("Send feedback"));
  expect(mockPush).toHaveBeenCalledWith("/feedback");
});

test("shows unread count badge when count > 0", async () => {
  const { getByText } = await render(<More />);
  expect(getByText("2")).toBeTruthy();
});


// --- #171: sign-out must disarm local reminders ----------------------------
//
// unregisterPushToken only addresses REMOTE push. Meal, custom and weight
// reminders are LOCAL scheduled notifications living in the OS, so without an
// explicit cancel they keep firing for whoever just signed out — on a shared
// device, at the previous user's mealtimes.
test("signing out disarms the scheduled local reminders", async () => {
  const { getByLabelText } = await render(<More />);
  await fireEvent.press(getByLabelText("Sign out"));

  await waitFor(() => expect(mockCancelReminders).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1));
});

// Best-effort, exactly like the push de-registration beside it: a wedged
// notification service must not trap the user in a session they left.
test("a failed cancellation still signs the user out", async () => {
  mockCancelReminders.mockRejectedValue(new Error("notification service unavailable"));
  const { getByLabelText } = await render(<More />);
  await fireEvent.press(getByLabelText("Sign out"));

  await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1));
});
