import AsyncStorage from "@react-native-async-storage/async-storage";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import type { Profile } from "@/api/types";
import { PlanReviewCard } from "../PlanReviewCard";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));

const KEY = "kora.planReview.dismissed.u1";
const P = { id: "u1", onboarded_at: "2025-03-14T00:00:00Z", plan_saved_at: null } as Profile;

beforeEach(async () => {
  mockPush.mockClear();
  await AsyncStorage.clear();
});

test("card shows for an onboarded user who never saved a plan, and opens /plan", async () => {
  const { findByText, getByText } = await render(<PlanReviewCard profile={P} />);
  await findByText("Check your plan");
  expect(getByText("We've improved how protein is worked out. Take a look.")).toBeTruthy();
  await fireEvent.press(getByText("Check your plan"));
  expect(mockPush).toHaveBeenCalledWith("/plan");
});

test("card hides after dismiss", async () => {
  const { findByLabelText, queryByText } = await render(<PlanReviewCard profile={P} />);
  await fireEvent.press(await findByLabelText("Dismiss"));
  await waitFor(() => expect(queryByText("Check your plan")).toBeNull());
  expect(await AsyncStorage.getItem(KEY)).toBe("1");
});

test("card stays hidden when already dismissed", async () => {
  await AsyncStorage.setItem(KEY, "1");
  const { queryByText } = await render(<PlanReviewCard profile={P} />);
  await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
  expect(queryByText("Check your plan")).toBeNull();
});

test("card hides once plan_saved_at is set, or before onboarding", async () => {
  const saved = await render(<PlanReviewCard profile={{ ...P, plan_saved_at: "2026-10-01T00:00:00Z" }} />);
  await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
  expect(saved.queryByText("Check your plan")).toBeNull();
  const fresh = await render(<PlanReviewCard profile={{ ...P, onboarded_at: null }} />);
  expect(fresh.queryByText("Check your plan")).toBeNull();
});
