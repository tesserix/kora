import { fireEvent, render } from "@testing-library/react-native";
import { Linking } from "react-native";

import SecurityScreen from "../security";
import * as twoStep from "@/api/twoStep";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
}));
jest.mock("@/api/twoStep", () => ({
  ...jest.requireActual("@/api/twoStep"),
  fetchTwoStepEnabled: jest.fn(),
  startTwoStep: jest.fn(),
  confirmTwoStep: jest.fn(),
  disableTwoStep: jest.fn(),
}));

const api = twoStep as jest.Mocked<typeof twoStep>;

function apiError(code: string, message: string) {
  return Object.assign(new Error(message), { name: "ApiError", status: 400, code });
}

beforeEach(() => {
  jest.clearAllMocks();
});

test("turning on: setup key, open the app, confirm with a code", async () => {
  api.fetchTwoStepEnabled.mockResolvedValue(false);
  api.startTwoStep.mockResolvedValue({ uri: "otpauth://totp/Tesserix:ann?secret=ABCDEFGHIJKL", secret: "ABCDEFGHIJKL" });
  api.confirmTwoStep.mockResolvedValue();
  const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);

  const ui = await render(<SecurityScreen />);
  await fireEvent.press(await ui.findByTestId("security-enable"));
  expect(ui.getByTestId("security-secret").props.children).toBe("ABCD EFGH IJKL");

  await fireEvent.press(ui.getByTestId("security-open-app"));
  expect(open).toHaveBeenCalledWith("otpauth://totp/Tesserix:ann?secret=ABCDEFGHIJKL");

  await fireEvent.changeText(ui.getByLabelText("Code"), "123 456");
  await fireEvent.press(ui.getByTestId("security-confirm"));
  expect(api.confirmTwoStep).toHaveBeenCalledWith("123456");
  expect(await ui.findByText("Two-step verification is on.")).toBeTruthy();
});

test("a wrong confirmation code shows kora-api's wording and stays on setup", async () => {
  api.fetchTwoStepEnabled.mockResolvedValue(false);
  api.startTwoStep.mockResolvedValue({ uri: "otpauth://x", secret: "ABCD" });
  api.confirmTwoStep.mockRejectedValue(apiError("invalid_code", "That code didn't work."));

  const ui = await render(<SecurityScreen />);
  await fireEvent.press(await ui.findByTestId("security-enable"));
  await fireEvent.changeText(ui.getByLabelText("Code"), "000000");
  await fireEvent.press(ui.getByTestId("security-confirm"));
  expect(await ui.findByText("That code didn't work.")).toBeTruthy();
  expect(ui.getByTestId("security-confirm")).toBeTruthy();
});

test("turning off needs a current code", async () => {
  api.fetchTwoStepEnabled.mockResolvedValue(true);
  api.disableTwoStep.mockResolvedValue();

  const ui = await render(<SecurityScreen />);
  await fireEvent.press(await ui.findByTestId("security-disable"));
  expect(api.disableTwoStep).not.toHaveBeenCalled();
  expect(ui.getByText("Enter the 6-digit code from your authenticator app.")).toBeTruthy();

  await fireEvent.changeText(ui.getByLabelText("Code"), "654321");
  await fireEvent.press(ui.getByTestId("security-disable"));
  expect(api.disableTwoStep).toHaveBeenCalledWith("654321");
  expect(await ui.findByText("Two-step verification is off.")).toBeTruthy();
  expect(ui.getByTestId("security-enable")).toBeTruthy();
});

test("a failed status read can be retried", async () => {
  api.fetchTwoStepEnabled.mockRejectedValueOnce(new TypeError("Network request failed")).mockResolvedValueOnce(false);

  const ui = await render(<SecurityScreen />);
  await fireEvent.press(await ui.findByTestId("security-retry"));
  expect(await ui.findByTestId("security-enable")).toBeTruthy();
});

test("groupedSecret splits the key into fours", () => {
  expect(twoStep.groupedSecret("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
  expect(twoStep.groupedSecret("ABCD")).toBe("ABCD");
});
