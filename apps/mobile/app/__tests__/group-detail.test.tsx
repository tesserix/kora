import { render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { back: jest.fn() }, useLocalSearchParams: () => ({ id: "g1" }) }));
jest.mock("@/api/hooks", () => ({
  useGroup: () => ({ data: { id: "g1", name: "Squad", invite_code: "CODE1234", my_role: "owner", members: [
    { id: "u1", display_name: "Owner", role: "owner" },
    { id: "u2", display_name: "Mate", role: "member" },
  ] } }),
  useGroupProgress: () => ({ data: { members: [
    { id: "u1", display_name: "Owner", sharing: true, streak_days: 5, adherence_days: 4 },
    { id: "u2", display_name: "Mate", sharing: false },
  ] } }),
  useGroupCode: () => ({ data: { code: "CODE1234", link: "mobile://group/CODE1234" } }),
  useLeaveGroup: () => ({ mutate: jest.fn(), isPending: false }),
  useRemoveMember: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteGroup: () => ({ mutate: jest.fn(), isPending: false }),
  useProfile: () => ({ data: { id: "u1" } }),
  useGroupChallenges: () => ({ data: [{ id: "c1", title: "July streak", metric: "logged", status: "active", start_date: "", end_date: "", participant_count: 2, joined: true }] }),
}));

import GroupDetail from "../group/[id]";

test("renders name, roster, leaderboard, and owner-only Delete", async () => {
  const { getByText, getAllByText } = await render(<GroupDetail />);
  expect(getByText("Squad")).toBeTruthy();
  // "Owner" (the sharing member's display_name) renders once in the leaderboard
  // row and once in the roster row below it.
  expect(getAllByText("Owner")).toHaveLength(2);
  expect(getByText("Mate")).toBeTruthy();
  expect(getByText("4/7 on target")).toBeTruthy(); // leaderboard, sharing member
  expect(getByText("Delete group")).toBeTruthy(); // my_role owner
  expect(getByText("July streak")).toBeTruthy(); // challenges section
});
