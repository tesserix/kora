import { Text } from "react-native";
import { render, fireEvent } from "@testing-library/react-native";

import { ErrorBoundary } from "../ErrorBoundary";

const mockReportError = jest.fn();
jest.mock("@/observability/reporter", () => ({
  reportError: (...a: unknown[]) => mockReportError(...a),
}));

function Boom(): never {
  throw new Error("render exploded");
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockReportError.mockClear();
  // React logs caught render errors; silencing keeps the suite output honest
  // about real failures.
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

test("renders children when nothing throws", async () => {
  const { getByText } = await render(
    <ErrorBoundary>
      <Text>all good</Text>
    </ErrorBoundary>,
  );
  expect(getByText("all good")).toBeTruthy();
});

test("renders the fallback and reports when a child throws", async () => {
  const { getByText } = await render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  );

  expect(getByText("Something went wrong.")).toBeTruthy();
  expect(mockReportError).toHaveBeenCalledTimes(1);
  const [reported] = mockReportError.mock.calls[0];
  expect((reported as Error).message).toBe("render exploded");
});

test("the reset action clears the error state", async () => {
  const { getByText, queryByText } = await render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  );

  expect(getByText("Something went wrong.")).toBeTruthy();
  await fireEvent.press(getByText("Try again"));

  // The child throws again on re-render, so the fallback is expected to
  // return. What this proves is that the reset path runs and re-renders —
  // asserted via a SECOND report, which a no-op reset could not produce.
  expect(mockReportError).toHaveBeenCalledTimes(2);
  expect(queryByText("Something went wrong.")).toBeTruthy();
});
