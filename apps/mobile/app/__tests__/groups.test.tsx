import { render, fireEvent } from "@testing-library/react-native";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock("@/api/hooks", () => ({
  useGroups: () => ({ data: [{ id: "g1", name: "Squad", member_count: 3, role: "owner" }] }),
  useCreateGroup: () => ({ mutate: jest.fn(), isPending: false }),
  useJoinGroup: () => ({ mutate: jest.fn(), isPending: false }),
}));

import Groups from "../groups";

test("lists my groups and navigates to detail on tap", async () => {
  const { getByText } = await render(<Groups />);
  expect(getByText("Squad")).toBeTruthy();
  expect(getByText("3 members")).toBeTruthy();
  await fireEvent.press(getByText("Squad"));
  expect(mockPush).toHaveBeenCalledWith("/group/g1");
});
