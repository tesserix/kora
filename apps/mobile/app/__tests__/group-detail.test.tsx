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
}));

import GroupDetail from "../group/[id]";

test("renders name, roster, leaderboard, and owner-only Delete", async () => {
  const { getByText } = await render(<GroupDetail />);
  expect(getByText("Squad")).toBeTruthy();
  expect(getByText("Owner")).toBeTruthy();
  expect(getByText("Mate")).toBeTruthy();
  expect(getByText("4/7 on target")).toBeTruthy(); // leaderboard, sharing member
  expect(getByText("Delete group")).toBeTruthy(); // my_role owner
});
