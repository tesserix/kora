import { render } from "@testing-library/react-native";
import { FriendsLeaderboard } from "../FriendsLeaderboard";

const data = {
  me: { streak_days: 5, adherence_days: 4, adherence_window: 7 },
  friends: [
    { id: "a", display_name: "Ada", sharing: true, streak_days: 9, adherence_days: 6 },
    { id: "b", display_name: "Ben", sharing: false },
  ],
};

test("ranks by streak, shows on-target in rank order, and groups non-sharing", async () => {
  const { getByText, getAllByText } = await render(<FriendsLeaderboard data={data} />);
  expect(getByText("You")).toBeTruthy();
  expect(getByText("Ada")).toBeTruthy();
  // Ada (streak 9) ranks above You (streak 5): on-target lines appear in rank order.
  const onTarget = getAllByText(/on target$/).map((n) => n.props.children);
  expect(onTarget).toEqual(["6/7 on target", "4/7 on target"]);
  // Ben is non-sharing -> grouped under "Not sharing", no metrics shown.
  expect(getByText("Not sharing")).toBeTruthy();
  expect(getByText("Ben")).toBeTruthy();
});
