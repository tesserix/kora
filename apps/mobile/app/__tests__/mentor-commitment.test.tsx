import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import MentorCommitmentScreen from "../mentor-commitment";
import * as Notifications from "expo-notifications";

const mockPutCommitment = jest.fn();
const mockAcceptProposal = jest.fn();
let mockSearchParams: Record<string, string> = {};

jest.mock("@/api/hooks", () => ({
  usePutMentorCommitment: () => ({ mutateAsync: mockPutCommitment, isPending: false }),
  useAcceptMentorProposal: () => ({ mutateAsync: mockAcceptProposal, isPending: false }),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "0a38f2c2-97b8-4f8f-a0ce-44caf5134532" }));
jest.mock("expo-router", () => ({
  router: { back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => mockSearchParams,
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = {};
  mockPutCommitment.mockResolvedValue({ id: "0a38f2c2-97b8-4f8f-a0ce-44caf5134532" });
  mockAcceptProposal.mockResolvedValue({ id: "0a38f2c2-97b8-4f8f-a0ce-44caf5134532" });
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: "granted", granted: true });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: "granted", granted: true });
});

test("an AI suggestion is prefilled and accepted only after the user activates it", async () => {
  mockSearchParams = {
    proposalId: "proposal-1",
    title: "Walk after lunch",
    kind: "walking",
    cadence: "fixed",
    weekdaysMask: "62",
    startMinute: "780",
    intervalMinutes: "",
    endMinute: "",
    timezone: "Australia/Melbourne",
    startsOn: "2026-08-22",
  };

  const { getByLabelText, getByRole, getByText } = await render(<MentorCommitmentScreen />);
  expect(getByLabelText("Commitment title").props.value).toBe("Walk after lunch");
  expect(getByText(/review this agent suggestion/i)).toBeTruthy();
  fireEvent.press(getByRole("button", { name: "Activate suggestion" }));

  await waitFor(() => expect(mockAcceptProposal).toHaveBeenCalledWith(expect.objectContaining({
    proposalId: "proposal-1",
    commitmentId: "0a38f2c2-97b8-4f8f-a0ce-44caf5134532",
    title: "Walk after lunch",
    kind: "walking",
    weekdays_mask: 62,
    start_minute: 780,
  })));
  expect(mockPutCommitment).not.toHaveBeenCalled();
});

test("a hydration interval becomes active only after explicit confirmation", async () => {
  const { getByLabelText, getByRole } = await render(<MentorCommitmentScreen />);
  await fireEvent.changeText(getByLabelText("Commitment title"), "Drink water");
  await fireEvent.press(getByRole("radio", { name: "Water" }));
  await fireEvent.press(getByRole("radio", { name: "Interval" }));
  await waitFor(() => expect(getByRole("button", { name: "Every 120 minutes" })).toBeTruthy());
  await fireEvent.press(getByRole("button", { name: "Every 120 minutes" }));
  await fireEvent.press(getByRole("button", { name: "Activate commitment" }));

  await waitFor(() => expect(mockPutCommitment).toHaveBeenCalledWith(expect.objectContaining({
    id: "0a38f2c2-97b8-4f8f-a0ce-44caf5134532",
    title: "Drink water",
    kind: "hydration",
    cadence: "interval",
    interval_minutes: 120,
    status: "active",
    weekdays_mask: 127,
  })));
  expect(router.replace).toHaveBeenCalledWith("/mentor");
});

test("denied notification access keeps the commitment but reports reminders are off", async () => {
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: "denied", granted: false, canAskAgain: false });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: "denied", granted: false, canAskAgain: false });
  const { getByLabelText, getByRole, getByText } = await render(<MentorCommitmentScreen />);
  await fireEvent.changeText(getByLabelText("Commitment title"), "Evening walk");
  await fireEvent.press(getByRole("button", { name: "Activate commitment" }));

  await waitFor(() => expect(mockPutCommitment).toHaveBeenCalledTimes(1));
  expect(getByText(/commitment is active, but notifications are off/i)).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalled();
});
