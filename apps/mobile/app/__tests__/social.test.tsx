import { render, fireEvent } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

import Social from "../social";

// This repo's testing-library build has no UNSAFE_getByType/UNSAFE_queryAllByType
// (see Avatar.test.tsx) -- component-type queries go through queryAll instead.
function queryImages(container: TestInstance): TestInstance[] {
  return container.queryAll((instance) => instance.type === "Image");
}

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
  expect(getByText(/handle, email or friend code/i)).toBeTruthy();
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

// kora#454: `uri` was passed at only 3 of 7 Avatar sites -- neither the
// accepted-friends PersonRow nor the incoming-request row here was one of
// them, though Friend.avatar_url has existed since kora#449.
test("an accepted friend's picture is passed through to their Avatar", async () => {
  mockFriends = [{ id: "u1", display_name: "Ada Lovelace", avatar_url: "https://assets.test/ada.jpg" }];
  const { container } = await render(<Social />);
  const images = queryImages(container);
  expect(images.map((i) => i.props.source)).toContainEqual({ uri: "https://assets.test/ada.jpg" });
});

// This is the screen where consent is granted -- the incoming-request row
// used to render no Avatar at all, even though the API composes avatar_url
// for both directions of a pending request.
test("an incoming request's picture is passed through to their Avatar", async () => {
  mockIncoming = [{ id: "r1", user: { id: "u2", display_name: "Ben", avatar_url: "https://assets.test/ben.jpg" } }];
  const { container } = await render(<Social />);
  const images = queryImages(container);
  expect(images.map((i) => i.props.source)).toContainEqual({ uri: "https://assets.test/ben.jpg" });
});

// kora#452. At accessibility text sizes, a row shaped [avatar / name /
// trailing control(s)] squeezes the name to nothing between two fixed-size
// siblings -- worst for the request row, whose pair of 44pt accept/decline
// buttons is 88pt of fixed width plus gaps. The fix drops the trailing
// control(s) to their own line past a font-scale threshold so the name gets
// (almost) the full row width. jest cannot observe platform font scaling
// (see sign-in.test.tsx's own note), so this drives useWindowDimensions
// directly, exactly as that suite does.
function withFontScale(fontScale: number) {
  // require, not a top-level import: an ESM namespace object is sealed, so
  // jest.spyOn cannot redefine a property on it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = require("react-native");
  return jest
    .spyOn(rn, "useWindowDimensions")
    .mockReturnValue({ width: 440, height: 956, scale: 3, fontScale });
}

describe("row reflow at accessibility text sizes (kora#452)", () => {
  afterEach(() => jest.restoreAllMocks());

  test("keeps accept/decline beside the avatar and name at ordinary text sizes", async () => {
    withFontScale(1);
    mockIncoming = [{ id: "r1", user: { id: "u2", display_name: "Ben" } }];
    const { getByLabelText, getByText, unmount } = await render(<Social />);

    const accept = getByLabelText("Accept request from Ben");
    const name = getByText("Ben");
    // Same immediate row: the accept button and the name share one parent
    // View, alongside the Avatar and the decline button -- four children.
    expect(accept.parent).toBe(name.parent);
    expect(accept.parent?.children.length).toBe(4);
    unmount();
  });

  test("moves accept/decline to their own row past the accessibility threshold, keeping both visible", async () => {
    // Between iOS's xxxL (~1.35) and AX1 (~1.64) -- same boundary as
    // sign-in.tsx's HERO_COLLAPSE_FONT_SCALE (kora#173/#260).
    withFontScale(2.643);
    mockIncoming = [{ id: "r1", user: { id: "u2", display_name: "Ben" } }];
    const { getByLabelText, getByText, unmount } = await render(<Social />);

    const accept = getByLabelText("Accept request from Ben");
    const decline = getByLabelText("Decline request from Ben");
    const name = getByText("Ben");

    // Consent surface: the requester's name and both actions are all still
    // reachable -- reflow must never drop who is asking or hide a control.
    expect(name).toBeTruthy();
    expect(accept).toBeTruthy();
    expect(decline).toBeTruthy();
    // No longer sharing a row with the name.
    expect(accept.parent).not.toBe(name.parent);
    // Its own row holds only the two controls.
    expect(accept.parent).toBe(decline.parent);
    expect(accept.parent?.children.length).toBe(2);
    unmount();
  });

  // Two separate tests rather than a loop over one render: this build's
  // `render` is async, and looping bare renders in a single test left the
  // second `render()` racing the first's not-yet-flushed unmount (visible as
  // React's "overlapping act() calls" warning), which went on to corrupt the
  // NEXT test's tree rather than this one's assertions.
  test("accept/decline stay 44pt targets at ordinary text sizes", async () => {
    withFontScale(1);
    mockIncoming = [{ id: "r1", user: { id: "u2", display_name: "Ben" } }];
    const { getByLabelText, unmount } = await render(<Social />);
    for (const label of ["Accept request from Ben", "Decline request from Ben"]) {
      const style = getByLabelText(label).props.style;
      const flat = Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
      expect(flat.width).toBe(44);
      expect(flat.height).toBe(44);
    }
    unmount();
  });

  test("accept/decline stay 44pt targets once stacked", async () => {
    withFontScale(2.643);
    mockIncoming = [{ id: "r1", user: { id: "u2", display_name: "Ben" } }];
    const { getByLabelText, unmount } = await render(<Social />);
    for (const label of ["Accept request from Ben", "Decline request from Ben"]) {
      const style = getByLabelText(label).props.style;
      const flat = Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
      expect(flat.width).toBe(44);
      expect(flat.height).toBe(44);
    }
    unmount();
  });

  test("a friend row keeps the chevron beside the name at ordinary text sizes", async () => {
    withFontScale(1);
    mockFriends = [ada];
    const { getByText, unmount } = await render(<Social />);
    const name = getByText("Ada Lovelace");
    // Avatar + name + chevron on one row.
    expect(name.parent?.children.length).toBe(3);
    unmount();
  });

  test("a friend row drops the chevron to its own line past the accessibility threshold", async () => {
    withFontScale(2.643);
    mockFriends = [ada];
    const { getByText, unmount } = await render(<Social />);
    const name = getByText("Ada Lovelace");
    // Just avatar + name now that the chevron moved off this row.
    expect(name.parent?.children.length).toBe(2);
    unmount();
  });

  test("a group row drops the chevron to its own line past the accessibility threshold", async () => {
    withFontScale(2.643);
    mockGroups = [{ id: "g1", name: "Sunday Runners", member_count: 3, role: "owner" }];
    const { getByText, unmount } = await render(<Social />);
    const name = getByText("Sunday Runners");
    // The name+meta column is the row's only remaining sibling once the
    // chevron drops to its own line.
    expect(name.parent?.parent?.children.length).toBe(1);
    unmount();
  });
});

// kora#452: the title must never truncate. numberOfLines/ellipsizeMode are
// the props that would produce the reported "Soci..." clip; asserting their
// absence pins the no-truncation contract regardless of how tall the title
// renders at accessibility sizes.
test("the screen title carries no truncation props", async () => {
  const { getByText } = await render(<Social />);
  const title = getByText("Social");
  expect(title.props.numberOfLines).toBeUndefined();
  expect(title.props.ellipsizeMode).toBeUndefined();
});
