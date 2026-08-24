import { render, fireEvent } from "@testing-library/react-native";
import Diary from "../(tabs)/diary";

// useFocusEffect: ScreenEntrance (Task 9) wraps Diary's root content and
// calls the real expo-router hook, which needs a navigation container this
// isolated render doesn't mount.
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, useFocusEffect: () => {} }));
// The diary now reads the offline queue too; these tests are about water/copy,
// so the queue is stubbed empty (it has its own tests in src/offline).
jest.mock("@/offline/useQueuedLogs", () => ({
  useQueuedLogs: () => ({ rows: [], retryRow: jest.fn(), discardRow: jest.fn() }),
}));
jest.mock("@/offline/useQueuedCaptures", () => ({
  useQueuedCaptures: () => ({ rows: [] }),
}));


const mockCopyMutate = jest.fn();
jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { consumed: { kcal: 0 }, targets: { kcal: 2000 }, water_ml: 0 } }),
  useDayLogs: () => ({ data: [] }),
  useAddWater: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteLog: () => ({ mutate: jest.fn(), isPending: false }),
  useCopyDay: () => ({ mutate: mockCopyMutate, isPending: false }),
  useCurrentFast: () => ({ data: null, isSuccess: true }),
  useStartFast: () => ({ mutate: jest.fn(), isPending: false }),
  useEndFast: () => ({ mutate: jest.fn(), isPending: false }),
}));

test("empty day shows the Copy-from-another-day CTA and it opens the picker", async () => {
  const { getByText, findByText } = await render(<Diary />);
  expect(getByText("Copy from another day")).toBeTruthy();
  await fireEvent.press(getByText("Copy from another day"));
  expect(await findByText("Copy a day")).toBeTruthy();
});
