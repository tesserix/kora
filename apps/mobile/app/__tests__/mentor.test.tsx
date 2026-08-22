import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import MentorScreen from "../mentor";

const mockPutProfile = jest.fn();
const mockDeleteHealth = jest.fn();
const mockPutCommitment = jest.fn();
const mockPutFoodRules = jest.fn();
const mockConfirmFoodRule = jest.fn();
const mockDeleteFoodRule = jest.fn();
const mockRefetchFoodRules = jest.fn();

const profile = {
  motivation: "Feel more energetic",
  dietary_preferences: "Vegetarian",
  allergies: "Peanuts",
  diet_pattern: "vegetarian",
  coaching_style: "supportive",
  reminder_intensity: "balanced",
  quiet_start_minute: 1320,
  quiet_end_minute: 420,
  health_steps_enabled: true,
  health_sleep_enabled: false,
  health_workouts_enabled: false,
  confirmed_at: "2026-08-22T00:00:00Z",
  created_at: "2026-08-22T00:00:00Z",
  updated_at: "2026-08-22T00:00:00Z",
};

const commitment = {
  id: "0a38f2c2-97b8-4f8f-a0ce-44caf5134532",
  title: "Walk after work",
  kind: "walking",
  cadence: "fixed",
  weekdays_mask: 127,
  start_minute: 1080,
  interval_minutes: null,
  end_minute: null,
  timezone: "Australia/Melbourne",
  starts_on: "2026-08-22",
  ends_on: null,
  status: "active",
  source: "coach",
  agent_name: "Kora Coach",
  created_at: "2026-08-22T00:00:00Z",
  updated_at: "2026-08-22T00:00:00Z",
};

const foodRules = {
  rules: [
    {
      id: "8c1e0e8a-2a41-4a03-8bd0-6b1b0f0f0001",
      subject: "peanut",
      kind: "allergy",
      severity: "block",
      label: "Peanut",
      source: "user",
      confirmed_at: "2026-08-22T00:00:00Z",
      created_at: "2026-08-22T00:00:00Z",
      updated_at: "2026-08-22T00:00:00Z",
    },
    {
      id: "8c1e0e8a-2a41-4a03-8bd0-6b1b0f0f0002",
      subject: "beef",
      kind: "exclusion",
      severity: "flag",
      label: "Beef",
      source: "pattern",
      confirmed_at: null,
      created_at: "2026-08-22T00:00:00Z",
      updated_at: "2026-08-22T00:00:00Z",
    },
  ],
  subjects: [
    { subject: "peanut", label: "Peanut", family: "peanut" },
    { subject: "beef", label: "Beef" },
    { subject: "mushroom", label: "Mushroom" },
  ],
  patterns: ["vegetarian", "vegan"],
};

jest.mock("@/api/hooks", () => ({
  useMentorProfile: () => ({ data: profile, isPending: false, isError: false, refetch: jest.fn() }),
  useMentorCommitments: () => ({ data: [commitment], isPending: false, isError: false, refetch: jest.fn() }),
  usePutMentorProfile: () => ({ mutateAsync: mockPutProfile, isPending: false }),
  useDeleteMentorHealth: () => ({ mutateAsync: mockDeleteHealth, isPending: false }),
  usePutMentorCommitment: () => ({ mutateAsync: mockPutCommitment, isPending: false }),
  useMentorFoodRules: () => ({
    data: foodRules, isPending: false, isError: false, refetch: mockRefetchFoodRules,
  }),
  usePutMentorFoodRules: () => ({ mutateAsync: mockPutFoodRules, isPending: false }),
  useConfirmMentorFoodRule: () => ({ mutateAsync: mockConfirmFoodRule, isPending: false }),
  useDeleteMentorFoodRule: () => ({ mutateAsync: mockDeleteFoodRule, isPending: false }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockPutProfile.mockResolvedValue(profile);
  mockDeleteHealth.mockResolvedValue(undefined);
  mockPutCommitment.mockResolvedValue(commitment);
  mockPutFoodRules.mockResolvedValue(foodRules.rules);
  mockConfirmFoodRule.mockResolvedValue(foodRules.rules[1]);
  mockDeleteFoodRule.mockResolvedValue(undefined);
});

test("Personal Mentor explains private aggregation and shows active commitments", async () => {
  const { getByText } = await render(<MentorScreen />);

  expect(getByText("Personal Mentor")).toBeTruthy();
  expect(getByText(/Raw Apple Health samples stay on this device/i)).toBeTruthy();
  expect(getByText("Walk after work")).toBeTruthy();
  expect(getByText("Kora Coach")).toBeTruthy();
});

test("saving revoked Health consent updates the profile and deletes uploaded summaries", async () => {
  const { getByTestId, getByRole, getByDisplayValue } = await render(<MentorScreen />);
  await waitFor(() => expect(getByDisplayValue("Feel more energetic")).toBeTruthy());
  await act(async () => {
    fireEvent(getByTestId("mentor-health-steps"), "valueChange", false);
  });
  await act(async () => {
    fireEvent.press(getByRole("button", { name: "Save mentor settings" }));
  });

  await waitFor(() => expect(mockPutProfile).toHaveBeenCalledWith(expect.objectContaining({
    health_steps_enabled: false,
    health_sleep_enabled: false,
    health_workouts_enabled: false,
  })));
  expect(mockDeleteHealth).toHaveBeenCalledTimes(1);
});

test("commitments activate and pause only through an explicit user toggle", async () => {
  const { getByTestId, getByText } = await render(<MentorScreen />);
  await waitFor(() => expect(getByText("Walk after work")).toBeTruthy());
  await act(async () => {
    fireEvent(getByTestId(`mentor-commitment-${commitment.id}`), "valueChange", false);
  });

  await waitFor(() => expect(mockPutCommitment).toHaveBeenCalledWith({ ...commitment, status: "paused" }));
});

test("food rules separate what Kora enforces from what it has only proposed", async () => {
  const { getByTestId, queryByTestId } = await render(<MentorScreen />);

  // A confirmed allergy is in force; a pattern-derived rule is only proposed,
  // and the two must not look like the same thing.
  getByTestId("mentor-food-rule-peanut");
  getByTestId("mentor-food-rule-proposed-beef");
  expect(queryByTestId("mentor-food-rule-beef")).toBeNull();
});

test("confirming a proposed rule puts it in force", async () => {
  const { getByTestId } = await render(<MentorScreen />);

  await act(async () => {
    fireEvent.press(getByTestId("mentor-food-rule-proposed-beef"));
  });

  await waitFor(() => expect(mockConfirmFoodRule).toHaveBeenCalledWith("beef"));
});

test("adding a rule keeps the user's existing rules", async () => {
  const { getByTestId } = await render(<MentorScreen />);

  await act(async () => {
    fireEvent.press(getByTestId("mentor-food-rule-add-preference"));
  });
  await act(async () => {
    fireEvent.press(getByTestId("mentor-food-subject-mushroom"));
  });

  await waitFor(() => expect(mockPutFoodRules).toHaveBeenCalledWith([
    { subject: "peanut", kind: "allergy", severity: "block" },
    { subject: "mushroom", kind: "preference" },
  ]));
});

test("a rule already set is not offered again in the picker", async () => {
  const { getByTestId, queryByTestId } = await render(<MentorScreen />);

  await act(async () => {
    fireEvent.press(getByTestId("mentor-food-rule-add-allergy"));
  });

  expect(queryByTestId("mentor-food-subject-peanut")).toBeNull();
  getByTestId("mentor-food-subject-mushroom");
});

test("removing a rule in force deletes it", async () => {
  const { getByTestId } = await render(<MentorScreen />);

  await act(async () => {
    fireEvent.press(getByTestId("mentor-food-rule-peanut"));
  });

  await waitFor(() => expect(mockDeleteFoodRule).toHaveBeenCalledWith("peanut"));
});
