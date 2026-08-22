import { fireEvent, render } from "@testing-library/react-native";

import AIInvoicesScreen from "../ai-invoices";

const mockOrders = jest.fn();

jest.mock("expo-router", () => ({
  router: { back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
}));
jest.mock("@/api/hooks", () => ({ useAIOrders: () => mockOrders() }));

const paid = {
  id: "order-1",
  pack_code: "spark",
  base_paise: 5_000,
  platform_fee_paise: 100,
  gst_paise: 918,
  total_paise: 6_018,
  currency: "INR",
  status: "paid" as const,
  invoice_number: "KORA/26-27/000001",
  paid_at: "2026-08-22T09:05:00Z",
  created_at: "2026-08-22T09:00:00Z",
};

beforeEach(() => {
  mockOrders.mockReturnValue({ data: [paid], isLoading: false, isError: false, refetch: jest.fn() });
});

// A GST invoice has to show the tax that was collected, not only the total.
test("a paid purchase itemises the fee and the GST it was billed", async () => {
  const { getByText } = await render(<AIInvoicesScreen />);

  expect(getByText("spark")).toBeTruthy();
  expect(getByText("₹60.18")).toBeTruthy();
  expect(getByText(/₹50\.00 \+ ₹1\.00 fee \+ ₹9\.18 GST/)).toBeTruthy();
  expect(getByText(/KORA\/26-27\/000001/)).toBeTruthy();
});

test("an unpaid order is not shown as an invoice", async () => {
  mockOrders.mockReturnValue({
    data: [{ ...paid, status: "created", invoice_number: undefined, paid_at: undefined }],
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  });

  const { getByText, queryByText } = await render(<AIInvoicesScreen />);

  expect(getByText(/Awaiting payment/)).toBeTruthy();
  expect(queryByText(/fee \+ /)).toBeNull();
});

test("no purchases says so plainly", async () => {
  mockOrders.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: jest.fn() });

  const { getByText } = await render(<AIInvoicesScreen />);

  expect(getByText("You haven't bought a top-up yet.")).toBeTruthy();
});

test("a load failure is retryable", async () => {
  const refetch = jest.fn();
  mockOrders.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });

  const { getByLabelText, getByText } = await render(<AIInvoicesScreen />);

  expect(getByText("Couldn't load your purchases.")).toBeTruthy();
  await fireEvent.press(getByLabelText("Retry"));
  expect(refetch).toHaveBeenCalledTimes(1);
});
