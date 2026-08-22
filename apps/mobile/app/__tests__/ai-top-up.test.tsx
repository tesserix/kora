import { Linking } from "react-native";
import { fireEvent, render, waitFor } from "@testing-library/react-native";

import AITopUpScreen from "../ai-top-up";

const mockPacks = jest.fn();
const mockCreateOrder = jest.fn();
const mockOrder = jest.fn();
const mockMutateAsync = jest.fn();
const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  router: { back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true), push: (...args: unknown[]) => mockPush(...args) },
}));
jest.mock("@/api/hooks", () => ({
  useAIPacks: () => mockPacks(),
  useAIOrder: (id: string | null) => mockOrder(id),
  useCreateAIOrder: () => mockCreateOrder(),
  useProfile: () => ({ data: { email: "payer@example.dev" } }),
}));

const spark = {
  code: "spark",
  name: "Spark",
  base_paise: 5_000,
  grant: 25,
  daily_cap: 10,
  unlimited: false,
  summary: "25 extra requests, up to 10 a day",
  base_rupees: "50.00",
  total_rupees: "60.18",
  price: {
    base_paise: 5_000,
    platform_fee_paise: 100,
    taxable_paise: 5_100,
    gst_paise: 918,
    total_paise: 6_018,
    gst_rate_basis_points: 1800,
    platform_fee_rate_basis_points: 200,
  },
};
const boundless = {
  ...spark,
  code: "boundless",
  name: "Boundless",
  base_paise: 105_000,
  grant: 0,
  daily_cap: 0,
  unlimited: true,
  summary: "Unlimited requests for 30 days",
  base_rupees: "1050.00",
  total_rupees: "1263.78",
  price: {
    base_paise: 105_000,
    platform_fee_paise: 2_100,
    taxable_paise: 107_100,
    gst_paise: 19_278,
    total_paise: 126_378,
    gst_rate_basis_points: 1800,
    platform_fee_rate_basis_points: 200,
  },
};

const createdOrder = {
  id: "order-1",
  pack_code: "spark",
  base_paise: 5_000,
  platform_fee_paise: 100,
  gst_paise: 918,
  total_paise: 6_018,
  currency: "INR",
  status: "created" as const,
  checkout_url: "https://payments-test.cashfree.com/order/#session-1",
  created_at: "2026-08-22T09:00:00Z",
};

beforeEach(() => {
  mockPush.mockClear();
  mockMutateAsync.mockReset().mockResolvedValue(createdOrder);
  mockPacks.mockReturnValue({ data: [spark, boundless], isLoading: false, isError: false, refetch: jest.fn() });
  mockCreateOrder.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
  mockOrder.mockReturnValue({ data: undefined });
});

test("every pack is priced with the platform fee and GST it will actually charge", async () => {
  const { getByText, getByLabelText } = await render(<AITopUpScreen />);

  expect(getByText("Spark")).toBeTruthy();
  expect(getByText("₹60.18")).toBeTruthy();
  expect(getByText("Boundless")).toBeTruthy();
  expect(getByText("₹1263.78")).toBeTruthy();

  await fireEvent.press(getByLabelText(/^Spark,/));

  expect(getByText("Pack price")).toBeTruthy();
  expect(getByText("₹50.00")).toBeTruthy();
  expect(getByText("Platform fee (2%)")).toBeTruthy();
  expect(getByText("₹1.00")).toBeTruthy();
  expect(getByText("GST (18%)")).toBeTruthy();
  expect(getByText("₹9.18")).toBeTruthy();
  expect(getByText("You pay")).toBeTruthy();
});

test("paying needs a chosen pack and a usable phone number", async () => {
  const { getByLabelText } = await render(<AITopUpScreen />);
  const pay = getByLabelText("Pay securely");

  await fireEvent.press(pay);
  expect(mockMutateAsync).not.toHaveBeenCalled();

  await fireEvent.press(getByLabelText(/^Spark,/));
  await fireEvent.changeText(getByLabelText("Phone number"), "12345");
  await fireEvent.press(pay);
  expect(mockMutateAsync).not.toHaveBeenCalled();
});

test("paying opens the gateway's own checkout link", async () => {
  const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
  const { getByLabelText } = await render(<AITopUpScreen />);

  await fireEvent.press(getByLabelText(/^Spark,/));
  await fireEvent.changeText(getByLabelText("Phone number"), "9876543210");
  await fireEvent.press(getByLabelText("Pay securely"));

  await waitFor(() =>
    expect(mockMutateAsync).toHaveBeenCalledWith({
      pack_code: "spark",
      phone: "9876543210",
      email: "payer@example.dev",
    }),
  );
  await waitFor(() => expect(openURL).toHaveBeenCalledWith(createdOrder.checkout_url));
  openURL.mockRestore();
});

// The app must never claim a payment succeeded: only the settled order does.
test("an open order waits for confirmation instead of claiming success", async () => {
  mockOrder.mockReturnValue({ data: createdOrder });
  jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
  const { getByLabelText, getByText } = await render(<AITopUpScreen />);

  await fireEvent.press(getByLabelText(/^Spark,/));
  await fireEvent.changeText(getByLabelText("Phone number"), "9876543210");
  await fireEvent.press(getByLabelText("Pay securely"));

  await waitFor(() => expect(getByText("Waiting for confirmation")).toBeTruthy());
});

test("a settled order names its invoice", async () => {
  mockOrder.mockReturnValue({
    data: { ...createdOrder, status: "paid", invoice_number: "KORA/26-27/000001", paid_at: "2026-08-22T09:05:00Z" },
  });
  jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
  const { getByLabelText, getByText } = await render(<AITopUpScreen />);

  await fireEvent.press(getByLabelText(/^Spark,/));
  await fireEvent.changeText(getByLabelText("Phone number"), "9876543210");
  await fireEvent.press(getByLabelText("Pay securely"));

  await waitFor(() => expect(getByText("Payment confirmed")).toBeTruthy());
  expect(getByText(/KORA\/26-27\/000001/)).toBeTruthy();
});

test("a failed payment says nothing was charged", async () => {
  mockOrder.mockReturnValue({ data: { ...createdOrder, status: "failed" } });
  jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
  const { getByLabelText, getByText } = await render(<AITopUpScreen />);

  await fireEvent.press(getByLabelText(/^Spark,/));
  await fireEvent.changeText(getByLabelText("Phone number"), "9876543210");
  await fireEvent.press(getByLabelText("Pay securely"));

  await waitFor(() => expect(getByText("Payment didn't go through")).toBeTruthy());
  expect(getByText("Nothing was charged. You can start again.")).toBeTruthy();
});

test("a refused checkout is reported rather than silently swallowed", async () => {
  mockMutateAsync.mockRejectedValue(new Error("gateway down"));
  const { getByLabelText, getByText } = await render(<AITopUpScreen />);

  await fireEvent.press(getByLabelText(/^Spark,/));
  await fireEvent.changeText(getByLabelText("Phone number"), "9876543210");
  await fireEvent.press(getByLabelText("Pay securely"));

  await waitFor(() => expect(getByText("Couldn't start the payment. Please try again.")).toBeTruthy());
});

test("an unavailable catalogue is honest and retryable", async () => {
  const refetch = jest.fn();
  mockPacks.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
  const { getByLabelText, getByText } = await render(<AITopUpScreen />);

  expect(getByText("Top-ups aren't available right now.")).toBeTruthy();
  await fireEvent.press(getByLabelText("Retry"));
  expect(refetch).toHaveBeenCalledTimes(1);
});
