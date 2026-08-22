import { fireEvent, render } from "@testing-library/react-native";

import AIUsageScreen from "../ai-usage";

const mockUseAIUsage = jest.fn();
const mockRefetch = jest.fn();

const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  router: { back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true), push: (...args: unknown[]) => mockPush(...args) },
}));
jest.mock("@/api/hooks", () => ({ useAIUsage: () => mockUseAIUsage() }));

const usage = {
  daily: { used: 3, limit: 20, remaining: 17, resets_at: "2026-08-20T00:00:00Z" },
  weekly: { used: 9, limit: 100, remaining: 91, resets_at: "2026-08-24T00:00:00Z" },
  monthly: { used: 17, limit: 300, remaining: 283, resets_at: "2026-09-01T00:00:00Z" },
};

beforeEach(() => {
  mockPush.mockClear();
  mockRefetch.mockClear();
  mockUseAIUsage.mockReturnValue({ data: usage, isLoading: false, isError: false, refetch: mockRefetch });
});

test("shows daily weekly and monthly AI allowance", async () => {
  const { getByText } = await render(<AIUsageScreen />);

  expect(getByText("17 calls left")).toBeTruthy();
  expect(getByText("Daily")).toBeTruthy();
  expect(getByText("3 / 20")).toBeTruthy();
  expect(getByText("Weekly")).toBeTruthy();
  expect(getByText("9 / 100")).toBeTruthy();
  expect(getByText("Monthly")).toBeTruthy();
  expect(getByText("17 / 300")).toBeTruthy();
});

test("shows an honest retry state when usage cannot be loaded", async () => {
  mockUseAIUsage.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: mockRefetch });

  const { getByText, getByLabelText } = await render(<AIUsageScreen />);

  expect(getByText("Couldn't load your AI usage.")).toBeTruthy();
  await fireEvent.press(getByLabelText("Retry"));
  expect(mockRefetch).toHaveBeenCalledTimes(1);
});

test("calls out an exhausted limit instead of reporting zero calls as available", async () => {
  mockUseAIUsage.mockReturnValue({
    data: { ...usage, daily: { ...usage.daily, used: 20, remaining: 0 } },
    isLoading: false,
    isError: false,
    refetch: mockRefetch,
  });

  const { getByText } = await render(<AIUsageScreen />);

  expect(getByText("AI limit reached")).toBeTruthy();
  expect(getByText(/Available again/)).toBeTruthy();
});

test("offers a top-up from the usage screen", async () => {
  const { getByLabelText } = await render(<AIUsageScreen />);

  await fireEvent.press(getByLabelText("Add requests"));

  expect(mockPush).toHaveBeenCalledWith("/ai-top-up");
});

// A user who paid should be able to see what they paid for, separately from
// the free allowance it sits on top of.
test("an active top-up is shown beside the free allowance, not merged into it", async () => {
  mockUseAIUsage.mockReturnValue({
    data: {
      ...usage,
      daily: { ...usage.daily, used: 20, remaining: 0 },
      top_up: {
        active: true,
        unlimited: false,
        pack_code: "spark",
        remaining: 25,
        daily_remaining: 10,
        expires_at: "2026-09-21T09:00:00Z",
      },
    },
    isLoading: false,
    isError: false,
    refetch: mockRefetch,
  });

  const { getByText, getByLabelText } = await render(<AIUsageScreen />);

  expect(getByText("10 calls left")).toBeTruthy();
  expect(getByText("20 / 20")).toBeTruthy();
  expect(getByLabelText("Top-up active: 25 requests left, 10 today")).toBeTruthy();
});

test("an unlimited pack reports unlimited rather than a count", async () => {
  mockUseAIUsage.mockReturnValue({
    data: {
      ...usage,
      daily: { ...usage.daily, used: 20, remaining: 0 },
      top_up: { active: true, unlimited: true, pack_code: "boundless", remaining: 0, daily_remaining: 0 },
    },
    isLoading: false,
    isError: false,
    refetch: mockRefetch,
  });

  const { getByText } = await render(<AIUsageScreen />);

  expect(getByText("Unlimited")).toBeTruthy();
  expect(getByText("No daily cap")).toBeTruthy();
});
