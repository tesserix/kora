import { render, fireEvent } from "@testing-library/react-native";
import Diary from "../(tabs)/diary";

const mockAddWaterMutate = jest.fn();

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
// The diary now reads the offline queue too; these tests are about water/copy,
// so the queue is stubbed empty (it has its own tests in src/offline).
jest.mock("@/offline/useQueuedLogs", () => ({
  useQueuedLogs: () => ({ rows: [], retryRow: jest.fn(), discardRow: jest.fn() }),
}));
jest.mock("@/offline/useQueuedCaptures", () => ({
  useQueuedCaptures: () => ({ rows: [], retryRow: jest.fn(), discardRow: jest.fn() }),
}));

jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { consumed: { kcal: 0 }, targets: { kcal: 2000 }, water_ml: 500 } }),
  useDayLogs: () => ({ data: [] }),
  useAddWater: () => ({ mutate: mockAddWaterMutate, isPending: false }),
  useDeleteLog: () => ({ mutate: jest.fn(), isPending: false }),
}));

beforeEach(() => mockAddWaterMutate.mockClear());

test("tapping +250 ml logs 250 for the selected day at noon UTC", async () => {
  const { getByText } = await render(<Diary />);
  await fireEvent.press(getByText("+250 ml"));
  const [arg] = mockAddWaterMutate.mock.calls[0];
  expect(arg.volume_ml).toBe(250);
  expect(arg.logged_at).toMatch(/^\d{4}-\d{2}-\d{2}T12:00:00Z$/); // noon-UTC of the selected day
});
