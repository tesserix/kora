import { render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";

import BillingReturnScreen from "../billing/return";

const mockInvalidate = jest.fn();

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), back: jest.fn(), push: jest.fn(), canGoBack: jest.fn(() => true) },
}));
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));

beforeEach(() => {
  mockInvalidate.mockClear();
  (router.replace as jest.Mock).mockClear();
});

// The link Cashfree sends the user back on is forgeable, so returning must
// only re-read the server's answer — never report a result from the URL.
test("returning from checkout drops the stale allowance and shows what the server says", async () => {
  const { getByText } = await render(<BillingReturnScreen />);

  expect(getByText("Checking your payment…")).toBeTruthy();
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/ai-usage"));
  expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["ai-usage"] });
  expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["ai-orders"] });
  expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["ai-order"] });
});
