import { render } from "@testing-library/react-native";

import FriendBody from "../friend/[id]";


let mockData: unknown;
let mockError: unknown = null;
let mockPending = false;

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "u1" }),
  router: { back: jest.fn(), replace: jest.fn() },
}));
jest.mock("@/api/hooks", () => ({
  useFriends: () => ({ data: [{ id: "u1", display_name: "Ada Lovelace" }] }),
  useFriendBody: () => ({ data: mockData, error: mockError, isError: Boolean(mockError), isPending: mockPending, refetch: jest.fn() }),
}));

// Arbitrary fixtures; they describe nobody.
const entry = {
  logged_at: "2026-08-25T02:00:00Z",
  local_date: "2026-08-25T00:00:00Z",
  weight_kg: 70.4,
  body_fat_pct: 20,
};

beforeEach(() => {
  mockData = [entry];
  mockError = null;
  mockPending = false;
});

test("shows the latest weigh-in and the friend's name", async () => {
  const { getByTestId, getByText } = await render(<FriendBody />);
  expect(getByText("Ada Lovelace")).toBeTruthy();
  expect(getByTestId("friend-body-weight")).toHaveTextContent("70.4 kg");
  expect(getByTestId("friend-body-body_fat_pct")).toHaveTextContent("20%");
});

// The rule that matters most on this screen: an absent metric means NOT
// MEASURED. A friend who only records weight must never appear to have 0%
// body fat.
test("an absent metric reads as not measured, never as zero", async () => {
  mockData = [{ logged_at: entry.logged_at, local_date: entry.local_date, weight_kg: 70 }];
  const { getByTestId } = await render(<FriendBody />);
  expect(getByTestId("friend-body-body_fat_pct")).toHaveTextContent("Not measured");
  expect(getByTestId("friend-body-waist_cm")).toHaveTextContent("Not measured");
});

// A zero that was actually MEASURED is still a measurement, and must not be
// laundered into "Not measured" by a falsy check.
test("a measured zero renders as a number, not as not-measured", async () => {
  mockData = [{ ...entry, body_fat_pct: 0 }];
  const { getByTestId } = await render(<FriendBody />);
  expect(getByTestId("friend-body-body_fat_pct")).toHaveTextContent("0%");
});

// 404 is not an error: the server returns it for not-shared, not-a-friend,
// no-such-person and reading-yourself, deliberately indistinguishable. It must
// render one calm state with no retry prompt.
test("a 404 renders as nothing-shared, not as a failure", async () => {
  mockData = undefined;
  mockError = Object.assign(new Error("Not found."), { name: "ApiError", status: 404 });
  const { getByText, queryByText, queryByTestId } = await render(<FriendBody />);
  expect(getByText("Nothing shared with you")).toBeTruthy();
  expect(queryByTestId("friend-body-load-error")).toBeNull();
  expect(queryByText(/Retry/i)).toBeNull();
  expect(queryByText(/went wrong/i)).toBeNull();
});

// A real failure is a different thing and must say so, with a retry.
test("a 500 renders as a failure with a retry", async () => {
  mockData = undefined;
  mockError = Object.assign(new Error("boom"), { name: "ApiError", status: 500 });
  const { getByTestId, queryByText } = await render(<FriendBody />);
  expect(getByTestId("friend-body-load-error")).toBeTruthy();
  expect(queryByText("Nothing shared with you")).toBeNull();
});

// local_date is the OWNER's device-local day. Re-deriving it from logged_at in
// the viewer's timezone would shift entries across day boundaries.
test("the date shown is the owner's local day, not the viewer's", async () => {
  mockData = [{ ...entry, logged_at: "2026-08-25T23:30:00Z", local_date: "2026-08-26T00:00:00Z" }];
  const { getByText } = await render(<FriendBody />);
  expect(getByText(/2026-08-26/)).toBeTruthy();
});

// A 200 with an empty series is NOT the same fact as a 404, and conflating
// them told a viewer who holds a grant that they hold nothing. Found on
// device. Distinguishing them leaks nothing: someone holding a grant is
// entitled to know they hold it.
test("a granted friend with no weigh-ins is distinguished from not-shared", async () => {
  mockData = [];
  const { getByText, queryByText } = await render(<FriendBody />);
  expect(getByText("Nothing recorded yet")).toBeTruthy();
  expect(queryByText("Nothing shared with you")).toBeNull();
});

test("a 404 still reads as not-shared, never as nothing-recorded", async () => {
  mockData = undefined;
  mockError = Object.assign(new Error("Not found."), { name: "ApiError", status: 404 });
  const { getByText, queryByText } = await render(<FriendBody />);
  expect(getByText("Nothing shared with you")).toBeTruthy();
  expect(queryByText("Nothing recorded yet")).toBeNull();
});


// Found on device: a friend with five weigh-ins read as having none, because
// `data` is undefined while the request is in flight and the empty branch
// treated that as an answer. A pending fetch must never render as a claim
// about another person's data (#174's rule, applied here).
test("a request in flight does not claim they have recorded nothing", async () => {
  mockPending = true;
  mockData = undefined;
  const { getByTestId, queryByText } = await render(<FriendBody />);
  expect(getByTestId("friend-body-loading")).toBeTruthy();
  expect(queryByText("Nothing recorded yet")).toBeNull();
  expect(queryByText("Nothing shared with you")).toBeNull();
});
