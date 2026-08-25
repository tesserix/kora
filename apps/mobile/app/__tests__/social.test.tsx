import { render, fireEvent } from "@testing-library/react-native";

import Social from "../social";

// The real "@/lib/api" pulls in firebase/auth (real ESM), which Jest cannot
// parse unmocked. Social renders AddFriendSheet, which imports it directly
// (not through @/api/hooks, mocked below) -- same reasoning and shape as
// AddFriendSheet.test.tsx's own mock and profile.test.tsx's.
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    requestId?: string;
    constructor(status: number, code: string, message: string, requestId?: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.requestId = requestId;
      this.name = "ApiError";
    }
  },
}));

const mockPush = jest.fn();
const mockAccept = jest.fn();
const mockDecline = jest.fn();

let mockCircles: unknown[] = [];
let mockCirclesErr = false;
let mockFriends: unknown[] = [];
let mockFriendsErr = false;
let mockGroups: unknown[] = [];
let mockGroupsErr = false;
let mockIncoming: unknown[] = [];

jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn() } }));
jest.mock("@/components/Toast", () => ({ useToast: () => ({ show: jest.fn() }) }));
jest.mock("@/api/hooks", () => ({
  useCircles: () => ({ data: mockCircles, isError: mockCirclesErr, refetch: jest.fn() }),
  useFriends: () => ({ data: mockFriends, isError: mockFriendsErr, refetch: jest.fn() }),
  useFriendRequests: () => ({ data: { incoming: mockIncoming, outgoing: [] }, isError: false, refetch: jest.fn() }),
  useGroups: () => ({ data: mockGroups, isError: mockGroupsErr, refetch: jest.fn() }),
  useAcceptRequest: () => ({ mutate: mockAccept, isPending: false }),
  useDeclineRequest: () => ({ mutate: mockDecline, isPending: false }),
  useSendFriendRequest: () => ({ mutate: jest.fn(), isPending: false }),
  useLookupHandle: () => ({ mutate: jest.fn(), isPending: false }),
  useMyFriendCode: () => ({ data: { code: "ABC", link: "l" } }),
  useCreateGroup: () => ({ mutate: jest.fn(), isPending: false }),
  useJoinGroup: () => ({ mutate: jest.fn(), isPending: false }),
}));

const ada = { id: "u1", display_name: "Ada Lovelace" };

beforeEach(() => {
  [mockPush, mockAccept, mockDecline].forEach((m) => m.mockClear());
  mockCircles = []; mockFriends = []; mockGroups = []; mockIncoming = [];
  mockCirclesErr = mockFriendsErr = mockGroupsErr = false;
});

test("the audit heads the screen and reports who can see what", async () => {
  mockCircles = [{ id: "c1", name: "Household", members: [ada], categories: ["body"] }];
  const { getByTestId } = await render(<Social />);
  expect(getByTestId("audit-count-body")).toHaveTextContent("1");
  expect(getByTestId("audit-empty-progress")).toBeTruthy();
});

// The regression test for the whole per-section-boundary design: one failed
// query must not take the others down with it.
test("a failed circles fetch leaves friends and groups rendering", async () => {
  mockCirclesErr = true;
  mockFriends = [ada];
  mockGroups = [{ id: "g1", name: "Sunday Runners", member_count: 3, role: "member" }];
  const { getByTestId, getByText, queryByTestId } = await render(<Social />);
  expect(getByTestId("audit-load-error")).toBeTruthy();
  expect(queryByTestId("audit-empty-body")).toBeNull();
  expect(getByText("Ada Lovelace")).toBeTruthy();
  expect(getByText("Sunday Runners")).toBeTruthy();
});

test("a failed friends fetch leaves the audit and groups intact", async () => {
  mockFriendsErr = true;
  mockCircles = [{ id: "c1", name: "Household", members: [ada], categories: ["body"] }];
  mockGroups = [{ id: "g1", name: "Sunday Runners", member_count: 3, role: "member" }];
  const { getByTestId, getByText } = await render(<Social />);
  expect(getByTestId("friends-load-error")).toBeTruthy();
  expect(getByTestId("audit-count-body")).toHaveTextContent("1");
  expect(getByText("Sunday Runners")).toBeTruthy();
});

test("a failed groups fetch leaves the audit and friends intact", async () => {
  mockGroupsErr = true;
  mockFriends = [ada];
  const { getByTestId, getByText } = await render(<Social />);
  expect(getByTestId("groups-load-error")).toBeTruthy();
  expect(getByText("Ada Lovelace")).toBeTruthy();
});

test("the empty state explains how to find people, not just that there are none", async () => {
  const { getByText } = await render(<Social />);
  expect(getByText(/friend code, or by the email they signed up with/i)).toBeTruthy();
  expect(getByText("Create one, or join with a code.")).toBeTruthy();
});

test("tapping the audit opens circles", async () => {
  const { getByLabelText } = await render(<Social />);
  await fireEvent.press(getByLabelText("Who can see your data"));
  expect(mockPush).toHaveBeenCalledWith("/circles");
});

test("incoming requests can be accepted inline", async () => {
  mockIncoming = [{ id: "r1", user: { id: "u2", display_name: "Ben" } }];
  const { getByLabelText } = await render(<Social />);
  await fireEvent.press(getByLabelText("Accept request from Ben"));
  expect(mockAccept).toHaveBeenCalledWith("r1", expect.objectContaining({ onError: expect.any(Function) }));
});

// Previews hand off rather than growing without bound.
test("friends overflow to the full screen past the preview limit", async () => {
  mockFriends = Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, display_name: `Person ${i}` }));
  const { getByLabelText } = await render(<Social />);
  await fireEvent.press(getByLabelText("See all 7 friends"));
  expect(mockPush).toHaveBeenCalledWith("/friends");
});

test("no overflow row when everyone fits in the preview", async () => {
  mockFriends = [ada];
  const { queryByLabelText } = await render(<Social />);
  expect(queryByLabelText(/See all .* friends/)).toBeNull();
});

test("a group opens its detail screen", async () => {
  mockGroups = [{ id: "g1", name: "Sunday Runners", member_count: 3, role: "owner" }];
  const { getByLabelText } = await render(<Social />);
  await fireEvent.press(getByLabelText("Open group Sunday Runners"));
  expect(mockPush).toHaveBeenCalledWith("/group/g1");
});

// kora#449 task 15 finding 3: a blank display_name rendered as an empty line
// and an accessibility label with nothing after it ("Open ", "Accept request
// from "). "@handle" is the same fallback LookupResultCard.tsx uses (kora#443).
test("a friend with no display name falls back to their handle", async () => {
  mockFriends = [{ id: "u9", display_name: "", handle: "ada_l" }];
  const { getByText, getByLabelText } = await render(<Social />);
  expect(getByText("@ada_l")).toBeTruthy();
  expect(getByLabelText("Open @ada_l")).toBeTruthy();
});

test("an incoming request with no display name falls back to their handle, in both the row and the a11y labels", async () => {
  mockIncoming = [{ id: "r1", user: { id: "u2", display_name: "", handle: "ben_f" } }];
  const { getByText, getByLabelText } = await render(<Social />);
  expect(getByText("@ben_f")).toBeTruthy();
  expect(getByLabelText("Accept request from @ben_f")).toBeTruthy();
  expect(getByLabelText("Decline request from @ben_f")).toBeTruthy();
});

// kora#449 task 15 finding 8: a friend with no name used to show a hardcoded
// "K" avatar glyph -- reading as a real person's initial rather than a
// fallback. It must never render "K" for someone whose name is blank.
test("a friend with no display name never shows the hardcoded K avatar glyph", async () => {
  mockFriends = [{ id: "u9", display_name: "", handle: "ada_l" }];
  const { queryByText } = await render(<Social />);
  expect(queryByText("K")).toBeNull();
});
