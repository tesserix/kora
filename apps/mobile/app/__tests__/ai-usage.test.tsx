import { fireEvent, render } from "@testing-library/react-native";

import AIUsageScreen from "../ai-usage";

const mockUseAIUsage = jest.fn();
const mockRefetch = jest.fn();

jest.mock("expo-router", () => ({
  router: { back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
}));
jest.mock("@/api/hooks", () => ({ useAIUsage: () => mockUseAIUsage() }));

const usage = {
  daily: { used: 3, limit: 20, remaining: 17, resets_at: "2026-08-20T00:00:00Z" },
  weekly: { used: 9, limit: 100, remaining: 91, resets_at: "2026-08-24T00:00:00Z" },
  monthly: { used: 17, limit: 300, remaining: 283, resets_at: "2026-09-01T00:00:00Z" },
};

beforeEach(() => {
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
