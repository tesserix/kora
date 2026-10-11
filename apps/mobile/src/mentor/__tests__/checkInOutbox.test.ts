import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiFetch } from "@/lib/api";
import { enqueueMentorCheckIn, flushMentorCheckIns } from "../checkInOutbox";

let mockOwnerID = "user-a";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  currentUserId: () => mockOwnerID,
  TimeoutError: class TimeoutError extends Error {},
  isNetworkError: (error: unknown) => error instanceof TypeError,
}));

const checkIn = {
  commitmentId: "0a38f2c2-97b8-4f8f-a0ce-44caf5134532",
  scheduled_for: "2026-08-24T08:00:00.000Z",
  local_date: "2026-08-24",
  action: "done" as const,
  snoozed_until: null,
};

beforeEach(async () => {
  mockOwnerID = "user-a";
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

test("an offline notification action survives and is retried later", async () => {
  (apiFetch as jest.Mock).mockRejectedValueOnce(new TypeError("offline"));

  await enqueueMentorCheckIn(checkIn);
  await flushMentorCheckIns();

  expect(apiFetch).toHaveBeenCalledTimes(1);

  (apiFetch as jest.Mock).mockResolvedValue({ id: "check-in-1" });
  await expect(flushMentorCheckIns()).resolves.toEqual({ sent: 1, pending: 0 });
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

test("one account never sends another account's queued check-in", async () => {
  await enqueueMentorCheckIn(checkIn);
  mockOwnerID = "user-b";
  (apiFetch as jest.Mock).mockResolvedValue({ id: "check-in-1" });

  await expect(flushMentorCheckIns()).resolves.toEqual({ sent: 0, pending: 0 });
  expect(apiFetch).not.toHaveBeenCalled();

  mockOwnerID = "user-a";
  await expect(flushMentorCheckIns()).resolves.toEqual({ sent: 1, pending: 0 });
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
